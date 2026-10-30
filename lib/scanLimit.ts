import { adminDb } from "@/lib/firebase-admin";
import type { Entitlement } from "@/lib/entitlements";
// Single source of truth — the pricing page states this same number, and the
// two drifting apart means the site promises one thing and the API enforces
// another.
import { FREE_SCANS_PER_DAY, CREDIT_HOLDER_SCANS_PER_DAY } from "@/lib/types";

/**
 * Where a free-plan account stands against its daily scan limit.
 *
 * Read by /api/jobs before anything is uploaded, and by /api/jobs/[id]/start,
 * which also counts the scan. The start route used to be the only check, so a
 * user over the limit uploaded the whole file first and was refused after it:
 * 5 times between 28 and 30 Oct, all to the two most engaged new users.
 */
export async function dailyScanStatus(uid: string, ent: Entitlement) {
  const today = new Date().toISOString().slice(0, 10);
  const snap = await adminDb.collection("users").doc(uid).get();
  const data = snap.exists ? snap.data()! : {};
  const scansToday = data.scanDate === today ? (data.scansToday ?? 0) : 0;
  const limit = ent.creditsBalance > 0 ? CREDIT_HOLDER_SCANS_PER_DAY : FREE_SCANS_PER_DAY;
  return { today, scansToday, limit, reached: ent.plan === "free" && scansToday >= limit };
}

// No longer says "upgrade": there are no plans to upgrade to. The daily limit
// exists because analysis is the part that costs real money per run (Claude
// vision, billed to us on every scan, free ones included) — unlike fixes,
// which draw on a prepaid balance.
export function scanLimitMessage(limit: number): string {
  return limit === 1
    ? "That's your free scan for today. It resets at midnight UTC."
    : `That's your ${limit} scans for today. They reset at midnight UTC.`;
}
