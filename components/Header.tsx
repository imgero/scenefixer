"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { signOut } from "firebase/auth";
import { doc, setDoc, onSnapshot } from "firebase/firestore";
import { auth, db } from "@/lib/firebase";
import { useAuth } from "@/lib/hooks/useAuth";
import { PLAN_LIMITS, type Plan } from "@/lib/types";
import posthog from "posthog-js";
import { signInWithGoogle } from "@/lib/signIn";
import { HelpLink } from "@/components/HelpDialog";

/**
 * Record the signed-in identity on the user document.
 *
 * Deliberately writes nothing but identity. This used to also write `plan`,
 * `creditsUsedThisMonth` and `monthResetAt` from the browser — all three are
 * entitlement fields the security rules forbid the client to touch, so the
 * write was rejected on every sign-in where any of them differed from what the
 * server had (and on every first sign-in, where the document does not exist
 * yet and the update rule has no `resource` to diff against). The rejection
 * surfaced as an unhandled `FirebaseError: Missing or insufficient
 * permissions`.
 *
 * The full entitlement shape is the server's job: `ensureEntitlement` creates
 * and backfills it on the first scan or fix. The client must not guess at it.
 */
async function ensureUserIdentity(uid: string, email: string) {
  await setDoc(doc(db, "users", uid), { uid, email }, { merge: true });
}

const PLAN_BADGE: Record<Plan, { label: string; className: string }> = {
  free:    { label: "Free",    className: "bg-gray-100 text-gray-600" },
  starter: { label: "Starter", className: "bg-blue-50 text-blue-600" },
  pro:     { label: "Pro",     className: "bg-black text-white" },
  studio:  { label: "Studio",  className: "bg-purple-50 text-purple-700" },
};

/** What Scene Fixer makes. The header's Products menu and the mobile account menu list these. */
const PRODUCTS = [
  { name: "Continuity check", href: "/", blurb: "Find and fix continuity errors in AI videos.", isNew: false },
  { name: "Studio", href: "/studio", blurb: "Make Seedance 2.5 videos with sound.", isNew: true },
];

function NewBadge() {
  return (
    <span className="text-[9px] font-semibold uppercase tracking-widest bg-emerald-100 text-emerald-700 rounded-full px-1.5 py-0.5">
      New
    </span>
  );
}

function getInitials(email: string): string {
  if (!email) return "?";
  const local = email.split("@")[0];
  const parts = local.split(/[._-]/);
  if (parts.length >= 2 && parts[0] && parts[1])
    return (parts[0][0] + parts[1][0]).toUpperCase();
  return local.slice(0, 2).toUpperCase();
}

