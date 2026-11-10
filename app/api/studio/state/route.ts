import { NextRequest, NextResponse } from "next/server";
import {
  StudioError,
  batchState,
  listStudioJobs,
  publicStudioJob,
  refreshStudioJob,
  requireUid,
  studioAccount,
} from "@/lib/studio/server";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** How much of the batch is left, plus (when signed in) the buyer's balance and videos. */
export async function GET(req: NextRequest) {
  const b = await batchState();
  const batch = { open: b.open, videosLeft: b.videosLeft, passesLeft: b.passesLeft };
  if (!req.headers.get("Authorization")) return NextResponse.json({ batch });
  try {
    const { uid } = await requireUid(req);
    const jobs = await listStudioJobs(uid);
    const fresh = await Promise.all(jobs.map((j) => refreshStudioJob(j)));
    return NextResponse.json({
      batch,
      account: await studioAccount(uid),
      jobs: await Promise.all(fresh.map(publicStudioJob)),
    });
  } catch (err) {
    if (err instanceof StudioError) return NextResponse.json({ error: err.message, batch }, { status: err.status });
    console.error("[studio] state crashed", err);
    return NextResponse.json({ error: "Something went wrong", batch }, { status: 500 });
  }
}
