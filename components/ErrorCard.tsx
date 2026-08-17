"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { doc, updateDoc } from "firebase/firestore";
import { auth, db } from "@/lib/firebase";
import type { ContinuityError, BBox, FixMode } from "@/lib/types";
import posthog from "posthog-js";

type Props = {
  error: ContinuityError;
  jobId: string;
  shotAKeyframe: string;
  shotBKeyframe: string;
  onAdjustLocation?: (error: ContinuityError) => void;
};

const SEVERITY_COLORS = {
  low: "text-amber-700 bg-amber-50 border-amber-200",
  medium: "text-orange-700 bg-orange-50 border-orange-200",
  high: "text-red-700 bg-red-50 border-red-200",
};

const TYPE_LABELS: Record<ContinuityError["type"], string> = {
  prop: "Prop",
  wardrobe: "Wardrobe",
  lighting: "Lighting",
  hair: "Hair",
  set_dressing: "Set Dressing",
  eyeline: "Eyeline",
  atmosphere: "Atmosphere",
  other: "Other",
};

const FIX_STATUS_LABELS = {
  pending: null,
  fixing: "Fixing…",
  fixed: "Fixed ✓",
  failed: "Fix failed",
};

function BBoxOverlay({ bbox }: { bbox: BBox }) {
  return (
    <>
      <div
        className="absolute inset-0 z-[5] pointer-events-none"
        style={{
          boxShadow: "inset 0 0 0 9999px rgba(0,0,0,0.35)",
          clipPath: `polygon(
            0 0, 100% 0, 100% 100%, 0 100%, 0 0,
            ${bbox.x * 100}% ${bbox.y * 100}%,
            ${bbox.x * 100}% ${(bbox.y + bbox.h) * 100}%,
            ${(bbox.x + bbox.w) * 100}% ${(bbox.y + bbox.h) * 100}%,
            ${(bbox.x + bbox.w) * 100}% ${bbox.y * 100}%,
            ${bbox.x * 100}% ${bbox.y * 100}%
          )`,
        }}
      />
      <div
        className="absolute z-10 border-[3px] border-red-500 rounded shadow-lg pointer-events-none"
        style={{
          left: `${bbox.x * 100}%`,
          top: `${bbox.y * 100}%`,
          width: `${bbox.w * 100}%`,
          height: `${bbox.h * 100}%`,
          boxSizing: "border-box",
          boxShadow: "0 0 0 1px rgba(255,255,255,0.8), 0 0 12px rgba(239,68,68,0.6)",
        }}
      />
    </>
  );
}

async function getAuthHeaders(): Promise<Record<string, string>> {
  const token = await auth.currentUser?.getIdToken();
  if (token) return { Authorization: `Bearer ${token}` };
  if (typeof window !== "undefined" && localStorage.getItem("sf_beta_mode") === "1") {
    const betaId = localStorage.getItem("sf_beta_id");
    if (betaId) return { "X-Beta-Token": betaId };
  }
  return {};
}

