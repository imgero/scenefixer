import { after } from "next/server";
import { NextRequest, NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb, adminAuth } from "@/lib/firebase-admin";
import { triggerDeepScan } from "@/lib/modal";
import { ensureEntitlement } from "@/lib/entitlements";
import { captureServer } from "@/lib/posthog-server";
import { DEEP_SCAN_CREDITS_PER_SHOT } from "@/lib/types";

/**
 * Re-scan a finished quick scan with Opus, for credits the owner chose to spend.
 *
 * Until 28 Oct anyone holding credits got Opus on every upload, free: a $10
 * buyer's 11-shot scan cost us $3.92 and left his 15 credits untouched, and an
 * unused pack stayed refundable after any number of such scans. Now every
 * upload is the Haiku quick scan, and this is the only way to Opus.
 *
 * Priced per analysed shot because shots are what drive the Claude calls, and
 * the quick scan has already counted them, so the price is known and shown
 * before anyone pays. Only detection re-runs: the shots and keyframes are kept.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: jobId } = await params;

  const authHeader = req.headers.get("Authorization");
  let uid: string | null = null;
  if (authHeader?.startsWith("Bearer ")) {
    try {
      uid = (await adminAuth.verifyIdToken(authHeader.slice(7))).uid;
    } catch {
      uid = null;
    }
  }
  if (!uid) {
    return NextResponse.json({ error: "Sign in to run a deep scan." }, { status: 401 });
  }

  const reject = async (
    reason: string,
    status: number,
    body: Record<string, unknown>,
    extra: Record<string, unknown> = {}
  ) => {
    await captureServer({
      distinctId: uid,
      event: "deep_scan_rejected",
      properties: { job_id: jobId, reason, http_status: status, ...extra },
    });
    return NextResponse.json(body, { status });
  };

  try {
    // Repairs a partial user document before the balance is read from it.
    const userRecord = await adminAuth.getUser(uid).catch(() => null);
    await ensureEntitlement(uid, {
      email: userRecord?.email ?? null,
      emailVerified: userRecord?.emailVerified ?? false,
    });

    const jobRef = adminDb.collection("jobs").doc(jobId);
    const userRef = adminDb.collection("users").doc(uid);
    const shotsSnap = await jobRef.collection("shots").get();
    // The same shots run_detect analyses: blank ones are skipped there.
    const shotCount = shotsSnap.docs.filter((d) => !d.data().isBlank).length;
    const cost = shotCount * DEEP_SCAN_CREDITS_PER_SHOT;

    // Balance check, deduction and the job's state change happen together, so
    // two clicks cannot both pass the check and spend the same credits.
    const outcome = await adminDb.runTransaction(async (tx) => {
      const [jobSnap, userSnap] = await Promise.all([tx.get(jobRef), tx.get(userRef)]);
      if (!jobSnap.exists || jobSnap.data()!.ownerUid !== uid) {
        return { ok: false as const, reason: "job_not_found", status: 404, error: "Job not found" };
      }
      const job = jobSnap.data()!;
      if (job.status !== "awaiting_confirmation" || job.scanTier !== "free" || job.deepScanCredits) {
        return {
          ok: false as const,
          reason: "not_deep_scannable",
          status: 409,
          error: "This video can't be deep scanned right now.",
        };
      }
      if (cost === 0) {
        return { ok: false as const, reason: "no_shots", status: 409, error: "There are no shots to scan." };
      }
      const balance = userSnap.data()?.creditsBalance ?? 0;
      if (balance < cost) {
        return {
          ok: false as const,
          reason: "insufficient_credits",
          status: 402,
          error: `A deep scan of this video costs ${cost} credits and you have ${balance}.`,
          balance,
        };
      }
      tx.update(userRef, { creditsBalance: balance - cost });
      tx.update(jobRef, {
        status: "detecting",
        deepScanCredits: cost,
        deepScanRefunded: false,
      });
      return { ok: true as const, balance };
    });

    if (!outcome.ok) {
      return reject(
        outcome.reason,
        outcome.status,
        { error: outcome.error, code: outcome.reason, creditsNeeded: cost },
        { credits_needed: cost, balance: "balance" in outcome ? outcome.balance : null }
      );
    }

    await captureServer({
      distinctId: uid,
      event: "deep_scan_started",
      properties: { job_id: jobId, shot_count: shotCount, credits: cost, balance_before: outcome.balance },
    });

    after(async () => {
      try {
        await triggerDeepScan(jobId);
      } catch (err) {
        // Modal never received it, so the quick-scan results are untouched:
        // put the job back as it was and return the credits.
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`Modal deep scan trigger failed for job ${jobId}: ${msg}`);
        await adminDb.runTransaction(async (tx) => {
          const jobSnap = await tx.get(jobRef);
          if (jobSnap.data()?.deepScanRefunded !== false) return;
          tx.update(userRef, { creditsBalance: FieldValue.increment(cost) });
          tx.update(jobRef, {
            status: "awaiting_confirmation",
            deepScanCredits: FieldValue.delete(),
            deepScanRefunded: true,
          });
        });
        await captureServer({
          distinctId: uid,
          event: "deep_scan_trigger_failed",
          properties: { job_id: jobId, credits_refunded: cost, error_message: msg },
        });
      }
    });

    return NextResponse.json({ ok: true, creditsUsed: cost, creditsRemaining: outcome.balance - cost });
  } catch (err) {
    console.error(`POST /api/jobs/${jobId}/deep-scan error:`, err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
