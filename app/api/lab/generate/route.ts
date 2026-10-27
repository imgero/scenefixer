import { NextRequest, NextResponse } from "next/server";
import { readSession } from "@/lib/lab/auth";
import { createJob, getBudget, LabError, publicJob, type GenerateInput } from "@/lib/lab/jobs";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const session = readSession(req);
  if (!session) return NextResponse.json({ error: "Sign in" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as GenerateInput | null;
  if (!body) return NextResponse.json({ error: "Bad request" }, { status: 400 });

  try {
    const job = await createJob(session.sid, body);
    return NextResponse.json({ job: publicJob(job), budget: await getBudget(session.sid) });
  } catch (err) {
    if (err instanceof LabError) return NextResponse.json({ error: err.message }, { status: err.status });
    console.error("[lab] generate crashed", err);
    return NextResponse.json({ error: "Something went wrong. Nothing was charged." }, { status: 500 });
  }
}
