import RunwayML from "@runwayml/sdk";
import { adminDb } from "@/lib/firebase-admin";
import {
  imageCost,
  imageModel,
  MAX_IMAGE_DATA_URI_BYTES,
  MAX_PROMPT_CHARS,
  videoCost,
  videoModel,
  type AspectRatio,
  type Kind,
} from "@/lib/lab/catalog";

/**
 * Budget ledger and Runway calls for the tester page.
 *
 * The cap is enforced HERE, in Firestore, before Runway is ever called:
 *
 *   1. reserve  — in one transaction, check spent + reserved + cost <= limit,
 *                 then add cost to `reserved` and write the job.
 *   2. submit   — call Runway. If it refuses, release the reservation.
 *   3. verify   — Runway answers with `estimatedCost`, the most it may charge.
 *                 If that exceeds what we reserved, cancel the task and release.
 *   4. settle   — when the task ends, move the reservation to `spent` at
 *                 Runway's own final `cost.credits` (0 for a failed task).
 *
 * A reservation is held until the task is seen to finish, so closing the tab
 * mid-generation can only ever over-count, never under-count.
 */

const DEFAULT_LIMIT = 2000;
const MAX_PENDING_JOBS = 2;

export class LabError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

export type JobStatus = "RESERVED" | "PENDING" | "THROTTLED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED";

export type LabJob = {
  id: string;
  sid: string;
  kind: Kind;
  modelId: string;
  runwayModel: string;
  prompt: string;
  aspect: AspectRatio;
  seconds?: number;
  audio?: boolean;
  imageCount: number;
  estimate: number;
  taskId?: string;
  status: JobStatus;
  settled: boolean;
  charged?: number;
  output?: string[];
  error?: string;
  createdAt: number;
};

export type ImageInput = { type: "upload"; dataUri: string } | { type: "job"; jobId: string };

export type GenerateInput = {
  kind: Kind;
  modelId: string;
  prompt: string;
  aspect: AspectRatio;
  seconds?: number;
  audio?: boolean;
  images?: ImageInput[];
  /** Seedance only: treat the images as references to hold, not as the first frame. */
  imageMode?: "start" | "reference";
};

let client: RunwayML | null = null;
function runway(): RunwayML {
  if (!process.env.RUNWAYML_API_SECRET) throw new LabError("Generation is not configured", 503);
  return (client ??= new RunwayML({ apiKey: process.env.RUNWAYML_API_SECRET }));
}

const sessions = () => adminDb.collection("lab_sessions");
const jobs = () => adminDb.collection("lab_jobs");

function limitFor(): number {
  const n = Number(process.env.LAB_CREDIT_CAP);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_LIMIT;
}

export type Budget = { limit: number; spent: number; reserved: number; remaining: number };

function toBudget(d: FirebaseFirestore.DocumentData | undefined): Budget {
  const limit = d?.limit ?? limitFor();
  const spent = d?.spent ?? 0;
  const reserved = d?.reserved ?? 0;
  return { limit, spent, reserved, remaining: Math.max(0, limit - spent - reserved) };
}

export async function getBudget(sid: string): Promise<Budget> {
  return toBudget((await sessions().doc(sid).get()).data());
}

function validate(input: GenerateInput): { cost: number; imageRefs: number } {
  const prompt = (input.prompt ?? "").trim();
  if (!prompt) throw new LabError("Write a prompt first");
  if (prompt.length > MAX_PROMPT_CHARS) throw new LabError(`Keep the prompt under ${MAX_PROMPT_CHARS} characters`);
  if (input.aspect !== "16:9" && input.aspect !== "9:16") throw new LabError("Pick 16:9 or 9:16");

  const images = input.images ?? [];
  for (const img of images) {
    if (img.type === "upload") {
      if (!/^data:image\/(jpeg|png|webp);base64,/.test(img.dataUri ?? "")) throw new LabError("Images must be JPEG, PNG or WebP");
      if (img.dataUri.length > MAX_IMAGE_DATA_URI_BYTES) throw new LabError("An image is too large, try a smaller one");
    } else if (img.type !== "job" || typeof img.jobId !== "string") {
      throw new LabError("Bad image reference");
    }
  }

  if (input.kind === "image") {
    const m = imageModel(input.modelId);
    if (!m) throw new LabError("Unknown image model");
    if (images.length > m.maxRefs) throw new LabError(`${m.label} takes up to ${m.maxRefs} reference images`);
    return { cost: imageCost(m), imageRefs: images.length };
  }
  if (input.kind === "video") {
    const m = videoModel(input.modelId);
    if (!m) throw new LabError("Unknown video model");
    if (!m.durations.includes(input.seconds ?? -1)) throw new LabError(`${m.label} makes ${m.durations.join(", ")} second clips`);
    if (images.length > m.maxImages) throw new LabError(`${m.label} takes up to ${m.maxImages} image${m.maxImages > 1 ? "s" : ""}`);
    if (!m.textOnly && images.length === 0) throw new LabError(`${m.label} animates an image — pick or make one first`);
    return { cost: videoCost(m, input.seconds!, !!input.audio), imageRefs: images.length };
  }
  throw new LabError("Unknown kind");
}

