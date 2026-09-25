"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useAuth } from "@/lib/hooks/useAuth";
import { auth } from "@/lib/firebase";
import { getAdditionalUserInfo, GoogleAuthProvider, signInWithPopup } from "firebase/auth";
import Link from "next/link";
import posthog from "posthog-js";
import { registerLoopsContact } from "@/lib/loops";
import { PLAN_LIMITS, FREE_SCANS_PER_DAY } from "@/lib/types";
import { HelpLink } from "@/components/HelpDialog";

/**
 * Credit packs are the only thing sold.
 *
 * The starter/pro/studio subscriptions are gone from this page. They were
 * never the thing people wanted: /pricing drew 2 pageviews in the six days to
 * 13 September, nobody subscribed, and the single purchase intent in the whole
 * dataset was a credit pack clicked eleven minutes after a user was blocked on
 * a video that was too long. The tiers also carried a contradiction the code
 * itself flagged — the free grant exceeded Starter's — because their real
 * purpose was fencing limits, not selling capacity.
 *
 * Existing subscribers keep their plan and their grant until they cancel; the
 * billing portal link at the bottom of this page is how they do that.
 */
const FREE_TIER = {
  scanMinutes: 5,
  scansPerDay: FREE_SCANS_PER_DAY,
  credits: PLAN_LIMITS.free.creditsPerMonth,
};

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
  const [loading, setLoading] = useState<string | null>(null);
  const { user } = useAuth();
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

        </div>

        {/* What you get without paying anything.
            Stated as a panel rather than a "Free plan" card in a tier grid:
            there are no tiers to compare it against any more, and the point of
            this block is to make clear that the expensive, useful half —
            finding the errors — costs nothing. */}
        <div className="max-w-md mx-auto rounded-2xl border border-gray-200 bg-white p-6 mb-6">
          <h2 className="font-semibold text-black text-base mb-1">Free, no card</h2>
          <p className="text-sm text-gray-500 mb-4">
            Every account starts here.
          </p>
          <ul className="flex flex-col gap-2 text-sm">
            <li className="flex items-start gap-2">
              <span className="text-gray-400 mt-0.5">✓</span>
              <span className="text-gray-700">
                Scan up to{" "}
                <span className="text-black font-semibold">
                  {FREE_TIER.scanMinutes} minutes
                </span>{" "}
                of video per upload
              </span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-gray-400 mt-0.5">✓</span>
              <span className="text-gray-700">
                {FREE_TIER.scansPerDay} scans a day, every day
              </span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-gray-400 mt-0.5">✓</span>
              <span className="text-gray-700">
                <span className="text-black font-semibold">
                  {FREE_TIER.credits} free credits
                </span>{" "}
                a month — {FREE_TIER.credits} seconds of fixed output
              </span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-gray-400 mt-0.5">✓</span>
              <span className="text-gray-700">480p output with a watermark</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-gray-400 mt-0.5">✓</span>
              <span className="text-gray-700">
                Refunded automatically if a fix doesn&apos;t land
              </span>
            </li>
          </ul>
        </div>

        {/* ── Credit packs ── */}
        <div className="mt-12 max-w-md mx-auto rounded-2xl border border-gray-200 bg-gray-50 p-6">
          <div className="mb-5">
            <h3 className="font-semibold text-black text-base mb-1">Buy credits one-time</h3>
            <p className="text-sm text-gray-500">
              Top up when you need to. Credits never expire and there is nothing
              to cancel.
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
              {portalLoading ? "Opening…" : "On an old subscription? Manage or cancel it"}
            </button>
            {portalError && (
              <p className="mt-2 text-xs text-amber-700">{portalError}</p>
            )}
          </div>
        )}

        <p className="mt-4 text-center text-xs text-gray-400">
          Prices in USD. Credits you buy never expire; the free monthly credits reset on the 1st.
        </p>

        <div className="mt-8 text-center space-y-2">
          <p className="text-sm text-gray-500">
            Questions?{" "}
            <HelpLink source="pricing" className="text-black underline underline-offset-2 hover:opacity-70">
              Ask us
            </HelpLink>
          </p>
          <Link href="/" className="text-sm text-gray-500 hover:text-black transition-colors">
            ← Back to Scene Fixer
          </Link>
        </div>
      </div>
    </main>
  );
}
