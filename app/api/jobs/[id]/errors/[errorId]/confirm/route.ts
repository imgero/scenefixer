import { NextRequest, NextResponse } from "next/server";
import { adminDb, adminAuth } from "@/lib/firebase-admin";
import { captureServer } from "@/lib/posthog-server";

/**
 * Server-side confirmation receipt.
 *
 * The client writes `userConfirmed` straight to Firestore and then captures
 * `error_confirmed` from the browser. That event proves the button was clicked,
 * not that the write landed — so a confirm that silently failed rules or lost
 * the connection looked identical to one that succeeded, and the fix route's
 * "no unfixed errors" branch could then fire with nothing to explain it.
 *
 * This route re-reads the document server-side and reports what is actually
 * persisted. The client calls it after its write resolves; it never blocks the
 * UI and it never writes anything itself.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; errorId: string }> }
) {
  const { id: jobId, errorId } = await params;

  let uid: string | null = null;
  const auth = req.headers.get("Authorization");
  if (auth?.startsWith("Bearer ")) {
    try {
      uid = (await adminAuth.verifyIdToken(auth.slice(7))).uid;
    } catch {
      uid = null;
    }
  }
  const betaToken = req.headers.get("X-Beta-Token");
  const distinctId = uid ?? (betaToken ? `beta_${betaToken.slice(0, 8)}` : `anon_job_${jobId}`);

  try {
    const snap = await adminDb
      .collection("jobs").doc(jobId)
      .collection("errors").doc(errorId)
      .get();

    if (!snap.exists) {
      await captureServer({
        distinctId,
        event: "error_confirm_failed",
        properties: { job_id: jobId, error_id: errorId, reason: "error_doc_not_found" },
      });
      return NextResponse.json({ error: "Error not found" }, { status: 404 });
    }

    const e = snap.data()!;

    // Count what the fix route will actually see, using the same predicate.
    const confirmedSnap = await adminDb
      .collection("jobs").doc(jobId)
      .collection("errors")
      .where("userConfirmed", "==", true)
      .get();
    const fixableCount = confirmedSnap.docs.filter(
      (d) => d.data().fixStatus !== "fixed"
    ).length;

    await captureServer({
      distinctId,
      event: "error_confirmed",
      properties: {
        job_id: jobId,
        error_id: errorId,
        error_type: e.type,
        severity: e.severity,
        fix_mode: e.fixMode ?? null,
        fix_direction: e.fixDirection ?? null,
        // The whole point: what Firestore actually holds, not what was clicked.
        persisted_user_confirmed: e.userConfirmed === true,
        fix_status: e.fixStatus ?? null,
        // What the fix route would compute right now.
        job_fixable_confirmed_count: fixableCount,
      },
    });

    return NextResponse.json({ ok: true, persisted: e.userConfirmed === true, fixableCount });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`POST /api/jobs/${jobId}/errors/${errorId}/confirm error:`, err);
    await captureServer({
      distinctId,
      event: "error_confirm_failed",
      properties: { job_id: jobId, error_id: errorId, reason: "exception", error_message: msg },
    });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
