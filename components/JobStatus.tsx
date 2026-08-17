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
  errorCount?: number;
  errorMessage?: string;
  fixTimedOut?: boolean;
};

export default function JobStatus({ status, shotCount, errorCount, errorMessage, fixTimedOut }: Props) {
  const currentIndex = ORDER.indexOf(status);
  const isError = status === "error";
  const banner = fixTimedOut ? null : STATUS_BANNER[status];

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
            const done = currentIndex > i;
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
    </div>
  );
}
