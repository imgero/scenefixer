"use client";

import { useEffect, useState } from "react";
import { collection, onSnapshot, orderBy, query } from "firebase/firestore";
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

    const unsub = onSnapshot(q, (snap) => {
      setErrors(
        snap.docs.map((d) => ({ id: d.id, ...d.data() }) as ContinuityError)
      );
      setLoading(false);
    });

    return unsub;
  }, [jobId]);

  return { errors, loading };
}
