import { NextRequest, NextResponse } from "next/server";
import { readSession } from "@/lib/lab/auth";
import { getBudget, getJob, publicJob, refreshJob } from "@/lib/lab/jobs";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = readSession(req);
  if (!session) return NextResponse.json({ error: "Sign in" }, { status: 401 });

  const { id } = await params;
  const job = await getJob(session.sid, id);
  if (!job) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const fresh = await refreshJob(job);
  return NextResponse.json({ job: publicJob(fresh), budget: await getBudget(session.sid) });
}
