const OWNER_EMAIL = "business@alanany.com";

const LOOPS_URL = "https://app.loops.so/api/v1/transactional";

/**
 * Email the owner, via Loops.
 *
 * This used to call Resend. RESEND_API_KEY is set in no environment — not
 * .env.local, not any Vercel environment — so the `if (!apiKey) return` guard
 * below fired on every call and not one owner notification has ever been sent
 * since this file was written. The "new job" and "new sign-up" emails were
 * silently going nowhere.
 *
 * Loops instead, because LOOPS_API_KEY already exists and already works: the
 * sign-up path in app/api/loops/contact/route.ts has been creating contacts
 * with it this whole time. Same key, same account, nothing new to verify.
 *
 * Still best-effort and still non-blocking: a notification must never be able
 * to fail a request. Missing config no-ops rather than guessing.
 */
export async function notifyOwner(subject: string, text: string): Promise<void> {
  const apiKey = process.env.LOOPS_API_KEY;
  const transactionalId = process.env.LOOPS_OWNER_TRANSACTIONAL_ID;
  if (!apiKey || !transactionalId) return;
  try {
    const res = await fetch(LOOPS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email: OWNER_EMAIL,
        transactionalId,
        addToAudience: false,
        dataVariables: { subject_line: subject, body_text: text },
      }),
    });
    if (!res.ok) {
      // Logged, never thrown. A dead notification channel that fails loudly in
      // the logs is recoverable; one that takes a job creation down with it is
      // not. This log is also the only way the silent-Resend failure would
      // ever have been visible.
      console.error(`notifyOwner: loops ${res.status} ${await res.text()}`);
    }
  } catch (err) {
    console.error("notifyOwner failed:", err);
  }
}