async function reserve(sid: string, job: Omit<LabJob, "id">): Promise<string> {
  const sessionRef = sessions().doc(sid);
  const jobRef = jobs().doc();
  await adminDb.runTransaction(async (tx) => {
    const snap = await tx.get(sessionRef);
    if (snap.data()?.disabled) throw new LabError("This tester login has been switched off", 403);
    const b = toBudget(snap.data());
    if (job.estimate > b.remaining) {
      throw new LabError(`That costs ${job.estimate} credits and you have ${b.remaining} left`, 402);
    }
    const pending = await tx.get(jobs().where("sid", "==", sid).where("settled", "==", false));
    if (pending.size >= MAX_PENDING_JOBS) {
      throw new LabError(`Wait for your ${MAX_PENDING_JOBS} running generations to finish first`, 429);
    }
    tx.set(jobRef, job);
    tx.set(sessionRef, { limit: b.limit, spent: b.spent, reserved: b.reserved + job.estimate }, { merge: true });
  });
  return jobRef.id;
}

/** Gives the reservation back and closes the job. Idempotent: a settled job is left alone. */
async function release(jobId: string, status: JobStatus, error: string, charged = 0): Promise<void> {
  const jobRef = jobs().doc(jobId);
  await adminDb.runTransaction(async (tx) => {
    const j = await tx.get(jobRef);
    const d = j.data() as LabJob | undefined;
    if (!d || d.settled) return;
    const sessionRef = sessions().doc(d.sid);
    const s = toBudget((await tx.get(sessionRef)).data());
    tx.update(jobRef, { status, error, settled: true, charged });
    tx.set(
      sessionRef,
      { limit: s.limit, spent: s.spent + charged, reserved: Math.max(0, s.reserved - d.estimate) },
      { merge: true },
    );
  });
}

async function resolveImages(sid: string, images: ImageInput[]): Promise<string[]> {
  const uris: string[] = [];
  for (const img of images) {
    if (img.type === "upload") {
      uris.push(img.dataUri);
      continue;
    }
    const snap = await jobs().doc(img.jobId).get();
    const d = snap.data() as LabJob | undefined;
    // Only the caller's own finished images. The URL is re-read from Runway
    // because the one stored at creation time expires within a day.
    if (!d || d.sid !== sid || d.kind !== "image" || d.status !== "SUCCEEDED" || !d.taskId) {
      throw new LabError("That image is no longer available — upload it again");
    }
    const task = await runway().tasks.retrieve(d.taskId);
    const url = task.status === "SUCCEEDED" ? task.output?.[0] : undefined;
    if (!url) throw new LabError("That image has expired — generate or upload it again");
    uris.push(url);
  }
  return uris;
}

type Submitted = { id: string; estimatedCost?: { credits: number } };

