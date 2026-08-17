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
  free:    { creditsPerMonth: 5,   maxVideoMinutes: 0.5, qualityLabel: "480p",  watermark: true  },
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
