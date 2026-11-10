import { NextRequest, NextResponse } from "next/server";
import { adminAuth, adminDb } from "@/lib/firebase-admin";
import { loopsEvent } from "@/lib/loopsEvents";
import { notifyOwner } from "@/lib/notify";

/**
 * The 👍 / 👎 under a scan result. It used to go to PostHog only, so nobody
 * heard about a 👎 and nobody could answer it. Now it's stored on the job,
 * a 👎 emails the owner, and Loops gets `scan_feedback` for the follow-up
 * emails. Counted once per job: a second vote changes nothing.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: jobId } = await params;
  const header = req.headers.get("Authorization");
  if (!header?.startsWith("Bearer ")) return NextResponse.json({ error: "Sign in" }, { status: 401 });
  let uid: string;
  try {
    uid = (await adminAuth.verifyIdToken(header.slice(7))).uid;
  } catch {
    return NextResponse.json({ error: "Invalid token" }, { status: 401 });
  }

  const { vote } = await req.json().catch(() => ({}));
  if (vote !== "up" && vote !== "down") return NextResponse.json({ error: "vote must be up or down" }, { status: 400 });

  const ref = adminDb.collection("jobs").doc(jobId);
  const first = await adminDb.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists || snap.data()!.ownerUid !== uid) return null;
    if (snap.data()!.scanVote) return false;
    tx.update(ref, { scanVote: vote, scanVoteAt: Date.now() });
    return true;
  });
  if (first === null) return NextResponse.json({ error: "Not your scan" }, { status: 403 });
  if (!first) return NextResponse.json({ ok: true, already: true });

  const job = (await ref.get()).data()!;
  const url = `https://scenefixer.com/job/${jobId}`;
  await Promise.all([
    loopsEvent(uid, `scan_feedback_${vote}`, { vote, errorCount: job.errorCount ?? 0, jobUrl: url }, { lastScanVote: vote }),
    vote === "down"
      ? notifyOwner(
          `[Scene Fixer] 👎 on a scan (${job.errorCount ?? 0} errors)`,
          `Someone said the findings were wrong.\n\nJob: ${url}\nUser: ${uid}\nErrors: ${job.errorCount ?? 0}\nTier: ${job.scanTier ?? "?"}`
        ).catch(() => undefined)
      : Promise.resolve(),
  ]);
  return NextResponse.json({ ok: true });
}
