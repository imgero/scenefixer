import { NextRequest } from "next/server";
import { adminAuth } from "@/lib/firebase-admin";

/**
 * Who may reach the admin surfaces.
 *
 * Defaults to the owner. `ADMIN_EMAILS` (comma-separated) overrides, so a
 * second reviewer can be added without a deploy of this file.
 */
export const ADMIN_EMAILS: string[] = (
  process.env.ADMIN_EMAILS || "business@alanany.com"
)
  .split(",")
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

export function isAdminEmail(email?: string | null): boolean {
  return !!email && ADMIN_EMAILS.includes(email.toLowerCase());
}

/**
 * Authorise an admin request by either route:
 *
 *  - `Authorization: Bearer <firebase id token>` from a signed-in admin. This
 *    is the one a human uses — sign in normally and the page works.
 *  - `x-admin-secret` matching ADMIN_SECRET, kept for curl and for the
 *    existing admin routes that already use it.
 *
 * The email is read from the VERIFIED token, never from the request body, so
 * a caller cannot simply claim to be the owner.
 */
export async function authorizeAdmin(
  req: NextRequest,
): Promise<{ ok: true; email: string } | { ok: false; reason: string }> {
  const secret = process.env.ADMIN_SECRET;
  const provided = req.headers.get("x-admin-secret");
  if (secret && provided && provided === secret) {
    return { ok: true, email: "admin-secret" };
  }

  const authz = req.headers.get("authorization") || "";
  const token = authz.startsWith("Bearer ") ? authz.slice(7).trim() : "";
  if (!token) {
    return { ok: false, reason: "Sign in with an admin account" };
  }
  try {
    const decoded = await adminAuth.verifyIdToken(token);
    if (!isAdminEmail(decoded.email)) {
      return { ok: false, reason: "That account is not an admin" };
    }
    // An unverified email can be anything the signer typed at a provider that
    // does not check. Admin access is not the place to be relaxed about it.
    if (decoded.email_verified === false) {
      return { ok: false, reason: "Verify your email address first" };
    }
    return { ok: true, email: decoded.email! };
  } catch {
    return { ok: false, reason: "Session expired — sign in again" };
  }
}