async function submit(input: GenerateInput, uris: string[]): Promise<Submitted> {
  const r = runway();
  const prompt = input.prompt.trim();

  if (input.kind === "image") {
    const m = imageModel(input.modelId)!;
    // The catalog holds sizes as plain strings so the browser can use it too;
    // the SDK types them per model. Each one is exercised against Runway in the
    // pre-release test, so a wrong entry fails there and not in front of the tester.
    const base = { promptText: prompt, ratio: m.sizes[input.aspect] as never };
    if (m.runwayModel === "gen4_image") {
      // Gen-4 Image only uses a reference it is told about by tag.
      const tags = uris.map((_, i) => `ref${i + 1}`);
      const mention = tags.filter((t) => !prompt.includes(`@${t}`)).map((t) => `@${t}`);
      return r.textToImage.create({
        model: "gen4_image",
        ...base,
        promptText: mention.length ? `${prompt} (using ${mention.join(", ")} as reference)`.slice(0, 1000) : prompt,
        ...(uris.length ? { referenceImages: uris.map((uri, i) => ({ uri, tag: tags[i] })) } : {}),
      });
    }
    const referenceImages = uris.length ? { referenceImages: uris.map((uri) => ({ uri })) } : {};
    if (m.runwayModel === "gemini_image3.1_flash") {
      return r.textToImage.create({ model: "gemini_image3.1_flash", ...base, ...referenceImages });
    }
    if (m.runwayModel === "gpt_image_2") {
      return r.textToImage.create({ model: "gpt_image_2", ...base, quality: "medium", ...referenceImages });
    }
    return r.textToImage.create({ model: "seedream5_lite", ...base, ...referenceImages });
  }

  const m = videoModel(input.modelId)!;
  const ratio = m.sizes[input.aspect] as "1280:720" | "720:1280";
  const duration = input.seconds!;
  const audio = !!input.audio && m.hasAudio;

  switch (m.runwayModel) {
    case "gen4_turbo":
      return r.imageToVideo.create({
        model: "gen4_turbo",
        promptImage: uris[0],
        promptText: prompt,
        ratio,
        duration,
      });
    case "gen4.5":
      return uris.length
        ? r.imageToVideo.create({ model: "gen4.5", promptImage: uris[0], promptText: prompt, ratio, duration })
        : r.textToVideo.create({ model: "gen4.5", promptText: prompt, ratio, duration });
    case "veo3.1_fast": {
      const veoDuration = duration as 4 | 6 | 8;
      return uris.length
        ? r.imageToVideo.create({ model: "veo3.1_fast", promptImage: uris[0], promptText: prompt, ratio, duration: veoDuration, audio })
        : r.textToVideo.create({ model: "veo3.1_fast", promptText: prompt, ratio, duration: veoDuration, audio });
    }
    default: {
      // seedance2_5
      if (uris.length && input.imageMode === "reference") {
        return r.textToVideo.create({
          model: "seedance2_5",
          promptText: prompt,
          ratio,
          duration,
          audio,
          references: uris.map((uri) => ({ uri })),
        });
      }
      return uris.length
        ? r.imageToVideo.create({
            model: "seedance2_5",
            promptImage: [{ uri: uris[0], position: "first" }],
            promptText: prompt,
            ratio,
            duration,
            audio,
          })
        : r.textToVideo.create({ model: "seedance2_5", promptText: prompt, ratio, duration, audio });
    }
  }
}

function friendlyRunwayError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/moderat|safety|content/i.test(msg)) return "Runway's content filter refused that prompt or image. Nothing was charged — try rewording it.";
  if (/credit|insufficient/i.test(msg)) return "The Runway account behind this page is out of credits. Tell the owner.";
  if (/rate|too many|429|concurren/i.test(msg)) return "Runway is busy — wait a moment and try again.";
  return "Runway couldn't start that generation. Nothing was charged.";
}

