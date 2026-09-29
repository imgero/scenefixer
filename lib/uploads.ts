import type { Job } from "@/lib/types";

/** How long the signed PUT URL issued by POST /api/jobs stays valid. */
export const UPLOAD_URL_TTL_MS = 60 * 60 * 1000;

/**
 * A job still "uploading" after its upload URL expired can never receive its
 * file. 38 of the first 232 jobs ended like this, 31 of them followed by the
 * same person trying again, and each sat in My Jobs as "Uploading" forever,
 * opening onto "Hang tight while your file uploads".
 */
export function isAbandonedUpload(
  job: Pick<Job, "status" | "createdAt">,
  now: number = Date.now(),
): boolean {
  if (job.status !== "uploading") return false;
  // null while a serverTimestamp() write is still pending on this client.
  const created = job.createdAt?.toMillis?.();
  return created !== undefined && now - created > UPLOAD_URL_TTL_MS;
}
