"use client";

import { useErrors } from "@/lib/hooks/useErrors";
import type { Shot, ContinuityError } from "@/lib/types";
import ErrorCard from "./ErrorCard";

type Props = {
  jobId: string;
  shots: Shot[];
  onAdjustLocation?: (error: ContinuityError) => void;
};

const SEVERITY_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 };

function sortErrors(errors: ContinuityError[]): ContinuityError[] {
  return [...errors].sort((a, b) => {
    const sevDiff = (SEVERITY_ORDER[a.severity] ?? 1) - (SEVERITY_ORDER[b.severity] ?? 1);
    if (sevDiff !== 0) return sevDiff;
    // Within same severity: unresolved before resolved
    if (a.verifiedResolved !== b.verifiedResolved) return a.verifiedResolved ? 1 : -1;
    return 0;
  });
}

export default function ErrorList({ jobId, shots, onAdjustLocation }: Props) {
  const { errors, loading } = useErrors(jobId);
  const shotMap = Object.fromEntries(shots.map((s) => [s.id, s]));

  if (loading) {
    return (
      <div className="text-gray-400 text-sm text-center py-8">
        Scanning for errors…
      </div>
    );
  }

  if (errors.length === 0) {
    return (
      <div className="text-gray-400 text-sm text-center py-8">
        No inconsistencies detected yet.
      </div>
    );
  }

  const sorted = sortErrors(errors);

  return (
    <div className="flex flex-col gap-4">
      {sorted.map((err) => {
        const shotA = shotMap[err.shotAId];
        const shotB = shotMap[err.shotBId];
        if (!shotA || !shotB) return null;

        return (
          <ErrorCard
            key={err.id}
            error={err}
            jobId={jobId}
            shotAKeyframe={shotA.keyframeUrl}
            shotBKeyframe={shotB.keyframeUrl}
            onAdjustLocation={onAdjustLocation}
          />
        );
      })}
    </div>
  );
}
