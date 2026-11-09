import RunwayML from "@runwayml/sdk";
import { FieldValue } from "firebase-admin/firestore";
import type { NextRequest } from "next/server";
import { adminAuth, adminDb, adminStorage } from "@/lib/firebase-admin";
import { captureServer } from "@/lib/posthog-server";
import {
  CREDITS_PER_VIDEO,
  PASS_FAST_PER_DAY,
  RUNWAY_PER_STUDIO_CREDIT,
  STUDIO_MAX_IMAGE_BYTES,
  STUDIO_MAX_PROMPT,
  runwayCost,
  studioCost,
  studioModel,
  type Aspect,
  type Resolution,
} from "@/lib/studio/catalog";

/**
 * Studio ledger, pool guard and Runway calls.
 *
 * Money side. Every Studio credit sold is a promise of 10 Runway credits from
 * one prepaid Runway balance, the same balance Scene Fixer's fixes draw on.
 * `studio/ledger.outstanding` is the total of Studio credits sold and not yet
 * spent. Selling stops while
 *
 *     runway balance - outstanding * 10 - this pack * 10 < SELL_RESERVE
 *
 * so the pool can never be sold twice and fixes always keep SELL_RESERVE.
 * Pass holders' free Fast videos are not pre-sold; they run while the
 * unpromised balance is above FAST_FLOOR, which sits below SELL_RESERVE so a
 * sold-out batch does not stop a pass someone already paid for.
 *
 * Per generation, as in the Lab: reserve (take credits, write the job) in one
 * transaction, submit, cancel if Runway's estimate is higher than ours, and
 * settle when the task ends. A failed or refused task gives everything back.
 */

const SELL_RESERVE = Number(process.env.STUDIO_RESERVE_RUNWAY) || 40_000;
const FAST_FLOOR = Math.floor(SELL_RESERVE / 2);
const MAX_PENDING = 2;
const DAY_MS = 24 * 60 * 60 * 1000;

export class StudioError extends Error {
  constructor(message: string, public status = 400, public code?: string) {
    super(message);
  }
}

export async function requireUid(req: NextRequest): Promise<{ uid: string; email: string }> {
  const h = req.headers.get("Authorization");
  if (!h?.startsWith("Bearer ")) throw new StudioError("Sign in first", 401);
  try {
    const d = await adminAuth.verifyIdToken(h.slice(7));
    return { uid: d.uid, email: d.email ?? "" };
  } catch {
    throw new StudioError("Sign in again", 401);
  }
}

// ── Runway ────────────────────────────────────────────────────────────────

let client: RunwayML | null = null;
function runway(): RunwayML {
  if (!process.env.RUNWAYML_API_SECRET) throw new StudioError("Video generation is not configured", 503);
  return (client ??= new RunwayML({ apiKey: process.env.RUNWAYML_API_SECRET }));
}

let balanceCache: { at: number; value: number | null } | null = null;

/** Runway org balance in Runway credits, cached for a minute. null if it can't be read. */
export async function runwayBalance(): Promise<number | null> {
  if (balanceCache && Date.now() - balanceCache.at < 60_000) return balanceCache.value;
  let value: number | null = null;
  try {
    const res = await fetch("https://api.dev.runwayml.com/v1/organization", {
      headers: {
        Authorization: `Bearer ${process.env.RUNWAYML_API_SECRET}`,
        "X-Runway-Version": "2024-11-06",
      },
      cache: "no-store",
    });
    if (res.ok) {
      const n = (await res.json())?.creditBalance;
      if (typeof n === "number") value = n;
    }
  } catch (err) {
    console.error("[studio] balance read failed", err instanceof Error ? err.message : err);
  }
  balanceCache = { at: Date.now(), value };
  return value;
}

const ledgerRef = () => adminDb.collection("studio").doc("ledger");

export type Batch = { open: boolean; videosLeft: number; fastOpen: boolean };

