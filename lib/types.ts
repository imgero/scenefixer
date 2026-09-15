import type { Timestamp } from "firebase/firestore";

export type JobStatus =
  | "uploading"
  | "decomposing"
  | "detecting"
  | "awaiting_confirmation"
  | "fixing"
  | "verifying"
  | "reprocessing"
  | "done"
  | "error";

export type Job = {
  id: string;
  status: JobStatus;
  inputVideoUrl: string;
  outputVideoUrl?: string;
  stitchVideoUrl?: string;
  outputQuality?: string;
  watermark?: boolean;
  scoreBefore?: number;
  scoreAfter?: number;
  /**
   * Whether scoreAfter is comparable to scoreBefore.
   *
   * False when the verify pass resolved a different shot structure than the
   * input had (one shot means no pairs, so detection finds nothing and the
   * score comes back 100 regardless), or when nothing verified yet the score
   * rose anyway. Absent on jobs written before this existed — and those are
   * exactly the jobs whose flattering before/after numbers cannot be trusted,
   * so treat undefined as "unknown", never as "reliable".
   */
  scoreAfterReliable?: boolean;
  /** Why the after-score is missing or unchanged, when it is. */
  scoreAfterNote?: string;
  shotCount: number;
  /** Shots with usable keyframes. Absent on jobs written before this field
   *  existed; treat undefined as "equal to shotCount". */
  shotsAnalyzed?: number;
  errorCount: number;
  fixedCount: number;
  /**
   * Analysis stopped at the free budget rather than covering the whole video.
   *
   * Replaces the old hard rejection. A video longer than the plan's analysis
   * budget is scanned up to that budget and the findings shown, with the
   * boundary stated and the remainder offered for credits. Absent on jobs
   * written before this existed — treat undefined as "fully analysed", which
   * is what those jobs were, since anything longer was rejected outright.
   */
  analysisTruncated?: boolean;
  /** Seconds of the video actually analysed. */
  analysedSeconds?: number;
  /** Full duration of the uploaded video. */
  totalSeconds?: number;
  /** Per-run fix outcomes. Absent on jobs written before these existed.
   *
   *  A job where every fix threw is written as "error", not "done". But a fix
   *  that RAN can still leave the error visible, and that is not a success
   *  either — so "done" means the pipeline finished, and `verificationPassed`
   *  says whether it actually fixed anything. Read that flag, not the status,
   *  before telling a user their video is fixed. */
  fixesAttempted?: number;
  /** Verifier confirmed the error is gone. */
  fixesVerified?: number;
  /** Ran and produced output, but the error is still visible. Credits refunded. */
  fixesUnverified?: number;
  /** Threw before producing anything. Credits refunded. */
  fixesFailed?: number;
  /** False when not one error came back verified. */
  verificationPassed?: boolean;
  /** Total credits returned to the owner for this run. */
  creditsRefunded?: number;
  userHint?: string;
  createdAt: Timestamp;
  fixingStartedAt?: number;
  errorMessage?: string;
  isPublic?: boolean;
  betaToken?: string;
};

export type Shot = {
  id: string;
  index: number;
  startMs: number;
  endMs: number;
  keyframeUrl: string;
  keyframeUrls?: string[];
};

export type ErrorType =
  | "prop"
  | "wardrobe"
  | "lighting"
  | "hair"
  | "set_dressing"
  | "eyeline"
  | "atmosphere"
  | "other";

export type FixStatus = "pending" | "fixing" | "fixed" | "failed";

export type BBox = { x: number; y: number; w: number; h: number };

export type FixMode = "remove" | "replace";

