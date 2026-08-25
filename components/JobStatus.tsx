import type { JobStatus } from "@/lib/types";

const STEPS: { status: JobStatus; label: string }[] = [
  { status: "uploading", label: "Uploading" },
  { status: "decomposing", label: "Splitting shots" },
  { status: "detecting", label: "Scanning shots" },
  { status: "awaiting_confirmation", label: "Review" },
  { status: "fixing", label: "Fixing with Aleph" },
  { status: "verifying", label: "Verifying" },
  { status: "done", label: "Done" },
];

const ORDER = STEPS.map((s) => s.status);

const STATUS_BANNER: Partial<Record<JobStatus, { heading: string; sub: string }>> = {
  uploading:   { heading: "Uploading video…",          sub: "Hang tight while your file uploads." },
  decomposing: { heading: "Splitting into shots…",     sub: "Transcoding and detecting scene cuts — takes 1–3 min." },
  detecting:   { heading: "Scanning for inconsistencies…", sub: "Claude is reviewing every shot pair — takes 1–2 min." },
  fixing:      { heading: "Fixing with Runway Aleph…", sub: "AI is regenerating the affected frames — takes a few minutes per fix." },
  verifying:   { heading: "Verifying fixes…",          sub: "Checking that each error is resolved." },
};

type Props = {
  status: JobStatus;
  shotCount?: number;
  shotsAnalyzed?: number;
  errorCount?: number;
  errorMessage?: string;
  fixTimedOut?: boolean;
  /** False when a finished run did not verify a single fix. */
  verificationPassed?: boolean;
  /** Credits returned to the owner for this run. */
  creditsRefunded?: number;
  fixesAttempted?: number;
  fixesFailed?: number;
  /**
   * Evidence that each phase actually produced its output. A tick must mean
   * "this ran", never "the job is past this point in the sequence".
   */
  evidence?: {
    uploaded?: boolean;
    analysed?: boolean;
    fixStarted?: boolean;
    stitched?: boolean;
    output?: boolean;
  };
};

