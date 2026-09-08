import { NextRequest, NextResponse } from "next/server";
import { stripe, planFromPriceId, isOurPriceId } from "@/lib/stripe";
import { adminDb } from "@/lib/firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import type Stripe from "stripe";
import { captureServer } from "@/lib/posthog-server";
import { notifyOwner } from "@/lib/notify";

export const config = { api: { bodyParser: false } };

/**
 * Find the Firebase uid a checkout session belongs to.
 *
 * `metadata.uid` is what our own checkout route sets, and it is the only link
 * we had. A funded `checkout.session.completed` arrived on 31 August with no
 * metadata and no customer attached — so it was not created by that route, and
 * the entitlement write had nothing to key on. The customer paid and received
 * nothing.
 *
 * A session created anywhere else (Payment Link, hosted pricing table, Stripe
 * dashboard) will never carry our metadata, so resolution falls back through
 * every other identifier the session does carry. Order is most to least
 * trustworthy; each fallback is reported so a rescue is never silent.
 */
async function resolveUid(
  session: Stripe.Checkout.Session
): Promise<{ uid: string | null; via: string }> {
  if (session.metadata?.uid) return { uid: session.metadata.uid, via: "metadata" };
  if (session.client_reference_id) {
    return { uid: session.client_reference_id, via: "client_reference_id" };
  }

  const customerId = typeof session.customer === "string" ? session.customer : null;
  if (customerId) {
    const byCustomer = await adminDb
      .collection("users")
      .where("stripeCustomerId", "==", customerId)
      .limit(1)
      .get();
    if (!byCustomer.empty) return { uid: byCustomer.docs[0].id, via: "stripe_customer_id" };
  }

  const email =
    session.customer_details?.email ?? session.customer_email ?? null;
  if (email) {
    // The stored address is whatever Firebase Auth reported, which is not
    // guaranteed to be normalised the same way Stripe's is. Try both spellings
    // rather than lose a paying customer to a capital letter.
    for (const candidate of new Set([email, email.toLowerCase()])) {
      const byEmail = await adminDb
        .collection("users")
        .where("email", "==", candidate)
        .limit(1)
        .get();
      if (!byEmail.empty) return { uid: byEmail.docs[0].id, via: "customer_email" };
    }
  }

  return { uid: null, via: "unresolved" };
}

/**
 * Is this checkout for something Scene Fixer sells?
 *
 * The Stripe account is shared with other businesses, so this endpoint sees
 * their checkouts as well as ours. Those must be ignored in silence: they are
 * not entitlement failures, and treating them as such buries a real one under
 * false alarms — which is exactly what happened on 31 August.
 *
 * Fails CLOSED for our own sales: if the line items cannot be read we assume
 * the sale is ours and let it flow to the resolution path, so a Stripe API
 * blip can never make a genuine Scene Fixer purchase disappear quietly.
 */
async function isOurCheckout(session: Stripe.Checkout.Session): Promise<boolean> {
  if (session.metadata?.uid || session.metadata?.plan || session.metadata?.type) return true;
  try {
    const items = await stripe.checkout.sessions.listLineItems(session.id, { limit: 10 });
    return items.data.some((i) => isOurPriceId(i.price?.id));
  } catch {
    return true;
  }
}

/**
 * Which plan a session bought, when metadata does not say.
 *
 * Derived from the line item's price id, the same mapping the subscription
 * webhooks already use, so a session created outside our checkout route can
 * still be turned into an entitlement.
 */
async function resolvePlan(session: Stripe.Checkout.Session): Promise<string | null> {
  if (session.metadata?.plan) return session.metadata.plan;
  try {
    const items = await stripe.checkout.sessions.listLineItems(session.id, { limit: 1 });
    const priceId = items.data[0]?.price?.id;
    return priceId ? planFromPriceId(priceId) : null;
  } catch {
    return null;
  }
}

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

    if (!(await isOurCheckout(session))) {
      // Another business on the same Stripe account. Recorded so the traffic is
      // visible, but this is not ours to grant and not a failure of any kind.
      await captureServer({
        distinctId: "stripe_webhook",
        event: "stripe_webhook_ignored",
        properties: { reason: "not_our_product", stripe_event_id: event.id },
      });
      return NextResponse.json({ received: true });
    }

    const { uid, via: uidVia } = await resolveUid(session);

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
    const plan = await resolvePlan(session);
    if (!uid || !plan) {
      // Nothing left to key the entitlement write on. This is a funded
      // checkout that will produce no entitlement, so it pages someone rather
      // than only landing in analytics — the 31 August case was found by the
      // customer complaining, days later.
      const reason = !uid ? "uid_unresolvable" : "plan_unresolvable";
      await captureServer({
        distinctId: uid ?? "stripe_webhook",
        event: "entitlement_write_failed",
        properties: {
          reason,
          uid_resolved_via: uidVia,
          stripe_event_id: event.id,
          stripe_customer_id: (session.customer as string) ?? null,
          customer_email:
            session.customer_details?.email ?? session.customer_email ?? null,
          amount_total: session.amount_total,
        },
      });
      await notifyOwner(
        "[Scene Fixer] PAID CHECKOUT WITH NO ENTITLEMENT",
        `A checkout.session.completed could not be turned into an entitlement.\n\n` +
          `Reason: ${reason}\n` +
          `Stripe event: ${event.id}\n` +
          `Session: ${session.id}\n` +
          `Customer: ${(session.customer as string) ?? "(none)"}\n` +
          `Email: ${session.customer_details?.email ?? session.customer_email ?? "(none)"}\n` +
          `Amount: ${session.amount_total} ${session.currency}\n\n` +
          `The customer has paid and has received nothing. Grant the plan by hand or refund.`
      );
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
        uid_resolved_via: uidVia,
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
