"use client";

import { useEffect, useState } from "react";
import { collection, onSnapshot, orderBy, query } from "firebase/firestore";
import posthog from "posthog-js";
import { db } from "@/lib/firebase";
import type { ContinuityError } from "@/lib/types";

export function useErrors(jobId: string) {
  const [errors, setErrors] = useState<ContinuityError[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const q = query(
      collection(db, "jobs", jobId, "errors"),
      orderBy("createdAt", "asc")
    );

    // A listener with no error callback throws asynchronously, which reaches
    // the user as an unhandled `FirebaseError: Missing or insufficient
    // permissions` with no stack and nothing naming what was being read.
    // Handle it, and report which listener failed.
    const unsub = onSnapshot(
      q,
      (snap) => {
        setErrors(
          snap.docs.map((d) => ({ id: d.id, ...d.data() }) as ContinuityError)
        );
        setLoading(false);
      },
      (err) => {
        setLoading(false);
        posthog.capture("firestore_listen_failed", {
          listener: "job_errors",
          job_id: jobId,
          code: err.code,
          message: err.message,
        });
      }
    );

    return unsub;
  }, [jobId]);

  return { errors, loading };
}