export async function createJob(sid: string, input: GenerateInput): Promise<LabJob> {
  const { cost } = validate(input);
  const m = input.kind === "image" ? imageModel(input.modelId)! : videoModel(input.modelId)!;

  const draft: Omit<LabJob, "id"> = {
    sid,
    kind: input.kind,
    modelId: input.modelId,
    runwayModel: m.runwayModel,
    prompt: input.prompt.trim(),
    aspect: input.aspect,
    ...(input.kind === "video" ? { seconds: input.seconds!, audio: !!input.audio && videoModel(input.modelId)!.hasAudio } : {}),
    imageCount: input.images?.length ?? 0,
    estimate: cost,
    status: "RESERVED",
    settled: false,
    createdAt: Date.now(),
  };
  const jobId = await reserve(sid, draft);

  let submitted: Submitted;
  try {
    const uris = await resolveImages(sid, input.images ?? []);
    submitted = await submit(input, uris);
  } catch (err) {
    const message = err instanceof LabError ? err.message : friendlyRunwayError(err);
    console.error("[lab] submit failed", jobId, err instanceof Error ? err.message : err);
    await release(jobId, "FAILED", message);
    throw new LabError(message, err instanceof LabError ? err.status : 502);
  }

  const runwayEstimate = submitted.estimatedCost?.credits;
  if (typeof runwayEstimate === "number" && runwayEstimate > cost) {
    // Our table is stale or Runway priced it differently. Stop it before it
    // runs, rather than discovering the difference after the money is gone.
    console.error("[lab] price mismatch", jobId, { ours: cost, runway: runwayEstimate, model: m.runwayModel });
    await runway().tasks.delete(submitted.id).catch(() => undefined);
    await release(jobId, "CANCELLED", `Runway priced this at ${runwayEstimate} credits, more than the ${cost} shown`);
    throw new LabError("The price changed on Runway's side, so this was stopped. Nothing was charged.", 409);
  }

  await jobs().doc(jobId).update({ taskId: submitted.id, status: "PENDING" });
  return { ...draft, id: jobId, taskId: submitted.id, status: "PENDING" };
}

/** Looks at the Runway task and, if it has ended, moves the reservation to spent (or gives it back). */
export async function refreshJob(job: LabJob): Promise<LabJob> {
  if (job.settled || !job.taskId) return job;
  let task;
  try {
    task = await runway().tasks.retrieve(job.taskId);
  } catch (err) {
    console.error("[lab] poll failed", job.id, err instanceof Error ? err.message : err);
    return job;
  }

  if (task.status === "SUCCEEDED") {
    // Runway's own final figure, never ours: that is the number on the invoice.
    const charged = task.cost?.credits ?? job.estimate;
    const output = task.output ?? [];
    const jobRef = jobs().doc(job.id);
    await adminDb.runTransaction(async (tx) => {
      const cur = (await tx.get(jobRef)).data() as LabJob | undefined;
      if (!cur || cur.settled) return;
      const sessionRef = sessions().doc(cur.sid);
      const s = toBudget((await tx.get(sessionRef)).data());
      tx.update(jobRef, { status: "SUCCEEDED", settled: true, charged, output });
      tx.set(sessionRef, { limit: s.limit, spent: s.spent + charged, reserved: Math.max(0, s.reserved - cur.estimate) }, { merge: true });
    });
    return { ...job, status: "SUCCEEDED", settled: true, charged, output };
  }

  if (task.status === "FAILED" || task.status === "CANCELLED") {
    const charged = task.cost?.credits ?? 0;
    const error =
      task.status === "FAILED"
        ? task.failureCode?.includes("SAFETY") || task.failureCode?.includes("MODERATION")
          ? "Runway's content filter blocked this. Try rewording the prompt or using a different image."
          : "Runway couldn't finish this one."
        : "Cancelled.";
    await release(job.id, task.status, error, charged);
    return { ...job, status: task.status, settled: true, charged, error };
  }

  if (task.status !== job.status) {
    await jobs().doc(job.id).update({ status: task.status });
    return { ...job, status: task.status };
  }
  return job;
}

export async function getJob(sid: string, id: string): Promise<LabJob | null> {
  const snap = await jobs().doc(id).get();
  const d = snap.data() as Omit<LabJob, "id"> | undefined;
  return d && d.sid === sid ? { ...d, id } : null;
}

export async function listJobs(sid: string): Promise<LabJob[]> {
  const snap = await jobs().where("sid", "==", sid).get();
  const all = snap.docs.map((d) => ({ ...(d.data() as Omit<LabJob, "id">), id: d.id }));
  all.sort((a, b) => b.createdAt - a.createdAt);
  return all.slice(0, 60);
}

/** What the browser is allowed to see of a job. */
export function publicJob(j: LabJob) {
  return {
    id: j.id,
    kind: j.kind,
    modelId: j.modelId,
    prompt: j.prompt,
    aspect: j.aspect,
    seconds: j.seconds,
    audio: j.audio,
    estimate: j.estimate,
    charged: j.charged,
    status: j.status,
    done: j.settled,
    output: j.output,
    error: j.error,
    createdAt: j.createdAt,
  };
}
