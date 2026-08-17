import { NextRequest, NextResponse } from "next/server";
import { adminDb, adminAuth } from "@/lib/firebase-admin";

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; errorId: string }> }
) {
  const { id: jobId, errorId } = await params;

  const authHeader = req.headers.get("Authorization");
  const betaToken = req.headers.get("X-Beta-Token");

  let uid: string | null = null;
  if (authHeader?.startsWith("Bearer ")) {
    try {
      const decoded = await adminAuth.verifyIdToken(authHeader.slice(7));
      uid = decoded.uid;
    } catch {
      return NextResponse.json({ error: "Invalid token" }, { status: 401 });
    }
  }

  const jobSnap = await adminDb.collection("jobs").doc(jobId).get();
  if (!jobSnap.exists) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }
  const jobData = jobSnap.data()!;

  const isOwner = uid && jobData.ownerUid === uid;
  const isBeta = betaToken && jobData.betaToken === betaToken;
  if (!isOwner && !isBeta) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  }

  const errorRef = adminDb.collection("jobs").doc(jobId).collection("errors").doc(errorId);
  const errorSnap = await errorRef.get();
  if (!errorSnap.exists) {
    return NextResponse.json({ error: "Error not found" }, { status: 404 });
  }
  if (errorSnap.data()?.fixStatus === "fixing") {
    return NextResponse.json({ error: "Cannot delete an error while it is being fixed" }, { status: 409 });
  }

  await errorRef.delete();
  return NextResponse.json({ ok: true });
}
