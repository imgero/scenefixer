import { after } from "next/server";
import { NextRequest, NextResponse } from "next/server";
import { adminDb, adminStorage, adminAuth } from "@/lib/firebase-admin";
import { createId } from "@paralleldrive/cuid2";
import { FieldValue } from "firebase-admin/firestore";
import { captureServer } from "@/lib/posthog-server";
import { notifyOwner } from "@/lib/notify";
import { UPLOAD_URL_TTL_MS } from "@/lib/uploads";
import { ensureEntitlement } from "@/lib/entitlements";
import { dailyScanStatus, scanLimitMessage } from "@/lib/scanLimit";

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("Authorization");

  // The no-sign-in beta path is gone (30 Oct): it could scan but never fix,
  // and left no way to follow up. Google sign-in is one tap.
  if (!authHeader?.startsWith("Bearer ")) {
    return NextResponse.json({ error: "Sign in to analyse a video.", code: "unauthenticated" }, { status: 401 });
  }
  let uid: string;
  try {
    uid = (await adminAuth.verifyIdToken(authHeader.slice(7))).uid;
  } catch {
    return NextResponse.json({ error: "Invalid token" }, { status: 401 });
  }

  try {
    // Refuse an account over its daily scan limit now, before it uploads the
    // file. /start counts the scan; this only reads, so a job that is created
    // and never started costs nothing.
    const userRecord = await adminAuth.getUser(uid).catch(() => null);
    const ent = await ensureEntitlement(uid, {
      email: userRecord?.email ?? null,
      emailVerified: userRecord?.emailVerified ?? false,
    });
    const { limit, reached } = await dailyScanStatus(uid, ent);
    if (reached) {
      return NextResponse.json(
        { error: scanLimitMessage(limit), code: "scan_limit" },
        { status: 429 }
      );
    }

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
      expires: Date.now() + UPLOAD_URL_TTL_MS,
      contentType,
    });

    const cleanedHint =
      typeof userHint === "string" ? userHint.trim().slice(0, 500) : "";

    await adminDb
      .collection("jobs")
      .doc(jobId)
      .set({
        ownerUid: uid,
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
      await captureServer({
        distinctId: uid,
        event: "job_created",
        timestamp: createdAt,
        properties: {
          job_id: jobId,
          has_hint: !!cleanedHint,
          content_type: contentType,
          is_beta: false,
        },
      });

      const who = `Signed-in user (uid: ${uid})`;
      notifyOwner(
        "[Scene Fixer] New job — User",
        `${who} created job ${jobId}.\n\nFile: ${filename}\nHint: ${cleanedHint || "(none)"}\nTime: ${new Date().toUTCString()}`
      );
    });

    return NextResponse.json({ jobId, uploadUrl, storagePath });
  } catch (err) {
    console.error("POST /api/jobs error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
