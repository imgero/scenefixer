import crypto from "node:crypto";
import { NextRequest } from "next/server";
import { adminDb } from "@/lib/firebase-admin";

/**
 * Login for the private tester page. One shared login, set in env, handed to
 * one person by hand. Not Firebase Auth on purpose: the tester has no Google
 * account here, and this must not create a user document or touch the plans
 * and credits that real accounts live in.
 *
 * Fails CLOSED: with LAB_LOGIN, LAB_PASSWORD or LAB_COOKIE_SECRET unset the
 * page cannot be entered at all, so a deploy that forgets the env vars exposes
 * nothing and spends nothing.
 */

export const LAB_COOKIE = "lab_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_FAILED_LOGINS = 8;
const LOCKOUT_MS = 15 * 60 * 1000;

export type LabSession = { sid: string; exp: number };

function config() {
  const login = process.env.LAB_LOGIN?.trim();
  const password = process.env.LAB_PASSWORD;
  const secret = process.env.LAB_COOKIE_SECRET;
  if (!login || !password || !secret || secret.length < 32) return null;
  return { login, password, secret };
}

export function labEnabled(): boolean {
  return config() !== null;
}

/** The Firestore document id for this tester's budget and jobs. */
export function sessionIdFor(login: string): string {
  return login.toLowerCase().replace(/[^a-z0-9_-]/g, "_").slice(0, 40);
}

function sign(payload: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(payload).digest("base64url");
}

function sameString(a: string, b: string): boolean {
  // Hash first so the comparison is constant-time even when lengths differ.
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export function makeToken(sid: string): { token: string; expires: Date } {
  const cfg = config();
  if (!cfg) throw new Error("Lab login is not configured");
  const exp = Date.now() + SESSION_TTL_MS;
  const payload = Buffer.from(JSON.stringify({ sid, exp } satisfies LabSession)).toString("base64url");
  return { token: `${payload}.${sign(payload, cfg.secret)}`, expires: new Date(exp) };
}

export function readSession(req: NextRequest): LabSession | null {
  const cfg = config();
  if (!cfg) return null;
  const raw = req.cookies.get(LAB_COOKIE)?.value;
  if (!raw) return null;
  const [payload, sig] = raw.split(".");
  if (!payload || !sig || !sameString(sig, sign(payload, cfg.secret))) return null;
  try {
    const s = JSON.parse(Buffer.from(payload, "base64url").toString()) as LabSession;
    if (typeof s.sid !== "string" || typeof s.exp !== "number" || s.exp < Date.now()) return null;
    // A cookie minted for a login that has since been changed stops working.
    if (s.sid !== sessionIdFor(cfg.login)) return null;
    return s;
  } catch {
    return null;
  }
}

export type LoginResult =
  | { ok: true; sid: string }
  | { ok: false; reason: "disabled" | "locked" | "wrong"; retryInMin?: number };

/** Checks the credentials, counting failures in Firestore so a guesser is slowed across requests. */
export async function attemptLogin(login: string, password: string): Promise<LoginResult> {
  const cfg = config();
  if (!cfg) return { ok: false, reason: "disabled" };

  const ref = adminDb.collection("lab_sessions").doc(sessionIdFor(cfg.login));
  const snap = await ref.get();
  const lockedUntil: number = snap.data()?.lockedUntil ?? 0;
  if (lockedUntil > Date.now()) {
    return { ok: false, reason: "locked", retryInMin: Math.ceil((lockedUntil - Date.now()) / 60000) };
  }

  const good = sameString(login.trim().toLowerCase(), cfg.login.toLowerCase()) && sameString(password, cfg.password);
  if (good) {
    await ref.set({ failedLogins: 0, lockedUntil: 0 }, { merge: true });
    return { ok: true, sid: sessionIdFor(cfg.login) };
  }

  const failed = (snap.data()?.failedLogins ?? 0) + 1;
  await ref.set(
    failed >= MAX_FAILED_LOGINS
      ? { failedLogins: 0, lockedUntil: Date.now() + LOCKOUT_MS }
      : { failedLogins: failed },
    { merge: true },
  );
  return { ok: false, reason: "wrong" };
}
