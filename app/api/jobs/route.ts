import { after } from "next/server";
import { NextRequest, NextResponse } from "next/server";
import { adminDb, adminStorage, adminAuth } from "@/lib/firebase-admin";
import { createId } from "@paralleldrive/cuid2";
import { FieldValue } from "firebase-admin/firestore";
import { captureServer } from "@/lib/posthog-server";
import { notifyOwner } from "@/lib/notify";
import { UPLOAD_URL_TTL_MS, MAX_CLIPS, MAX_UPLOAD_BYTES, ACCEPTED_VIDEO_TYPES } from "@/lib/uploads";
import { ensureEntitlement } from "@/lib/entitlements";
import { dailyScanStatus, scanLimitMessage } from "@/lib/scanLimit";
import { EXTRA_SCAN_CREDITS } from "@/lib/pricing";

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
    const { filename, contentType, userHint, extraScan, clips } = await req.json();

    // Over the limit, a scan can still be paid for with a credit. Nothing is
    // charged here: /start charges it, so an upload that never finishes costs
    // nothing. Before this, the only answer was "come back tomorrow" — one
    // user on 5 Nov tried three times in a minute, then came back 7 hours
    // later.
    const { limit, reached } = await dailyScanStatus(uid, ent);
    const paidExtra = reached && extraScan === true && ent.creditsBalance >= EXTRA_SCAN_CREDITS;
    if (reached && !paidExtra) {
      return NextResponse.json(
        {
          error: scanLimitMessage(limit),
          code: "scan_limit",
          // So the upload box can offer the paid scan, or the credits for it.
          balance: ent.creditsBalance,
          extraScanCredits: EXTRA_SCAN_CREDITS,
        },
        { status: 429 }
      );
    }

    // Several clips dropped together: each gets its own signed URL, and Modal
    // joins them in this order into one video before analysis
    // (modal_app/combine.py). Without `clips` this route is what it was.
    type Clip = { filename: string; contentType: string; size: number };
    let clipList: Clip[] | null = null;
    if (clips !== undefined) {
      const ok =
        Array.isArray(clips) &&
        clips.length >= 2 &&
        clips.length <= MAX_CLIPS &&
        clips.every(
          (c: unknown): c is Clip =>
            !!c &&
            typeof (c as Clip).filename === "string" &&
            (c as Clip).filename.length > 0 &&
            ACCEPTED_VIDEO_TYPES.includes((c as Clip).contentType) &&
            typeof (c as Clip).size === "number" &&
            (c as Clip).size > 0
        );
      if (!ok) {
        return NextResponse.json(
          { error: `Drop between 2 and ${MAX_CLIPS} MP4 or MOV clips.`, code: "bad_clips" },
          { status: 400 }
        );
      }
      if (clips.reduce((n: number, c: Clip) => n + c.size, 0) > MAX_UPLOAD_BYTES) {
        return NextResponse.json(
          { error: "Clips must be under 200MB in total.", code: "too_large" },
          { status: 400 }
        );
      }
      clipList = clips as Clip[];
    } else if (!filename || !contentType) {
      return NextResponse.json(
        { error: "filename and contentType required" },
        { status: 400 }
      );
    }

    const jobId = createId();
    const bucket = adminStorage.bucket();
    const signUpload = async (path: string, type: string) => {
      const [url] = await bucket.file(path).getSignedUrl({
        version: "v4",
        action: "write",
        expires: Date.now() + UPLOAD_URL_TTL_MS,
        contentType: type,
      });
      return url;
    };

    let uploadUrl = "";
    let storagePath = "";
    let uploads: { uploadUrl: string; storagePath: string }[] | undefined;
    if (clipList) {
      uploads = await Promise.all(
        clipList.map(async (c, i) => {
          // The index keeps the order and two clips both named "output.mp4" apart.
          const path = `jobs/${jobId}/input/clips/${String(i).padStart(2, "0")}_${c.filename.replace(/\//g, "_")}`;
          return { uploadUrl: await signUpload(path, c.contentType), storagePath: path };
        })
      );
    } else {
      storagePath = `jobs/${jobId}/input/${filename}`;
      uploadUrl = await signUpload(storagePath, contentType);
    }

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
        ...(paidExtra ? { extraScanCredits: EXTRA_SCAN_CREDITS } : {}),
        ...(clipList
          ? { inputClipCount: clipList.length, inputClipNames: clipList.map((c) => c.filename) }
          : {}),
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
          content_type: clipList ? clipList[0].contentType : contentType,
          clip_count: clipList ? clipList.length : 1,
          is_beta: false,
          paid_extra_scan: paidExtra,
        },
      });

      const who = `Signed-in user (uid: ${uid})`;
      notifyOwner(
        "[Scene Fixer] New job — User",
        `${who} created job ${jobId}.\n\nFile: ${clipList ? `${clipList.length} clips: ${clipList.map((c) => c.filename).join(", ")}` : filename}\nHint: ${cleanedHint || "(none)"}\nTime: ${new Date().toUTCString()}`
      );
    });

    return NextResponse.json(uploads ? { jobId, uploads } : { jobId, uploadUrl, storagePath });
  } catch (err) {
    console.error("POST /api/jobs error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
