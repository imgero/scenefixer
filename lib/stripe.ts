import Stripe from "stripe";
import type { Plan } from "@/lib/types";

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: "2026-04-22.dahlia",
});

// Stripe Price IDs — set these in .env.local after creating products in Stripe dashboard.
// Format: price_xxxxxxxxxxxxxxxxxx
export const STRIPE_PRICES: Record<string, { monthly: string; annual: string }> = {
  starter: {
    monthly: process.env.STRIPE_PRICE_STARTER_MONTHLY ?? "",
    annual:  process.env.STRIPE_PRICE_STARTER_ANNUAL  ?? "",
  },
  pro: {
    monthly: process.env.STRIPE_PRICE_PRO_MONTHLY ?? "",
    annual:  process.env.STRIPE_PRICE_PRO_ANNUAL  ?? "",
  },
  studio: {
    monthly: process.env.STRIPE_PRICE_STUDIO_MONTHLY ?? "",
    annual:  process.env.STRIPE_PRICE_STUDIO_ANNUAL  ?? "",
  },
};

// One-time credit packs: 1 credit = 1 second of Runway output fixed.
// Create each as a one-time Stripe product and paste the price_xxx IDs below.
export const CREDIT_PACKS: { pack: string; credits: number; price: number; label: string; priceId: string }[] = [
  { pack: "10",  credits: 18,  price: 10,  label: "",           priceId: process.env.STRIPE_PRICE_CREDIT_10  ?? "" },
  { pack: "25",  credits: 50,  price: 25,  label: "save ~10%",  priceId: process.env.STRIPE_PRICE_CREDIT_25  ?? "" },
  { pack: "50",  credits: 110, price: 50,  label: "save ~15%",  priceId: process.env.STRIPE_PRICE_CREDIT_50  ?? "" },
  { pack: "100", credits: 240, price: 100, label: "save ~20%",  priceId: process.env.STRIPE_PRICE_CREDIT_100 ?? "" },
];

/**
 * Every price id this product sells, subscriptions and credit packs alike.
 *
 * Scene Fixer shares a Stripe account with other businesses, so the webhook
 * endpoint receives their events too. A $2,000 consulting invoice on
 * 31 August 2026 arrived as a live `checkout.session.completed` with no
 * metadata and no customer, was logged as `entitlement_write_failed`, and was
 * read as a Scene Fixer customer who had paid and got nothing. It was not one.
 * This is how the webhook tells its own sales from everyone else's.
 */
export function isOurPriceId(priceId: string | null | undefined): boolean {
  if (!priceId) return false;
  if (planFromPriceId(priceId)) return true;
  return CREDIT_PACKS.some((p) => p.priceId && p.priceId === priceId);
}

export function planFromPriceId(priceId: string): Plan | null {
  for (const [plan, prices] of Object.entries(STRIPE_PRICES)) {
    if (prices.monthly === priceId || prices.annual === priceId) {
      return plan as Plan;
    }
  }
  return null;
}
