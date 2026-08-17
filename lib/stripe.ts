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

export function planFromPriceId(priceId: string): Plan | null {
  for (const [plan, prices] of Object.entries(STRIPE_PRICES)) {
    if (prices.monthly === priceId || prices.annual === priceId) {
      return plan as Plan;
    }
  }
  return null;
}