export default function JobStatus({ status, shotCount, shotsAnalyzed, errorCount, errorMessage, fixTimedOut, evidence, verificationPassed, creditsRefunded, fixesAttempted, fixesFailed }: Props) {
  const currentIndex = ORDER.indexOf(status);
  const isError = status === "error";
  const banner = fixTimedOut ? null : STATUS_BANNER[status];

  // The job page passes `shotCount={job.shotCount || undefined}`, so a real 0
  // arrives as undefined. Normalise here rather than change the call site.
  const shotsDetected = shotCount ?? 0;

  // Jobs written before shotsAnalyzed existed have no value for it; for those,
  // every detected shot was analysed by definition.
  const shotsUsable = shotsAnalyzed ?? shotsDetected;

  // Some shots lost every keyframe, so the analysis only saw part of the video.
  // Neither "single continuous shot" nor "clean result" is true here.
  const partiallyAnalysed = shotsUsable < shotsDetected;

  // Each tick is derived from that phase having produced something, not from
  // the job's position in STEPS. The positional version ticked "Splitting
  // shots" and "Scanning shots" on a job rejected before transcoding ever
  // ran — certifying work that did not happen, which is worse than saying
  // nothing. Falls back to the positional rule only when no evidence is
  // supplied, so the component still renders sensibly without it.
  const phaseDone: boolean[] = STEPS.map((step, i) => {
    if (!evidence) return currentIndex > i;
    switch (step.status) {
      case "uploading":
        return !!evidence.uploaded;
      case "decomposing":
        return shotsDetected > 0;
      case "detecting":
        return !!evidence.analysed;
      case "awaiting_confirmation":
        return !!evidence.fixStarted;
      case "fixing":
        return !!evidence.stitched;
      case "verifying":
        return !!evidence.output;
      case "done":
        // Same rule as every other step: the tick means the phase produced its
        // output. A run that verified nothing did not.
        return status === "done" && verificationPassed !== false;
      default:
        return false;
    }
  });

  // A finished run that verified nothing is NOT a fix, however "done" the
  // status says it is. Explicit false only: jobs written before this field
  // existed leave it undefined and must keep their old presentation.
  const finishedUnfixed = status === "done" && verificationPassed === false;

  // A job can carry an errorMessage while its status is NOT "error" — decompose
  // writes one on a plan rejection and detect then overwrites the status. Show
  // the message whenever it exists, or the reason stays unread in Firestore.
  const showRejection = !isError && !!errorMessage;

  // A finished analysis that found nothing rendered as a bare progress rail
  // with no text at all. Two genuinely different outcomes, two messages.
  const showEmptyState =
    !isError &&
    !errorMessage &&
    status === "awaiting_confirmation" &&
    (errorCount ?? 0) === 0;

  return (
    <div className="w-full max-w-2xl mx-auto">
      {isError ? (
        <div className="rounded-xl border border-red-200 bg-red-50 px-5 py-4 text-red-700">
          <p className="font-semibold text-sm mb-1">Pipeline error</p>
          {errorMessage ? (
            <p className="text-xs font-mono break-all opacity-80">{errorMessage}</p>
          ) : (
            <p className="text-xs opacity-70">No details available — check Modal logs.</p>
          )}
        </div>
      ) : (
        <>
          {banner && (
            <div className="mb-6 rounded-xl border border-gray-100 bg-gray-50 px-5 py-4 flex items-start gap-3">
              <svg className="mt-0.5 shrink-0 animate-spin text-black" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" strokeLinecap="round"/>
              </svg>
              <div>
                <p className="text-black font-semibold text-sm">{banner.heading}</p>
                <p className="text-gray-500 text-xs mt-0.5">{banner.sub}</p>
              </div>
            </div>
          )}
        <div className="flex items-center gap-0">
          {STEPS.map((step, i) => {
            const done = phaseDone[i];
            const active = currentIndex === i;

            return (
              <div key={step.status} className="flex items-center flex-1 min-w-0">
                <div className="flex flex-col items-center">
                  <div
                    className={[
                      "w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold border transition-colors",
                      done
                        ? "bg-black border-black text-white"
                        : active
                          ? "bg-white border-black text-black animate-pulse"
                          : "bg-white border-gray-200 text-gray-400",
                    ].join(" ")}
                  >
                    {done ? "✓" : i + 1}
                  </div>
                  <span
                    className={[
                      "text-[10px] mt-1 whitespace-nowrap",
                      done
                        ? "text-gray-500"
                        : active
                          ? "text-black font-medium"
                          : "text-gray-400",
                    ].join(" ")}
                  >
                    {step.label}
                  </span>
                </div>
                {i < STEPS.length - 1 && (
                  <div
                    className={[
                      "h-px flex-1 mb-5 mx-0.5 transition-colors",
                      done ? "bg-black" : "bg-gray-200",
                    ].join(" ")}
                  />
                )}
              </div>
            );
          })}
        </div>
        </>
      )}

      {(shotCount !== undefined || errorCount !== undefined) && (
        <div className="flex gap-6 mt-4 text-sm text-gray-500 justify-center">
          {shotCount !== undefined && (
            <span>
              <span className="text-black font-semibold">{shotCount}</span> shots
            </span>
          )}
          {errorCount !== undefined && (
            <span>
              <span className="text-black font-semibold">{errorCount}</span>{" "}
              errors found
            </span>
          )}
        </div>
      )}

      {finishedUnfixed && (
        <div className="mt-5 rounded-xl border border-amber-200 bg-amber-50 px-5 py-4">
          <p className="font-semibold text-sm text-amber-900 mb-1">
            We couldn&apos;t fix this one
          </p>
          <p className="text-sm text-amber-800">
            {fixesFailed && fixesAttempted && fixesFailed >= fixesAttempted
              ? "The fix couldn't be applied to this clip."
              : "We regenerated the affected frames, but the inconsistency is still visible, so this isn't a fix."}
            {creditsRefunded && creditsRefunded > 0
              ? ` Your ${creditsRefunded} credit${creditsRefunded === 1 ? "" : "s"} ${creditsRefunded === 1 ? "has" : "have"} been returned — you have not been charged.`
              : " You have not been charged."}
          </p>
          <p className="text-sm text-amber-800 mt-2">
            The result is still available below if you want to look at it, but we
            are not calling it a fixed video.
          </p>
        </div>
      )}

      {showRejection && (
        <div className="mt-5 rounded-xl border border-amber-200 bg-amber-50 px-5 py-4">
          <p className="font-semibold text-sm text-amber-900 mb-1">
            This video wasn&apos;t analysed
          </p>
          <p className="text-sm text-amber-800">{errorMessage}</p>
        </div>
      )}

      {showEmptyState && partiallyAnalysed && (
        <div className="mt-5 rounded-xl border border-amber-200 bg-amber-50 px-5 py-4">
          <p className="font-semibold text-sm text-amber-900 mb-1">
            Analysed {shotsUsable} of {shotsDetected} shots
          </p>
          <p className="text-sm text-amber-800">
            Some frames could not be extracted, so part of this video was not
            checked. Nothing was found in the {shotsUsable} shot
            {shotsUsable === 1 ? "" : "s"} that were analysed, but that is not a
            clean result for the whole clip. Re-uploading often works.
          </p>
        </div>
      )}

      {showEmptyState && !partiallyAnalysed && shotsUsable <= 1 && (
        <div className="mt-5 rounded-xl border border-gray-200 bg-gray-50 px-5 py-4">
          <p className="font-semibold text-sm text-black mb-1">
            Nothing to compare in this clip
          </p>
          <p className="text-sm text-gray-600">
            Scene Fixer finds continuity errors by comparing one shot against
            another, and this video is a single continuous shot. Upload a clip
            with at least two or three cuts and it will have something to work
            with.
          </p>
        </div>
      )}

      {showEmptyState && !partiallyAnalysed && shotsUsable >= 2 && (
        <div className="mt-5 rounded-xl border border-green-200 bg-green-50 px-5 py-4">
          <p className="font-semibold text-sm text-green-900 mb-1">
            No continuity errors found
          </p>
          <p className="text-sm text-green-800">
            The analysis compared all {shotsUsable} shots and found nothing
            inconsistent between them. This clip is clean — there is nothing to
            fix.
          </p>
        </div>
      )}
    </div>
  );
}
