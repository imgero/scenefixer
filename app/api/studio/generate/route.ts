import { NextRequest, NextResponse } from "next/server";
import { StudioError, createStudioJob, publicStudioJob, requireUid, studioAccount, type StudioInput } from "@/lib/studio/server";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const { uid } = await requireUid(req);
    const body = (await req.json().catch(() => null)) as StudioInput | null;
    if (!body) throw new StudioError("Bad request");
    const job = await createStudioJob(uid, body);
    return NextResponse.json({ job: await publicStudioJob(job), account: await studioAccount(uid) });
  } catch (err) {
    if (err instanceof StudioError) return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    console.error("[studio] generate crashed", err);
    return NextResponse.json({ error: "Something went wrong. Nothing was charged." }, { status: 500 });
  }
}
