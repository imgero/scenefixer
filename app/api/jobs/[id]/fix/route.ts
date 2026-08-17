import { after } from "next/server";
import { NextRequest, NextResponse } from "next/server";
import { adminDb, adminAuth } from "@/lib/firebase-admin";
import { triggerFixPhase } from "@/lib/modal";
import { PLAN_LIMITS, type Plan } from "@/lib/types";
import { getPostHogClient } from "@/lib/posthog-server";

function startOfMonth(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), 1).getTime();
}

async function getUidFromRequest(req: NextRequest): Promise<string | null> {
  const auth = req.headers.get("Authorization");
  if (!auth?.startsWith("Bearer ")) return null;
  const token = auth.slice(7);
  try {
    const decoded = await adminAuth.verifyIdToken(token);
    return decoded.uid;
  } catch {
    return null;
  }
}

async function calcCreditsNeeded(jobId: string): Promise<{ total: number; perError: Map<string, number> }> {
  const [errorsSnap, shotsSnap] = await Promise.all([
    adminDb.collection("jobs").doc(jobId).collection("errors")
      .where("userConfirmed", "==", true)
      .get(),
    adminDb.collection("jobs").doc(jobId).collection("shots").get(),
  ]);

  const shotDurations = new Map<string, number>();
  for (const s of shotsSnap.docs) {
    const d = s.data();
    shotDurations.set(s.id, Math.max(1, Math.ceil((d.endMs - d.startMs) / 1000)));
  }

  let total = 0;
  const perError = new Map<string, number>();
  for (const e of errorsSnap.docs) {
    const err = e.data();
    if (err.fixStatus === "fixed") continue;
    const fixDirection = err.fixDirection ?? "aTob";
    const targetShotId = fixDirection === "aTob" ? err.shotBId : err.shotAId;
    const secs = shotDurations.get(targetShotId) ?? 5;
    perError.set(e.id, secs);
    total += secs;
  }

  return { total, perError };
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: jobId } = await params;
  const betaToken = req.headers.get("X-Beta-Token");

  if (betaToken && !req.headers.get("Authorization")) {
    return handleBetaFix(req, jobId, betaToken);
  }

  const uid = await getUidFromRequest(req);
  if (!uid) {
    return NextResponse.json(
      { error: "Sign in to fix continuity errors.", code: "unauthenticated" },
      { status: 401 }
    );
  }

  try {
    const userRef = adminDb.collection("users").doc(uid);
    const userSnap = await userRef.get();
    const now = Date.now();
    const monthStart = startOfMonth(new Date());

    let plan: Plan = "free";
    let creditsUsedThisMonth = 0;
    let monthResetAt = monthStart;
    let creditsBalance = 0;

    if (userSnap.exists) {
      const data = userSnap.data()!;
      plan = (data.plan as Plan) ?? "free";
      monthResetAt = data.monthResetAt ?? monthStart;
      const resetted = monthResetAt < monthStart;
      creditsUsedThisMonth = resetted ? 0 : (data.creditsUsedThisMonth ?? 0);
      creditsBalance = data.creditsBalance ?? 0;
    }

    // Job state check
    const jobSnap = await adminDb.collection("jobs").doc(jobId).get();
    if (!jobSnap.exists) {
      return NextResponse.json({ error: "Job not found" }, { status: 404 });
    }
    const jobData = jobSnap.data()!;
    const status = jobData.status;
    const FIXING_TIMEOUT_MS = 20 * 60 * 1000;
    const isStaleFixing =
      status === "fixing" &&
      typeof jobData.fixingStartedAt === "number" &&
      Date.now() - jobData.fixingStartedAt > FIXING_TIMEOUT_MS;
    if (
      status !== "awaiting_confirmation" &&
      status !== "error" &&
      status !== "done" &&
      !isStaleFixing
    ) {
      return NextResponse.json({ error: "Job is not in a fixable state" }, { status: 409 });
    }

    // Calculate credits needed (seconds of Runway output)
    const { total: creditsNeeded, perError } = await calcCreditsNeeded(jobId);
    if (creditsNeeded === 0) {
      return NextResponse.json({ error: "No unfixed errors to process" }, { status: 409 });
    }

    const limit = PLAN_LIMITS[plan].creditsPerMonth;
    // Monthly refresh: creditsUsedThisMonth resets whenever monthResetAt < the
    // start of the current calendar month. This fires every month regardless of
    // whether the user is on a monthly or annual plan — annual subscribers get
    // their monthly credit allowance refreshed each calendar month, NOT the
    // full year's worth upfront.
    const monthlyLeft = Math.max(0, limit - creditsUsedThisMonth);
    const fromMonthly = Math.min(creditsNeeded, monthlyLeft);
    const fromBalance = creditsNeeded - fromMonthly;

    if (fromBalance > creditsBalance) {
      getPostHogClient().capture({
        distinctId: uid,
        event: "fix_quota_exceeded",
        properties: { job_id: jobId, plan, credits_needed: creditsNeeded, monthly_left: monthlyLeft, balance: creditsBalance },
      });
      return NextResponse.json(
        {
          error: `Not enough credits. You need ${creditsNeeded}s of credits but only have ${monthlyLeft + creditsBalance}s available.`,
          code: "quota_exceeded",
          plan,
          creditsNeeded,
          available: monthlyLeft + creditsBalance,
        },
        { status: 402 }
      );
    }

    // Deduct credits
    const newUsedThisMonth = (monthResetAt < monthStart ? 0 : creditsUsedThisMonth) + fromMonthly;
    await userRef.set(
      {
        creditsUsedThisMonth: newUsedThisMonth,
        creditsBalance: creditsBalance - fromBalance,
        monthResetAt: monthResetAt < monthStart ? monthStart : monthResetAt,
        plan,
      },
      { merge: true }
    );

    // Record per-error credit cost so refunds know how much to return
    if (perError.size > 0) {
      const batch = adminDb.batch();
      for (const [errorId, secs] of perError) {
        batch.update(
          adminDb.collection("jobs").doc(jobId).collection("errors").doc(errorId),
          { creditsDeducted: secs }
        );
      }
      await batch.commit();
    }

    await adminDb.collection("jobs").doc(jobId).update({
      status: "fixing",
      fixingStartedAt: Date.now(),
      ownerUid: uid,
      outputQuality: PLAN_LIMITS[plan].qualityLabel,
      watermark: PLAN_LIMITS[plan].watermark,
    });

    getPostHogClient().capture({
      distinctId: uid,
      event: "fix_started",
      properties: {
        job_id: jobId,
        plan,
        credits_needed: creditsNeeded,
        from_monthly: fromMonthly,
        from_balance: fromBalance,
      },
    });

    after(async () => {
      try {
        await triggerFixPhase(jobId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`Modal fix trigger failed for job ${jobId}: ${msg}`);
        const snap = await adminDb.collection("jobs").doc(jobId).get();
        const current = snap.exists ? snap.data()?.status : undefined;
        if (current !== "done") {
          await adminDb.collection("jobs").doc(jobId).update({
            status: "error",
            errorMessage: msg,
          });
        }
      }
    });

    return NextResponse.json({ ok: true, creditsUsed: creditsNeeded, creditsRemaining: monthlyLeft - fromMonthly + (creditsBalance - fromBalance) });
  } catch (err) {
    console.error(`POST /api/jobs/${jobId}/fix error:`, err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

async function handleBetaFix(req: NextRequest, jobId: string, betaToken: string) {
  try {
    const jobSnap = await adminDb.collection("jobs").doc(jobId).get();
    if (!jobSnap.exists) return NextResponse.json({ error: "Job not found" }, { status: 404 });

    const jobData = jobSnap.data()!;
    if (jobData.betaToken !== betaToken) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
    }

    const status = jobData.status;
    if (status !== "awaiting_confirmation" && status !== "error" && status !== "done") {
      return NextResponse.json({ error: "Job is not in a fixable state" }, { status: 409 });
    }

    const useSnap = await adminDb.collection("betaUses").doc(betaToken).get();
    if (!useSnap.exists) {
      return NextResponse.json({ error: "Beta token not registered", code: "invalid_beta" }, { status: 403 });
    }

    if (useSnap.data()?.fixedAt) {
      return NextResponse.json(
        { error: "Your beta test has already been used.", code: "beta_used" },
        { status: 402 }
      );
    }

    await adminDb.collection("betaUses").doc(betaToken).update({ fixedAt: Date.now() });

    await adminDb.collection("jobs").doc(jobId).update({
      status: "fixing",
      fixingStartedAt: Date.now(),
      outputQuality: "720p",
      watermark: false,
    });

    getPostHogClient().capture({
      distinctId: `beta_${betaToken.slice(0, 8)}`,
      event: "fix_started",
      properties: { job_id: jobId, plan: "beta" },
    });

    after(async () => {
      try {
        await triggerFixPhase(jobId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`Modal beta fix trigger failed for job ${jobId}: ${msg}`);
        const snap = await adminDb.collection("jobs").doc(jobId).get();
        if (snap.exists && snap.data()?.status !== "done") {
          await adminDb.collection("jobs").doc(jobId).update({ status: "error", errorMessage: msg });
        }
      }
    });

    return NextResponse.json({ ok: true, beta: true });
  } catch (err) {
    console.error(`Beta fix error for job ${jobId}:`, err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
