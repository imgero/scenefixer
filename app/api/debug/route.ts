import { NextResponse } from "next/server";

export async function GET() {
  const processUrl = process.env.MODAL_PROCESS_JOB_URL;
  const fixUrl = process.env.MODAL_FIX_PHASE_URL;
  const token = process.env.MODAL_BEARER_TOKEN;

  // Ping the process_job endpoint with a fake jobId to see the raw Modal response
  let modalPing: { status?: number; body?: string; error?: string } = {};
  if (processUrl && token) {
    try {
      const res = await fetch(processUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ jobId: "debug-ping" }),
      });
      modalPing = { status: res.status, body: await res.text() };
    } catch (e) {
      modalPing = { error: String(e) };
    }
  }

  return NextResponse.json({
    env: {
      MODAL_PROCESS_JOB_URL: processUrl ?? "MISSING",
      MODAL_FIX_PHASE_URL: fixUrl ?? "MISSING",
      MODAL_BEARER_TOKEN: token ? `set (${token.length} chars)` : "MISSING",
    },
    modalPing,
  });
}
