/**
 * What credits cost. Client-safe: the pricing page, the job page and the
 * checkout route all read these, so the price on a button is the price charged.
 *
 * 1 credit = 1 second of a shot being fixed. Our cost for that second is the
 * Runway output (aleph2, 28 provider credits a second, $0.28 at the API's
 * $0.01 a credit; gemini_omni_flash is 11) plus a cheap verification pass, so
 * about $0.30 at worst. Every price here clears that after Stripe's
 * 2.9% + $0.30.
 *
 * Until 9 Nov the smallest pack was 15 credits for $10. In the week after the
 * cost was put on the Fix button, 8 people scanned, 3 opened pricing, and none
 * bought: one went back to /pricing four times. A fix on a 4-second shot now
 * costs $2.40 on its own instead of a $10 pack.
 */

export type CreditPack = { pack: string; price: number; credits: number; label: string };

// pack ids are the dollar price, and stay the same as before so old links and
// analytics keep meaning the same pack.
export const CREDIT_PACKS: CreditPack[] = [
  { pack: "10",  price: 10,  credits: 20,  label: "" },
  { pack: "25",  price: 25,  credits: 55,  label: "save 10%" },
  { pack: "50",  price: 50,  credits: 115, label: "save 15%" },
  { pack: "100", price: 100, credits: 240, label: "best value" },
];

/** Buying exactly what one fix needs: per credit, with a floor. */
export const EXACT_CENTS_PER_CREDIT = 60;
/** Below this Stripe's $0.30 fixed fee eats the sale. */
export const EXACT_MIN_CENTS = 199;
export const EXACT_MAX_CREDITS = 300;

/**
 * The price of buying exactly `needed` credits.
 *
 * At the floor the buyer gets every credit the floor pays for (3 for $1.99),
 * not just the one they needed.
 */
export function exactCreditPrice(needed: number): { credits: number; cents: number } {
  const want = Math.max(1, Math.ceil(needed));
  const floorCredits = Math.floor(EXACT_MIN_CENTS / EXACT_CENTS_PER_CREDIT);
  const credits = Math.max(want, floorCredits);
  return { credits, cents: Math.max(EXACT_MIN_CENTS, credits * EXACT_CENTS_PER_CREDIT) };
}

export function formatUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** Credits a fix costs: the whole target shot, rounded up, at least one. */
export function shotCredits(startMs: number, endMs: number): number {
  return Math.max(1, Math.ceil((endMs - startMs) / 1000));
}

/**
 * One free fix per account, so people see what a fix looks like before paying.
 *
 * Nobody had ever pressed Fix: 0 of 8 scanners in the week to 9 Nov. Capped at
 * a short shot and delivered at 480p with a watermark, so it costs at most
 * ~170 prepaid Runway credits (about $1.70) and is a preview, not the product.
 */
export const FREE_FIX_MAX_SECONDS = 6;

/** Credits for one scan past the daily free limit. */
export const EXTRA_SCAN_CREDITS = 1;
