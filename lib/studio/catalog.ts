/**
 * Scene Fixer Studio: what it sells and what each video costs.
 *
 * Shared by the server (authoritative) and the browser (display only).
 *
 * Videos are paid for in Studio credits. 1 Studio credit = 10 Runway API
 * credits ($0.10 at Runway's list price), so a 5-second Seedance 2.5 video at
 * 720p (150 Runway credits) costs 15 Studio credits. Runway rates are from
 * docs.dev.runwayml.com/guides/pricing, checked 9 Nov 2026. The server also
 * cancels any task whose estimatedCost from Runway is higher than ours, so a
 * stale rate here can refuse a request but never overspend.
 *
 * Studio credits are a separate balance from Scene Fixer's fix credits: they
 * are priced off a prepaid pool of Runway credits being sold down, not off
 * what a fix costs to run.
 */

export const RUNWAY_PER_STUDIO_CREDIT = 10;

export type Aspect = "16:9" | "9:16";
export type Resolution = "480p" | "720p" | "1080p";

export type StudioModel = {
  id: "seedance" | "fast";
  runwayModel: "seedance2_5" | "grok_imagine_1_5_lite";
  label: string;
  blurb: string;
  /** Runway credits per second of video, by resolution. */
  perSecond: Partial<Record<Resolution, number>>;
  /** Runway credits added when a start image is sent. */
  imageExtra: number;
  /** Runway's floor per generation, in Runway credits. */
  minRunway: number;
  durations: number[];
  hasAudio: boolean;
  /** Included without limit (fair use) in the Unlimited pass. */
  inPass: boolean;
  /** Runway ratio strings by resolution and shape. */
  ratios: Partial<Record<Resolution, Record<Aspect, string>>>;
};

export const STUDIO_MODELS: StudioModel[] = [
  {
    id: "seedance",
    runwayModel: "seedance2_5",
    label: "Seedance 2.5",
    blurb: "ByteDance's newest video model. Best motion and detail, with sound. Won't animate photos of real people.",
    perSecond: { "480p": 20, "720p": 30, "1080p": 68 },
    imageExtra: 0,
    minRunway: 80,
    durations: [5, 8, 10],
    hasAudio: true,
    inPass: false,
    ratios: {
      "480p": { "16:9": "854:480", "9:16": "480:854" },
      "720p": { "16:9": "1280:720", "9:16": "720:1280" },
      "1080p": { "16:9": "1920:1080", "9:16": "1080:1920" },
    },
  },
  {
    id: "fast",
    runwayModel: "grok_imagine_1_5_lite",
    label: "Fast (Grok Imagine Lite)",
    blurb: "Quick drafts for trying ideas before you spend Seedance credits. Lower quality, no sound.",
    perSecond: { "480p": 2, "720p": 3 },
    imageExtra: 1,
    minRunway: 0,
    durations: [5, 8, 10],
    hasAudio: false,
    inPass: true,
    ratios: {
      "480p": { "16:9": "848:480", "9:16": "480:848" },
      "720p": { "16:9": "1280:720", "9:16": "720:1280" },
    },
  },
];

export function studioModel(id: string): StudioModel | undefined {
  return STUDIO_MODELS.find((m) => m.id === id);
}

export function resolutionsFor(m: StudioModel): Resolution[] {
  return (["480p", "720p", "1080p"] as Resolution[]).filter((r) => m.perSecond[r] !== undefined);
}

/** What Runway will charge, in Runway credits. */
export function runwayCost(m: StudioModel, res: Resolution, seconds: number, hasImage: boolean): number {
  const rate = m.perSecond[res];
  if (rate === undefined) return Infinity;
  return Math.max(m.minRunway, Math.ceil(rate * seconds) + (hasImage ? m.imageExtra : 0));
}

/** What the buyer pays, in Studio credits. */
export function studioCost(m: StudioModel, res: Resolution, seconds: number, hasImage: boolean): number {
  return Math.ceil(runwayCost(m, res, seconds, hasImage) / RUNWAY_PER_STUDIO_CREDIT);
}

/** The yardstick everything is described in: one 5-second Seedance 2.5 video at 720p. */
export const CREDITS_PER_VIDEO = 15;

export type StudioPack = {
  id: "s9" | "s19" | "s49" | "pass";
  price: number;
  credits: number;
  title: string;
  note?: string;
  /** Days of unlimited Fast videos included. */
  passDays?: number;
};

export const STUDIO_PACKS: StudioPack[] = [
  { id: "s9", price: 9, credits: 120, title: "Try it" },
  { id: "s19", price: 19, credits: 270, title: "Creator", note: "most popular" },
  { id: "s49", price: 49, credits: 750, title: "Studio", note: "best value" },
  { id: "pass", price: 29, credits: 300, title: "Unlimited*", passDays: 30 },
];

/**
 * Launch bonus: extra credits on every pack bought before the deadline.
 * A real, dated offer (the base pack is what's sold after it ends), so the
 * "+20%" shown on the page and in the launch email is true.
 */
export const LAUNCH_BONUS = { pct: 20, until: Date.UTC(2026, 10, 15, 23, 59, 59) };

export function launchBonusActive(now = Date.now()): boolean {
  return now <= LAUNCH_BONUS.until;
}

/** Credits a pack grants if bought at `now`, launch bonus included. */
export function packCredits(p: StudioPack, now = Date.now()): { base: number; bonus: number; total: number } {
  const bonus = launchBonusActive(now) ? Math.round((p.credits * LAUNCH_BONUS.pct) / 100) : 0;
  return { base: p.credits, bonus, total: p.credits + bonus };
}

/** Fair-use limit on Fast videos for pass holders, per UTC day. */
export const PASS_FAST_PER_DAY = 20;

export function studioPack(id: string): StudioPack | undefined {
  return STUDIO_PACKS.find((p) => p.id === id);
}

// The Lab's tested limit; Grok Imagine Lite's own maximum isn't documented.
export const STUDIO_MAX_PROMPT = 1000;
export const STUDIO_MAX_IMAGE_BYTES = 1_400_000;