export default function ErrorCard({
  error,
  jobId,
  shotAKeyframe,
  shotBKeyframe,
  onAdjustLocation,
}: Props) {
  const errorRef = doc(db, "jobs", jobId, "errors", error.id);

  const [replaceMode, setReplaceMode] = useState(false);
  const [replaceDraft, setReplaceDraft] = useState(error.replaceWith ?? "");
  const isWholeclipType = error.type === "lighting" || error.type === "atmosphere";
  const [deleting, setDeleting] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [refunding, setRefunding] = useState(false);
  // Auto-collapse low-severity errors; user can toggle any card
  const [collapsed, setCollapsed] = useState(error.severity === "low");

  useEffect(() => {
    setReplaceDraft(error.replaceWith ?? "");
  }, [error.replaceWith]);

  const isFixing = error.fixStatus === "fixing";
  const isSelected = error.userConfirmed && !!error.fixMode;
  const fixStatusLabel = FIX_STATUS_LABELS[error.fixStatus];
  // Wardrobe/hair errors: the right fix is almost always "restore original", not "remove"
  const isRestoreType = error.type === "wardrobe" || error.type === "hair";
  // Set dressing / prop continuity: object may be MISSING from the target shot (need to add, not remove)
  const isAddType = error.type === "set_dressing" || error.type === "prop";
  // For whole-clip types (lighting/atmosphere), bboxes are meaningless —
  // Aleph must regrade the entire clip, not inpaint a region.
  const hasBbox = !isWholeclipType && !!(error.bboxA || error.bboxB);

  // Retry: one free retry when fix completed but verification is high-confidence failure
  const canRetry =
    error.fixStatus === "fixed" &&
    error.verifiedResolved === false &&
    error.verifyResult?.errorStillVisible === true &&
    error.verifyResult?.confidence === "high" &&
    (error.retryCount ?? 0) < 1;

  // Refund: after retry also fails (or if already retried once and still bad)
  const canRefund =
    error.fixStatus === "fixed" &&
    error.verifiedResolved === false &&
    error.verifyResult?.errorStillVisible === true &&
    (error.retryCount ?? 0) >= 1;

  const baseUpdate = (over: Record<string, unknown>) => ({
    ...over,
    ...(error.fixStatus === "fixed" || error.fixStatus === "failed"
      ? { fixStatus: "pending" }
      : {}),
  });

  const pickRemove = async () => {
    if (isFixing) return;
    setReplaceMode(false);
    await updateDoc(errorRef, baseUpdate({ userConfirmed: true, fixMode: "remove", replaceWith: "" }));
    posthog.capture("error_confirmed", { job_id: jobId, error_id: error.id, error_type: error.type, severity: error.severity, fix_mode: "remove" });
  };

  const pickWholeclip = async () => {
    if (isFixing) return;
    const prompt = (error.fixSuggestion || error.description || "Fix the visual inconsistency").trim();
    await updateDoc(errorRef, baseUpdate({ userConfirmed: true, fixMode: "replace", replaceWith: prompt }));
    posthog.capture("error_confirmed", { job_id: jobId, error_id: error.id, error_type: error.type, severity: error.severity, fix_mode: "wholeclip" });
  };

  const pickRestore = async () => {
    if (isFixing) return;
    const suggestion = (error.fixSuggestion || error.description || "").trim();
    await updateDoc(errorRef, baseUpdate({ userConfirmed: true, fixMode: "replace", replaceWith: suggestion }));
    posthog.capture("error_confirmed", { job_id: jobId, error_id: error.id, error_type: error.type, severity: error.severity, fix_mode: "restore" });
  };

  const pickAdd = () => {
    if (isFixing) return;
    // Pre-fill the replace input with Claude's fix suggestion so the user
    // can review/edit before submitting. The Aleph prompt for "add" types
    // uses a different template that places the object rather than replacing it.
    setReplaceDraft((error.fixSuggestion || error.description || "").trim());
    setReplaceMode(true);
  };

  const pickRemoveFromSource = async () => {
    if (isFixing) return;
    // Flip the fix direction: instead of adding the object to Shot B,
    // remove it from Shot A so both shots are consistent.
    const flippedDirection = error.fixDirection === "aTob" ? "bToA" : "aTob";
    await updateDoc(errorRef, baseUpdate({
      userConfirmed: true,
      fixMode: "remove",
      fixDirection: flippedDirection,
    }));
    posthog.capture("error_confirmed", { job_id: jobId, error_id: error.id, error_type: error.type, severity: error.severity, fix_mode: "remove_from_source" });
  };

  const pickReplace = async () => {
    if (isFixing) return;
    const value = replaceDraft.trim().slice(0, 200);
    if (!value) return;
    setReplaceMode(false);
    await updateDoc(errorRef, baseUpdate({ userConfirmed: true, fixMode: "replace", replaceWith: value }));
    posthog.capture("error_confirmed", { job_id: jobId, error_id: error.id, error_type: error.type, severity: error.severity, fix_mode: "replace" });
  };

  const reset = async () => {
    if (isFixing) return;
    setReplaceDraft("");
    setReplaceMode(false);
    await updateDoc(errorRef, { userConfirmed: false, fixMode: "", replaceWith: "" });
  };

  const handleDelete = async () => {
    if (isFixing || deleting) return;
    setDeleting(true);
    try {
      const headers = await getAuthHeaders();
      await fetch(`/api/jobs/${jobId}/errors/${error.id}`, { method: "DELETE", headers });
    } catch {
      setDeleting(false);
    }
  };

  const handleRetry = async () => {
    if (retrying) return;
    setRetrying(true);
    try {
      const headers = await getAuthHeaders();
      const res = await fetch(`/api/jobs/${jobId}/errors/${error.id}/retry`, { method: "POST", headers });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        console.error("Retry failed:", data.error);
      }
      posthog.capture("error_retry", { job_id: jobId, error_id: error.id, error_type: error.type });
    } catch (err) {
      console.error("Retry error:", err);
    } finally {
      setRetrying(false);
    }
  };

  const handleRefund = async () => {
    if (refunding) return;
    setRefunding(true);
    try {
      const headers = await getAuthHeaders();
      const res = await fetch(`/api/jobs/${jobId}/errors/${error.id}/refund`, { method: "POST", headers });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        console.error("Refund failed:", data.error);
      }
      posthog.capture("error_refunded", { job_id: jobId, error_id: error.id });
    } catch (err) {
      console.error("Refund error:", err);
    } finally {
      setRefunding(false);
    }
  };

  const borderClass = isSelected ? "border-black bg-gray-50" : "border-gray-200 bg-white";

  return (
    <div className={`rounded-2xl border p-5 transition-colors ${borderClass}`}>
      {/* Header: badges + collapse toggle + delete */}
      <div className="flex items-start justify-between gap-2 mb-3">
        <div className="flex items-center gap-2 flex-wrap flex-1 min-w-0">
          <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-gray-100 text-gray-700">
            {TYPE_LABELS[error.type]}
          </span>
          <span className={`text-xs font-medium px-2 py-0.5 rounded-full border ${SEVERITY_COLORS[error.severity]}`}>
            {error.severity}
          </span>
          {fixStatusLabel && (
            <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${
              error.fixStatus === "fixed"
                ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
                : error.fixStatus === "failed"
                  ? "bg-red-50 text-red-700 border border-red-200"
                  : "bg-gray-100 text-gray-700 animate-pulse"
            }`}>
              {fixStatusLabel}
            </span>
          )}
          {/* Collapsed: show truncated description inline */}
          {collapsed && (
            <span className="text-xs text-gray-500 truncate max-w-[200px]">{error.description}</span>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {/* Collapse toggle */}
          <button
            type="button"
            onClick={() => setCollapsed((c) => !c)}
            className="text-gray-400 hover:text-gray-700 transition-colors text-xs leading-none px-1"
            title={collapsed ? "Expand" : "Collapse"}
            aria-label={collapsed ? "Expand error" : "Collapse error"}
          >
            {collapsed ? "▼" : "▲"}
          </button>

          {!isFixing && (
            <button
              type="button"
              onClick={handleDelete}
              disabled={deleting}
              className="text-gray-300 hover:text-red-400 transition-colors text-sm leading-none disabled:opacity-40"
              title="Remove this error"
            >
              ✕
            </button>
          )}
        </div>
      </div>

      {/* Collapsible body */}
      {!collapsed && (
        <>
          {/* Description */}
          <p className="text-gray-900 text-sm mb-4">{error.description}</p>

          {/* Action row */}
          <div className="mb-4">
            {!isSelected && !replaceMode && (
              <>
                {!hasBbox && onAdjustLocation ? (
                  isWholeclipType ? (
                    <div className="flex flex-col gap-2">
                      <p className="text-xs text-gray-600">
                        This is a whole-clip adjustment — can&apos;t mark precisely.
                        Aleph will apply the fix across the entire clip.
                      </p>
                      <button
                        type="button"
                        onClick={pickWholeclip}
                        disabled={isFixing}
                        className="px-4 py-1.5 rounded-lg bg-black hover:bg-gray-800 text-white text-sm font-medium transition-colors disabled:opacity-50 self-start"
                      >
                        Apply to whole clip →
                      </button>
                    </div>
                  ) : (
                    <div className="flex flex-col gap-2">
                      <p className="text-xs text-gray-600">
                        Auto-detection couldn&apos;t pinpoint the exact location. Mark it
                        yourself to continue.
                      </p>
                      <button
                        type="button"
                        onClick={() => onAdjustLocation(error)}
                        disabled={isFixing}
                        className="px-4 py-1.5 rounded-lg bg-black hover:bg-gray-800 text-white text-sm font-medium transition-colors disabled:opacity-50 self-start"
                      >
                        Pinpoint the location →
                      </button>
                    </div>
                  )
                ) : isRestoreType ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={pickRestore}
                      disabled={isFixing}
                      className="px-4 py-1.5 rounded-lg bg-black hover:bg-gray-800 text-white text-sm font-medium transition-colors disabled:opacity-50"
                    >
                      Restore original
                    </button>
                    <button
                      type="button"
                      onClick={() => setReplaceMode(true)}
                      disabled={isFixing}
                      className="px-4 py-1.5 rounded-lg border border-gray-300 bg-white hover:bg-gray-50 text-gray-900 text-sm font-medium transition-colors disabled:opacity-50"
                    >
                      Replace with…
                    </button>
                    <button
                      type="button"
                      onClick={pickRemove}
                      disabled={isFixing}
                      className="px-3 py-1.5 rounded-lg text-gray-400 hover:text-gray-700 text-sm transition-colors disabled:opacity-50"
                      title="Remove the item entirely instead of restoring it"
                    >
                      Remove
                    </button>
                    {onAdjustLocation && (
                      <button
                        type="button"
                        onClick={() => onAdjustLocation(error)}
                        disabled={isFixing}
                        className="ml-auto px-3 py-1.5 rounded-lg border border-gray-300 bg-white hover:bg-gray-50 text-gray-700 text-sm font-medium transition-colors disabled:opacity-50"
                        title="If the red box below isn't on the right spot, click to mark it yourself."
                      >
                        Wrong spot? Adjust →
                      </button>
                    )}
                  </div>
                ) : isAddType ? (
                  <div className="flex flex-col gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={pickAdd}
                        disabled={isFixing}
                        className="px-4 py-1.5 rounded-lg bg-black hover:bg-gray-800 text-white text-sm font-medium transition-colors disabled:opacity-50"
                      >
                        Add to shot
                      </button>
                      <button
                        type="button"
                        onClick={pickRemoveFromSource}
                        disabled={isFixing}
                        className="px-4 py-1.5 rounded-lg border border-gray-300 bg-white hover:bg-gray-50 text-gray-900 text-sm font-medium transition-colors disabled:opacity-50"
                      >
                        Remove from Shot A instead
                      </button>
                      {onAdjustLocation && (
                        <button
                          type="button"
                          onClick={() => onAdjustLocation(error)}
                          disabled={isFixing}
                          className="ml-auto px-3 py-1.5 rounded-lg border border-gray-300 bg-white hover:bg-gray-50 text-gray-700 text-sm font-medium transition-colors disabled:opacity-50"
                          title="Mark where the object should appear."
                        >
                          Mark location →
                        </button>
                      )}
                    </div>
                    <p className="text-xs text-gray-400">
                      Adding is experimental — Aleph may not match the original object exactly. Removing from Shot A is easier and more reliable.
                    </p>
                  </div>
                ) : (
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={pickRemove}
                      disabled={isFixing}
                      className="px-4 py-1.5 rounded-lg bg-black hover:bg-gray-800 text-white text-sm font-medium transition-colors disabled:opacity-50"
                    >
                      Remove
                    </button>
                    <button
                      type="button"
                      onClick={() => setReplaceMode(true)}
                      disabled={isFixing}
                      className="px-4 py-1.5 rounded-lg border border-gray-300 bg-white hover:bg-gray-50 text-gray-900 text-sm font-medium transition-colors disabled:opacity-50"
                    >
                      Replace with…
                    </button>
                    {onAdjustLocation && (
                      <button
                        type="button"
                        onClick={() => onAdjustLocation(error)}
                        disabled={isFixing}
                        className="ml-auto px-3 py-1.5 rounded-lg border border-gray-300 bg-white hover:bg-gray-50 text-gray-700 text-sm font-medium transition-colors disabled:opacity-50"
                        title="If the red box below isn't on the right spot, click to mark it yourself."
                      >
                        Wrong spot? Adjust →
                      </button>
                    )}
                  </div>
                )}
              </>
            )}

            {!isSelected && replaceMode && (
              <div className="flex flex-wrap items-center gap-2">
                <input
                  autoFocus
                  type="text"
                  value={replaceDraft}
                  onChange={(e) => setReplaceDraft(e.target.value.slice(0, 200))}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") { e.preventDefault(); pickReplace(); }
                    else if (e.key === "Escape") { setReplaceMode(false); setReplaceDraft(error.replaceWith ?? ""); }
                  }}
                  placeholder="Replace with what? e.g. an empty section of the wooden table"
                  className="flex-1 min-w-[200px] rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm text-black placeholder:text-gray-400 outline-none focus:border-black"
                />
                <button
                  type="button"
                  onClick={pickReplace}
                  disabled={!replaceDraft.trim()}
                  className="px-4 py-1.5 rounded-lg bg-black hover:bg-gray-800 text-white text-sm font-medium transition-colors disabled:opacity-40"
                >
                  Apply
                </button>
                <button
                  type="button"
                  onClick={() => { setReplaceMode(false); setReplaceDraft(error.replaceWith ?? ""); }}
                  className="px-3 py-1.5 rounded-lg text-gray-500 hover:text-black text-sm transition-colors"
                >
                  Cancel
                </button>
              </div>
            )}

            {isSelected && (
              <div className="flex items-center justify-between gap-3 rounded-lg bg-gray-100 border border-gray-200 px-3 py-2">
                <span className="text-sm text-gray-900">
                  {error.fixMode === "remove" && isAddType && error.fixDirection !== "aTob" ? (
                    <><span className="font-medium">Will remove from Shot A</span>{" "}<span className="text-gray-500">and fill in the background.</span></>
                  ) : error.fixMode === "remove" ? (
                    <><span className="font-medium">Will remove</span>{" "}<span className="text-gray-500">and fill in the background.</span></>
                  ) : isWholeclipType ? (
                    <><span className="font-medium">Whole-clip fix:</span>{" "}<span className="text-gray-500 text-xs">{error.replaceWith}</span></>
                  ) : isRestoreType && error.replaceWith === error.fixSuggestion ? (
                    <><span className="font-medium">Will restore original</span>{" "}<span className="text-gray-500 text-xs truncate max-w-[260px]">— {error.replaceWith}</span></>
                  ) : isAddType && error.replaceWith === error.fixSuggestion ? (
                    <><span className="font-medium">Will add to shot</span>{" "}<span className="text-gray-500 text-xs truncate max-w-[260px]">— {error.replaceWith}</span></>
                  ) : (
                    <><span className="font-medium">Will replace with</span>{" "}<span className="text-black">&ldquo;{error.replaceWith}&rdquo;</span></>
                  )}
                </span>
                <button
                  type="button"
                  onClick={reset}
                  disabled={isFixing}
                  className="text-xs text-gray-500 hover:text-black underline underline-offset-2 disabled:opacity-50"
                >
                  Change
                </button>
              </div>
            )}
          </div>

          {hasBbox && !isSelected && (
            <p className="text-xs text-gray-600 mb-2">
              <span className="text-red-600 font-medium">↓</span> Check the highlighted
              area on the {error.fixDirection === "bToA" ? "left" : "right"} keyframe —
              is the red box on the right spot? If not, hit{" "}
              <span className="font-medium">Wrong spot? Adjust →</span>.
            </p>
          )}

          {/* Side-by-side keyframes */}
          {(() => {
            const targetIsA = error.fixDirection === "bToA";
            return (
              <div className="grid grid-cols-2 gap-2">
                <div className="relative">
                  <p className={`text-[10px] mb-1 uppercase tracking-wider font-medium ${targetIsA ? "text-red-600" : "text-gray-400"}`}>
                    Shot A {targetIsA ? "(to fix)" : "(reference)"}
                  </p>
                  <div className="relative rounded-lg overflow-hidden aspect-video bg-gray-100">
                    <Image src={shotAKeyframe} alt="Shot A keyframe" fill className="object-cover" unoptimized />
                    {error.bboxA && <BBoxOverlay bbox={error.bboxA} />}
                  </div>
                </div>
                <div className="relative">
                  <p className={`text-[10px] mb-1 uppercase tracking-wider font-medium ${targetIsA ? "text-gray-400" : "text-red-600"}`}>
                    Shot B {targetIsA ? "(reference)" : "(to fix)"}
                  </p>
                  <div className="relative rounded-lg overflow-hidden aspect-video bg-gray-100">
                    <Image src={shotBKeyframe} alt="Shot B keyframe" fill className="object-cover" unoptimized />
                    {error.bboxB && <BBoxOverlay bbox={error.bboxB} />}
                  </div>
                </div>
              </div>
            );
          })()}

          {/* Before / After clip comparison */}
          {error.fixStatus === "fixed" && error.fixedClipUrl && (
            <div className="mt-4">
              <div className="grid grid-cols-2 gap-2">
                {error.originalClipUrl && (
                  <div>
                    <p className="text-[10px] text-gray-400 mb-1 uppercase tracking-wider">Before</p>
                    <video src={error.originalClipUrl} controls loop muted className="w-full rounded-lg bg-black aspect-video" />
                  </div>
                )}
                <div className={error.originalClipUrl ? "" : "col-span-2"}>
                  <div className="flex items-center justify-between mb-1">
                    <p className="text-[10px] text-emerald-700 uppercase tracking-wider">After (Aleph)</p>
                    <a href={error.fixedClipUrl} download className="text-[10px] font-semibold text-emerald-700 hover:text-emerald-900 underline underline-offset-2 transition-colors">
                      Download ↓
                    </a>
                  </div>
                  <video src={error.fixedClipUrl} controls loop muted className="w-full rounded-lg bg-black aspect-video" />
                </div>
              </div>

              {error.markerUrl && (
                <div className="mt-2">
                  <p className="text-[10px] text-red-700 mb-1 uppercase tracking-wider">Marker frame sent to Aleph (red box = inpainting mask)</p>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={error.markerUrl} alt="marker frame" className="w-full rounded-lg bg-gray-100 aspect-video object-contain" />
                </div>
              )}

              {error.verifyResult && (
                <div className={`mt-2 rounded-lg px-3 py-2.5 text-xs border ${
                  error.verifyResult.errorStillVisible === false
                    ? "bg-emerald-50 text-emerald-800 border-emerald-200"
                    : error.verifyResult.errorStillVisible === true
                      ? "bg-red-50 text-red-800 border-red-200"
                      : "bg-gray-50 text-gray-600 border-gray-200"
                }`}>
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <span className="font-semibold">
                        {error.verifyResult.errorStillVisible === false
                          ? "Verified fixed"
                          : error.verifyResult.errorStillVisible === true
                            ? "Error still visible"
                            : "Verification inconclusive"}
                      </span>{" "}
                      <span className="opacity-70">({error.verifyResult.confidence} confidence)</span>
                      {" — "}
                      {error.verifyResult.notes}
                    </div>

                    {/* Retry / Refund actions */}
                    {canRetry && (
                      <button
                        type="button"
                        onClick={handleRetry}
                        disabled={retrying}
                        className="shrink-0 px-3 py-1 rounded-lg bg-red-700 hover:bg-red-800 text-white text-xs font-semibold transition-colors disabled:opacity-50 whitespace-nowrap"
                      >
                        {retrying ? "Retrying…" : "Retry for free →"}
                      </button>
                    )}
                    {canRefund && (
                      <button
                        type="button"
                        onClick={handleRefund}
                        disabled={refunding}
                        className="shrink-0 px-3 py-1 rounded-lg border border-red-300 text-red-700 hover:bg-red-50 text-xs font-semibold transition-colors disabled:opacity-50 whitespace-nowrap"
                      >
                        {refunding ? "Refunding…" : "Refund fix →"}
                      </button>
                    )}
                  </div>
                  {canRetry && (
                    <p className="mt-1.5 text-[11px] opacity-60">One free retry — Aleph will try again with a stronger instruction.</p>
                  )}
                  {canRefund && (
                    <p className="mt-1.5 text-[11px] opacity-60">This fix failed after retry. Refunding adds 1 fix credit back to your account.</p>
                  )}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
