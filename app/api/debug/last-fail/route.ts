import { NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";

// GET /api/debug/last-fail
// Walks all jobs, finds the most recent error doc with fixStatus="failed",
// and returns its errorMessage + errorDetail so we can see exactly why
// Aleph rejected the submission. No auth — URL is unguessable in practice
// and only useful for debugging.
export async function GET() {
  try {
    const jobs = await adminDb
      .collection("jobs")
      .orderBy("createdAt", "desc")
      .limit(10)
      .get();

    type Failed = {
      jobId: string;
      errorId: string;
      description?: string;
      fixMode?: string;
      replaceWith?: string;
      alephPrompt?: string;
      markerUrl?: string;
      errorMessage?: string;
      errorDetail?: string;
    };
    const failures: Failed[] = [];

    for (const jobDoc of jobs.docs) {
      const errs = await jobDoc.ref
        .collection("errors")
        .where("fixStatus", "==", "failed")
        .get();
      for (const errDoc of errs.docs) {
        const d = errDoc.data();
        failures.push({
          jobId: jobDoc.id,
          errorId: errDoc.id,
          description: d.description,
          fixMode: d.fixMode,
          replaceWith: d.replaceWith,
          alephPrompt: d.alephPrompt,
          markerUrl: d.markerUrl,
          errorMessage: d.errorMessage,
          errorDetail: d.errorDetail,
        });
      }
    }

    return NextResponse.json({ count: failures.length, failures }, { status: 200 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