/** What is left to sell, in 5-second 720p Seedance videos. Fails closed: an unreadable balance sells nothing. */
export async function batchState(): Promise<Batch & { unpromised: number | null }> {
  const [balance, ledger] = await Promise.all([runwayBalance(), ledgerRef().get()]);
  if (balance === null) return { open: false, videosLeft: 0, fastOpen: false, unpromised: null };
  const outstanding = (ledger.data()?.outstanding as number | undefined) ?? 0;
  const unpromised = balance - outstanding * RUNWAY_PER_STUDIO_CREDIT;
  const sellable = unpromised - SELL_RESERVE;
  return {
    open: sellable >= CREDITS_PER_VIDEO * RUNWAY_PER_STUDIO_CREDIT,
    videosLeft: Math.max(0, Math.floor(sellable / (CREDITS_PER_VIDEO * RUNWAY_PER_STUDIO_CREDIT))),
    fastOpen: unpromised > FAST_FLOOR,
    unpromised,
  };
}

export async function canSell(studioCredits: number): Promise<boolean> {
  const b = await batchState();
  return b.unpromised !== null && b.unpromised - studioCredits * RUNWAY_PER_STUDIO_CREDIT >= SELL_RESERVE;
}

/**
 * Called by the Stripe webhook once a Studio purchase is paid. Grants each
 * checkout session once: the marker is written in the same transaction as the
 * credits, so a Stripe retry after a crash either finds both or neither.
 * Returns false when this session was already granted.
 */
export async function grantStudioPurchase(sessionId: string, uid: string, credits: number, passDays: number): Promise<boolean> {
  const userRef = adminDb.collection("users").doc(uid);
  const marker = adminDb.collection("studio_purchases").doc(sessionId);
  return adminDb.runTransaction(async (tx) => {
    const [m, u] = await Promise.all([tx.get(marker), tx.get(userRef)]);
    if (m.exists) return false;
    const update: Record<string, unknown> = { studioCredits: FieldValue.increment(credits) };
    if (passDays > 0) {
      // A second pass bought while one is running extends it rather than overlapping.
      const from = Math.max(Date.now(), (u.data()?.studioPassUntil as number | undefined) ?? 0);
      update.studioPassUntil = from + passDays * DAY_MS;
    }
    tx.create(marker, { uid, credits, passDays, at: Date.now() });
    tx.set(userRef, update, { merge: true });
    tx.set(ledgerRef(), { outstanding: FieldValue.increment(credits) }, { merge: true });
    return true;
  });
}

// ── Jobs ──────────────────────────────────────────────────────────────────

export type StudioJob = {
  id: string;
  uid: string;
  modelId: string;
  runwayModel: string;
  resolution: Resolution;
  aspect: Aspect;
  seconds: number;
  audio: boolean;
  prompt: string;
  hasImage: boolean;
  cost: number;
  runwayEstimate: number;
  paidWith: "credits" | "pass";
  day: string;
  taskId?: string;
  status: "RESERVED" | "PENDING" | "THROTTLED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED";
  settled: boolean;
  charged?: number;
  output?: string[];
  storagePath?: string;
  error?: string;
  createdAt: number;
};

export type StudioInput = {
  modelId: string;
  resolution: Resolution;
  aspect: Aspect;
  seconds: number;
  audio?: boolean;
  prompt: string;
  image?: string;
};

const jobsCol = () => adminDb.collection("studio_jobs");
const today = () => new Date().toISOString().slice(0, 10);

function validate(input: StudioInput) {
  const m = studioModel(input?.modelId);
  if (!m) throw new StudioError("Pick a model");
  const prompt = (input.prompt ?? "").trim();
  if (!prompt) throw new StudioError("Describe the video first");
  if (prompt.length > STUDIO_MAX_PROMPT) throw new StudioError(`Keep the prompt under ${STUDIO_MAX_PROMPT} characters`);
  if (input.aspect !== "16:9" && input.aspect !== "9:16") throw new StudioError("Pick landscape or portrait");
  if (!m.ratios[input.resolution]) throw new StudioError(`${m.label} doesn't do ${input.resolution}`);
  if (!m.durations.includes(input.seconds)) throw new StudioError(`${m.label} makes ${m.durations.join(", ")} second videos`);
  const image = input.image;
  if (image !== undefined) {
    if (typeof image !== "string" || !/^data:image\/(jpeg|png|webp);base64,/.test(image)) throw new StudioError("Images must be JPEG, PNG or WebP");
    if (image.length > STUDIO_MAX_IMAGE_BYTES) throw new StudioError("That image is too large, try a smaller one");
  }
  const hasImage = !!image;
  return {
    m,
    prompt,
    hasImage,
    cost: studioCost(m, input.resolution, input.seconds, hasImage),
    runway: runwayCost(m, input.resolution, input.seconds, hasImage),
  };
}

