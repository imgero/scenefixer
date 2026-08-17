import { after } from "next/server";
import { NextRequest, NextResponse } from "next/server";
import { adminDb, adminAuth } from "@/lib/firebase-admin";
import { triggerReprocessJob } from "@/lib/modal";
import { PLAN_LIMITS, type Plan } from "@/lib/types";

async function getUidFromRequest(req: NextRequest): Promise<string | null> {
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
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: jobId } = await params;

  const uid = await getUidFromRequest(req);
  if (!uid) {
    return NextResponse.json({ error: "Sign in to re-process.", code: "unauthenticated" }, { status: 401 });
  }

  try {
    const [jobSnap, userSnap] = await Promise.all([
      adminDb.collection("jobs").doc(jobId).get(),
      adminDb.collection("users").doc(uid).get(),
    ]);

    if (!jobSnap.exists) return NextResponse.json({ error: "Job not found" }, { status: 404 });

    const jobData = jobSnap.data()!;
    if (jobData.ownerUid !== uid) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
    }
    if (jobData.status !== "done") {
      return NextResponse.json({ error: "Job is not in a done state" }, { status: 409 });
    }
    if (!jobData.stitchVideoUrl && !jobData.outputVideoUrl) {
      return NextResponse.json({ error: "No source video to re-process" }, { status: 409 });
    }

    const userData = userSnap.exists ? userSnap.data()! : {};
    const plan = (userData.plan as Plan) ?? "free";

    await adminDb.collection("jobs").doc(jobId).update({
      status: "reprocessing",
      outputQuality: PLAN_LIMITS[plan].qualityLabel,
      watermark: plan === "free",
    });

    after(async () => {
      try {
        await triggerReprocessJob(jobId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`Modal reprocess trigger failed for job ${jobId}: ${msg}`);
        await adminDb.collection("jobs").doc(jobId).update({
          status: "done",
          errorMessage: msg,
        });
      }
    });

    return NextResponse.json({ ok: true, outputQuality: PLAN_LIMITS[plan].qualityLabel });
  } catch (err) {
    console.error(`POST /api/jobs/${jobId}/reprocess error:`, err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
