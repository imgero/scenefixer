"use client";

import { useEffect, useState } from "react";
import { use } from "react";
import { collection, doc, onSnapshot, orderBy, query, writeBatch } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useJob } from "@/lib/hooks/useJob";
import { useErrors } from "@/lib/hooks/useErrors";
import { useAuth } from "@/lib/hooks/useAuth";
import { auth } from "@/lib/firebase";
import { PLAN_LIMITS, type Plan } from "@/lib/types";
import JobStatus from "@/components/JobStatus";
import ErrorList from "@/components/ErrorList";
import DiffPlayer from "@/components/DiffPlayer";
import ScoreBadge from "@/components/ScoreBadge";
import ManualMarker from "@/components/ManualMarker";
import type { Shot, RecentJob, ContinuityError, Job } from "@/lib/types";
import posthog from "posthog-js";

type Props = {
  params: Promise<{ id: string }>;
};

function getDownloadFilename(job: Job): string {
  const rawPath = job.inputVideoUrl?.split("/o/")[1]?.split("?")[0] ?? "";
  const original = (rawPath ? decodeURIComponent(rawPath).split("/").pop() : null) ?? "video.mp4";
  const base = original.replace(/\.[^/.]+$/, "");
  const date = job.createdAt?.toDate?.() ?? new Date();
  const dd = String(date.getDate()).padStart(2, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const yy = String(date.getFullYear()).slice(-2);
  return `${base} Scenefixer Fixed v${dd}${mm}${yy}.mp4`;
}

export default function JobPage({ params }: Props) {
  const { id: jobId } = use(params);
  const { job, loading: jobLoading, denied } = useJob(jobId);
  const { errors } = useErrors(jobId);
  const { user } = useAuth();
  const [shots, setShots] = useState<Shot[]>([]);
  const [fixing, setFixing] = useState(false);
  const [fixError, setFixError] = useState<string | null>(null);
  const [manualOpen, setManualOpen] = useState(false);
  const [adjustingError, setAdjustingError] = useState<ContinuityError | null>(null);
  const [userPlan, setUserPlan] = useState<Plan>("free");
  const [fixesUsed, setFixesUsed] = useState(0);
  const [creditsBalance, setCreditsBalance] = useState(0);
  const [betaToken, setBetaToken] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [reprocessing, setReprocessing] = useState(false);

  // Load beta token from localStorage
  useEffect(() => {
    const mode = localStorage.getItem("sf_beta_mode");
    if (mode === "1") {
      setBetaToken(localStorage.getItem("sf_beta_id"));
    }
  }, []);

  // Live-sync user plan + quota
  useEffect(() => {
    if (!user) return;
    const unsub = onSnapshot(
      doc(db, "users", user.uid),
      (snap) => {
        if (snap.exists()) {
          const data = snap.data();
          setUserPlan((data.plan as Plan) ?? "free");
          setFixesUsed(data.creditsUsedThisMonth ?? 0);
          setCreditsBalance(data.creditsBalance ?? 0);
        }
      },
      (err) =>
        posthog.capture("firestore_listen_failed", {
          listener: "user_entitlement",
          job_id: jobId,
          code: err.code,
          message: err.message,
        })
    );
    return unsub;
  }, [user]);

  // Register this job in recent jobs localStorage
  useEffect(() => {
    if (!job) return;
    try {
      const recent: RecentJob[] = JSON.parse(
        localStorage.getItem("scenefixer_recent_jobs") || "[]"
      );
      if (!recent.find((r) => r.id === jobId)) {
        const updated = [
          {
            id: jobId,
            filename: job.inputVideoUrl.split("/").pop() ?? jobId,
            createdAt: Date.now(),
          },
          ...recent,
        ].slice(0, 5);
        localStorage.setItem("scenefixer_recent_jobs", JSON.stringify(updated));
      }
    } catch {
      // ignore
    }
  }, [job, jobId]);

  // If the job is no longer actively fixing/verifying but some error docs are
  // still stuck in fixStatus "fixing" (happens when Modal kills the container
  // before the exception handler can clean up), reset them to "pending" so
  // the user can interact with and retry them.
  useEffect(() => {
    if (!job) return;
    const jobIsFixing = job.status === "fixing" || job.status === "verifying";
    if (jobIsFixing) return;
    const stuckErrors = errors.filter((e) => e.fixStatus === "fixing");
    if (stuckErrors.length === 0) return;
    const batch = writeBatch(db);
    for (const err of stuckErrors) {
      batch.update(doc(db, "jobs", jobId, "errors", err.id), { fixStatus: "pending" });
    }
    batch.commit().catch((e) => {
      console.error("Failed to reset stuck errors:", e);
      posthog.capture("firestore_write_failed", {
        operation: "reset_stuck_errors",
        job_id: jobId,
        count: stuckErrors.length,
        code: (e as { code?: string }).code ?? null,
        message: (e as Error).message,
      });
    });
  }, [job?.status, errors, jobId]);

  // Subscribe to shots subcollection
  useEffect(() => {
    const q = query(
      collection(db, "jobs", jobId, "shots"),
      orderBy("index", "asc")
    );
    const unsub = onSnapshot(
      q,
      (snap) => {
        setShots(snap.docs.map((d) => ({ id: d.id, ...d.data() }) as Shot));
      },
      (err) =>
        posthog.capture("firestore_listen_failed", {
          listener: "job_shots",
          job_id: jobId,
          code: err.code,
          message: err.message,
        })
    );
    return unsub;
  }, [jobId]);

  // Mirrors what the fix route will actually charge for: an error detection
  // marked unrepairable is skipped there, so counting it here would promise a
  // fix the server is right to refuse.
  const confirmedCount = errors.filter(
    (e) =>
      e.userConfirmed &&
      e.repairable !== false &&
      (e.fixStatus === "pending" || e.fixStatus === "failed")
  ).length;

  const FIXING_TIMEOUT_MS = 20 * 60 * 1000;
  const fixTimedOut =
    !!job &&
    job.status === "fixing" &&
    typeof job.fixingStartedAt === "number" &&
    Date.now() - job.fixingStartedAt > FIXING_TIMEOUT_MS;

  const showScoreAfter =
    job?.scoreAfter !== undefined && job?.verificationPassed !== false;

  const monthlyLimit = PLAN_LIMITS[userPlan].creditsPerMonth;
  const quotaExhausted = user ? (fixesUsed >= monthlyLimit && creditsBalance <= 0) : false;

  const handleFix = async () => {
    setFixError(null);
    setFixing(true);
    posthog.capture("fix_requested", {
      job_id: jobId,
      confirmed_error_count: confirmedCount,
      is_beta: !!betaToken,
    });
    try {
      const token = await auth.currentUser?.getIdToken();
      const headers: Record<string, string> = {};
      if (token) headers["Authorization"] = `Bearer ${token}`;
      else if (betaToken) headers["X-Beta-Token"] = betaToken;

      const res = await fetch(`/api/jobs/${jobId}/fix`, {
        method: "POST",
        headers,
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        if (data.code === "unauthenticated") {
          setFixError("Sign in to fix continuity errors.");
        } else if (data.code === "quota_exceeded") {
          setFixError(data.error + " Upgrade your plan or buy fix credits.");
        } else if (data.code === "beta_used") {
          setFixError("Your beta fix has already been used. Sign up free to get another fix!");
        } else {
          setFixError(data.error ?? "Fix failed. Please try again.");
        }
        setFixing(false);
      }
    } catch {
      setFixError("Fix failed. Please try again.");
      setFixing(false);
    }
  };

  const handleDownload = async () => {
    if (!job?.outputVideoUrl || downloading) return;
    setDownloading(true);
    try {
      const res = await fetch(job.outputVideoUrl);
      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = getDownloadFilename(job);
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(blobUrl);
    } catch {
      // fallback: open in new tab
      window.open(job.outputVideoUrl, "_blank");
    } finally {
      setDownloading(false);
    }
  };

  if (jobLoading) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-white">
        <div className="text-gray-400 animate-pulse">Loading job…</div>
      </main>
    );
  }

  if (denied || (!jobLoading && !job)) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-white px-4">
        <div className="text-center max-w-sm">
          <p className="text-2xl mb-2">🔒</p>
          <p className="text-black font-semibold mb-1">Sign in to view this job</p>
          <p className="text-gray-500 text-sm mb-5">
            Jobs are private to the account that created them.
          </p>
          <a href="/" className="inline-block bg-black text-white text-sm font-semibold px-5 py-2.5 rounded-xl hover:bg-gray-800 transition-colors">
            Go to Scene Fixer
          </a>
        </div>
      </main>
    );
  }

  if (!job) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-white">
        <div className="text-gray-600">Job not found.</div>
      </main>
    );
  }

  const showDiff =
    (job.status === "done" || job.status === "reprocessing") &&
    job.inputVideoUrl && job.outputVideoUrl;

  const QUALITY_RANK: Record<string, number> = { "480p": 1, "720p": 2, "1080p": 3 };
  const jobQualityRank = QUALITY_RANK[job.outputQuality ?? "720p"] ?? 2;
  const planQualityRank = QUALITY_RANK[PLAN_LIMITS[userPlan].qualityLabel] ?? 2;
  const canReprocess = job.status === "done" && user && (
    (job.watermark === true && userPlan !== "free") ||
    planQualityRank > jobQualityRank
  );

  const handleReprocess = async () => {
    if (reprocessing || !user) return;
    setReprocessing(true);
    try {
      const token = await auth.currentUser?.getIdToken();
      const res = await fetch(`/api/jobs/${jobId}/reprocess`, {
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) {
        const data = await res.json();
        console.error("Reprocess failed:", data.error);
        setReprocessing(false);
      }
      // status will update via onSnapshot when done
    } catch {
      setReprocessing(false);
    }
  };

  // Reset reprocessing spinner when job returns to done
  if (job.status === "done" && reprocessing) setReprocessing(false);

  return (
    <main className="min-h-screen px-4 py-12 max-w-3xl mx-auto bg-white">
      {/* Header */}
      <div className="mb-10">
        <a
          href="/"
          className="text-gray-500 text-sm hover:text-black transition-colors"
        >
          ← Scene Fixer
        </a>
        <h1 className="text-black font-semibold text-2xl mt-2 mb-1 truncate">
          Job{" "}
          <span className="text-gray-400 font-mono text-base">{jobId}</span>
        </h1>

        {/* Score badges.
            The "after" score comes from re-running detection on the output
            video, which is a different check from the per-error verification
            that decides whether a fix actually landed. When they disagree the
            per-error check wins: a run whose every fix came back unverified
            and refunded must not be crowned with a perfect "after" score.
            Two jobs shipped exactly that — 84 → 100 and 92 → 100 — beside a
            full refund. */}
        {(job.scoreBefore !== undefined || showScoreAfter) && (
          <div className="flex gap-4 mt-4">
            {job.scoreBefore !== undefined && (
              <ScoreBadge score={job.scoreBefore} label="before" />
            )}
            {showScoreAfter && (
              <ScoreBadge score={job.scoreAfter!} label="after" />
            )}
          </div>
        )}
      </div>

      {/* Beta notice */}
      <div className="mb-6 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 flex items-center justify-between gap-4">
        <p className="text-xs text-amber-800">
          <span className="font-semibold">Beta</span> — detection and fixes may not always be perfect.
        </p>
        <a
          href="mailto:help@scenefixer.com"
          className="text-xs text-amber-800 font-semibold underline underline-offset-2 hover:opacity-70 whitespace-nowrap shrink-0"
        >
          Email us →
        </a>
      </div>

      {/* Pipeline status */}
      <div className="mb-6">
        <JobStatus
          status={job.status}
          shotCount={job.shotCount || undefined}
          shotsAnalyzed={job.shotsAnalyzed}
          errorMessage={job.errorMessage}
          evidence={{
            uploaded: !!job.inputVideoUrl,
            // run_detect writes scoreBefore only on the path that actually
            // analysed shots — not on the zero-shot early return.
            analysed: job.scoreBefore !== undefined,
            fixStarted: job.fixingStartedAt !== undefined,
            stitched: !!job.stitchVideoUrl,
            output: !!job.outputVideoUrl,
          }}
          fixTimedOut={fixTimedOut}
          verificationPassed={job.verificationPassed}
          creditsRefunded={job.creditsRefunded}
          fixesAttempted={job.fixesAttempted}
          fixesFailed={job.fixesFailed}
          errorCount={
            job.status !== "uploading" && job.status !== "decomposing"
              ? job.errorCount
              : undefined
          }
        />
      </div>

      {/* Reprocessing notice */}
      {job.status === "reprocessing" && (
        <div className="mb-8 rounded-2xl border border-blue-200 bg-blue-50 px-5 py-4">
          <p className="text-sm font-semibold text-blue-900">Re-processing your video</p>
          <p className="text-xs text-blue-700 mt-0.5">
            Applying {PLAN_LIMITS[userPlan].qualityLabel} quality and removing the watermark. Usually under a minute — you can close this page.
          </p>
        </div>
      )}

      {/* Background processing notice */}
      {(job.status === "fixing" || job.status === "verifying") && !fixTimedOut && (
        <div className="mb-8 rounded-2xl border border-blue-200 bg-blue-50 px-5 py-4">
          <p className="text-sm font-semibold text-blue-900">Running in the background</p>
          <p className="text-xs text-blue-700 mt-0.5">
            You can safely close this page.{" "}
            <a href="/jobs" className="font-semibold underline underline-offset-2">My fixed videos</a>
            {" "}will update when it&apos;s ready — usually 5–15 minutes depending on how many errors were selected.
          </p>
        </div>
      )}

      {/* Fix timed out — replace the background notice with an error + retry prompt */}
      {fixTimedOut && (
        <div className="mb-8 rounded-2xl border border-red-200 bg-red-50 px-5 py-4">
          <p className="text-sm font-semibold text-red-900">Fix timed out</p>
          <p className="text-xs text-red-700 mt-0.5">
            The fix is taking longer than expected and may have been interrupted. Select your errors below and retry.
          </p>
        </div>
      )}

      {/* Done banner + download CTA */}
      {showDiff && (() => {
        const quality = job.outputQuality ?? "720p";
        const hasWatermark = job.watermark === true;
        const isLow = quality === "480p";
        const isMid = quality === "720p";

        const bannerBorder = hasWatermark
          ? "border-amber-200 bg-amber-50"
          : job.verificationPassed === false
            ? "border-amber-200 bg-amber-50"
            : "border-emerald-200 bg-emerald-50";
        const titleColor = hasWatermark ? "text-amber-900" : "text-emerald-900";
        const subColor = hasWatermark ? "text-amber-700" : "text-emerald-700";

        // A run that verified nothing produced a file, not a fix. The download
        // stays available — it is harmless to look at — but it must not be
        // labelled as a fixed video.
        const unfixed = job.verificationPassed === false;

        let upgradeNote: string | null = null;
        if (isLow) upgradeNote = "Upgrade to Starter for 720p watermark-free output.";
        else if (isMid) upgradeNote = "Upgrade to Pro for crisp 1080p upscaled output.";

        return (
          <div className={`mb-6 rounded-2xl border px-5 py-4 ${bannerBorder}`}>
            <div className="flex flex-col sm:flex-row sm:items-center gap-3">
              <div className="flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className={`font-semibold text-sm ${unfixed ? "text-amber-900" : titleColor}`}>
                    {unfixed ? "Result available — not a fix" : "Your fixed video is ready"}
                  </p>
                  <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${
                    quality === "1080p"
                      ? "bg-black text-white"
                      : quality === "720p"
                        ? "bg-blue-100 text-blue-700"
                        : "bg-gray-200 text-gray-600"
                  }`}>
                    {quality}
                  </span>
                  {hasWatermark && (
                    <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-amber-200 text-amber-800">
                      watermark
                    </span>
                  )}
                </div>
                {upgradeNote && !canReprocess && (
                  <p className={`text-xs mt-1 ${subColor}`}>
                    {upgradeNote}{" "}
                    <a href="/pricing" className="font-semibold underline underline-offset-2">
                      Upgrade →
                    </a>
                  </p>
                )}
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                {canReprocess && (
                  <button
                    onClick={handleReprocess}
                    disabled={reprocessing}
                    className="shrink-0 inline-flex items-center gap-1.5 border border-gray-200 hover:border-gray-300 text-gray-700 text-sm font-medium px-4 py-2.5 rounded-xl transition-colors disabled:opacity-50"
                  >
                    {reprocessing ? "Re-processing…" : `Re-process in ${PLAN_LIMITS[userPlan].qualityLabel}`}
                  </button>
                )}
                <button
                  onClick={handleDownload}
                  disabled={downloading || job.status === "reprocessing"}
                  className="shrink-0 inline-flex items-center gap-2 bg-black hover:bg-gray-800 text-white text-sm font-semibold px-5 py-2.5 rounded-xl transition-colors disabled:opacity-60"
                >
                  {downloading ? "Downloading…" : `Download ${quality}`}
                  {!downloading && (
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                      <path d="M10.75 2.75a.75.75 0 0 0-1.5 0v8.614L6.295 8.235a.75.75 0 1 0-1.09 1.03l4.25 4.5a.75.75 0 0 0 1.09 0l4.25-4.5a.75.75 0 0 0-1.09-1.03l-2.955 3.129V2.75Z" />
                      <path d="M3.5 12.75a.75.75 0 0 0-1.5 0v2.5A2.75 2.75 0 0 0 4.75 18h10.5A2.75 2.75 0 0 0 18 15.25v-2.5a.75.75 0 0 0-1.5 0v2.5c0 .69-.56 1.25-1.25 1.25H4.75c-.69 0-1.25-.56-1.25-1.25v-2.5Z" />
                    </svg>
                  )}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Before/after diff player */}
      {showDiff && (
        <div className="mb-10">
          <h2 className="text-black font-semibold mb-3">Before / After</h2>
          <DiffPlayer
            beforeUrl={job.inputVideoUrl}
            afterUrl={job.outputVideoUrl!}
          />
        </div>
      )}

      {/* Error review */}
      {(job.status === "awaiting_confirmation" ||
        job.status === "fixing" ||
        job.status === "verifying" ||
        job.status === "reprocessing" ||
        job.status === "done") && (
        <div>
          <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
            <h2 className="text-black font-semibold">
              Continuity Errors
              {errors.length > 0 && (
                <span className="ml-2 text-gray-500 font-normal text-sm">
                  {confirmedCount}/{errors.length} selected
                </span>
              )}
            </h2>

            <div className="flex items-center gap-2">
              {shots.length > 0 && (
                <button
                  onClick={() => setManualOpen(true)}
                  className="px-4 py-2 rounded-xl border border-gray-200 hover:border-gray-300 text-gray-500 hover:text-gray-700 text-sm transition-colors"
                >
                  + Add another fix
                </button>
              )}

              {confirmedCount > 0 &&
                (job.status === "awaiting_confirmation" || job.status === "done" || fixTimedOut) && (
                  quotaExhausted ? (
                    <a
                      href="/pricing"
                      className="px-5 py-2 rounded-xl bg-amber-50 border border-amber-200 text-amber-800 font-semibold text-sm hover:bg-amber-100 transition-colors"
                    >
                      Out of fixes · Upgrade →
                    </a>
                  ) : (
                    <button
                      onClick={handleFix}
                      disabled={fixing || (!user && !betaToken)}
                      className="px-5 py-2 rounded-xl bg-black hover:bg-gray-800 text-white font-semibold text-sm transition-colors disabled:opacity-50"
                      title={(!user && !betaToken) ? "Sign in to fix errors" : undefined}
                    >
                      {fixing
                        ? "Starting…"
                        : fixTimedOut
                          ? `Retry ${confirmedCount} fix${confirmedCount !== 1 ? "es" : ""}`
                          : `Fix ${confirmedCount} error${confirmedCount !== 1 ? "s" : ""}`}
                    </button>
                  )
                )}
            </div>
          </div>

          {confirmedCount > 8 && (
            <div className="mb-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-xs text-amber-800">
              You&apos;ve selected {confirmedCount} errors — only the first 8 will be processed per fix session.
            </div>
          )}

          {fixError && (
            <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 flex items-center justify-between gap-3">
              <span>{fixError}</span>
              {(fixError.includes("Sign in") || fixError.includes("Upgrade")) && (
                <a
                  href={fixError.includes("Upgrade") ? "/pricing" : "/"}
                  className="shrink-0 text-xs font-semibold underline underline-offset-2"
                >
                  {fixError.includes("Upgrade") ? "See plans →" : "Sign in →"}
                </a>
              )}
            </div>
          )}

          {!user && !betaToken && (job.status === "awaiting_confirmation" || job.status === "done") && (
            <div className="mb-4 rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-600">
              <a href="/" className="font-semibold text-black hover:underline">Sign in</a> to apply fixes. Free plan includes 1 fix/month.
            </div>
          )}

          <ErrorList
            jobId={jobId}
            shots={shots}
            onAdjustLocation={(err) => setAdjustingError(err)}
          />
        </div>
      )}

      {manualOpen && (
        <ManualMarker
          jobId={jobId}
          shots={shots}
          onClose={() => setManualOpen(false)}
          betaToken={betaToken}
        />
      )}

      {adjustingError && (
        <ManualMarker
          jobId={jobId}
          shots={shots}
          existingError={adjustingError}
          onClose={() => setAdjustingError(null)}
          betaToken={betaToken}
        />
      )}
    </main>
  );
}
