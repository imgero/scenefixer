import { after } from "next/server";
import { NextRequest, NextResponse } from "next/server";
import { adminDb, adminAuth } from "@/lib/firebase-admin";
import { triggerProcessJob } from "@/lib/modal";
import { getPostHogClient } from "@/lib/posthog-server";
import type { Plan } from "@/lib/types";

const FREE_SCANS_PER_DAY = 3;

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
    const jobSnap = await adminDb.collection("jobs").doc(jobId).get();
    if (!jobSnap.exists) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const jobData = jobSnap.data()!;
    const isOwner = uid && jobData.ownerUid === uid;
    const isBetaOwner = betaToken && jobData.betaToken === betaToken;
    if (!isOwner && !isBetaOwner) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const { inputVideoUrl } = await req.json();

    if (!inputVideoUrl) {
      return NextResponse.json({ error: "inputVideoUrl required" }, { status: 400 });
    }

    // Rate-limit free-tier authenticated users to 3 scans/day
    if (uid) {
      const userSnap = await adminDb.collection("users").doc(uid).get();
      const userData = userSnap.exists ? userSnap.data()! : {};
      const plan = (userData.plan as Plan) ?? "free";
      if (plan === "free") {
        const today = new Date().toISOString().slice(0, 10);
        const scanDate = userData.scanDate ?? "";
        const scansToday = scanDate === today ? (userData.scansToday ?? 0) : 0;
        if (scansToday >= FREE_SCANS_PER_DAY) {
          return NextResponse.json(
            { error: "Free plan allows 3 scans per day. Try again tomorrow or upgrade.", code: "scan_limit" },
            { status: 429 }
          );
        }
        await adminDb.collection("users").doc(uid).set(
          { scanDate: today, scansToday: scansToday + 1 },
          { merge: true }
        );
      }
    }

    await adminDb.collection("jobs").doc(jobId).update({
      inputVideoUrl,
      status: "decomposing",
    });

    getPostHogClient().capture({
      distinctId: uid ?? `beta_${betaToken?.slice(0, 8)}`,
      event: "job_analysis_started",
      properties: { job_id: jobId, is_beta: !uid },
    });

    // Use after() so Vercel keeps the background fetch alive after the
    // response is sent — plain fire-and-forget gets killed on Vercel.
    after(async () => {
      try {
        await triggerProcessJob(jobId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`Modal trigger failed for job ${jobId}: ${msg}`);
        const snap = await adminDb.collection("jobs").doc(jobId).get();
        const current = snap.exists ? snap.data()?.status : undefined;
        const completed = new Set([
          "awaiting_confirmation",
          "fixing",
          "verifying",
          "done",
        ]);
        if (!completed.has(current)) {
          await adminDb.collection("jobs").doc(jobId).update({
            status: "error",
            errorMessage: msg,
          });
        }
      }
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error(`POST /api/jobs/${jobId}/start error:`, err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
