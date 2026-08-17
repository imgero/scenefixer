async function callModal(url: string, body: Record<string, unknown>) {
  const token = process.env.MODAL_BEARER_TOKEN;
  if (!url) throw new Error(`Modal URL not configured (check .env.local)`);
  if (!token) throw new Error(`MODAL_BEARER_TOKEN not set`);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Modal ${url} → ${res.status}: ${text}`);
  }

  return res.json();
}

export async function triggerProcessJob(jobId: string) {
  return callModal(process.env.MODAL_PROCESS_JOB_URL!, { jobId });
}

export async function triggerFixPhase(jobId: string) {
  return callModal(process.env.MODAL_FIX_PHASE_URL!, { jobId });
}

export async function triggerReprocessJob(jobId: string) {
  return callModal(process.env.MODAL_REPROCESS_URL!, { jobId });
}
