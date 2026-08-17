import { after } from "next/server";
import { NextRequest, NextResponse } from "next/server";
import { adminDb, adminAuth } from "@/lib/firebase-admin";
import { triggerFixPhase } from "@/lib/modal";

async function getUid(req: NextRequest): Promise<string | null> {
  const auth = req.headers.get("Authorization");
  if (!auth?.startsWith("Bearer ")) return null;
  try {
    const decoded = await adminAuth.verifyIdToken(auth.slice(7));
    return decoded.uid;
  } catch {
    return null;
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; errorId: string }> }
) {
  const { id: jobId, errorId } = await params;
  const betaToken = req.headers.get("X-Beta-Token");
  const uid = await getUid(req);

  // Verify ownership
  const jobSnap = await adminDb.collection("jobs").doc(jobId).get();
  if (!jobSnap.exists) return NextResponse.json({ error: "Job not found" }, { status: 404 });
  const jobData = jobSnap.data()!;
  const isOwner = uid && jobData.ownerUid === uid;
  const isBeta = betaToken && jobData.betaToken === betaToken;
  if (!isOwner && !isBeta) return NextResponse.json({ error: "Unauthorized" }, { status: 403 });

  // Validate error state
  const errorRef = adminDb.collection("jobs").doc(jobId).collection("errors").doc(errorId);
  const errorSnap = await errorRef.get();
  if (!errorSnap.exists) return NextResponse.json({ error: "Error not found" }, { status: 404 });
  const errorData = errorSnap.data()!;

  if (errorData.fixStatus !== "fixed") {
    return NextResponse.json({ error: "Only completed fixes can be retried" }, { status: 409 });
  }
  if (errorData.verifiedResolved === true) {
    return NextResponse.json({ error: "Fix was already verified as resolved" }, { status: 409 });
  }
  const retryCount = errorData.retryCount ?? 0;
  if (retryCount >= 1) {
    return NextResponse.json(
      { error: "Already retried once — no further free retries", code: "retry_exhausted" },
      { status: 402 }
    );
  }

  // Reset error for retry — no quota charge
  await errorRef.update({
    fixStatus: "pending",
    retryCount: retryCount + 1,
    verifyResult: null,
    verifiedResolved: false,
  });

  // Set job back to fixing so the fix phase can run
  await adminDb.collection("jobs").doc(jobId).update({ status: "fixing" });

  after(async () => {
    try {
      await triggerFixPhase(jobId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Retry fix trigger failed for job ${jobId}: ${msg}`);
      const snap = await adminDb.collection("jobs").doc(jobId).get();
      if (snap.exists && snap.data()?.status !== "done") {
        await adminDb.collection("jobs").doc(jobId).update({ status: "error", errorMessage: msg });
      }
    }
  });

  return NextResponse.json({ ok: true, retryCount: retryCount + 1 });
}
