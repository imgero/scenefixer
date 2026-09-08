import { after } from "next/server";
import { NextRequest, NextResponse } from "next/server";
import { adminDb, adminStorage, adminAuth } from "@/lib/firebase-admin";
import { createId } from "@paralleldrive/cuid2";
import { FieldValue } from "firebase-admin/firestore";
import { captureServer } from "@/lib/posthog-server";
import { notifyOwner } from "@/lib/notify";

const BETA_MAX_CREDITS = 200;

async function checkBetaToken(token: string): Promise<{ ok: boolean; reason?: string }> {
  if (!token || token.length < 10) return { ok: false, reason: "invalid_token" };
  const useRef = adminDb.collection("betaUses").doc(token);
  const poolRef = adminDb.collection("config").doc("beta");

  return adminDb.runTransaction(async (tx) => {
    const [useSnap, poolSnap] = await Promise.all([tx.get(useRef), tx.get(poolRef)]);
    if (useSnap.exists) return { ok: false, reason: "already_used" };
    const used = poolSnap.exists ? (poolSnap.data()?.usedCount ?? 0) : 0;
    if (used >= BETA_MAX_CREDITS) return { ok: false, reason: "pool_exhausted" };
    tx.set(useRef, { claimedAt: Date.now() });
    tx.set(poolRef, { usedCount: used + 1, maxCredits: BETA_MAX_CREDITS }, { merge: true });
    return { ok: true };
  });
}

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("Authorization");
  const betaToken = req.headers.get("X-Beta-Token");

  let uid: string | null = null;
  let isBeta = false;

  if (authHeader?.startsWith("Bearer ")) {
    try {
      const decoded = await adminAuth.verifyIdToken(authHeader.slice(7));
      uid = decoded.uid;
    } catch {
      return NextResponse.json({ error: "Invalid token" }, { status: 401 });
    }
  } else if (betaToken) {
    const betaCheck = await checkBetaToken(betaToken);
    if (!betaCheck.ok) {
      const msg = betaCheck.reason === "pool_exhausted"
        ? "The beta pool is full. Check back soon!"
        : betaCheck.reason === "already_used"
          ? "This beta slot has already been used."
          : "Invalid beta token.";
      return NextResponse.json({ error: msg, code: betaCheck.reason }, { status: 403 });
    }
    isBeta = true;
  } else {
    return NextResponse.json({ error: "Sign in to analyse a video.", code: "unauthenticated" }, { status: 401 });
  }

  try {
    const { filename, contentType, userHint } = await req.json();

    if (!filename || !contentType) {
      return NextResponse.json(
        { error: "filename and contentType required" },
        { status: 400 }
      );
    }

    const jobId = createId();
    const storagePath = `jobs/${jobId}/input/${filename}`;
    const bucket = adminStorage.bucket();
    const file = bucket.file(storagePath);

    const [uploadUrl] = await file.getSignedUrl({
      version: "v4",
      action: "write",
      expires: Date.now() + 60 * 60 * 1000,
      contentType,
    });

    const cleanedHint =
      typeof userHint === "string" ? userHint.trim().slice(0, 500) : "";

    await adminDb
      .collection("jobs")
      .doc(jobId)
      .set({
        ...(uid ? { ownerUid: uid } : { ownerUid: null }),
        ...(isBeta ? { betaToken: betaToken } : {}),
        isPublic: true,
        status: "uploading",
        inputVideoUrl: "",
        shotCount: 0,
        errorCount: 0,
        fixedCount: 0,
        ...(cleanedHint ? { userHint: cleanedHint } : {}),
        createdAt: FieldValue.serverTimestamp(),
      });

    // Taken here, not inside after(). after() runs once the response has been
    // sent and, on a frozen serverless instance, can run appreciably later —
    // long enough that job_created appeared minutes after the job document's
    // own createdAt, and that two unrelated creations looked like one
    // double-submit ~3s apart. The event now carries the creation time.
    const createdAt = new Date();

    after(async () => {
      const distinctId = uid ?? `beta_${betaToken?.slice(0, 8)}`;
      await captureServer({
        distinctId,
        event: "job_created",
        timestamp: createdAt,
        properties: {
          job_id: jobId,
          has_hint: !!cleanedHint,
          content_type: contentType,
          is_beta: isBeta,
        },
      });

      const who = isBeta ? `Beta user (token: ${betaToken?.slice(0, 8)}…)` : `Signed-in user (uid: ${uid})`;
      notifyOwner(
        `[Scene Fixer] New job — ${isBeta ? "Beta" : "User"}`,
        `${who} created job ${jobId}.\n\nFile: ${filename}\nHint: ${cleanedHint || "(none)"}\nTime: ${new Date().toUTCString()}`
      );
    });

    return NextResponse.json({ jobId, uploadUrl, storagePath });
  } catch (err) {
    console.error("POST /api/jobs error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
