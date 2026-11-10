import { NextRequest, NextResponse } from "next/server";
import { stripe, STRIPE_PRICES } from "@/lib/stripe";
import { CREDIT_PACKS, EXACT_MAX_CREDITS, exactCreditPrice } from "@/lib/pricing";
import { adminAuth, adminDb } from "@/lib/firebase-admin";
import { packCredits, studioPack } from "@/lib/studio/catalog";
import { batchState, canSell } from "@/lib/studio/server";

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

  const body = await req.json() as { type?: string; plan?: string; interval?: "monthly" | "annual"; pack?: string; job?: string; credits?: number; source?: string };
  // The scan the buyer came from, so the success page can send them back to
  // fix it. Only a job-id-shaped value goes into the URL.
  const returnJob = typeof body.job === "string" && /^[a-z0-9]{10,40}$/.test(body.job) ? body.job : null;
  const appUrl = req.headers.get("origin") || process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

  // ── Studio video packs ──────────────────────────────────────────────────
  //
  // Sold out of a fixed pool of prepaid Runway credits, so a pack is only
  // offered while the pool can still honour it (lib/studio/server.ts).
  if (body.type === "studio") {
    const pack = studioPack(body.pack ?? "");
    if (!pack) return NextResponse.json({ error: "Invalid pack" }, { status: 400 });
    // Priced at the moment of checkout, so the launch bonus shown is the one granted.
    const credits = packCredits(pack);
    if (pack.passDays && (await batchState()).passesLeft <= 0) {
      return NextResponse.json({ error: "The Unlimited* passes for this batch are gone. Packs are still available.", code: "sold_out" }, { status: 409 });
    }
    if (!(await canSell(credits.total))) {
      return NextResponse.json({ error: "This batch is sold out. Check back soon.", code: "sold_out" }, { status: 409 });
    }
    const customerId = await getOrCreateCustomer(uid, email);
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: "payment",
      line_items: [{
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: pack.price * 100,
          product_data: {
            name: pack.passDays
              ? `Scene Fixer Studio Unlimited* pass (${pack.passDays} days, ${credits.total} credits)`
              : `${credits.total} Scene Fixer Studio credits${credits.bonus ? ` (incl. ${credits.bonus} launch bonus)` : ""}`,
          },
        },
      }],
      success_url: `${appUrl}/studio?bought=${pack.id}`,
      cancel_url: `${appUrl}/studio?cancelled=1`,
      client_reference_id: uid,
      metadata: {
        uid,
        type: "studio",
        pack: pack.id,
        quantity: String(credits.total),
        pass_days: String(pack.passDays ?? 0),
        ...(typeof body.source === "string" ? { source: body.source.slice(0, 40) } : {}),
      },
    });
    return NextResponse.json({ url: session.url });
  }

  // ── One-time credits: a pack, or exactly what a fix needs ───────────────
  //
  // Priced inline rather than against Stripe Price objects, so the amount and
  // the credit count Stripe shows are the ones in lib/pricing.ts and cannot
  // drift from them. The webhook grants metadata.quantity either way.
  if (body.type === "credits" || body.type === "exact") {
    let credits: number;
    let cents: number;
    if (body.type === "exact") {
      const wanted = Number(body.credits);
      if (!Number.isInteger(wanted) || wanted < 1 || wanted > EXACT_MAX_CREDITS) {
        return NextResponse.json({ error: "Invalid credit amount" }, { status: 400 });
      }
      ({ credits, cents } = exactCreditPrice(wanted));
    } else {
      const pack = CREDIT_PACKS.find(p => p.pack === body.pack);
      if (!pack) {
        return NextResponse.json({ error: "Invalid credit pack" }, { status: 400 });
      }
      credits = pack.credits;
      cents = pack.price * 100;
    }
    // The job page sends people straight to Stripe from a fix; they come back
    // to that job, not to the pricing page.
    // Credits bought at the daily scan limit go back to the upload box.
    const toUpload = !returnJob && body.source === "scan_limit";
    const successUrl = returnJob
      ? `${appUrl}/job/${returnJob}?paid=${credits}`
      : toUpload
        ? `${appUrl}/?credits_added=${credits}`
        : `${appUrl}/pricing?success=credits&credits=${credits}`;
    const cancelUrl = returnJob
      ? `${appUrl}/job/${returnJob}?cancelled=1`
      : toUpload
        ? `${appUrl}/`
        : `${appUrl}/pricing?cancelled=1`;
    const customerId = await getOrCreateCustomer(uid, email);
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: "payment",
      line_items: [{
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: cents,
          product_data: { name: `${credits} Scene Fixer credits` },
        },
      }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      // Second, independent carrier of the uid. metadata is easy to lose —
      // any session Stripe creates outside this route (a Payment Link, the
      // hosted pricing table, a dashboard-created session) arrives with none —
      // and the webhook then has nothing to key the entitlement write on.
      client_reference_id: uid,
      metadata: {
        uid,
        type: "credits",
        quantity: String(credits),
        purchase: body.type === "exact" ? "exact" : `pack_${body.pack}`,
        ...(returnJob ? { job: returnJob } : {}),
        ...(typeof body.source === "string" ? { source: body.source.slice(0, 40) } : {}),
      },
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
