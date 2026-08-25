"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/lib/hooks/useAuth";
import { auth } from "@/lib/firebase";
import { getAdditionalUserInfo, GoogleAuthProvider, signInWithPopup } from "firebase/auth";
import Link from "next/link";
import posthog from "posthog-js";
import { registerLoopsContact } from "@/lib/loops";

const PLANS = [
  {
    id: "free",
    name: "Free",
    monthly: 0,
    annual: 0,
    credits: 30,
    maxVideo: "30 sec",
    quality: "480p",
    watermark: true,
    features: [
      "Unlimited continuity scans",
      // Stated in fixes, not credits. The old copy claimed 5 credits was
      // roughly one fix; 5 credits could not cover a single ~10s shot, and it
      // asked the reader to do arithmetic in an internal unit to find that out.
      "2 free fixes per month, up to 10 seconds each",
      "480p output + watermark",
      "Up to 30-sec uploads",
      "3 scans / day",
      "Refund if a fix doesn't land",
    ],
    cta: "Get started free",
    highlight: false,
  },
  {
    id: "starter",
    name: "Starter",
    monthly: 9,
    annual: 7,
    credits: 20,
    maxVideo: "5 min",
    quality: "720p",
    watermark: false,
    features: [
      "Unlimited continuity scans",
      "20 credits / month (~3 fixes)",
      "720p output, no watermark",
      "Up to 5-min uploads",
      "Refund if a fix doesn't land",
    ],
    cta: "Start Starter",
    highlight: false,
  },
  {
    id: "pro",
    name: "Pro",
    monthly: 19,
    annual: 15,
    credits: 45,
    maxVideo: "15 min",
    quality: "1080p",
    watermark: false,
    features: [
      "Unlimited continuity scans",
      "45 credits / month (~6–8 fixes)",
      "1080p output, no watermark",
      "Up to 15-min uploads",
      "Full shot chunking for long scenes",
      "Refund if a fix doesn't land",
    ],
    cta: "Start Pro",
    highlight: true,
  },
  {
    id: "studio",
    name: "Studio",
    monthly: 49,
    annual: 39,
    credits: 120,
    maxVideo: "60 min",
    quality: "1080p",
    watermark: false,
    features: [
      "Unlimited continuity scans",
      "120 credits / month (~15–20 fixes)",
      "1080p output, no watermark, priority queue",
      "Up to 60-min uploads",
      "Full shot chunking + priority support",
      "Refund if a fix doesn't land",
    ],
    cta: "Start Studio",
    highlight: false,
  },
];

const CREDIT_PACKS = [
  { pack: "10",  price: 10,  credits: 18,  label: "" },
  { pack: "25",  price: 25,  credits: 50,  label: "save ~10%" },
  { pack: "50",  price: 50,  credits: 110, label: "save ~18%" },
  { pack: "100", price: 100, credits: 240, label: "best value" },
];

export default function PricingPage() {
  return (
    <Suspense>
      <PricingContent />
    </Suspense>
  );
}

