import dns from "node:dns/promises";
import { adminDb } from "@/lib/firebase-admin";
import { PLAN_LIMITS, type Plan } from "@/lib/types";

/**
 * Single source of truth for what an account is entitled to.
 *
 * Before this existed, `/api/jobs/[id]/start` created user documents with only
 * `{ scanDate, scansToday }` via a merge-write. Every account created that way
 * had no `plan`, no `monthResetAt` and no credit fields, so the fix route read
 * `plan ?? "free"` and silently treated everyone as free — including a customer
 * who had paid, because the entitlement write that sets `plan` never ran.
 * Any code path that touches a user document goes through here now.
 */

/** Start of the current calendar month, in local server time. */
export function startOfMonth(date: Date = new Date()): number {
  return new Date(date.getFullYear(), date.getMonth(), 1).getTime();
}

/**
 * Hard ceiling on credits an account may spend in one calendar month,
 * regardless of plan grant plus purchased balance.
 *
 * This is a blast-radius limit, not a product tier. The Runway balance is a
 * fixed prepaid pool with no expiry; without a ceiling, one compromised or
 * abusive account with a large purchased balance could drain a meaningful
 * fraction of it in a day. Set well above what a legitimate user of each tier
 * would reach in a month, so it never fires in normal use.
 */
export const MONTHLY_SPEND_CEILING: Record<Plan, number> = {
  // Must stay ABOVE PLAN_LIMITS[plan].creditsPerMonth, or the ceiling silently
  // becomes the grant: when the free grant went to 90 this was still 30, which
  // would have capped every free user at a third of what they were promised
  // and produced a "you have 60 credits" balance that could not be spent.
  //
  // Purchased credits stack on top of the grant, so the headroom above it is
  // what a credit pack can actually buy within one month — 300 lets a free
  // user spend their 90 plus a $100/240-credit pack without hitting this.
  free: 300,
  starter: 400,
  pro: 800,
  studio: 1600,
};

/**
 * Credits granted per month to an account whose email is not yet verified.
 *
 * Zero, deliberately. Signup accepted `thelilithshow@thelilithshow.com`, a
 * domain that does not resolve, so every transactional email to that account
 * hard-bounced from day one. An unverified address is also the cheapest way to
 * mint unlimited free accounts against a prepaid credit pool.
 */
export const UNVERIFIED_MONTHLY_CREDITS = 0;

/**
 * How long an "undeliverable" verdict stands before it is re-checked.
 *
 * Deliverability is cached to keep a DNS lookup off every fix request. Caching
 * a negative forever turns one DNS answer — including one taken during a
 * resolver outage that happened to return NXDOMAIN — into a permanent, silent
 * lockout that the user cannot clear by any action available to them.
 */
export const RECHECK_UNDELIVERABLE_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * Whether an address's domain can receive mail at all.
 *
 * Google OAuth is the only signup path, so Firebase always reports
 * emailVerified: true — including for `thelilithshow@thelilithshow.com`, a
 * Google Workspace account on a domain that no longer resolves at all
 * (ENOTFOUND on both MX and A). Every transactional email to that account had
 * hard-bounced since day one and the verified flag never noticed.
 *
 * So "verified" is not the property that matters — deliverable is. A domain
 * with no MX and no A record cannot accept mail under RFC 5321 fallback rules.
 *
 * Fails OPEN: a DNS timeout or resolver hiccup must never lock a legitimate
 * customer out of credits they are entitled to. Only an explicit
 * "this domain does not exist" answer counts as undeliverable.
 */
export async function isDeliverableDomain(email: string | null | undefined): Promise<boolean> {
  const domain = email?.split("@")[1]?.trim().toLowerCase();
  if (!domain) return false;
  try {
    const mx = await dns.resolveMx(domain);
    if (mx.length > 0) return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // NODATA means the domain exists but publishes no MX — fall through to the
    // A-record check, which is the RFC 5321 implicit-MX fallback.
    if (code !== "ENOTFOUND" && code !== "ENODATA") return true;
  }
  try {
    const a = await dns.resolve4(domain);
    return a.length > 0;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOTFOUND" || code === "ENODATA") return false;
    return true; // resolver problem, not a verdict — fail open
  }
}

export type Entitlement = {
  plan: Plan;
  emailVerified: boolean;
  /** Domain resolves and can accept mail. See isDeliverableDomain. */
  emailDeliverable: boolean;
  /** Credits granted this month — 0 until the address is verified AND deliverable. */
  monthlyGrant: number;
  creditsUsedThisMonth: number;
  creditsBalance: number;
  monthResetAt: number;
  /** Grant remaining this month, after usage. */
  monthlyLeft: number;
  /** Ceiling headroom: how much more may be spent this month at all. */
  ceilingLeft: number;
};

