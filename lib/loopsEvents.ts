import { adminAuth, adminDb } from "@/lib/firebase-admin";

/**
 * Tell Loops something happened to a user, for the lifecycle emails built as
 * Loops automations (welcome, feedback replies, Studio receipt, pass ending).
 *
 * Sends nothing by itself: an event only emails someone once a published Loop
 * in Loops listens for it. Best-effort; never throws. Modal sends the scan and
 * fix events (modal_app/notify.py `event`).
 */
export async function loopsEvent(
  uid: string,
  eventName: string,
  eventProperties: Record<string, string | number | boolean> = {},
  contactProperties: Record<string, string | number | boolean> = {}
): Promise<void> {
  const apiKey = process.env.LOOPS_API_KEY;
  if (!apiKey) return;
  try {
    const email = await emailFor(uid);
    if (!email) return;
    const res = await fetch("https://app.loops.so/api/v1/events/send", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ email, userId: uid, eventName, eventProperties, ...contactProperties }),
    });
    if (!res.ok) console.error(`loopsEvent ${eventName}: ${res.status} ${await res.text()}`);
  } catch (err) {
    console.error(`loopsEvent ${eventName} failed:`, err);
  }
}

async function emailFor(uid: string): Promise<string | null> {
  const doc = await adminDb.collection("users").doc(uid).get();
  const fromDoc = doc.exists ? (doc.data()?.email as string | undefined) : undefined;
  if (fromDoc) return fromDoc;
  const user = await adminAuth.getUser(uid).catch(() => null);
  return user?.email ?? null;
}
