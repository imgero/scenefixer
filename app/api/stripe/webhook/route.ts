import { NextRequest, NextResponse } from "next/server";
import { stripe, planFromPriceId } from "@/lib/stripe";
import { adminDb } from "@/lib/firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import type Stripe from "stripe";
import { captureServer } from "@/lib/posthog-server";

export const config = { api: { bodyParser: false } };

export async function POST(req: NextRequest) {
  const sig = req.headers.get("stripe-signature");
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!sig || !secret) {
    await captureServer({
      distinctId: "stripe_webhook",
      event: "stripe_webhook_rejected",
      properties: { reason: !sig ? "missing_signature_header" : "missing_webhook_secret" },
    });
    return NextResponse.json({ error: "Missing signature" }, { status: 400 });
  }

  let event: Stripe.Event;
  try {
    const body = await req.text();
    event = stripe.webhooks.constructEvent(body, sig, secret);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Invalid signature";
    // A signature mismatch means the endpoint's signing secret does not match
    // the one Stripe signed with — the whole handler is skipped and no
    // entitlement is ever written. Without this event that is invisible.
    await captureServer({
      distinctId: "stripe_webhook",
      event: "stripe_webhook_rejected",
      properties: { reason: "signature_verification_failed", error_message: msg },
    });
    return NextResponse.json({ error: msg }, { status: 400 });
  }

  // Proof the endpoint was reached at all, for every event type Stripe sends.
  // `checkout_success` is a client-side event fired off the Stripe redirect, so
  // until now a payment left no server-side record whatsoever.
  await captureServer({
    distinctId: "stripe_webhook",
    event: "stripe_webhook_received",
    properties: { stripe_event_id: event.id, stripe_event_type: event.type, livemode: event.livemode },
  });

  if (event.type === "checkout.session.completed") {
    const session = event.data.object as Stripe.Checkout.Session;
    const uid = session.metadata?.uid;

    // One-time credit purchase
    if (session.metadata?.type === "credits" && uid) {
      const qty = parseInt(session.metadata.quantity ?? "0", 10);
      if (qty > 0) {
        const { FieldValue } = await import("firebase-admin/firestore");
        await adminDb.collection("users").doc(uid).set(
          { creditsBalance: FieldValue.increment(qty) },
          { merge: true }
        );
        await captureServer({
          distinctId: uid,
          event: "credits_purchased",
          properties: { quantity: qty, amount_total: session.amount_total, stripe_event_id: event.id },
        });
      }
      return NextResponse.json({ received: true });
    }

    // Subscription activation
    const plan = session.metadata?.plan;
    if (!uid || !plan) {
      // Metadata is the only link from a payment back to an account. If either
      // half is missing the entitlement can never be written for anyone.
      await captureServer({
        distinctId: uid ?? "stripe_webhook",
        event: "entitlement_write_failed",
        properties: {
          reason: !uid ? "missing_uid_metadata" : "missing_plan_metadata",
          stripe_event_id: event.id,
          stripe_customer_id: (session.customer as string) ?? null,
        },
      });
      return NextResponse.json({ received: true });
    }

    await adminDb.collection("users").doc(uid).set(
      { plan, stripeCustomerId: session.customer as string },
      { merge: true }
    );

    // Read back rather than assume. This is the exact field the fix route's
    // quota check reads; a payment that does not end with it set is a customer
    // who paid and got nothing.
    const verify = await adminDb.collection("users").doc(uid).get();
    const persistedPlan = verify.data()?.plan ?? null;

    await captureServer({
      distinctId: uid,
      event: persistedPlan === plan ? "subscription_activated" : "entitlement_write_failed",
      properties: {
        plan,
        persisted_plan: persistedPlan,
        stripe_event_id: event.id,
        stripe_customer_id: session.customer as string,
        amount_total: session.amount_total,
        currency: session.currency,
        ...(persistedPlan === plan ? {} : { reason: "plan_not_persisted" }),
      },
    });
  }

  if (event.type === "customer.subscription.updated") {
    const sub = event.data.object as Stripe.Subscription;
    const uid = sub.metadata?.uid;
    const priceId = sub.items.data[0]?.price.id;
    const plan = priceId ? planFromPriceId(priceId) : null;
    if (uid && plan) {
      const status = sub.status === "active" ? plan : "free";
      await adminDb.collection("users").doc(uid).set({ plan: status }, { merge: true });
    }
  }

  if (event.type === "customer.subscription.deleted") {
    const sub = event.data.object as Stripe.Subscription;
    const uid = sub.metadata?.uid;
    if (uid) {
      await adminDb.collection("users").doc(uid).set({ plan: "free" }, { merge: true });
      await captureServer({
        distinctId: uid,
        event: "subscription_cancelled",
        properties: { cancel_at_period_end: sub.cancel_at_period_end, stripe_event_id: event.id },
      });
    }
  }

  return NextResponse.json({ received: true });
}