export type ContinuityError = {
  id: string;
  shotAId: string;
  shotBId: string;
  type: ErrorType;
  description: string;
  fixSuggestion: string;
  severity: "low" | "medium" | "high";
  bboxA?: BBox;
  bboxB?: BBox;
  // Multi-bbox support — when set, takes precedence over bboxA/bboxB.
  // Used when the user draws multiple boxes for scattered errors (e.g.
  // multiple bullet holes).
  bboxes?: BBox[];
  userConfirmed: boolean;
  fixDirection?: "aTob" | "bToA";
  fixMode?: FixMode;
  replaceWith?: string;
  // Manual marker fields — set when the user marked the error themselves
  // via the ManualMarker UI (bypasses Opus detection + relocation).
  manualMarker?: boolean;
  manualFrameUrl?: string;
  manualFramePct?: number;
  fixStatus: FixStatus;
  fixedClipUrl?: string;
  originalClipUrl?: string;
  markerUrl?: string;
  relocatedBbox?: BBox;
  alephPrompt?: string;
  retryCount?: number;
  /**
   * Whether editing the footage can plausibly repair this.
   *
   * False for anything needing a re-shoot, re-frame or re-stage — camera
   * movement, shot scale, eyeline, a subject morphing. Those are still worth
   * showing the user, but must never be offered a fix: every attempt spends
   * Runway credits on a result the verifier correctly rejects. Absent means
   * repairable, so errors detected before this field existed are unaffected.
   */
  repairable?: boolean;
  notRepairableReason?: string;
  /**
   * How many detected findings this error represents.
   *
   * Detection reports a systemic defect once per shot pair that happens to
   * show it — a video whose characters change clothes throughout produced
   * twelve separate wardrobe errors, three of them on one shot. Those are
   * collapsed to one error per (shot, defect class), because they are one
   * edit. Absent or 1 means nothing was merged.
   */
  mergedCount?: number;
  /** The other findings' descriptions, so none is hidden from the user. */
  mergedDescriptions?: string[];
  /**
   * Written by Claude when a fix failed for a reason nothing in the pipeline
   * anticipated — a provider changing what it accepts, an unusual file, a new
   * limit. `message` is shown to the user verbatim in place of the raw
   * exception; `actions` are rendered as buttons. Absent for failures that had
   * a specific handler, and absent when the diagnosis itself could not run.
   */
  diagnosis?: {
    cause?: string;
    message: string;
    actions?: { label: string; kind: string }[];
    retryable?: boolean;
    confidence?: "low" | "medium" | "high";
  };
  /** The original exception text, kept when `errorMessage` was replaced. */
  rawErrorMessage?: string;
  /** Overrides automatic engine routing — used to retry on a different model. */
  fixEngine?: string;
  fixEngineUsed?: string;
  verifiedResolved: boolean;
  verifyResult?: {
    errorStillVisible: boolean | null;
    confidence: "low" | "medium" | "high";
    notes: string;
  };
  createdAt: Timestamp;
};

export type RecentJob = {
  id: string;
  filename: string;
  createdAt: number;
};

export type Plan = "free" | "starter" | "pro" | "studio";

/**
 * Seconds of video analysed for free per upload, by plan.
 *
 * Must stay in step with `_FREE_ANALYSIS_SECONDS` in modal_app/decompose.py,
 * which is where it is actually enforced. This copy exists so the UI can state
 * the budget before an upload rather than after.
 */
export const FREE_ANALYSIS_SECONDS: Record<Plan, number> = {
  free: 300, starter: 900, pro: 1800, studio: 3600,
};

/** Free scans per day before a scan draws on credits. */
export const FREE_SCANS_PER_DAY = 3;

export const PLAN_LIMITS: Record<Plan, {
  creditsPerMonth: number;  // seconds of Runway output included per month
  qualityLabel: string;
  watermark: boolean;
}> = {
  // 90 credits = 90 seconds of fixed output a month.
  //
  // Deliberately generous, and the generosity is close to free: fixes draw on
  // a PREPAID Runway balance (230,812 credits sitting unused as of 13 Sep), so
  // the marginal cash cost of a fix is zero — the money is already spent. What
  // costs live cash is analysis (Claude vision, billed per scan), and that is
  // bounded separately by FREE_ANALYSIS_SECONDS and FREE_SCANS_PER_DAY.
  //
  // The objective right now is successful fixes and downloads, not revenue.
  // Only 2 of 8 fix attempts in the 8-13 Sep window ever verified, and no user
  // has yet downloaded a video this product demonstrably repaired. Until that
  // happens the grant should not be what stops anyone, and it can be cut once
  // there is something to protect.
  free:    { creditsPerMonth: 90,  qualityLabel: "480p",  watermark: true  },
  // Legacy subscription tiers. No longer sold — the pricing page is credit
  // packs only — but existing subscribers keep their grant until they cancel,
  // so these must keep resolving. The old free-30 > starter-20 inversion is
  // gone now that free is 90; these are kept above it in quality terms only
  // (720p+, no watermark), which is what they always really differentiated on.
  starter: { creditsPerMonth: 120, qualityLabel: "720p",  watermark: false },
  pro:     { creditsPerMonth: 300, qualityLabel: "1080p", watermark: false },
  studio:  { creditsPerMonth: 800, qualityLabel: "1080p", watermark: false },
};

export type UserDoc = {
  uid: string;
  email: string;
  plan: Plan;
  creditsUsedThisMonth: number;  // seconds of Runway output used this month
  monthResetAt: number;
  stripeCustomerId?: string;
  creditsBalance?: number;       // extra seconds purchased via one-time packs
  createdAt: number;
};