function PricingContent() {
  const [annual, setAnnual] = useState(false);
  const [loading, setLoading] = useState<string | null>(null);
  const { user } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  const success = searchParams.get("success");
  const cancelled = searchParams.get("cancelled");
  const successCaptured = useRef(false);
  const [portalLoading, setPortalLoading] = useState(false);
  const [portalError, setPortalError] = useState<string | null>(null);

  // Self-serve cancellation. Previously there was no path out of a
  // subscription anywhere in the app; the only customer to subscribe had to be
  // cancelled from the Stripe dashboard by hand.
  const openBillingPortal = async () => {
    if (portalLoading) return;
    setPortalLoading(true);
    setPortalError(null);
    try {
      const token = await auth.currentUser?.getIdToken();
      const res = await fetch("/api/stripe/portal", {
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.url) {
        posthog.capture("billing_portal_clicked");
        window.location.href = data.url;
        return;
      }
      setPortalError(data.error ?? "Could not open billing management.");
    } catch {
      setPortalError("Could not open billing management.");
    } finally {
      setPortalLoading(false);
    }
  };

  useEffect(() => {
    if (success && !successCaptured.current) {
      successCaptured.current = true;
      posthog.capture("checkout_success", {
        type: success === "credits" ? "credits" : "subscription",
      });
    }
  }, [success]);

  const ensureSignedIn = async (): Promise<boolean> => {
    if (user) return true;
    try {
      const provider = new GoogleAuthProvider();
      const result = await signInWithPopup(auth, provider);
      posthog.identify(result.user.uid, { email: result.user.email ?? undefined });
      if (getAdditionalUserInfo(result)?.isNewUser && result.user.email) {
        registerLoopsContact(result.user.email, result.user.uid);
      }
      return true;
    } catch {
      return false;
    }
  };

  const handlePlanClick = async (planId: string) => {
    if (planId === "free") { router.push("/"); return; }
    if (!(await ensureSignedIn())) return;

    setLoading(planId);
    try {
      const token = await auth.currentUser?.getIdToken();
      const res = await fetch("/api/stripe/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ plan: planId, interval: annual ? "annual" : "monthly" }),
      });
      const data = await res.json();
      if (data.url) {
        posthog.capture("plan_selected", { plan: planId, interval: annual ? "annual" : "monthly" });
        window.location.href = data.url;
      }
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(null);
    }
  };

  const handleBuyPack = async (pack: string) => {
    if (!(await ensureSignedIn())) return;
    setLoading(`credits_${pack}`);
    try {
      const token = await auth.currentUser?.getIdToken();
      const res = await fetch("/api/stripe/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ type: "credits", pack }),
      });
      const data = await res.json();
      if (data.url) {
        posthog.capture("credits_checkout_started", { pack });
        window.location.href = data.url;
      }
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(null);
    }
  };

  return (
    <main className="min-h-screen bg-white px-4 py-16">
      <div className="max-w-5xl mx-auto">
        {success === "1" && (
          <div className="mb-8 rounded-xl border border-green-200 bg-green-50 px-5 py-4 text-sm text-green-800 text-center">
            You&apos;re all set! Your plan has been activated.
          </div>
        )}
        {success === "credits" && (
          <div className="mb-8 rounded-xl border border-green-200 bg-green-50 px-5 py-4 text-sm text-green-800 text-center">
            Credits added to your account!
          </div>
        )}
        {cancelled && (
          <div className="mb-8 rounded-xl border border-gray-200 bg-gray-50 px-5 py-4 text-sm text-gray-600 text-center">
            Checkout cancelled — you haven&apos;t been charged.
          </div>
        )}

        <div className="text-center mb-12">
          <h1 className="text-4xl sm:text-5xl font-semibold text-black tracking-tight mb-3">
            Simple, honest pricing
          </h1>
          <p className="text-gray-500 text-lg max-w-lg mx-auto mb-2">
            Scanning your video is always free. You only pay when you actually fix something.
          </p>
          <p className="text-sm text-gray-400">
            <span className="text-black font-semibold">1 credit = 1 second</span> of fixed output · Max 8 fixes per upload · Refund if a fix doesn&apos;t land
          </p>
          <p className="text-sm text-gray-500 mt-1">
            Free accounts need a verified email address before the first fix.
          </p>

          <div className="mt-8 inline-flex items-center gap-3 rounded-full border border-gray-200 bg-gray-50 p-1">
            <button
              onClick={() => setAnnual(false)}
              className={[
                "px-4 py-1.5 rounded-full text-sm font-medium transition-colors",
                !annual ? "bg-white text-black shadow-sm" : "text-gray-500 hover:text-black",
              ].join(" ")}
            >
              Monthly
            </button>
            <button
              onClick={() => setAnnual(true)}
              className={[
                "px-4 py-1.5 rounded-full text-sm font-medium transition-colors flex items-center gap-1.5",
                annual ? "bg-white text-black shadow-sm" : "text-gray-500 hover:text-black",
              ].join(" ")}
            >
              Annual
              <span className="text-[10px] font-semibold bg-black text-white px-1.5 py-0.5 rounded-full">
                Save ~20%
              </span>
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {PLANS.map((plan) => {
            const price = annual ? plan.annual : plan.monthly;
            const isLoading = loading === plan.id;

            return (
              <div
                key={plan.id}
                className={[
                  "rounded-2xl border p-6 flex flex-col",
                  plan.highlight
                    ? "border-black bg-black text-white"
                    : "border-gray-200 bg-white text-black",
                ].join(" ")}
              >
                {plan.highlight && (
                  <div className="text-[10px] uppercase tracking-widest text-gray-400 font-semibold mb-3">
                    Recommended
                  </div>
                )}
                <div className="mb-4">
                  <h2 className="text-lg font-semibold">{plan.name}</h2>
                  <div className="mt-2 flex items-baseline gap-1">
                    <span className="text-3xl font-semibold">
                      {price === 0 ? "Free" : `$${price}`}
                    </span>
                    {price > 0 && (
                      <span className={plan.highlight ? "text-gray-400 text-sm" : "text-gray-500 text-sm"}>
                        /mo{annual ? " billed annually" : ""}
                      </span>
                    )}
                  </div>
                </div>

                <ul className="flex flex-col gap-2 mb-6 flex-1">
                  {plan.features.map((f) => (
                    <li key={f} className="flex items-start gap-2 text-sm">
                      <span className="text-gray-400 mt-0.5">✓</span>
                      <span className={plan.highlight ? "text-gray-200" : "text-gray-700"}>{f}</span>
                    </li>
                  ))}
                </ul>

                <button
                  onClick={() => handlePlanClick(plan.id)}
                  disabled={isLoading}
                  className={[
                    "w-full py-2.5 rounded-xl font-semibold text-sm transition-colors disabled:opacity-50",
                    plan.highlight
                      ? "bg-white text-black hover:bg-gray-100"
                      : "bg-black text-white hover:bg-gray-800",
                  ].join(" ")}
                >
                  {isLoading ? "Redirecting…" : plan.cta}
                </button>
              </div>
            );
          })}
        </div>

        {/* ── Credit packs ── */}
        <div className="mt-12 max-w-md mx-auto rounded-2xl border border-gray-200 bg-gray-50 p-6">
          <div className="mb-5">
            <h3 className="font-semibold text-black text-base mb-1">Buy credits one-time</h3>
            <p className="text-sm text-gray-500">
              No subscription. Stack on top of your plan. Credits never expire.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            {CREDIT_PACKS.map((pack) => (
              <button
                key={pack.pack}
                onClick={() => handleBuyPack(pack.pack)}
                disabled={loading === `credits_${pack.pack}`}
                className="relative rounded-xl border border-gray-200 bg-white px-4 py-3 text-left hover:border-black transition-colors disabled:opacity-50"
              >
                {pack.label && (
                  <span className="absolute -top-2 right-3 text-[10px] font-semibold bg-black text-white px-1.5 py-0.5 rounded-full">
                    {pack.label}
                  </span>
                )}
                <div className="text-base font-semibold text-black">${pack.price}</div>
                <div className="text-sm text-gray-500">{pack.credits} credits</div>
                {loading === `credits_${pack.pack}` && (
                  <div className="text-xs text-gray-400 mt-0.5">Redirecting…</div>
                )}
              </button>
            ))}
          </div>

          <p className="text-[11px] text-gray-400 text-center mt-4">
            One-time · never expire · no subscription required
          </p>
        </div>

        <p className="text-center text-[11px] text-gray-400 mt-6 max-w-lg mx-auto">
          Fixes run as a background job — you can close your browser while it processes and check back in My fixed videos.
        </p>

        {user && (
          <div className="mt-8 text-center">
            <button
              onClick={openBillingPortal}
              disabled={portalLoading}
              className="text-sm text-gray-600 underline underline-offset-2 hover:text-black transition-colors disabled:opacity-50"
            >
              {portalLoading ? "Opening…" : "Manage or cancel your subscription"}
            </button>
            {portalError && (
              <p className="mt-2 text-xs text-amber-700">{portalError}</p>
            )}
          </div>
        )}

        <p className="mt-4 text-center text-xs text-gray-400">
          Prices in USD. Cancel anytime from Manage subscription above. Monthly credits reset on the 1st.
        </p>

        <div className="mt-8 text-center space-y-2">
          <p className="text-sm text-gray-500">
            Questions?{" "}
            <a href="mailto:help@scenefixer.com" className="text-black underline underline-offset-2 hover:opacity-70">
              help@scenefixer.com
            </a>
          </p>
          <Link href="/" className="text-sm text-gray-500 hover:text-black transition-colors">
            ← Back to Scene Fixer
          </Link>
        </div>
      </div>
    </main>
  );
}
