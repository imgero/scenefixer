import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { authorizeAdmin } from "@/lib/admin";

type Shot = {
  id: string;
  index: number;
  startMs?: number;
  endMs?: number;
  keyframeUrls: string[];
};

/**
 * GET — the review queue.
 *
 * One row per ADJACENT SHOT PAIR of a recent job, carrying the frames
 * detection actually saw and whatever it reported about that pair. Pairs we
 * flagged come first, because a false positive is the expensive error and the
 * whole point of this queue is to catch them.
 */
export async function GET(req: NextRequest) {
  const auth = await authorizeAdmin(req);
  if (!auth.ok) return NextResponse.json({ error: auth.reason }, { status: 403 });
  const limit = Math.min(Number(req.nextUrl.searchParams.get("jobs") ?? 12), 40);

  const jobsSnap = await adminDb
    .collection("jobs")
    .orderBy("createdAt", "desc")
    .limit(limit)
    .get();

  const labelsSnap = await adminDb.collection("detection_labels").get();
  const labelled = new Map<string, Record<string, unknown>>();
  labelsSnap.forEach((d) => labelled.set(d.id, d.data()));

  const rows: Record<string, unknown>[] = [];

  for (const jobDoc of jobsSnap.docs) {
    const job = jobDoc.data();
    if (!job.shotCount || job.shotCount < 2) continue;

    const [shotsSnap, errsSnap] = await Promise.all([
      jobDoc.ref.collection("shots").orderBy("index").get(),
      jobDoc.ref.collection("errors").get(),
    ]);

    const shots: Shot[] = shotsSnap.docs.map((s) => {
      const d = s.data();
      return {
        id: s.id,
        index: d.index,
        startMs: d.startMs,
        endMs: d.endMs,
        keyframeUrls: (d.keyframeUrls ?? [d.keyframeUrl]).filter(Boolean),
      };
    });

    const errors = errsSnap.docs.map((e) => ({ id: e.id, ...e.data() })) as
      Record<string, unknown>[];

    for (let i = 0; i + 1 < shots.length; i++) {
      const A = shots[i];
      const B = shots[i + 1];
      const flagged = errors
        .filter((e) => e.shotAId === A.id && e.shotBId === B.id)
        .map((e) => ({
          errorId: e.id,
          type: e.type,
          severity: e.severity,
          description: e.description,
          fixSuggestion: e.fixSuggestion,
          userConfirmed: !!e.userConfirmed,
          fixStatus: e.fixStatus ?? null,
          verifiedResolved: e.verifiedResolved ?? null,
        }));

      const pairId = `${jobDoc.id}__${A.id}__${B.id}`;
      rows.push({
        pairId,
        jobId: jobDoc.id,
        createdAt: job.createdAt?._seconds ?? job.createdAt?.seconds ?? null,
        userHint: job.userHint ?? "",
        inputVideoUrl: job.inputVideoUrl ?? null,
        outputVideoUrl: job.outputVideoUrl ?? null,
        shotCount: job.shotCount,
        a: { id: A.id, index: A.index, frames: A.keyframeUrls.slice(0, 3) },
        b: { id: B.id, index: B.index, frames: B.keyframeUrls.slice(0, 3) },
        // Every shot's mid frame, so a pair can be judged against the whole
        // film rather than in isolation. Judging case10 on the pair alone got
        // it wrong: a storm read as a story beat until the other thirteen
        // shots showed the film is sunny throughout.
        sequence: shots.map((s) => ({
          index: s.index,
          frame: s.keyframeUrls[Math.floor(s.keyframeUrls.length / 2)] ?? null,
        })),
        flagged,
        label: labelled.get(pairId) ?? null,
      });
    }
  }

  rows.sort((x, y) => {
    const xl = x.label ? 1 : 0;
    const yl = y.label ? 1 : 0;
    if (xl !== yl) return xl - yl; // unlabelled first
    const xf = (x.flagged as unknown[]).length ? 0 : 1;
    const yf = (y.flagged as unknown[]).length ? 0 : 1;
    if (xf !== yf) return xf - yf; // flagged first
    return Number(y.createdAt ?? 0) - Number(x.createdAt ?? 0);
  });

  const total = rows.length;
  const done = rows.filter((r) => r.label).length;
  return NextResponse.json({ rows, total, done });
}

/**
 * POST — record one verdict.
 *
 * verdict:
 *   "correct"        we flagged it and it is genuinely a mistake
 *   "false_positive" we flagged it and it is not a mistake
 *   "missed"         we flagged nothing (or missed this) and there IS a mistake
 *   "clean"          we flagged nothing and there is nothing — confirms a negative
 */
export async function POST(req: NextRequest) {
  const auth = await authorizeAdmin(req);
  if (!auth.ok) return NextResponse.json({ error: auth.reason }, { status: 403 });
  const body = await req.json();
  const { pairId, jobId, shotAId, shotBId, verdict, note, errorId, errorType } = body;

  const allowed = ["correct", "false_positive", "missed", "clean"];
  if (!pairId || !allowed.includes(verdict)) {
    return NextResponse.json(
      { error: `pairId and verdict (${allowed.join("|")}) required` },
      { status: 400 },
    );
  }
  // A "missed" verdict with no note teaches nothing — the note IS the label.
  if (verdict === "missed" && !String(note ?? "").trim()) {
    return NextResponse.json(
      { error: "a 'missed' verdict needs a note saying what the error is" },
      { status: 400 },
    );
  }

  await adminDb.collection("detection_labels").doc(pairId).set(
    {
      pairId,
      jobId: jobId ?? null,
      shotAId: shotAId ?? null,
      shotBId: shotBId ?? null,
      errorId: errorId ?? null,
      errorType: errorType ?? null,
      verdict,
      note: String(note ?? "").trim(),
      labelledBy: auth.email,
      labelledAt: new Date(),
    },
    { merge: true },
  );

  return NextResponse.json({ ok: true, pairId, verdict });
}

/** DELETE — undo a verdict, for when you change your mind. */
export async function DELETE(req: NextRequest) {
  const auth = await authorizeAdmin(req);
  if (!auth.ok) return NextResponse.json({ error: auth.reason }, { status: 403 });
  const pairId = req.nextUrl.searchParams.get("pairId");
  if (!pairId) {
    return NextResponse.json({ error: "pairId required" }, { status: 400 });
  }
  await adminDb.collection("detection_labels").doc(pairId).delete();
  return NextResponse.json({ ok: true, deleted: pairId });
}
