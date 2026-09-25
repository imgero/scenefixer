import { NextRequest, NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb, adminAuth } from "@/lib/firebase-admin";
import { notifyOwner } from "@/lib/notify";
import { captureServer } from "@/lib/posthog-server";

// Replaces every mailto:help@scenefixer.com link. On desktop browsers with no
// mail handler a mailto click does nothing at all, and two real users in a row
// (one of them the first paying customer) clicked it and reached no one.
//
// Firestore is the record, the email is a courtesy. notifyOwner no-ops while
// LOOPS_OWNER_TRANSACTIONAL_ID is unset, so a request that only emailed would
// be lost exactly the way the mailto ones were.

const MAX_MESSAGE = 4000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  // Honeypot: a field no person can see. Bots that fill every input get a
  // success response and nothing is stored.
  if (typeof body.website === "string" && body.website.length > 0) {
    return NextResponse.json({ ok: true });
  }

  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) {
    return NextResponse.json({ error: "Please write a message." }, { status: 400 });
  }

  let uid: string | null = null;
  let accountEmail: string | null = null;
  const authHeader = req.headers.get("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    try {
      const decoded = await adminAuth.verifyIdToken(authHeader.slice(7));
      uid = decoded.uid;
      accountEmail = decoded.email ?? null;
    } catch {
      // A stale token must not cost someone their message — fall through and
      // treat it as a signed-out request, which requires a reply address.
    }
  }

  const givenEmail = typeof body.email === "string" ? body.email.trim() : "";
  const replyTo = givenEmail || accountEmail || "";
  if (!EMAIL_RE.test(replyTo)) {
    return NextResponse.json(
      { error: "Please add an email address so we can reply." },
      { status: 400 }
    );
  }

  const str = (v: unknown, max: number) =>
    typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;
  const jobId = str(body.jobId, 64);
  const page = str(body.page, 300);
  const source = str(body.source, 64);

  try {
    const ref = await adminDb.collection("support_requests").add({
      message: message.slice(0, MAX_MESSAGE),
      replyTo,
      uid,
      accountEmail,
      jobId,
      page,
      source,
      userAgent: req.headers.get("user-agent")?.slice(0, 300) ?? null,
      language: req.headers.get("accept-language")?.slice(0, 100) ?? null,
      status: "open",
      createdAt: FieldValue.serverTimestamp(),
    });

    await notifyOwner(
      `[Scene Fixer] Help request from ${replyTo}`,
      [
        message.slice(0, MAX_MESSAGE),
        "",
        `Reply to: ${replyTo}`,
        `UID: ${uid ?? "signed out"}`,
        `Job: ${jobId ?? "—"}`,
        `Page: ${page ?? "—"}`,
        `Firestore: support_requests/${ref.id}`,
      ].join("\n")
    );

    await captureServer({
      distinctId: uid ?? `support_${ref.id}`,
      event: "support_request_sent",
      properties: { job_id: jobId, source, signed_in: !!uid },
    });

    return NextResponse.json({ ok: true, id: ref.id });
  } catch (err) {
    console.error("POST /api/support error:", err);
    return NextResponse.json(
      { error: "Couldn't send that — please try again in a moment." },
      { status: 500 }
    );
  }
}
