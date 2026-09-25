"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { getAdditionalUserInfo, GoogleAuthProvider, signInWithPopup } from "firebase/auth";
import { auth } from "@/lib/firebase";
import { useAuth } from "@/lib/hooks/useAuth";
import posthog from "posthog-js";
import { registerLoopsContact } from "@/lib/loops";
import { HelpLink } from "@/components/HelpDialog";

const MAX_FILE_SIZE = 200 * 1024 * 1024; // 200MB
const ACCEPTED = ["video/mp4", "video/quicktime"];

function getBetaId(): string {
  let id = localStorage.getItem("sf_beta_id");
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem("sf_beta_id", id);
  }
  return id;
}

export function activateBetaMode() {
  getBetaId(); // ensure ID exists
  localStorage.setItem("sf_beta_mode", "1");
}

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
  const [betaMode, setBetaMode] = useState(false);

  useEffect(() => {
    setBetaMode(localStorage.getItem("sf_beta_mode") === "1");
  }, []);

  const handleSignIn = async () => {
    posthog.capture("sign_in_clicked", { source: "dropzone" });
    setSigningIn(true);
    try {
      const result = await signInWithPopup(auth, new GoogleAuthProvider());
      const u = result.user;
      posthog.identify(u.uid, { email: u.email ?? undefined });
      if (getAdditionalUserInfo(result)?.isNewUser && u.email) {
        registerLoopsContact(u.email, u.uid);
      }
    } catch (err) {
      console.error("Sign-in error:", err);
    } finally {
      setSigningIn(false);
    }
  };

  const handleActivateBeta = () => {
    activateBetaMode();
    setBetaMode(true);
    posthog.capture("beta_mode_activated", { source: "dropzone" });
  };

  const handleFile = useCallback(
    async (file: File) => {
      setError(null);

      if (!ACCEPTED.includes(file.type)) {
        setError("Only MP4 and MOV files are supported.");
        return;
      }

      if (file.size > MAX_FILE_SIZE) {
        setError("File must be under 200MB.");
        return;
      }

      const trimmedHint = hint.trim().slice(0, 500);
      const betaId = betaMode ? getBetaId() : null;

      // Show the panel immediately, before any network call.
      setProgress(0);
      setStage("Preparing your upload…");

      try {
        const token = await auth.currentUser?.getIdToken();
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (token) headers["Authorization"] = `Bearer ${token}`;
        else if (betaId) headers["X-Beta-Token"] = betaId;

        // 1. Create job + get signed upload URL
        const res = await fetch("/api/jobs", {
          method: "POST",
          headers,
          body: JSON.stringify({
            filename: file.name,
            contentType: file.type,
            userHint: trimmedHint || undefined,
          }),
        });

        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          if (data.code === "pool_exhausted") {
            setError("The beta pool is full. Sign up for free to continue!");
          } else if (data.code === "already_used") {
            setError("This beta slot has already been used. Sign up for free — it's quick!");
          } else {
            setError("Upload failed. Please try again.");
          }
          return;
        }

        const { jobId, uploadUrl, storagePath } = await res.json();

        // 2. PUT directly to the signed URL.
        //
        // Nothing was ever reported between job_created and video_uploaded, and
        // 19 of 43 jobs in the first two weeks never got past `status:
        // "uploading"` — the user picked a file, the record was written, and the
        // upload silently never landed. With no event on this step there was no
        // way to tell a network failure from an expired URL from a file the
        // browser could not read. Every outcome here is now reported.
        setStage("Uploading…");
        const uploadStartedAt = Date.now();
        const sizeMb = Math.round(file.size / 1024 / 1024);
        posthog.capture("upload_started", {
          job_id: jobId,
          file_size_mb: sizeMb,
          file_type: file.type,
          is_beta: !!betaId,
        });

        const reportUploadFailure = (reason: string, extra: Record<string, unknown> = {}) => {
          posthog.capture("upload_failed", {
            job_id: jobId,
            reason,
            file_size_mb: sizeMb,
            file_type: file.type,
            elapsed_ms: Date.now() - uploadStartedAt,
            is_beta: !!betaId,
            ...extra,
          });
        };

        await new Promise<void>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open("PUT", uploadUrl, true);
          xhr.setRequestHeader("Content-Type", file.type);
          // Without a timeout a stalled PUT hangs forever: no progress, no
          // error, no event, and a job left in "uploading" for good.
          xhr.timeout = 15 * 60 * 1000;
          let lastLoaded = 0;
          xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) {
              lastLoaded = e.loaded;
              setProgress(Math.round((e.loaded / e.total) * 100));
            }
          };
          xhr.onload = () => {
            if (xhr.status === 200) {
              resolve();
              return;
            }
            reportUploadFailure("http_status", {
              http_status: xhr.status,
              bytes_sent: lastLoaded,
            });
            reject(new Error(`Upload failed: ${xhr.status}`));
          };
          xhr.onerror = () => {
            reportUploadFailure("network_error", { bytes_sent: lastLoaded });
            reject(new Error("Upload network error"));
          };
          xhr.ontimeout = () => {
            reportUploadFailure("timeout", { bytes_sent: lastLoaded });
            reject(new Error("Upload timed out"));
          };
          xhr.onabort = () => {
            reportUploadFailure("aborted", { bytes_sent: lastLoaded });
            reject(new Error("Upload aborted"));
          };
          xhr.send(file);
        });

        setStage("Starting analysis…");
        posthog.capture("upload_completed", {
          job_id: jobId,
          file_size_mb: sizeMb,
          elapsed_ms: Date.now() - uploadStartedAt,
          is_beta: !!betaId,
        });

        const encodedPath = encodeURIComponent(storagePath);
        const bucket = process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET;
        const inputVideoUrl = `https://firebasestorage.googleapis.com/v0/b/${bucket}/o/${encodedPath}?alt=media`;

        // 3. Start pipeline
        const startHeaders: Record<string, string> = { "Content-Type": "application/json" };
        if (token) startHeaders["Authorization"] = `Bearer ${token}`;
        else if (betaId) startHeaders["X-Beta-Token"] = betaId;

        const startRes = await fetch(`/api/jobs/${jobId}/start`, {
          method: "POST",
          headers: startHeaders,
          body: JSON.stringify({ inputVideoUrl }),
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
            is_beta: !!betaId,
          });
          throw new Error(startData.error ?? "Failed to start pipeline");
        }

        // 4. Save to recent jobs in localStorage
        if (betaId) localStorage.setItem("sf_beta_job", jobId);

        const recent = JSON.parse(localStorage.getItem("scenefixer_recent_jobs") || "[]");
        const updated = [
          { id: jobId, filename: file.name, createdAt: Date.now() },
          ...recent,
        ].slice(0, 5);
        localStorage.setItem("scenefixer_recent_jobs", JSON.stringify(updated));

        posthog.capture("video_uploaded", {
          job_id: jobId,
          file_size_mb: Math.round(file.size / 1024 / 1024),
          file_type: file.type,
          has_hint: !!trimmedHint,
          is_beta: !!betaId,
        });

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
      }
    },
    [router, hint, betaMode]
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      const file = e.dataTransfer.files[0];
      if (file) handleFile(file);
    },
    [handleFile]
  );

  const onFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) handleFile(file);
    },
    [handleFile]
  );

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

  // Show sign-in gate while auth state is loading or user is not signed in (and not in beta mode)
  if (!loading && !user && !betaMode) {
    return (
      <div className="w-full max-w-xl mx-auto">
        <div className="rounded-2xl border-2 border-dashed border-gray-200 bg-white p-8 text-center">
          <div className="text-5xl mb-3">🎬</div>
          <p className="text-black font-semibold text-lg mb-1">Drop your video here</p>
          <p className="text-gray-500 text-sm mb-5">MP4 or MOV · 200MB max</p>
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
          <p className="text-gray-400 text-xs mt-3">Free plan · no credit card required</p>

          <div className="mt-4 pt-4 border-t border-gray-100">
            <p className="text-gray-400 text-xs mb-2">Helping us test?</p>
            <button
              onClick={handleActivateBeta}
              className="text-xs text-gray-500 hover:text-black underline underline-offset-2 transition-colors"
            >
              Beta tester? Try without signing in →
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full max-w-xl mx-auto flex flex-col gap-3">
      {betaMode && !user && (
        <div className="flex items-center justify-between rounded-xl bg-amber-50 border border-amber-200 px-3 py-2">
          <span className="text-xs text-amber-700 font-medium">Beta tester mode — 1 free fix</span>
          <button
            onClick={handleSignIn}
            className="text-xs text-amber-800 underline underline-offset-2 hover:opacity-70"
          >
            Sign in instead →
          </button>
        </div>
      )}

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
          className="hidden"
          onChange={onFileChange}
        />
        <div className="text-5xl mb-3">🎬</div>
        <p className="text-black font-semibold text-lg mb-1">
          Drop your video here
        </p>
        <p className="text-gray-500 text-sm">MP4 or MOV · 200MB max</p>
      </div>

      {error && (
        <p className="text-red-600 text-sm text-center">{error}</p>
      )}

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
