"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { collection, query, where, orderBy, limit, onSnapshot } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useAuth } from "@/lib/hooks/useAuth";
import type { Job } from "@/lib/types";
import { FilmSlate, ArrowRight, CheckCircle, Clock, Warning } from "@phosphor-icons/react";

const STATUS_META: Record<string, { label: string; color: string }> = {
  done:                  { label: "Fixed",      color: "text-emerald-600 bg-emerald-50" },
  fixing:                { label: "Fixing…",    color: "text-blue-600 bg-blue-50" },
  verifying:             { label: "Verifying…", color: "text-blue-600 bg-blue-50" },
  awaiting_confirmation: { label: "Review",     color: "text-amber-600 bg-amber-50" },
  detecting:             { label: "Detecting…", color: "text-gray-500 bg-gray-100" },
  decomposing:           { label: "Processing", color: "text-gray-500 bg-gray-100" },
  uploading:             { label: "Uploading",  color: "text-gray-500 bg-gray-100" },
  error:                 { label: "Error",      color: "text-red-600 bg-red-50" },
};

export default function JobsPage() {
  const { user, loading } = useAuth();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [jobsLoading, setJobsLoading] = useState(true);

  useEffect(() => {
    if (!user) { setJobsLoading(false); return; }

    const q = query(
      collection(db, "jobs"),
      where("ownerUid", "==", user.uid),
      orderBy("createdAt", "desc"),
      limit(50)
    );

    const unsub = onSnapshot(q, (snap) => {
      setJobs(snap.docs.map((d) => ({ id: d.id, ...d.data() }) as Job));
      setJobsLoading(false);
    }, () => {
      setJobsLoading(false);
    });

    return unsub;
  }, [user]);

  if (loading || jobsLoading) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-white">
        <div className="text-gray-400 animate-pulse text-sm">Loading…</div>
      </main>
    );
  }

  if (!user) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-white px-4">
        <div className="text-center max-w-sm">
          <p className="text-black font-semibold mb-2">Sign in to see your jobs</p>
          <Link href="/" className="text-sm text-gray-500 hover:text-black underline">
            ← Back to Scene Fixer
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-white px-4 py-12 max-w-3xl mx-auto">
      <div className="mb-8">
        <Link href="/" className="text-gray-400 text-sm hover:text-black transition-colors">
          ← Scene Fixer
        </Link>
        <h1 className="text-2xl font-semibold text-black mt-3">My fixed videos</h1>
        <p className="text-gray-500 text-sm mt-1">{jobs.length} job{jobs.length !== 1 ? "s" : ""}</p>
      </div>

      {jobs.length === 0 ? (
        <div className="rounded-2xl border-2 border-dashed border-gray-200 p-12 text-center">
          <FilmSlate size={36} weight="thin" className="mx-auto mb-4 text-gray-300" />
          <p className="text-gray-500 text-sm mb-4">No jobs yet.</p>
          <Link
            href="/"
            className="inline-block bg-black text-white text-sm font-semibold px-5 py-2.5 rounded-xl hover:bg-gray-800 transition-colors"
          >
            Upload your first video
          </Link>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {jobs.map((job) => {
            const meta = STATUS_META[job.status] ?? { label: job.status, color: "text-gray-500 bg-gray-100" };
            const rawPath = job.inputVideoUrl?.split("/o/")[1]?.split("?")[0] ?? "";
            const filename = (rawPath ? decodeURIComponent(rawPath).split("/").pop() : null) ?? job.id;
            const isDone = job.status === "done";

            return (
              <Link
                key={job.id}
                href={`/job/${job.id}`}
                className="flex items-center gap-4 rounded-2xl border border-gray-100 bg-white px-4 py-4 hover:border-gray-300 transition-colors group"
              >
                <div className="w-10 h-10 rounded-xl bg-gray-50 flex items-center justify-center shrink-0">
                  {isDone
                    ? <CheckCircle size={20} weight="thin" className="text-emerald-500" />
                    : job.status === "error"
                      ? <Warning size={20} weight="thin" className="text-red-400" />
                      : <Clock size={20} weight="thin" className="text-gray-400" />}
                </div>

                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-black truncate">{filename}</p>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${meta.color}`}>
                      {meta.label}
                    </span>
                    {isDone && job.outputQuality && (
                      <span className="text-[10px] text-gray-400">{job.outputQuality}</span>
                    )}
                    {isDone && job.fixedCount > 0 && (
                      <span className="text-[10px] text-gray-400">{job.fixedCount} error{job.fixedCount !== 1 ? "s" : ""} fixed</span>
                    )}
                    <span className="text-[10px] text-gray-300">
                      {job.createdAt?.toDate?.()?.toLocaleDateString?.() ?? ""}
                    </span>
                  </div>
                </div>

                <ArrowRight size={16} weight="thin" className="text-gray-300 group-hover:text-gray-600 transition-colors shrink-0" />
              </Link>
            );
          })}
        </div>
      )}
    </main>
  );
}
