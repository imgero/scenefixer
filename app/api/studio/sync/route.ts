import { NextResponse } from "next/server";
import { syncStudioJobs } from "@/lib/studio/server";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Saves finished Studio videos into our bucket even when nobody has the page
 * open. Called every 10 minutes by Modal (studio_sync in modal_app/app.py).
 * Public on purpose: it only finishes work that already exists, is
 * idempotent, and returns counts, nothing about anyone's videos.
 */
export async function GET() {
  try {
    return NextResponse.json(await syncStudioJobs());
  } catch (err) {
    console.error("[studio] sync crashed", err);
    return NextResponse.json({ error: "sync failed" }, { status: 500 });
  }
}
