import { after } from "next/server";
import { NextRequest, NextResponse } from "next/server";
import { adminDb, adminAuth } from "@/lib/firebase-admin";
import { triggerFixPhase } from "@/lib/modal";
import { PLAN_LIMITS } from "@/lib/types";
import { ensureEntitlement, MONTHLY_SPEND_CEILING } from "@/lib/entitlements";
import { captureServer } from "@/lib/posthog-server";

const FIXING_TIMEOUT_MS = 20 * 60 * 1000;

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

async function calcCreditsNeeded(
  jobId: string
): Promise<{ total: number; perError: Map<string, number>; confirmedCount: number }> {
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

  return { total, perError, confirmedCount: errorsSnap.size };
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

  // Server-side proof the request arrived. `fix_requested` is client-side, so
  // without this we cannot tell "never reached the server" from "server threw".
  // Emitted before any check, keyed on uid when we have one so an
  // unauthenticated request is still attributable to its job.
  await captureServer({
    distinctId: uid ?? `anon_job_${jobId}`,
    event: "fix_request_received",
    properties: { job_id: jobId, authenticated: !!uid, is_beta: false },
  });

  // Every non-success exit goes through here. The reason string is the whole
  // point — one collapsed `fix_failed` tells us it broke, not which branch.
  const reject = async (
    reason: string,
    status: number,
    body: Record<string, unknown>,
    extra: Record<string, unknown> = {}
  ) => {
    await captureServer({
      distinctId: uid ?? `anon_job_${jobId}`,
      event: "fix_rejected",
      properties: { job_id: jobId, reason, http_status: status, ...extra },
    });
    return NextResponse.json(body, { status });
  };

  if (!uid) {
    return reject("unauthorized", 401, {
      error: "Sign in to fix continuity errors.",
      code: "unauthenticated",
    });
  }

  try {
    const userRef = adminDb.collection("users").doc(uid);
    const userSnap = await userRef.get();
    const monthStart = startOfMonth(new Date());

    // Authoritative entitlement, and the place partial user documents get
    // repaired. Email verification is read from Firebase Auth, not the mirror
    // in Firestore, so a verification that happened after signup counts.
    const userRecord = await adminAuth.getUser(uid).catch(() => null);
    const ent = await ensureEntitlement(uid, {
      email: userRecord?.email ?? null,
      emailVerified: userRecord?.emailVerified ?? false,
    });

    const plan = ent.plan;
    const creditsUsedThisMonth = ent.creditsUsedThisMonth;
    const monthResetAt = ent.monthResetAt;
    const creditsBalance = ent.creditsBalance;

    // No credits until the address is both verified and actually reachable.
    // Google OAuth is the only signup path, so emailVerified is true for every
    // account — including one on a domain that no longer resolves, whose mail
    // had been hard-bouncing since signup. Deliverability is the real gate.
    // Checked before anything is computed or spent, so neither an unverified
    // nor an unreachable account can consume the prepaid pool.
    if (!ent.emailVerified || !ent.emailDeliverable) {
      const undeliverable = ent.emailVerified && !ent.emailDeliverable;
      return reject(
        undeliverable ? "email_undeliverable" : "email_not_verified",
        403,
        {
          error: undeliverable
            ? "We can't send mail to your address — its domain doesn't resolve. Sign in with a working email address to start fixing."
            : "Verify your email address to start fixing. Check your inbox for the verification link.",
          code: undeliverable ? "email_undeliverable" : "email_not_verified",
        },
        { plan, email_verified: ent.emailVerified, email_deliverable: ent.emailDeliverable }
      );
    }

    // Job state check
    const jobSnap = await adminDb.collection("jobs").doc(jobId).get();
    if (!jobSnap.exists) {
      return reject("job_not_found", 404, { error: "Job not found" });
    }
    const jobData = jobSnap.data()!;
    const status = jobData.status;
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
      return reject(
        "not_fixable_state",
        409,
        { error: "Job is not in a fixable state" },
        { status: status ?? null, fixing_started_at: jobData.fixingStartedAt ?? null }
      );
    }

    // One concurrent fix per free account. A fix holds a Modal container and
    // burns Runway credits for minutes; without this a single free account can
    // open N tabs and start N generations against the prepaid pool at once.
    if (plan === "free") {
      const activeSnap = await adminDb
        .collection("jobs")
        .where("ownerUid", "==", uid)
        .where("status", "==", "fixing")
        .get();
      const otherActive = activeSnap.docs.filter((d) => {
        if (d.id === jobId) return false;
        // A job stuck in "fixing" past the timeout is not really running and
        // must not block the account forever.
        const startedAt = d.data().fixingStartedAt;
        return (
          typeof startedAt !== "number" || Date.now() - startedAt <= FIXING_TIMEOUT_MS
        );
      });
      if (otherActive.length > 0) {
        return reject(
          "concurrent_fix_limit",
          409,
          {
            error: "You already have a fix running. Wait for it to finish, then try again.",
            code: "concurrent_fix_limit",
          },
          { plan, active_job_id: otherActive[0].id }
        );
      }
    }

    // Calculate credits needed (seconds of Runway output)
    const { total: creditsNeeded, perError, confirmedCount } = await calcCreditsNeeded(jobId);
    if (creditsNeeded === 0) {
      return reject(
        "no_unfixed_errors",
        409,
        { error: "No unfixed errors to process" },
        { confirmed_count: confirmedCount }
      );
    }

    // Hard monthly ceiling, checked before the grant/balance maths. Purchased
    // credits raise how much a user CAN spend; this caps how much they may
    // spend in one month regardless, so no single account can drain the pool.
    if (creditsNeeded > ent.ceilingLeft) {
      return reject(
        "monthly_ceiling_reached",
        402,
        {
          error: `This would exceed the ${MONTHLY_SPEND_CEILING[plan]}s monthly limit on your account. It resets on the 1st.`,
          code: "monthly_ceiling_reached",
        },
        {
          plan,
          credits_needed: creditsNeeded,
          ceiling_left: ent.ceilingLeft,
          ceiling: MONTHLY_SPEND_CEILING[plan],
        }
      );
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
      await captureServer({
        distinctId: uid,
        event: "fix_quota_exceeded",
        properties: {
          job_id: jobId,
          plan,
          credits_needed: creditsNeeded,
          monthly_left: monthlyLeft,
          balance: creditsBalance,
          // plan is absent on the user doc whenever the entitlement write never
          // ran; distinguishes a genuine free user from a broken paid one.
          plan_field_present: userSnap.exists && userSnap.data()!.plan !== undefined,
        },
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

    await captureServer({
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
        // Deliberately NOT fix_failed: fix_started already fired for this
        // request, and the one-terminal-event-per-request invariant must hold.
        // This is a later lifecycle stage — the handoff to Modal — so it gets
        // its own event rather than a second terminal one.
        await captureServer({
          distinctId: uid,
          event: "fix_trigger_failed",
          properties: { job_id: jobId, error_message: msg },
        });
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
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`POST /api/jobs/${jobId}/fix error:`, err);
    await captureServer({
      distinctId: uid,
      event: "fix_failed",
      properties: {
        job_id: jobId,
        error_message: msg,
        error_name: err instanceof Error ? err.name : typeof err,
      },
    });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

async function handleBetaFix(req: NextRequest, jobId: string, betaToken: string) {
  const distinctId = `beta_${betaToken.slice(0, 8)}`;

  await captureServer({
    distinctId,
    event: "fix_request_received",
    properties: { job_id: jobId, authenticated: false, is_beta: true },
  });

  const rejectBeta = async (
    reason: string,
    status: number,
    body: Record<string, unknown>,
    extra: Record<string, unknown> = {}
  ) => {
    await captureServer({
      distinctId,
      event: "fix_rejected",
      properties: { job_id: jobId, reason, http_status: status, is_beta: true, ...extra },
    });
    return NextResponse.json(body, { status });
  };

  try {
    const jobSnap = await adminDb.collection("jobs").doc(jobId).get();
    if (!jobSnap.exists) return rejectBeta("job_not_found", 404, { error: "Job not found" });

    const jobData = jobSnap.data()!;
    if (jobData.betaToken !== betaToken) {
      return rejectBeta("unauthorized", 403, { error: "Unauthorized" });
    }

    const status = jobData.status;
    if (status !== "awaiting_confirmation" && status !== "error" && status !== "done") {
      return rejectBeta(
        "not_fixable_state",
        409,
        { error: "Job is not in a fixable state" },
        { status: status ?? null }
      );
    }

    const useSnap = await adminDb.collection("betaUses").doc(betaToken).get();
    if (!useSnap.exists) {
      return rejectBeta("invalid_beta_token", 403, {
        error: "Beta token not registered",
        code: "invalid_beta",
      });
    }

    if (useSnap.data()?.fixedAt) {
      return rejectBeta("beta_already_used", 402, {
        error: "Your beta test has already been used.",
        code: "beta_used",
      });
    }

    await adminDb.collection("betaUses").doc(betaToken).update({ fixedAt: Date.now() });

    await adminDb.collection("jobs").doc(jobId).update({
      status: "fixing",
      fixingStartedAt: Date.now(),
      outputQuality: "720p",
      watermark: false,
    });

    await captureServer({
      distinctId,
      event: "fix_started",
      properties: { job_id: jobId, plan: "beta" },
    });

    after(async () => {
      try {
        await triggerFixPhase(jobId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`Modal beta fix trigger failed for job ${jobId}: ${msg}`);
        await captureServer({
          distinctId,
          event: "fix_trigger_failed",
          properties: { job_id: jobId, error_message: msg, is_beta: true },
        });
        const snap = await adminDb.collection("jobs").doc(jobId).get();
        if (snap.exists && snap.data()?.status !== "done") {
          await adminDb.collection("jobs").doc(jobId).update({ status: "error", errorMessage: msg });
        }
      }
    });

    return NextResponse.json({ ok: true, beta: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Beta fix error for job ${jobId}:`, err);
    await captureServer({
      distinctId,
      event: "fix_failed",
      properties: { job_id: jobId, error_message: msg, is_beta: true },
    });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
