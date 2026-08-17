import { NextRequest, NextResponse } from "next/server";
import { adminDb, adminAuth } from "@/lib/firebase-admin";
import { FieldValue } from "firebase-admin/firestore";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: jobId } = await params;

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
  } else if (!betaToken) {
    return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  }

  try {
    const body = await req.json();
    const {
      shotId,
      frameUrl,
      framePct,
      bbox,
      bboxes,
      description,
      fixMode,
      replaceWith,
      existingErrorId,
    }: {
      shotId: string;
      frameUrl: string;
      framePct: number;
      bbox: { x: number; y: number; w: number; h: number };
      bboxes?: { x: number; y: number; w: number; h: number }[];
      description: string;
      fixMode?: "remove" | "replace";
      replaceWith?: string;
      // When provided, ADJUST an existing auto-detected error in place
      // (overwrite its bbox with the user's manual pick) instead of
      // creating a brand-new error doc.
      existingErrorId?: string;
    } = body;

    if (!shotId || !frameUrl || !bbox || !description) {
      return NextResponse.json(
        { error: "shotId, frameUrl, bbox, and description are required" },
        { status: 400 }
      );
    }
    const normalizedBboxes = Array.isArray(bboxes) && bboxes.length > 0 ? bboxes : [bbox];
    if (!existingErrorId && !fixMode) {
      return NextResponse.json(
        { error: "fixMode is required when creating a new error" },
        { status: 400 }
      );
    }
    if (
      typeof bbox.x !== "number" ||
      typeof bbox.y !== "number" ||
      typeof bbox.w !== "number" ||
      typeof bbox.h !== "number" ||
      bbox.w <= 0 ||
      bbox.h <= 0
    ) {
      return NextResponse.json({ error: "invalid bbox" }, { status: 400 });
    }

    const jobRef = adminDb.collection("jobs").doc(jobId);
    const jobSnap = await jobRef.get();
    if (!jobSnap.exists) return NextResponse.json({ error: "job not found" }, { status: 404 });

    const jobData = jobSnap.data()!;
    const isOwner = uid && jobData.ownerUid === uid;
    const isBetaOwner = betaToken && jobData.betaToken === betaToken;
    const isPublicJob = jobData.ownerUid == null || jobData.isPublic === true;
    if (!isOwner && !isBetaOwner && !isPublicJob) {
      return NextResponse.json({ error: "job not found" }, { status: 404 });
    }

    // ADJUST EXISTING — update the bbox/frame on a detected error in place.
    // Keeps the original description and detected fields, just overlays the
    // user's manual pick. fixStatus reset to "pending" so the next Fix run
    // processes it.
    if (existingErrorId) {
      const errRef = jobRef.collection("errors").doc(existingErrorId);
      const errSnap = await errRef.get();
      if (!errSnap.exists) {
        return NextResponse.json({ error: "error not found" }, { status: 404 });
      }
      await errRef.update({
        // Manual path always uses bboxB + shotBId so fix.py routes via "aTob".
        shotBId: shotId,
        bboxB: normalizedBboxes[0],
        bboxes: normalizedBboxes,
        bboxA: FieldValue.delete(),
        fixDirection: "aTob",
        manualMarker: true,
        manualFrameUrl: frameUrl,
        manualFramePct: typeof framePct === "number" ? framePct : 0.5,
        fixStatus: "pending",
      });
      return NextResponse.json({ ok: true, errorId: existingErrorId, updated: true });
    }

    // CREATE NEW — fresh user-marked error from the standalone marker UI.
    const errDoc = await jobRef.collection("errors").add({
      shotAId: shotId,
      shotBId: shotId,
      type: "other",
      description,
      fixSuggestion:
        fixMode === "replace" && replaceWith
          ? `Replace the ${description} with ${replaceWith}`
          : `Remove the ${description}`,
      severity: "high",
      bboxB: normalizedBboxes[0],
      bboxes: normalizedBboxes,
      userConfirmed: true,
      fixMode,
      replaceWith: replaceWith ?? "",
      fixStatus: "pending",
      manualMarker: true,
      manualFrameUrl: frameUrl,
      manualFramePct: typeof framePct === "number" ? framePct : 0.5,
      verifiedResolved: false,
      createdAt: FieldValue.serverTimestamp(),
    });

    return NextResponse.json({ ok: true, errorId: errDoc.id });
  } catch (err) {
    console.error(`POST /api/jobs/${jobId}/manual-error error:`, err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