export default function Header() {
  const { user, loading } = useAuth();
  const [signingIn, setSigningIn] = useState(false);
  const [signInError, setSignInError] = useState<string | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [fixesUsed, setFixesUsed] = useState(0);
  const [creditsBalance, setCreditsBalance] = useState(0);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [productsOpen, setProductsOpen] = useState(false);
  const productsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!user) { setPlan(null); setFixesUsed(0); setCreditsBalance(0); return; }
    const ref = doc(db, "users", user.uid);
    const unsub = onSnapshot(ref, (snap) => {
      const d = snap.exists() ? snap.data() : {};
      setPlan((d.plan as Plan) ?? "free");
      setFixesUsed(d.creditsUsedThisMonth ?? 0);
      setCreditsBalance(d.creditsBalance ?? 0);
    });
    return unsub;
  }, [user]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node))
        setDropdownOpen(false);
      if (productsRef.current && !productsRef.current.contains(e.target as Node))
        setProductsOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const handleSignIn = async () => {
    setSigningIn(true);
    setSignInError(null);
    try {
      const result = await signInWithGoogle("header");
      if (result.ok) {
        await ensureUserIdentity(result.user.uid, result.user.email ?? "");
      } else {
        setSignInError(result.message);
      }
    } finally {
      setSigningIn(false);
    }
  };

  const handleSignOut = () => {
    setPlan(null);
    setDropdownOpen(false);
    signOut(auth);
  };

  return (
    <header className="w-full border-b border-gray-100 bg-white sticky top-0 z-40">
      <div className="max-w-6xl mx-auto px-5 h-15 flex items-center justify-between gap-6" style={{ height: 56 }}>

        {/* Logo — matches brand: /scenefixer where / and fixer are bold */}
        <Link href="/" className="flex items-center gap-2 shrink-0 select-none">
          <span className="flex items-center">
            <span className="text-lg font-bold text-black leading-none tracking-tight">/</span>
            <span className="text-lg font-normal text-black leading-none tracking-tight">scene</span>
            <span className="text-lg font-bold text-black leading-none tracking-tight">fixer</span>
          </span>
          <span className="hidden sm:inline text-[9px] font-semibold uppercase tracking-widest bg-amber-100 text-amber-700 rounded-full px-2 py-0.5">Beta</span>
        </Link>

        {/* Center nav */}
        <nav className="hidden md:flex items-center gap-7 flex-1 justify-center">
          <div className="relative" ref={productsRef}>
            <button
              onClick={() => setProductsOpen((o) => !o)}
              aria-expanded={productsOpen}
              className="flex items-center gap-1 text-sm text-gray-500 hover:text-black transition-colors"
            >
              Products
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden className={`transition-transform ${productsOpen ? "rotate-180" : ""}`}>
                <path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            {productsOpen && (
              <div className="absolute left-1/2 -translate-x-1/2 top-8 w-72 bg-white border border-gray-200 rounded-2xl shadow-lg p-1.5 z-50">
                {PRODUCTS.map((p) => (
                  <Link
                    key={p.href}
                    href={p.href}
                    onClick={() => setProductsOpen(false)}
                    className="block rounded-xl px-3 py-2.5 hover:bg-gray-50 transition-colors"
                  >
                    <span className="flex items-center gap-2 text-sm font-medium text-black">
                      {p.name}
                      {p.isNew && <NewBadge />}
                    </span>
                    <span className="block text-xs text-gray-500 mt-0.5">{p.blurb}</span>
                  </Link>
                ))}
              </div>
            )}
          </div>
          <Link href="/how-it-works" className="text-sm text-gray-500 hover:text-black transition-colors">
            How it works
          </Link>
          <Link href="/pricing" className="text-sm text-gray-500 hover:text-black transition-colors">
            Pricing
          </Link>
        </nav>

        {/* Right: user section */}
        <div className="flex items-center gap-2 sm:gap-3 shrink-0">
          {/* Phones have no center nav; most visitors are on one. */}
          <Link href="/studio" className="md:hidden flex items-center gap-1.5 text-sm text-gray-600 hover:text-black transition-colors">
            Studio
            <NewBadge />
          </Link>
          {!loading && (
            user ? (
              <>
                {/* Plan / fixes badge */}
                {plan && (() => {
                  const badge = PLAN_BADGE[plan];
                  const limit = PLAN_LIMITS[plan].creditsPerMonth;
                  const monthlyLeft = Math.max(0, limit - fixesUsed);
                  const totalCredits = monthlyLeft + creditsBalance;
                  const empty = totalCredits <= 0;
                  return (
                    <Link
                      href="/pricing"
                      className={`hidden sm:flex items-center gap-1.5 text-[11px] font-semibold px-2.5 py-1 rounded-full transition-opacity hover:opacity-80 ${
                        empty ? "bg-amber-50 text-amber-700" : badge.className
                      }`}
                    >
                      {badge.label}
                      <span className="opacity-60 font-normal">
                        {empty ? "0 credits" : `${totalCredits}s`}
                      </span>
                    </Link>
                  );
                })()}

                {/* Initials avatar + dropdown */}
                <div className="relative" ref={dropdownRef}>
                  <button
                    onClick={() => setDropdownOpen((o) => !o)}
                    className="w-8 h-8 rounded-full bg-gray-100 hover:bg-gray-200 flex items-center justify-center text-[11px] font-semibold text-gray-700 transition-colors"
                  >
                    {getInitials(user.email ?? "")}
                  </button>

                  {dropdownOpen && (
                    <div className="absolute right-0 top-10 w-48 bg-white border border-gray-200 rounded-2xl shadow-lg py-1.5 z-50">
                      <div className="px-3.5 py-2 border-b border-gray-100">
                        <p className="text-[11px] text-gray-400 truncate">{user.email}</p>
                      </div>
                      <Link
                        href="/jobs"
                        onClick={() => setDropdownOpen(false)}
                        className="flex items-center px-3.5 py-2 text-sm text-gray-600 hover:bg-gray-50 transition-colors"
                      >
                        My fixed videos
                      </Link>
                      <HelpLink
                        source="header_menu"
                        className="w-full flex items-center px-3.5 py-2 text-sm text-gray-600 hover:bg-gray-50 transition-colors"
                        onClick={() => setDropdownOpen(false)}
                      >
                        Help
                      </HelpLink>
                      <button
                        onClick={handleSignOut}
                        className="w-full flex items-center px-3.5 py-2 text-sm text-gray-600 hover:bg-gray-50 transition-colors"
                      >
                        Sign out
                      </button>
                    </div>
                  )}
                </div>
              </>
            ) : (
              <div className="flex items-center gap-2">
                <button
                  onClick={handleSignIn}
                  disabled={signingIn}
                  className="hidden sm:inline text-sm text-gray-600 hover:text-black transition-colors disabled:opacity-50 px-1"
                >
                  Log in
                </button>
                <button
                  onClick={handleSignIn}
                  disabled={signingIn}
                  className="text-sm bg-black text-white px-4 py-1.5 rounded-full hover:bg-gray-800 transition-colors disabled:opacity-50"
                >
                  {signingIn ? "…" : "Sign up"}
                </button>
                {signInError && (
                  <p className="absolute right-4 top-full mt-1 max-w-xs rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 shadow">
                    {signInError}
                  </p>
                )}
              </div>
            )
          )}
        </div>
      </div>
    </header>
  );
}