async function submit(job: Omit<StudioJob, "id">, image: string | undefined) {
  const r = runway();
  const m = studioModel(job.modelId)!;
  const ratio = m.ratios[job.resolution]![job.aspect] as never;
  if (m.runwayModel === "grok_imagine_1_5_lite") {
    return image
      ? r.imageToVideo.create({
          model: "grok_imagine_1_5_lite",
          promptImage: [{ uri: image, position: "first" }],
          promptText: job.prompt,
          duration: job.seconds,
          ratio: job.resolution === "480p" ? "auto_480p" : "auto_720p",
        })
      : r.textToVideo.create({ model: "grok_imagine_1_5_lite", promptText: job.prompt, duration: job.seconds, ratio });
  }
  return image
    ? r.imageToVideo.create({
        model: "seedance2_5",
        promptImage: [{ uri: image, position: "first" }],
        promptText: job.prompt,
        ratio,
        duration: job.seconds,
        audio: job.audio,
      })
    : r.textToVideo.create({ model: "seedance2_5", promptText: job.prompt, ratio, duration: job.seconds, audio: job.audio });
}

function friendlyRunwayError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/moderat|safety|content/i.test(msg)) return "The content filter refused that prompt or image. Nothing was charged. Try rewording it.";
  if (/rate|too many|429|concurren/i.test(msg)) return "The video service is busy. Wait a moment and try again. Nothing was charged.";
  return "That video couldn't be started. Nothing was charged.";
}

/** Gives back what the job took and closes it. Idempotent. */
async function release(jobId: string, status: StudioJob["status"], error: string, charged = 0): Promise<void> {
  const jobRef = jobsCol().doc(jobId);
  await adminDb.runTransaction(async (tx) => {
    const j = (await tx.get(jobRef)).data() as Omit<StudioJob, "id"> | undefined;
    if (!j || j.settled) return;
    const userRef = adminDb.collection("users").doc(j.uid);
    const u = j.paidWith === "pass" ? (await tx.get(userRef)).data() : undefined;
    tx.update(jobRef, { status, error, settled: true, charged });
    if (j.paidWith === "credits") {
      tx.set(userRef, { studioCredits: FieldValue.increment(j.cost) }, { merge: true });
      tx.set(ledgerRef(), { outstanding: FieldValue.increment(j.cost) }, { merge: true });
    } else if (u?.studioFastDay === j.day && (u?.studioFastCount ?? 0) > 0) {
      tx.set(userRef, { studioFastCount: FieldValue.increment(-1) }, { merge: true });
    }
  });
}