/**
 * The full default shape for a new user document.
 *
 * Written on creation so no document can exist in the partial state that
 * caused the entitlement bug. `plan` is explicitly "free" rather than absent —
 * an absent field and a free plan are indistinguishable to a reader, which is
 * exactly what made the paid-customer failure invisible.
 */
export function defaultUserDoc(uid: string, email: string | null) {
  return {
    uid,
    email: email ?? null,
    plan: "free" as Plan,
    creditsUsedThisMonth: 0,
    creditsBalance: 0,
    monthResetAt: startOfMonth(),
    createdAt: Date.now(),
  };
}

/**
 * Ensure users/{uid} exists with the complete entitlement shape, then return
 * the account's current entitlement.
 *
 * Backfills individual missing fields on documents written before this module
 * existed. Never overwrites a field that is already set — in particular it will
 * not clobber a `plan` written by the Stripe webhook.
 */
export async function ensureEntitlement(
  uid: string,
  opts: { email?: string | null; emailVerified?: boolean } = {}
): Promise<Entitlement> {
  const ref = adminDb.collection("users").doc(uid);
  const snap = await ref.get();
  const data = snap.exists ? snap.data()! : {};

  const monthStart = startOfMonth();
  const defaults = defaultUserDoc(uid, opts.email ?? data.email ?? null);

  const backfill: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(defaults)) {
    // createdAt must reflect the real first-seen time, not the backfill time.
    if (key === "createdAt" && snap.exists) continue;
    if (data[key] === undefined) backfill[key] = value;
  }
  if (opts.emailVerified !== undefined && data.emailVerified !== opts.emailVerified) {
    backfill.emailVerified = opts.emailVerified;
  }
  if (Object.keys(backfill).length > 0) {
    await ref.set(backfill, { merge: true });
  }

  const merged = { ...data, ...backfill };
  const plan = (merged.plan as Plan) ?? "free";
  const emailVerified =
    opts.emailVerified ?? (merged.emailVerified as boolean | undefined) ?? false;

  // Cached on the user document — a DNS lookup per fix request is wasteful, and
  // a domain lapsing mid-month is rare enough to catch on the next signup.
  //
  // A NEGATIVE verdict is re-checked after RECHECK_UNDELIVERABLE_AFTER_MS. A
  // "true" caches forever because a domain that resolves today is not going to
  // start being a mistake; a "false" is a permanent lockout on the strength of
  // one DNS answer, with no way for the user to get out of it and no way for
  // us to notice a domain that has since come back. One account sat behind this
  // gate on 26 August, clicked through to the billing portal, rage-clicked, and
  // was still refused.
  const email = (merged.email as string | null) ?? null;
  let emailDeliverable = merged.emailDeliverable as boolean | undefined;
  const checkedAt = (merged.emailCheckedAt as number | undefined) ?? 0;
  const staleNegative =
    emailDeliverable === false &&
    Date.now() - checkedAt > RECHECK_UNDELIVERABLE_AFTER_MS;
  if (email && (emailDeliverable === undefined || staleNegative)) {
    emailDeliverable = await isDeliverableDomain(email);
    await ref.set({ emailDeliverable, emailCheckedAt: Date.now() }, { merge: true });
  }

  // An account that has actually paid is never gated on deliverability. The
  // gate exists to stop unlimited free accounts on unreachable domains draining
  // the prepaid pool; it has no business standing between a paying customer and
  // what they bought. Note this keys on a paid plan or purchased credits, NOT on
  // the presence of a Stripe customer record — a customer record is created the
  // moment anyone clicks Upgrade, long before any money moves.
  const hasPaid =
    ((merged.plan as Plan) ?? "free") !== "free" ||
    ((merged.creditsBalance as number) ?? 0) > 0;
  if (hasPaid) emailDeliverable = true;

  const storedResetAt = (merged.monthResetAt as number) ?? monthStart;
  const monthRolledOver = storedResetAt < monthStart;
  const creditsUsedThisMonth = monthRolledOver
    ? 0
    : ((merged.creditsUsedThisMonth as number) ?? 0);
  const creditsBalance = (merged.creditsBalance as number) ?? 0;

  const usable = emailVerified && emailDeliverable !== false;
  const monthlyGrant = usable
    ? PLAN_LIMITS[plan].creditsPerMonth
    : UNVERIFIED_MONTHLY_CREDITS;

  return {
    plan,
    emailVerified,
    emailDeliverable: emailDeliverable !== false,
    monthlyGrant,
    creditsUsedThisMonth,
    creditsBalance,
    monthResetAt: monthRolledOver ? monthStart : storedResetAt,
    monthlyLeft: Math.max(0, monthlyGrant - creditsUsedThisMonth),
    ceilingLeft: Math.max(0, MONTHLY_SPEND_CEILING[plan] - creditsUsedThisMonth),
  };
}
