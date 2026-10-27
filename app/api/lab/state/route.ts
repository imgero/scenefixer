import { NextRequest, NextResponse } from "next/server";
import { labEnabled, readSession } from "@/lib/lab/auth";
import { getBudget, listJobs, publicJob, refreshJob } from "@/lib/lab/jobs";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Budget plus the tester's jobs. Any job still running is checked with Runway first, so a returning visitor sees final results. */
export async function GET(req: NextRequest) {
  if (!labEnabled()) return NextResponse.json({ error: "off" }, { status: 503 });
  const session = readSession(req);
  if (!session) return NextResponse.json({ error: "Sign in" }, { status: 401 });

  const all = await listJobs(session.sid);
  const refreshed = await Promise.all(all.map((j) => (j.settled ? j : refreshJob(j))));
  const budget = await getBudget(session.sid);
  return NextResponse.json({ budget, jobs: refreshed.map(publicJob) });
}
