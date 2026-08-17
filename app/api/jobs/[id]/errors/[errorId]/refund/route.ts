import { NextRequest, NextResponse } from "next/server";
import { adminDb, adminAuth } from "@/lib/firebase-admin";
import { FieldValue } from "firebase-admin/firestore";

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

  // Validate error state — must have been retried at least once and still failed
  const errorRef = adminDb.collection("jobs").doc(jobId).collection("errors").doc(errorId);
  const errorSnap = await errorRef.get();
  if (!errorSnap.exists) return NextResponse.json({ error: "Error not found" }, { status: 404 });
  const errorData = errorSnap.data()!;

  if (errorData.fixStatus !== "fixed") {
    return NextResponse.json({ error: "Only completed fixes can be refunded" }, { status: 409 });
  }
  if (errorData.verifiedResolved === true) {
    return NextResponse.json({ error: "Fix was verified as resolved — no refund needed" }, { status: 409 });
  }
  if ((errorData.retryCount ?? 0) < 1) {
    return NextResponse.json({ error: "Use the free retry first" }, { status: 409 });
  }
  if (errorData.refunded) {
    return NextResponse.json({ error: "Already refunded" }, { status: 409 });
  }

  // Mark error as refunded
  await errorRef.update({ refunded: true });

  // Return the actual seconds that were deducted for this error
  if (uid) {
    const refundCredits = errorData.creditsDeducted ?? 5;
    await adminDb.collection("users").doc(uid).set(
      { creditsBalance: FieldValue.increment(refundCredits) },
      { merge: true }
    );
  }

  return NextResponse.json({ ok: true });
}
