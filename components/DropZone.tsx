"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { auth } from "@/lib/firebase";
import { useAuth } from "@/lib/hooks/useAuth";
import posthog from "posthog-js";
import { signInWithGoogle } from "@/lib/signIn";
import { HelpLink } from "@/components/HelpDialog";
import { UPLOAD_URL_TTL_MS, MAX_CLIPS, MAX_UPLOAD_BYTES, ACCEPTED_VIDEO_TYPES } from "@/lib/uploads";
import { exactCreditPrice, formatUsd } from "@/lib/pricing";

const MAX_FILE_SIZE = MAX_UPLOAD_BYTES; // 200MB, for one video or all clips together
const ACCEPTED = ACCEPTED_VIDEO_TYPES;

// clip_2 before clip_10: the order people number their generations in.
const byName = (a: File, b: File) =>
  a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });

const formatMb = (bytes: number) => `${Math.max(1, Math.round(bytes / 1024 / 1024))} MB`;

export default function DropZone() {
  const router = useRouter();
  const { user, loading } = useAuth();
  const inputRef = useRef<HTMLInputElement>(null);
  const hintRef = useRef<HTMLTextAreaElement>(null);
  const [dragging, setDragging] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  // What the user is actually waiting on. Between picking a file and the first
  // byte moving there can be several seconds — creating the job, signing the
  // URL — during which the old UI showed the untouched drop zone, so it looked
  // like the click had done nothing.
  const [stage, setStage] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState("");
  const [signingIn, setSigningIn] = useState(false);
  const busy = useRef(false);
  // Over the daily limit: the file they tried, and whether a credit can pay
  // for the scan now. Set from the refusal; cleared on the next attempt.
  const [limitOffer, setLimitOffer] = useState<{ files: File[]; balance: number; credits: number } | null>(null);
  // Several clips dropped together, in the order they will be joined. Shown
  // as a list to check and reorder before the scan starts: drag-and-drop order
  // is arbitrary, and the order is the sequence that gets compared. A single
  // dropped file never lands here — it uploads straight away, as it always has.
  const [clips, setClips] = useState<File[]>([]);
  const [buying, setBuying] = useState(false);
  const [creditsAdded, setCreditsAdded] = useState<number | null>(null);

  // Back from buying credits for a scan (checkout's success_url).
  useEffect(() => {
    const n = Number(new URLSearchParams(window.location.search).get("credits_added"));
    if (Number.isFinite(n) && n > 0) setCreditsAdded(n);
  }, []);
  // The job a failed attempt created, kept so a retry of the same file (or
  // the same set of clips) uploads into it instead of abandoning it. See
  // handleFiles.
  const pendingUpload = useRef<{
    fileKey: string;
    jobId: string;
    uploads: { uploadUrl: string; storagePath: string }[];
    issuedAt: number;
  } | null>(null);


  const handleSignIn = async () => {
    posthog.capture("sign_in_clicked", { source: "dropzone" });
    setSigningIn(true);
    setError(null);
    try {
      const result = await signInWithGoogle("dropzone");
      if (!result.ok && result.message) setError(result.message);
    } finally {
      setSigningIn(false);
    }
  };

  // One video, or 2+ clips that Modal joins in this order into one sequence
  // (modal_app/combine.py). With one file every request is exactly what it
  // was before clips existed.
  const handleFiles = useCallback(
    async (files: File[], opts: { extraScan?: boolean } = {}) => {
      setError(null);
      setLimitOffer(null);

      if (files.length === 0) return;
      const multi = files.length > 1;
      const file = files[0];
      const totalBytes = files.reduce((n, f) => n + f.size, 0);

      if (!files.every((f) => ACCEPTED.includes(f.type))) {
        setError("Only MP4 and MOV files are supported.");
        return;
      }

      if (multi && files.length > MAX_CLIPS) {
        setError(`Up to ${MAX_CLIPS} clips at a time.`);
        return;
      }

      if (totalBytes > MAX_FILE_SIZE) {
        setError(multi ? "Clips must be under 200MB in total." : "File must be under 200MB.");
        return;
      }

      const trimmedHint = hint.trim().slice(0, 500);

      // One upload at a time. On 29 Oct an Android phone fired the file
      // picker's change twice, 3 s apart: two jobs were created and one was
      // left in "uploading" for good.
      if (busy.current) return;
      busy.current = true;

      // Show the panel immediately, before any network call.
      setProgress(0);
      setStage("Preparing your upload…");

      try {
        const token = await auth.currentUser?.getIdToken();
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (token) headers["Authorization"] = `Bearer ${token}`;

        // 1. Create job + get signed upload URL — or, when this is a retry of
        // the same file, reuse the job the failed attempt already created.
        //
        // Every retry used to create a fresh job and abandon the last one in
        // "uploading" for good: 31 of the 38 stuck jobs by 29 Sep were followed
        // by the same person trying again.
        const fileKey = [
          ...files.map((f) => [f.name, f.size, f.lastModified, f.type].join("|")),
          trimmedHint,
        ].join("|");
        const pending = pendingUpload.current;
        let jobId: string, uploads: { uploadUrl: string; storagePath: string }[];
        if (
          pending &&
          pending.fileKey === fileKey &&
          // Leave the URL a margin to finish a large upload before it expires.
          Date.now() - pending.issuedAt < UPLOAD_URL_TTL_MS - 10 * 60 * 1000
        ) {
          ({ jobId, uploads } = pending);
        } else {
          const res = await fetch("/api/jobs", {
            method: "POST",
            headers,
            body: JSON.stringify({
              ...(multi
                ? { clips: files.map((f) => ({ filename: f.name, contentType: f.type, size: f.size })) }
                : { filename: file.name, contentType: file.type }),
              userHint: trimmedHint || undefined,
              extraScan: opts.extraScan || undefined,
            }),
          }).catch((err) => {
            // The request can land and create the job while the response is
            // lost — on 27 Sep a phone left a job with no upload attempt at
            // all, then created a second one 16 s later. Nothing recorded it.
            posthog.capture("job_create_failed", { reason: "network" });
            throw err;
          });

          if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            posthog.capture("job_create_failed", {
              http_status: res.status,
              code: data.code ?? null,
            });
            if (data.code === "scan_limit" && data.error) {
              setError(data.error);
              setLimitOffer({
                files,
                balance: typeof data.balance === "number" ? data.balance : 0,
                credits: typeof data.extraScanCredits === "number" ? data.extraScanCredits : 1,
              });
            } else {
              setError("Upload failed. Please try again.");
            }
            setProgress(null);
            setStage("");
            return;
          }

          const created = await res.json();
          jobId = created.jobId;
          uploads = multi
            ? created.uploads
            : [{ uploadUrl: created.uploadUrl, storagePath: created.storagePath }];
          pendingUpload.current = { fileKey, jobId, uploads, issuedAt: Date.now() };
        }

        // 2. PUT directly to the signed URL.
        //
        // Nothing was ever reported between job_created and video_uploaded, and
        // 19 of 43 jobs in the first two weeks never got past `status:
        // "uploading"` — the user picked a file, the record was written, and the
        // upload silently never landed. With no event on this step there was no
        // way to tell a network failure from an expired URL from a file the
        // browser could not read. Every outcome here is now reported.
        setStage(multi ? `Uploading ${files.length} clips…` : "Uploading…");
        const uploadStartedAt = Date.now();
        const sizeMb = Math.round(totalBytes / 1024 / 1024);
        posthog.capture("upload_started", {
          job_id: jobId,
          file_size_mb: sizeMb,
          file_type: file.type,
          ...(multi ? { clip_count: files.length } : {}),
        });

        const reportUploadFailure = (reason: string, extra: Record<string, unknown> = {}) => {
          posthog.capture("upload_failed", {
            job_id: jobId,
            reason,
            file_size_mb: sizeMb,
            file_type: file.type,
            elapsed_ms: Date.now() - uploadStartedAt,
            ...(multi ? { clip_count: files.length } : {}),
            ...extra,
          });
        };

        // Clips go one after another, under one bar for all the bytes.
        let bytesBefore = 0;
        for (let i = 0; i < files.length; i++) {
          const part = files[i];
          const { uploadUrl } = uploads[i];
          if (multi) setStage(`Uploading clip ${i + 1} of ${files.length}…`);
          await new Promise<void>((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open("PUT", uploadUrl, true);
            xhr.setRequestHeader("Content-Type", part.type);
            // Without a timeout a stalled PUT hangs forever: no progress, no
            // error, no event, and a job left in "uploading" for good.
            xhr.timeout = 15 * 60 * 1000;
            let lastLoaded = 0;
            xhr.upload.onprogress = (e) => {
              if (e.lengthComputable) {
                lastLoaded = e.loaded;
                setProgress(
                  multi
                    ? Math.round(((bytesBefore + e.loaded) / totalBytes) * 100)
                    : Math.round((e.loaded / e.total) * 100)
                );
              }
            };
            xhr.onload = () => {
              if (xhr.status === 200) {
                resolve();
                return;
              }
              reportUploadFailure("http_status", {
                http_status: xhr.status,
                bytes_sent: bytesBefore + lastLoaded,
              });
              reject(new Error(`Upload failed: ${xhr.status}`));
            };
            xhr.onerror = () => {
              reportUploadFailure("network_error", { bytes_sent: bytesBefore + lastLoaded });
              reject(new Error("Upload network error"));
            };
            xhr.ontimeout = () => {
              reportUploadFailure("timeout", { bytes_sent: bytesBefore + lastLoaded });
              reject(new Error("Upload timed out"));
            };
            xhr.onabort = () => {
              reportUploadFailure("aborted", { bytes_sent: bytesBefore + lastLoaded });
              reject(new Error("Upload aborted"));
            };
            xhr.send(part);
          });
          bytesBefore += part.size;
        }

        setStage("Starting analysis…");
        posthog.capture("upload_completed", {
          job_id: jobId,
          file_size_mb: sizeMb,
          elapsed_ms: Date.now() - uploadStartedAt,
          ...(multi ? { clip_count: files.length } : {}),
        });

        const bucket = process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET;
        const urls = uploads.map(
          (u) =>
            `https://firebasestorage.googleapis.com/v0/b/${bucket}/o/${encodeURIComponent(u.storagePath)}?alt=media`
        );

        // 3. Start pipeline
        const startHeaders: Record<string, string> = { "Content-Type": "application/json" };
        if (token) startHeaders["Authorization"] = `Bearer ${token}`;

        const startRes = await fetch(`/api/jobs/${jobId}/start`, {
          method: "POST",
          headers: startHeaders,
          body: JSON.stringify(multi ? { inputClipUrls: urls } : { inputVideoUrl: urls[0] }),
        });
        if (!startRes.ok) {
          const startData = await startRes.json().catch(() => ({}));
          // The upload landed and the pipeline refused to start. That is a
          // different failure from an upload that never arrived, and it left
          // exactly the same trace as one: a job stuck in "uploading".
          posthog.capture("pipeline_start_failed", {
            job_id: jobId,
            http_status: startRes.status,
            code: startData.code ?? null,
            message: startData.error ?? null,
          });
          // Said as it is. Thrown, it fell through to "Upload failed. Please
          // try again." and people retried the same file into the same refusal.
          if (startData.code === "scan_limit" && startData.error) {
            setError(startData.error);
            // The upload already landed, so a paid retry reuses this job.
            pendingUpload.current = null;
            setProgress(null);
            setStage("");
            return;
          }
          throw new Error(startData.error ?? "Failed to start pipeline");
        }

        pendingUpload.current = null;

        // 4. Save to recent jobs in localStorage
        const recent = JSON.parse(localStorage.getItem("scenefixer_recent_jobs") || "[]");
        const updated = [
          {
            id: jobId,
            filename: multi ? `${file.name} (+${files.length - 1} clips)` : file.name,
            createdAt: Date.now(),
          },
          ...recent,
        ].slice(0, 5);
        localStorage.setItem("scenefixer_recent_jobs", JSON.stringify(updated));

        posthog.capture("video_uploaded", {
          job_id: jobId,
          file_size_mb: Math.round(totalBytes / 1024 / 1024),
          file_type: file.type,
          has_hint: !!trimmedHint,
          ...(multi ? { clip_count: files.length } : {}),
        });

        setClips([]);
        router.push(`/job/${jobId}`);
      } catch (err) {
        console.error(err);
        const msg = err instanceof Error ? err.message : "";
        setError(
          msg.includes("timed out")
            ? "The upload timed out. That usually means a slow connection — try again, or try a smaller file."
            : msg.includes("network")
              ? "The connection dropped during upload. Check your network and try again."
              : "Upload failed. Please try again."
        );
        setProgress(null);
        setStage("");
      } finally {
        busy.current = false;
      }
    },
    [router, hint]
  );

  // Credits for one more scan today, bought from the refusal itself.
  const buyScanCredits = async (credits: number) => {
    if (buying) return;
    setBuying(true);
    posthog.capture("extra_scan_buy_clicked", { credits });
    try {
      const token = await auth.currentUser?.getIdToken();
      const res = await fetch("/api/stripe/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ type: "exact", credits, source: "scan_limit" }),
      });
      const data = await res.json().catch(() => ({}));
      if (data.url) {
        window.location.href = data.url;
        return;
      }
      setError("Couldn't open checkout. Please try again.");
    } catch {
      setError("Couldn't open checkout. Please try again.");
    } finally {
      setBuying(false);
    }
  };

  // One file with nothing staged: straight to upload, as it always was.
  // Anything else goes onto the clip list to be checked and ordered first.
  const takeFiles = useCallback(
    (list: FileList | null | undefined) => {
      const picked = Array.from(list ?? []);
      if (picked.length === 0) return;
      if (picked.length === 1 && clips.length === 0) {
        handleFiles(picked);
        return;
      }
      setError(null);
      setLimitOffer(null);
      const videos = picked.filter((f) => ACCEPTED.includes(f.type));
      if (videos.length < picked.length) setError("Only MP4 and MOV files are supported.");
      const next = [...clips, ...videos.sort(byName)];
      if (next.length > MAX_CLIPS) setError(`Up to ${MAX_CLIPS} clips at a time.`);
      setClips(next.slice(0, MAX_CLIPS));
      if (videos.length > 0) {
        posthog.capture("clips_staged", { clip_count: Math.min(next.length, MAX_CLIPS) });
      }
    },
    [clips, handleFiles]
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      takeFiles(e.dataTransfer.files);
    },
    [takeFiles]
  );

  const onFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      takeFiles(e.target.files);
      // So picking the same file again still fires a change.
      e.target.value = "";
    },
    [takeFiles]
  );

  const moveClip = (i: number, delta: -1 | 1) =>
    setClips((cur) => {
      const j = i + delta;
      if (j < 0 || j >= cur.length) return cur;
      const next = [...cur];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });

  if (progress !== null) {
    // Before the first byte moves there is no percentage to show, so the bar
    // animates instead of sitting at a dead 0%.
    const indeterminate = progress === 0;
    return (
      <div className="w-full max-w-xl mx-auto">
        <div className="rounded-2xl border border-gray-200 bg-white p-8 text-center">
          <p className="text-sm text-gray-500 mb-3">{stage || "Uploading…"}</p>
          <div className="w-full bg-gray-100 rounded-full h-1.5 overflow-hidden">
            <div
              className={`bg-black h-1.5 rounded-full ${
                indeterminate ? "w-1/3 animate-pulse" : "transition-all duration-200"
              }`}
              style={indeterminate ? undefined : { width: `${progress}%` }}
            />
          </div>
          <p className="text-black mt-3 text-lg font-semibold tabular-nums">
            {indeterminate ? "\u00a0" : `${progress}%`}
          </p>
          <p className="text-gray-400 text-xs mt-2">
            Large files can take a few minutes. Keep this tab open.
          </p>
        </div>
      </div>
    );
  }

  // Show the sign-in gate once auth has loaded and nobody is signed in.
  if (!loading && !user) {
    return (
      <div className="w-full max-w-xl mx-auto">
        <div className="rounded-2xl border-2 border-dashed border-gray-200 bg-white p-8 text-center">
          <div className="text-5xl mb-3">🎬</div>
          <p className="text-black font-semibold text-lg mb-1">Drop your video here</p>
          <p className="text-gray-500 text-sm mb-5">MP4 or MOV · one video, or several clips · 200MB max</p>
          <button
            onClick={handleSignIn}
            disabled={signingIn}
            className="inline-flex items-center gap-2 bg-black hover:bg-gray-800 text-white text-sm font-semibold px-5 py-2.5 rounded-xl transition-colors disabled:opacity-50"
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
              <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
              <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
              <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
              <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
            </svg>
            {signingIn ? "Signing in…" : "Sign in with Google to continue"}
          </button>
          {error && <p className="text-red-600 text-xs mt-3">{error}</p>}
          <p className="text-gray-400 text-xs mt-3">Free plan · no credit card required</p>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full max-w-xl mx-auto flex flex-col gap-3">
      {/* Hint field */}
      <div>
        <label className="block text-[10px] uppercase tracking-widest text-gray-500 mb-1.5">
          Anything specific to look for?{" "}
          <span className="text-gray-400 normal-case tracking-normal">(optional)</span>
        </label>
        <textarea
          ref={hintRef}
          value={hint}
          onChange={(e) => setHint(e.target.value.slice(0, 500))}
          placeholder="e.g. The jacket color changes between clips, or the lighting feels warmer in the second shot."
          rows={2}
          className="w-full resize-none rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm text-black placeholder:text-gray-400 outline-none focus:border-black transition-colors"
        />
        {hint.length > 0 && (
          <p className="mt-1 text-[10px] text-gray-400 text-right tabular-nums">
            {hint.length}/500
          </p>
        )}
      </div>

      {/* Drop zone */}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        onClick={() => inputRef.current?.click()}
        className={[
          "rounded-2xl border-2 border-dashed p-8 text-center cursor-pointer transition-colors",
          dragging
            ? "border-black bg-gray-50"
            : "border-gray-300 bg-white hover:border-gray-500 hover:bg-gray-50",
        ].join(" ")}
      >
        <input
          ref={inputRef}
          type="file"
          accept="video/mp4,video/quicktime"
          multiple
          className="hidden"
          onChange={onFileChange}
        />
        <div className="text-5xl mb-3">🎬</div>
        <p className="text-black font-semibold text-lg mb-1">
          {clips.length > 0 ? "Drop more clips here" : "Drop your video here"}
        </p>
        <p className="text-gray-500 text-sm">MP4 or MOV · one video, or several clips · 200MB max</p>
      </div>

      {clips.length > 0 && (
        <div className="rounded-2xl border border-gray-200 bg-white p-4">
          <p className="text-sm font-semibold text-black mb-0.5">
            {clips.length === 1 ? "1 clip" : `${clips.length} clips`}, joined in this order
          </p>
          <p className="text-xs text-gray-500 mb-3">
            We compare them as one sequence, each clip its own shot. Check the order before you scan.
          </p>
          <ol className="flex flex-col gap-1.5 mb-3">
            {clips.map((f, i) => (
              <li
                key={`${f.name}|${f.size}|${f.lastModified}|${i}`}
                className="flex items-center gap-2 rounded-lg bg-gray-50 px-3 py-2 text-sm"
              >
                <span className="w-5 text-gray-400 tabular-nums text-xs">{i + 1}</span>
                <span className="flex-1 truncate text-black" title={f.name}>{f.name}</span>
                <span className="text-xs text-gray-400 tabular-nums">{formatMb(f.size)}</span>
                <button
                  type="button"
                  onClick={() => moveClip(i, -1)}
                  disabled={i === 0}
                  aria-label={`Move ${f.name} up`}
                  className="px-1.5 text-gray-500 hover:text-black disabled:opacity-25"
                >
                  ↑
                </button>
                <button
                  type="button"
                  onClick={() => moveClip(i, 1)}
                  disabled={i === clips.length - 1}
                  aria-label={`Move ${f.name} down`}
                  className="px-1.5 text-gray-500 hover:text-black disabled:opacity-25"
                >
                  ↓
                </button>
                <button
                  type="button"
                  onClick={() => setClips((cur) => cur.filter((_, k) => k !== i))}
                  aria-label={`Remove ${f.name}`}
                  className="px-1.5 text-gray-400 hover:text-red-600"
                >
                  ✕
                </button>
              </li>
            ))}
          </ol>
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-3 text-xs">
              {clips.length < MAX_CLIPS && (
                <button
                  type="button"
                  onClick={() => inputRef.current?.click()}
                  className="font-semibold text-black underline underline-offset-2 hover:opacity-70"
                >
                  + Add clips
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  setClips([]);
                  setError(null);
                }}
                className="text-gray-500 hover:text-black"
              >
                Clear
              </button>
              <span
                className={
                  clips.reduce((n, f) => n + f.size, 0) > MAX_FILE_SIZE ? "text-red-600" : "text-gray-400"
                }
              >
                {formatMb(clips.reduce((n, f) => n + f.size, 0))} of 200 MB
              </span>
            </div>
            <button
              type="button"
              onClick={() => {
                posthog.capture("clips_scan_clicked", { clip_count: clips.length });
                handleFiles(clips);
              }}
              className="bg-black hover:bg-gray-800 text-white text-sm font-semibold px-5 py-2.5 rounded-xl transition-colors"
            >
              {clips.length === 1 ? "Scan this video" : `Scan ${clips.length} clips as one sequence`}
            </button>
          </div>
        </div>
      )}

      {creditsAdded && !error && (
        <p className="text-emerald-700 text-sm text-center">
          {creditsAdded} credits added. Drop your video, or your clips, again to scan.
        </p>
      )}

      {error && (
        <p className="text-red-600 text-sm text-center">{error}</p>
      )}

      {limitOffer && (() => {
        const offer = exactCreditPrice(limitOffer.credits);
        return limitOffer.balance >= limitOffer.credits ? (
          <button
            onClick={() => {
              posthog.capture("extra_scan_clicked", { credits: limitOffer.credits, balance: limitOffer.balance });
              handleFiles(limitOffer.files, { extraScan: true });
            }}
            className="self-center bg-black hover:bg-gray-800 text-white text-sm font-semibold px-5 py-2.5 rounded-xl transition-colors"
          >
            Scan it now for {limitOffer.credits} credit{limitOffer.credits === 1 ? "" : "s"} (you have {limitOffer.balance})
          </button>
        ) : (
          <button
            onClick={() => buyScanCredits(limitOffer.credits)}
            disabled={buying}
            className="self-center bg-black hover:bg-gray-800 text-white text-sm font-semibold px-5 py-2.5 rounded-xl transition-colors disabled:opacity-50"
          >
            {buying ? "Opening checkout…" : `Don't wait: ${offer.credits} credits for ${formatUsd(offer.cents)}`}
          </button>
        );
      })()}

      <p className="text-center text-[11px] text-gray-500">
        Works on a video with two or more shots, or several clips dropped together. The free scan uses our standard AI
        model (Claude Haiku), which can miss things; for our most advanced model
        (Claude Opus), run a deep scan with credits — 1 credit per shot.
      </p>

      <p className="text-center text-[11px] text-gray-400">
        Beta — results may vary.{" "}
        <HelpLink source="dropzone" className="underline underline-offset-2 hover:text-gray-600 transition-colors">
          Let us know
        </HelpLink>{" "}
        if something looks wrong.
      </p>
    </div>
  );
}
