import { NextRequest, NextResponse } from "next/server";
import { StudioError, getStudioJob, publicStudioJob, refreshStudioJob, requireUid, studioAccount } from "@/lib/studio/server";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { uid } = await requireUid(req);
    const { id } = await params;
    const job = await getStudioJob(uid, id);
    if (!job) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const fresh = await refreshStudioJob(job);
    return NextResponse.json({ job: await publicStudioJob(fresh), account: await studioAccount(uid) });
  } catch (err) {
    if (err instanceof StudioError) return NextResponse.json({ error: err.message }, { status: err.status });
    console.error("[studio] job poll crashed", err);
    return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
  }
}
