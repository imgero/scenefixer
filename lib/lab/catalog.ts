/**
 * Model catalog and price table for the private tester page (/lab).
 *
 * Shared by the server (authoritative: it decides what a job costs and what
 * Runway is asked for) and the browser (display only: it shows the price
 * before the click). Rates are Runway's published API credits, 1 credit =
 * $0.01, checked against docs.dev.runwayml.com/guides/pricing on 27 Oct 2026.
 *
 * The server does not trust this table on its own. Runway returns
 * `estimatedCost.credits` when a task is created, and a task whose real price
 * is higher than ours is cancelled before it can run (see lib/lab/jobs.ts), so
 * a stale rate here can cost a refused request but never an unbudgeted one.
 */

export type AspectRatio = "16:9" | "9:16";
export type Kind = "image" | "video";

export type ImageModel = {
  id: string;
  runwayModel: string;
  label: string;
  maker: string;
  blurb: string;
  credits: number;
  /** Runway wants a pixel size, not an aspect ratio, and every model has its own list. */
  sizes: Record<AspectRatio, string>;
  maxRefs: number;
};

export type VideoModel = {
  id: string;
  runwayModel: string;
  label: string;
  maker: string;
  blurb: string;
  creditsPerSecond: number;
  /** Added per second when audio is on (Veo prices audio; Seedance 2.5 gives it away). */
  audioExtraPerSecond: number;
  /** Whether the clip can carry sound at all. */
  hasAudio: boolean;
  /** Per-generation floor Runway applies regardless of length. */
  minCredits: number;
  durations: number[];
  /** Can start from nothing but a prompt. gen4_turbo cannot: it animates an image. */
  textOnly: boolean;
  /** How many images may steer one clip. 1 = a start frame; more = look/character references. */
  maxImages: number;
  /** Takes several images as references rather than only a first frame. */
  multiReference: boolean;
  sizes: Record<AspectRatio, string>;
};

const SIZES_720: Record<AspectRatio, string> = { "16:9": "1280:720", "9:16": "720:1280" };

export const IMAGE_MODELS: ImageModel[] = [
  {
    id: "gen4_image",
    runwayModel: "gen4_image",
    label: "Gen-4 Image",
    maker: "Runway",
    blurb: "Keeps a character or look consistent across images. Up to 3 reference photos.",
    credits: 5,
    sizes: SIZES_720,
    maxRefs: 3,
  },
  {
    id: "gemini_image",
    runwayModel: "gemini_image3.1_flash",
    label: "Gemini 3.1 Flash Image",
    maker: "Google",
    blurb: "Fast, good at following detailed prompts and keeping a person recognisable.",
    credits: 7,
    sizes: { "16:9": "1344:768", "9:16": "768:1344" },
    maxRefs: 5,
  },
  {
    id: "gpt_image",
    runwayModel: "gpt_image_2",
    label: "GPT Image 2",
    maker: "OpenAI",
    blurb: "Strong on text in the image and precise instructions. Medium quality.",
    credits: 5,
    sizes: { "16:9": "1920:1088", "9:16": "1088:1920" },
    maxRefs: 5,
  },
  {
    id: "seedream_lite",
    runwayModel: "seedream5_lite",
    label: "Seedream 5 Lite",
    maker: "ByteDance",
    blurb: "Cheap and quick for trying ideas.",
    credits: 4,
    sizes: { "16:9": "2848:1600", "9:16": "1600:2848" },
    maxRefs: 5,
  },
];

export const VIDEO_MODELS: VideoModel[] = [
  {
    id: "gen4_turbo",
    runwayModel: "gen4_turbo",
    label: "Gen-4 Turbo",
    maker: "Runway",
    blurb: "The cheap one. Animates a start image, so make or upload one first.",
    creditsPerSecond: 5,
    audioExtraPerSecond: 0,
    hasAudio: false,
    minCredits: 0,
    durations: [5, 10],
    textOnly: false,
    maxImages: 1,
    multiReference: false,
    sizes: SIZES_720,
  },
  {
    id: "gen4_5",
    runwayModel: "gen4.5",
    label: "Gen-4.5",
    maker: "Runway",
    blurb: "Runway's better motion and prompt-following. Works from text or a start image.",
    creditsPerSecond: 12,
    audioExtraPerSecond: 0,
    hasAudio: false,
    minCredits: 0,
    durations: [5, 10],
    textOnly: true,
    maxImages: 1,
    multiReference: false,
    sizes: SIZES_720,
  },
  {
    id: "veo3_1_fast",
    runwayModel: "veo3.1_fast",
    label: "Veo 3.1 Fast",
    maker: "Google",
    blurb: "Google's video model with generated sound. Clips are 4, 6 or 8 seconds.",
    creditsPerSecond: 10,
    audioExtraPerSecond: 5,
    hasAudio: true,
    minCredits: 0,
    durations: [4, 6, 8],
    textOnly: true,
    maxImages: 1,
    multiReference: false,
    sizes: SIZES_720,
  },
  {
    id: "seedance_2_5",
    runwayModel: "seedance2_5",
    label: "Seedance 2.5 (720p)",
    maker: "ByteDance",
    blurb: "Best quality here. Sound included. Can hold several reference images of the same characters.",
    creditsPerSecond: 30,
    audioExtraPerSecond: 0,
    hasAudio: true,
    minCredits: 80,
    durations: [5, 8, 10],
    textOnly: true,
    maxImages: 4,
    multiReference: true,
    sizes: SIZES_720,
  },
];

export const MAX_PROMPT_CHARS = 1000;
export const MAX_IMAGE_DATA_URI_BYTES = 1_400_000;

export function imageModel(id: string): ImageModel | undefined {
  return IMAGE_MODELS.find((m) => m.id === id);
}

export function videoModel(id: string): VideoModel | undefined {
  return VIDEO_MODELS.find((m) => m.id === id);
}

export function imageCost(model: ImageModel): number {
  return model.credits;
}

export function videoCost(model: VideoModel, seconds: number, audio: boolean): number {
  const perSecond = model.creditsPerSecond + (audio && model.hasAudio ? model.audioExtraPerSecond : 0);
  return Math.max(model.minCredits, Math.ceil(seconds * perSecond));
}

/** Largest price any single option here can reach, for sizing the per-job guard. */
export const MAX_SINGLE_JOB_CREDITS = Math.max(
  ...VIDEO_MODELS.map((m) => videoCost(m, Math.max(...m.durations), true)),
  ...IMAGE_MODELS.map(imageCost),
);