export async function createStudioJob(uid: string, input: StudioInput): Promise<StudioJob> {
  const v = validate(input);
  const passEligible = v.m.inPass;
  const batch = passEligible ? await batchState() : null;

  const userRef = adminDb.collection("users").doc(uid);
  const jobRef = jobsCol().doc();
  const day = today();
  let job!: Omit<StudioJob, "id">;

  await adminDb.runTransaction(async (tx) => {
    const u = (await tx.get(userRef)).data() ?? {};
    const pending = await tx.get(jobsCol().where("uid", "==", uid).where("settled", "==", false));
    if (pending.size >= MAX_PENDING) {
      throw new StudioError(`Wait for your ${MAX_PENDING} videos in progress to finish first`, 429);
    }
    const passActive = ((u.studioPassUntil as number | undefined) ?? 0) > Date.now();
    const usedToday = u.studioFastDay === day ? ((u.studioFastCount as number | undefined) ?? 0) : 0;
    const usePass = passEligible && passActive && usedToday < PASS_FAST_PER_DAY && !!batch?.fastOpen;

    const balance = (u.studioCredits as number | undefined) ?? 0;
    if (!usePass && balance < v.cost) {
      throw new StudioError(
        balance > 0 ? `That costs ${v.cost} credits and you have ${balance}` : `That costs ${v.cost} credits. Get a pack to start.`,
        402,
        "no_credits",
      );
    }

    job = {
      uid,
      modelId: v.m.id,
      runwayModel: v.m.runwayModel,
      resolution: input.resolution,
      aspect: input.aspect,
      seconds: input.seconds,
      audio: v.m.hasAudio && input.audio !== false,
      prompt: v.prompt,
      hasImage: v.hasImage,
      cost: usePass ? 0 : v.cost,
      runwayEstimate: v.runway,
      paidWith: usePass ? "pass" : "credits",
      day,
      status: "RESERVED",
      settled: false,
      createdAt: Date.now(),
    };
    tx.set(jobRef, job);
    if (usePass) {
      tx.set(userRef, { studioFastDay: day, studioFastCount: usedToday + 1 }, { merge: true });
    } else {
      tx.set(userRef, { studioCredits: FieldValue.increment(-v.cost) }, { merge: true });
      tx.set(ledgerRef(), { outstanding: FieldValue.increment(-v.cost) }, { merge: true });
    }
  });

  let submitted: { id: string; estimatedCost?: { credits: number } };
  try {
    submitted = await submit(job, input.image);
  } catch (err) {
    const message = friendlyRunwayError(err);
    console.error("[studio] submit failed", jobRef.id, err instanceof Error ? err.message : err);
    await release(jobRef.id, "FAILED", message);
    throw new StudioError(message, 502);
  }

  const est = submitted.estimatedCost?.credits;
  if (typeof est === "number" && est > v.runway) {
    console.error("[studio] price mismatch", jobRef.id, { ours: v.runway, runway: est, model: v.m.runwayModel });
    await runway().tasks.delete(submitted.id).catch(() => undefined);
    await release(jobRef.id, "CANCELLED", "The price changed on our provider's side, so this was stopped. Nothing was charged.");
    throw new StudioError("The price changed on our provider's side, so this was stopped. Nothing was charged.", 409);
  }

  await jobRef.update({ taskId: submitted.id, status: "PENDING" });
  await captureServer({
    distinctId: uid,
    event: "studio_generation_started",
    properties: { job_id: jobRef.id, model: v.m.id, resolution: input.resolution, seconds: input.seconds, cost: job.cost, paid_with: job.paidWith, has_image: v.hasImage },
  });
  return { ...job, id: jobRef.id, taskId: submitted.id, status: "PENDING" };
}

/** Copies a finished video out of Runway (its links expire in a day) into our bucket. Best-effort; retried on the next look. */
async function persist(job: StudioJob): Promise<StudioJob> {
  const src = job.output?.[0];
  if (job.status !== "SUCCEEDED" || job.storagePath || !src) return job;
  // Runway's links last 24-48 hours; past that a copy can no longer be made.
  if (Date.now() - job.createdAt > 2 * DAY_MS) return job;
  try {
    const res = await fetch(src);
    if (!res.ok) throw new Error(`download ${res.status}`);
    const path = `studio/${job.uid}/${job.id}.mp4`;
    await adminStorage.bucket().file(path).save(Buffer.from(await res.arrayBuffer()), { contentType: "video/mp4", resumable: false });
    await jobsCol().doc(job.id).update({ storagePath: path });
    return { ...job, storagePath: path };
  } catch (err) {
    console.error("[studio] persist failed", job.id, err instanceof Error ? err.message : err);
    return job;
  }
}

