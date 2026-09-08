import { NextRequest, NextResponse } from "next/server";
import { stripe, STRIPE_PRICES, CREDIT_PACKS } from "@/lib/stripe";
import { adminAuth, adminDb } from "@/lib/firebase-admin";

async function getOrCreateCustomer(uid: string, email: string): Promise<string> {
  const userSnap = await adminDb.collection("users").doc(uid).get();
  const existing = userSnap.data()?.stripeCustomerId;
  if (existing) return existing;

  const customer = await stripe.customers.create({ email, metadata: { uid } });
  // Do NOT set plan here — it would overwrite an existing plan if the user
  // never had a stripeCustomerId (e.g. manually provisioned). Plan is only
  // written by the webhook after a payment completes.
  await adminDb.collection("users").doc(uid).set({
    uid, email,
    stripeCustomerId: customer.id,
    creditsUsedThisMonth: 0,
    monthResetAt: new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime(),
    createdAt: Date.now(),
  }, { merge: true });
  return customer.id;
}

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  }

  let uid: string;
  let email: string;
  try {
    const decoded = await adminAuth.verifyIdToken(authHeader.slice(7));
    uid = decoded.uid;
    email = decoded.email ?? "";
  } catch {
    return NextResponse.json({ error: "Invalid token" }, { status: 401 });
  }

  const body = await req.json() as { type?: string; plan?: string; interval?: "monthly" | "annual"; pack?: string };
  const appUrl = req.headers.get("origin") || process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

  // ── One-time credit pack purchase ───────────────────────────────────────
  if (body.type === "credits") {
    const pack = CREDIT_PACKS.find(p => p.pack === body.pack);
    if (!pack) {
      return NextResponse.json({ error: "Invalid credit pack" }, { status: 400 });
    }
    if (!pack.priceId) {
      return NextResponse.json({ error: "Credit pack price not configured" }, { status: 500 });
    }
    const customerId = await getOrCreateCustomer(uid, email);
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: "payment",
      line_items: [{ price: pack.priceId, quantity: 1 }],
      success_url: `${appUrl}/pricing?success=credits&credits=${pack.credits}`,
      cancel_url:  `${appUrl}/pricing?cancelled=1`,
      // Second, independent carrier of the uid. metadata is easy to lose —
      // any session Stripe creates outside this route (a Payment Link, the
      // hosted pricing table, a dashboard-created session) arrives with none —
      // and the webhook then has nothing to key the entitlement write on.
      client_reference_id: uid,
      metadata: { uid, type: "credits", quantity: String(pack.credits) },
    });
    return NextResponse.json({ url: session.url });
  }

  // ── Subscription ────────────────────────────────────────────────────────
  const { plan, interval } = body;
  if (!plan) return NextResponse.json({ error: "plan required" }, { status: 400 });

  const prices = STRIPE_PRICES[plan];
  if (!prices) return NextResponse.json({ error: "Unknown plan" }, { status: 400 });

  const priceId = interval === "annual" ? prices.annual : prices.monthly;
  if (!priceId) return NextResponse.json({ error: "Price not configured" }, { status: 500 });

  const customerId = await getOrCreateCustomer(uid, email);
  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: "subscription",
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${appUrl}/pricing?success=1`,
    cancel_url:  `${appUrl}/pricing?cancelled=1`,
    client_reference_id: uid,
    metadata: { uid, plan },
    subscription_data: { metadata: { uid, plan } },
  });

  return NextResponse.json({ url: session.url });
}
