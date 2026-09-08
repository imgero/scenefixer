"use client";

import { useEffect, useState } from "react";
import { doc, onSnapshot } from "firebase/firestore";
import { db } from "@/lib/firebase";
import posthog from "posthog-js";
import type { Job } from "@/lib/types";

export function useJob(jobId: string) {
  const [job, setJob] = useState<Job | null>(null);
  const [loading, setLoading] = useState(true);
  const [denied, setDenied] = useState(false);

  useEffect(() => {
    setDenied(false);
    const unsub = onSnapshot(
      doc(db, "jobs", jobId),
      (snap) => {
        if (snap.exists()) {
          setJob({ id: snap.id, ...snap.data() } as Job);
        }
        setLoading(false);
      },
      (err) => {
        if (err.code === "permission-denied") {
          setDenied(true);
        }
        setLoading(false);
        posthog.capture("firestore_listen_failed", {
          listener: "job",
          job_id: jobId,
          code: err.code,
          message: err.message,
        });
      }
    );

    return unsub;
  }, [jobId]);

  return { job, loading, denied };
}
