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
  shotCount: number;
  /** Shots with usable keyframes. Absent on jobs written before this field
   *  existed; treat undefined as "equal to shotCount". */
  shotsAnalyzed?: number;
  errorCount: number;
  fixedCount: number;
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

export const PLAN_LIMITS: Record<Plan, {
  creditsPerMonth: number;  // seconds of Runway output included per month
  maxVideoMinutes: number;
  qualityLabel: string;
  watermark: boolean;
}> = {
  // 30 = two complete 10-second fixes with headroom. At 5 credits a single
  // ~10s shot cost 11 and no free user could ever finish one fix.
  free:    { creditsPerMonth: 30,  maxVideoMinutes: 0.5, qualityLabel: "480p",  watermark: true  },
  // NOTE: free (30) now exceeds starter (20). Deliberate for this deploy —
  // paid grants are frozen until ~20 real fixes give a measured cost-per-fix
  // to reprice from. Starter still differentiates on 720p, no watermark and
  // 5-minute uploads, but the headline credit number is inverted and should
  // not survive the reprice.
  starter: { creditsPerMonth: 20,  maxVideoMinutes: 5,  qualityLabel: "720p",  watermark: false },
  pro:     { creditsPerMonth: 45,  maxVideoMinutes: 15, qualityLabel: "1080p", watermark: false },
  studio:  { creditsPerMonth: 120, maxVideoMinutes: 60, qualityLabel: "1080p", watermark: false },
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
