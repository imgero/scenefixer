"use client";

import {
  MouseEvent as ReactMouseEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import { auth } from "@/lib/firebase";
import type { Shot, ContinuityError } from "@/lib/types";

type Props = {
  jobId: string;
  shots: Shot[];
  onClose: () => void;
  onCreated?: (errorId: string) => void;
  existingError?: ContinuityError;
  betaToken?: string | null;
};

type Picked = {
  shotId: string;
  frameUrl: string;
  framePct: number; // 0..1 — position of this frame within the shot
};

type BBoxNorm = { x: number; y: number; w: number; h: number };

// Compute the 0..1 position of each keyframe within its shot. With 5
// keyframes the offsets are roughly 10/30/50/70/90% — but we map them
// linearly so the marker frame_pct passed to fix.py matches.
function framePctForIndex(idx: number, total: number): number {
  if (total <= 1) return 0.5;
  return idx / (total - 1);
}

export default function ManualMarker({
  jobId,
  shots,
  onClose,
  onCreated,
  existingError,
  betaToken,
}: Props) {
  const adjusting = !!existingError;
  const [picked, setPicked] = useState<Picked | null>(null);
  const [bboxes, setBboxes] = useState<BBoxNorm[]>([]);
  const [description, setDescription] = useState(existingError?.description ?? "");
  const [mode, setMode] = useState<"remove" | "replace">("remove");
  const [replaceWith, setReplaceWith] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Drag state — track in pixels relative to the image element
  const imgWrapRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ x: number; y: number } | null>(null);
  const [previewBbox, setPreviewBbox] = useState<BBoxNorm | null>(null);

  // Reset boxes when the picked frame changes — they no longer apply
  useEffect(() => {
    setBboxes([]);
    setPreviewBbox(null);
  }, [picked?.frameUrl]);

  // Keyboard: Esc closes the modal
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const startDrag = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (!imgWrapRef.current) return;
    const rect = imgWrapRef.current.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    dragRef.current = { x, y };
    setPreviewBbox({ x, y, w: 0, h: 0 });
  };
  const continueDrag = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (!dragRef.current || !imgWrapRef.current) return;
    const rect = imgWrapRef.current.getBoundingClientRect();
    const cx = (e.clientX - rect.left) / rect.width;
    const cy = (e.clientY - rect.top) / rect.height;
    const x1 = Math.min(dragRef.current.x, cx);
    const y1 = Math.min(dragRef.current.y, cy);
    const x2 = Math.max(dragRef.current.x, cx);
    const y2 = Math.max(dragRef.current.y, cy);
    setPreviewBbox({
      x: Math.max(0, x1),
      y: Math.max(0, y1),
      w: Math.min(1, x2 - x1),
      h: Math.min(1, y2 - y1),
    });
  };
  const endDrag = () => {
    dragRef.current = null;
    // Commit the just-drawn box to the list — supports drawing many on the
    // same frame (e.g. multiple bullet holes).
    if (previewBbox && previewBbox.w > 0.01 && previewBbox.h > 0.01) {
      setBboxes((prev) => [...prev, previewBbox]);
    }
    setPreviewBbox(null);
  };

  const removeBox = (i: number) => {
    setBboxes((prev) => prev.filter((_, idx) => idx !== i));
  };

  const canSubmit =
    !!picked &&
    bboxes.length > 0 &&
    description.trim().length > 0 &&
    (adjusting ||
      mode === "remove" ||
      (mode === "replace" && replaceWith.trim().length > 0)) &&
    !submitting;

  // A disabled button with no reason reads as broken. Name the first missing
  // step, in the order the modal asks for them.
  const missingStep = !picked
    ? "Pick a frame on the left."
    : bboxes.length === 0
      ? "Drag on the frame to draw a box around the error."
      : !adjusting && description.trim().length === 0
        ? "Describe what it is."
        : !adjusting && mode === "replace" && replaceWith.trim().length === 0
          ? "Say what to replace it with."
          : null;

  const submit = async () => {
    if (!picked || bboxes.length === 0) return;
    setSubmitting(true);
    setError(null);
    try {
      const token = await auth.currentUser?.getIdToken();
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (token) headers["Authorization"] = `Bearer ${token}`;
      else if (betaToken) headers["X-Beta-Token"] = betaToken;

      const res = await fetch(`/api/jobs/${jobId}/manual-error`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          shotId: picked.shotId,
          frameUrl: picked.frameUrl,
          framePct: picked.framePct,
          // First box stays under `bbox` for backwards compat; full array
          // goes under `bboxes` for the multi-region drawing path.
          bbox: bboxes[0],
          bboxes,
          description: description.trim().slice(0, 300),
          fixMode: adjusting ? undefined : mode,
          replaceWith: mode === "replace" ? replaceWith.trim().slice(0, 200) : "",
          existingErrorId: existingError?.id,
        }),
      });
      if (!res.ok) {
        const t = await res.text();
        throw new Error(t);
      }
      const data = await res.json();
      onCreated?.(data.errorId);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl shadow-2xl w-full max-w-5xl max-h-[90vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <div>
            <h2 className="text-lg font-semibold text-black">
              {adjusting ? "Adjust the location" : "Mark error manually"}
            </h2>
            <p className="text-xs text-gray-500 mt-0.5">
              {adjusting
                ? "Pick the frame where the error is clearest, then drag to draw a tight box around it."
                : "Pick the frame where the error is visible, then drag to draw a box around it."}
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-black text-sm"
            type="button"
          >
            Close ✕
          </button>
        </div>

        <div className="flex-1 overflow-auto p-6 grid grid-cols-12 gap-6">
          {/* Left: shot/frame grid */}
          <div className="col-span-12 md:col-span-5 overflow-auto max-h-[60vh] pr-2">
            <p className="text-[10px] uppercase tracking-widest text-gray-500 mb-2">
              All keyframes
            </p>
            <div className="space-y-4">
              {shots.map((shot) => {
                const frames =
                  shot.keyframeUrls && shot.keyframeUrls.length > 0
                    ? shot.keyframeUrls
                    : [shot.keyframeUrl];
                return (
                  <div key={shot.id}>
                    <p className="text-[10px] text-gray-400 mb-1">
                      Shot {shot.index + 1} · {Math.round(shot.startMs / 1000)}–
                      {Math.round(shot.endMs / 1000)}s
                    </p>
                    <div className="grid grid-cols-3 gap-1.5">
                      {frames.map((url, i) => {
                        const isPicked =
                          picked?.frameUrl === url && picked.shotId === shot.id;
                        return (
                          <button
                            key={url + i}
                            type="button"
                            onClick={() =>
                              setPicked({
                                shotId: shot.id,
                                frameUrl: url,
                                framePct: framePctForIndex(i, frames.length),
                              })
                            }
                            className={[
                              "relative rounded-md overflow-hidden aspect-video transition-all",
                              isPicked
                                ? "ring-2 ring-black"
                                : "ring-1 ring-gray-200 hover:ring-gray-400",
                            ].join(" ")}
                          >
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                              src={url}
                              alt={`shot ${shot.index} frame ${i + 1}`}
                              className="w-full h-full object-cover"
                            />
                            <span className="absolute bottom-0.5 right-1 text-[9px] text-white bg-black/60 px-1 rounded">
                              {Math.round(framePctForIndex(i, frames.length) * 100)}%
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Right: drawing canvas + controls */}
          <div className="col-span-12 md:col-span-7 flex flex-col">
            {picked ? (
              <>
                <p className="text-[10px] uppercase tracking-widest text-gray-500 mb-2">
                  Drag to draw a box around the error
                  {bboxes.length > 0 && (
                    <span className="ml-2 normal-case tracking-normal text-gray-400">
                      · {bboxes.length} box{bboxes.length !== 1 ? "es" : ""} drawn ·
                      drag again to add more
                    </span>
                  )}
                </p>
                <div
                  ref={imgWrapRef}
                  onMouseDown={startDrag}
                  onMouseMove={continueDrag}
                  onMouseUp={endDrag}
                  onMouseLeave={endDrag}
                  className="relative rounded-lg overflow-hidden bg-gray-100 select-none cursor-crosshair aspect-video"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={picked.frameUrl}
                    alt="picked frame"
                    draggable={false}
                    className="absolute inset-0 w-full h-full object-contain pointer-events-none"
                  />
                  {/* Committed boxes — each with a delete handle */}
                  {bboxes.map((b, i) => (
                    <div
                      key={i}
                      className="absolute border-2 border-red-500"
                      style={{
                        left: `${b.x * 100}%`,
                        top: `${b.y * 100}%`,
                        width: `${b.w * 100}%`,
                        height: `${b.h * 100}%`,
                        boxSizing: "border-box",
                      }}
                    >
                      <button
                        type="button"
                        onMouseDown={(e) => {
                          // Prevent triggering a new drag on the canvas
                          e.stopPropagation();
                        }}
                        onClick={(e) => {
                          e.stopPropagation();
                          removeBox(i);
                        }}
                        className="absolute -top-2 -right-2 w-5 h-5 rounded-full bg-red-500 text-white text-[11px] leading-none flex items-center justify-center hover:bg-red-600 shadow"
                        title="Delete this box"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                  {/* In-progress preview box (dashed) */}
                  {previewBbox && (
                    <div
                      className="absolute border-2 border-red-500 border-dashed pointer-events-none"
                      style={{
                        left: `${previewBbox.x * 100}%`,
                        top: `${previewBbox.y * 100}%`,
                        width: `${previewBbox.w * 100}%`,
                        height: `${previewBbox.h * 100}%`,
                        boxSizing: "border-box",
                      }}
                    />
                  )}
                </div>
                {bboxes.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setBboxes([])}
                    className="mt-1 text-[11px] text-gray-500 hover:text-black underline underline-offset-2"
                  >
                    Clear all boxes
                  </button>
                )}

                <div className="mt-4 space-y-3">
                  {adjusting ? (
                    <div>
                      <label className="block text-[10px] uppercase tracking-widest text-gray-500 mb-1">
                        Error (from auto-detection)
                      </label>
                      <p className="text-sm text-gray-900 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2">
                        {description}
                      </p>
                    </div>
                  ) : (
                    <div>
                      <label className="block text-[10px] uppercase tracking-widest text-gray-500 mb-1">
                        What is it?
                      </label>
                      <input
                        type="text"
                        value={description}
                        onChange={(e) =>
                          setDescription(e.target.value.slice(0, 300))
                        }
                        placeholder="e.g. a modern paper coffee cup"
                        className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-black placeholder:text-gray-400 outline-none focus:border-black"
                      />
                    </div>
                  )}

                  <div className={`flex items-center gap-2 ${adjusting ? "hidden" : ""}`}>
                    <button
                      type="button"
                      onClick={() => setMode("remove")}
                      className={[
                        "px-3 py-1 rounded-md text-xs font-medium border",
                        mode === "remove"
                          ? "bg-black text-white border-black"
                          : "bg-white text-gray-900 border-gray-300",
                      ].join(" ")}
                    >
                      Remove
                    </button>
                    <button
                      type="button"
                      onClick={() => setMode("replace")}
                      className={[
                        "px-3 py-1 rounded-md text-xs font-medium border",
                        mode === "replace"
                          ? "bg-black text-white border-black"
                          : "bg-white text-gray-900 border-gray-300",
                      ].join(" ")}
                    >
                      Replace with…
                    </button>
                    {mode === "replace" && (
                      <input
                        type="text"
                        value={replaceWith}
                        onChange={(e) =>
                          setReplaceWith(e.target.value.slice(0, 200))
                        }
                        placeholder="e.g. an empty wooden table surface"
                        className="flex-1 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm text-black placeholder:text-gray-400 outline-none focus:border-black"
                      />
                    )}
                  </div>

                </div>
              </>
            ) : (
              <div className="flex items-center justify-center h-full text-sm text-gray-400">
                Pick a frame on the left to start drawing.
              </div>
            )}
          </div>
        </div>

        {/* Outside the scrolling area on purpose. Inside it, a 1272x554
            viewport (a 1280x720 laptop screen) put "Mark error" ~80px below
            the modal's visible edge — a paying user filled in everything,
            never saw the button, and closed the modal twice. */}
        <div className="flex items-center justify-end gap-3 px-6 py-3 border-t border-gray-200">
          {error ? (
            <p className="mr-auto text-xs text-red-600">{error}</p>
          ) : (
            missingStep && (
              <p className="mr-auto text-xs text-gray-500">{missingStep}</p>
            )
          )}
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-1.5 rounded-lg text-gray-700 hover:text-black text-sm"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!canSubmit}
            className="px-4 py-1.5 rounded-lg bg-black hover:bg-gray-800 text-white text-sm font-medium disabled:opacity-40"
          >
            {submitting
              ? adjusting
                ? "Saving…"
                : "Creating…"
              : adjusting
                ? "Save new location"
                : "Mark error"}
          </button>
        </div>
      </div>
    </div>
  );
}