export async function refreshStudioJob(job: StudioJob): Promise<StudioJob> {
  if (job.settled) return persist(job);
  if (!job.taskId) {
    // Reserved but never submitted (the request died between the two). Give it back after a few minutes.
    if (Date.now() - job.createdAt > 5 * 60 * 1000) {
      await release(job.id, "FAILED", "This one didn't start. Nothing was charged.");
      return { ...job, settled: true, status: "FAILED", error: "This one didn't start. Nothing was charged." };
    }
    return job;
  }
  let task;
  try {
    task = await runway().tasks.retrieve(job.taskId);
  } catch (err) {
    console.error("[studio] poll failed", job.id, err instanceof Error ? err.message : err);
    return job;
  }

  if (task.status === "SUCCEEDED") {
    const charged = task.cost?.credits ?? job.runwayEstimate;
    const output = task.output ?? [];
    const ref = jobsCol().doc(job.id);
    await adminDb.runTransaction(async (tx) => {
      const cur = (await tx.get(ref)).data() as StudioJob | undefined;
      if (!cur || cur.settled) return;
      tx.update(ref, { status: "SUCCEEDED", settled: true, charged, output });
    });
    await captureServer({
      distinctId: job.uid,
      event: "studio_generation_succeeded",
      properties: { job_id: job.id, model: job.modelId, resolution: job.resolution, cost: job.cost, runway_charged: charged, paid_with: job.paidWith },
    });
    return persist({ ...job, status: "SUCCEEDED", settled: true, charged, output });
  }

  if (task.status === "FAILED" || task.status === "CANCELLED") {
    const blocked = /SAFETY|MODERATION/.test(task.status === "FAILED" ? task.failureCode ?? "" : "");
    const error = blocked
      ? "The content filter blocked this. Try rewording the prompt or using a different image. Your credits are back."
      : "This one didn't work. Your credits are back.";
    await release(job.id, task.status, error, task.cost?.credits ?? 0);
    await captureServer({
      distinctId: job.uid,
      event: "studio_generation_failed",
      properties: { job_id: job.id, model: job.modelId, failure_code: task.status === "FAILED" ? task.failureCode ?? null : "CANCELLED" },
    });
    return { ...job, status: task.status, settled: true, error };
  }

  if (task.status !== job.status) {
    await jobsCol().doc(job.id).update({ status: task.status });
    return { ...job, status: task.status };
  }
  return job;
}

export async function getStudioJob(uid: string, id: string): Promise<StudioJob | null> {
  const d = (await jobsCol().doc(id).get()).data() as Omit<StudioJob, "id"> | undefined;
  return d && d.uid === uid ? { ...d, id } : null;
}

export async function listStudioJobs(uid: string): Promise<StudioJob[]> {
  const snap = await jobsCol().where("uid", "==", uid).get();
  return snap.docs
    .map((d) => ({ ...(d.data() as Omit<StudioJob, "id">), id: d.id }))
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 40);
}

/** What the browser may see. The video link is a 7-day signed link to our copy, or Runway's own while the copy is pending. */
export async function publicStudioJob(j: StudioJob) {
  let url: string | undefined;
  let downloadUrl: string | undefined;
  if (j.status === "SUCCEEDED") {
    if (j.storagePath) {
      try {
        const file = adminStorage.bucket().file(j.storagePath);
        const expires = Date.now() + 7 * DAY_MS;
        [[url], [downloadUrl]] = await Promise.all([
          file.getSignedUrl({ action: "read", expires }),
          // Same file, served as an attachment so "Download" saves it instead of opening a player.
          file.getSignedUrl({ action: "read", expires, responseDisposition: `attachment; filename="scenefixer-${j.id}.mp4"` }),
        ]);
      } catch (err) {
        console.error("[studio] sign failed", j.id, err instanceof Error ? err.message : err);
      }
    }
    if (!url && Date.now() - j.createdAt < DAY_MS) url = j.output?.[0];
  }
  return {
    id: j.id,
    modelId: j.modelId,
    resolution: j.resolution,
    aspect: j.aspect,
    seconds: j.seconds,
    prompt: j.prompt,
    cost: j.cost,
    paidWith: j.paidWith,
    status: j.status,
    done: j.settled,
    url,
    downloadUrl: downloadUrl ?? url,
    saved: !!j.storagePath,
    error: j.error,
    createdAt: j.createdAt,
  };
}

export type StudioAccount = { credits: number; passUntil: number | null; fastLeftToday: number | null };

export async function studioAccount(uid: string): Promise<StudioAccount> {
  const u = (await adminDb.collection("users").doc(uid).get()).data() ?? {};
  const passUntil = ((u.studioPassUntil as number | undefined) ?? 0) > Date.now() ? (u.studioPassUntil as number) : null;
  const used = u.studioFastDay === today() ? ((u.studioFastCount as number | undefined) ?? 0) : 0;
  return {
    credits: (u.studioCredits as number | undefined) ?? 0,
    passUntil,
    fastLeftToday: passUntil ? Math.max(0, PASS_FAST_PER_DAY - used) : null,
  };
}
