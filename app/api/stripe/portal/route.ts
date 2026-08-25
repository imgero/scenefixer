import { NextRequest, NextResponse } from "next/server";
import { stripe } from "@/lib/stripe";
import { adminAuth, adminDb } from "@/lib/firebase-admin";
import { captureServer } from "@/lib/posthog-server";

/**
 * Self-serve billing management — the missing cancellation path.
 *
 * A customer subscribed on 23 August, spent 31 hours hunting for a way out
 * (six Support clicks in four seconds, then /legal/terms and /legal/refunds),
 * and had to be cancelled from the Stripe dashboard by hand because the app
 * offered no route. /legal/refunds meanwhile tells customers they "can cancel
 * your subscription at any time from your account", which was not true.
 *
 * Under Swiss/EU distance-selling rules a subscription must be as easy to exit
 * as it was to enter, so this is a compliance requirement, not a nicety.
 * Stripe's hosted Billing Portal handles cancellation, payment method updates
 * and invoice history.
 */
export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  }

  let uid: string;
  try {
    uid = (await adminAuth.verifyIdToken(authHeader.slice(7))).uid;
  } catch {
    return NextResponse.json({ error: "Invalid token" }, { status: 401 });
  }

  const appUrl =
    req.headers.get("origin") || process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

  try {
    const snap = await adminDb.collection("users").doc(uid).get();
    const customerId = snap.data()?.stripeCustomerId as string | undefined;

    if (!customerId) {
      // Never had a Stripe customer, so there is nothing to manage. Say so
      // plainly rather than sending them to a portal that would 500.
      return NextResponse.json(
        { error: "No billing account found. You are on the free plan.", code: "no_billing_account" },
        { status: 404 }
      );
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${appUrl}/pricing`,
    });

    await captureServer({
      distinctId: uid,
      event: "billing_portal_opened",
      properties: { stripe_customer_id: customerId },
    });

    return NextResponse.json({ url: session.url });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`POST /api/stripe/portal error:`, err);
    await captureServer({
      distinctId: uid,
      event: "billing_portal_failed",
      properties: { error_message: msg },
    });
    // The most common cause is no Billing Portal configuration existing on the
    // Stripe account yet; surface it rather than a bare 500.
    return NextResponse.json(
      { error: "Could not open billing management. Please contact help@scenefixer.com.", detail: msg },
      { status: 500 }
    );
  }
}
