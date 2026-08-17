"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import DropZone, { activateBetaMode } from "@/components/DropZone";
import { useAuth } from "@/lib/hooks/useAuth";
import type { RecentJob } from "@/lib/types";
import {
  Aperture,
  Eye,
  House,
  Package,
  Sparkle,
  TShirt,
  Trophy,
  X,
} from "@phosphor-icons/react";

const DETECTION_CATEGORIES = [
  {
    Icon: TShirt,
    title: "Wardrobe",
    desc: "A jacket that's navy in one shot and burgundy in the next.",
  },
  {
    Icon: Package,
    title: "Props",
    desc: "An object that appears, vanishes, or drifts between cuts.",
  },
  {
    Icon: Aperture,
    title: "Lighting",
    desc: "One shot golden, the next overcast — the cut falls apart.",
  },
  {
    Icon: House,
    title: "Set dressing",
    desc: "Background details that shift when they shouldn't.",
  },
  {
    Icon: Sparkle,
    title: "Hair & makeup",
    desc: "A look that doesn't carry from shot to shot.",
  },
  {
    Icon: Eye,
    title: "Eyeline",
    desc: "A gaze pointing the wrong way across a cut.",
  },
];

const STEPS = [
  { step: "01", title: "Drop your sequence", desc: "MP4 or MOV, up to 200MB. Cut your shots together — or drop a single clip with the thing that's bugging you." },
  { step: "02", title: "We catch what doesn't match", desc: "Our vision AI compares every adjacent shot and flags the continuity breaks — wardrobe, lighting, props, eyeline, and more." },
  { step: "03", title: "You confirm the spot", desc: "Review each break side-by-side, mark the exact region, then choose Remove or describe the change you want." },
  { step: "04", title: "Aleph fixes it to match", desc: "Each flagged shot is corrected to match your reference frame, then stitched back in — everything else stays frame-identical, audio intact." },
];

const DEMOS = [
  {
    src: "/Cup Demo 1.mov",
    tag: "Props",
    title: "A prop that appears and disappears",
    desc: "Scene Fixer detects the missing cup, then adds it back in to match the reference shot.",
  },
  {
    src: "/Astra Demo 1.mov",
    tag: "Atmosphere",
    title: "Two clips, two different skies",
    desc: "One rendered bright noon, one overcast evening. We shift the sky and light so both shots feel like the same scene.",
  },
  {
    src: "/Shirt Demo 1.mov",
    tag: "Wardrobe",
    title: "A jacket that changed color mid-sequence",
    desc: "The jacket drifted between generation runs. Scene Fixer corrects it to the reference color — no rerolling.",
  },
];

export default function HomePage() {
  const { user, loading } = useAuth();
  const [recentJobs, setRecentJobs] = useState<RecentJob[]>([]);
  const [showAnnouncement, setShowAnnouncement] = useState(true);
  const [betaKey, setBetaKey] = useState(0);
  const [betaActive, setBetaActive] = useState(false);

  useEffect(() => {
    try {
      const stored = JSON.parse(localStorage.getItem("scenefixer_recent_jobs") || "[]");
      setRecentJobs(stored);
    } catch { /* ignore */ }
    if (sessionStorage.getItem("sf_announce_hidden")) setShowAnnouncement(false);
    if (localStorage.getItem("sf_beta_mode") === "1") setBetaActive(true);
  }, []);

  const handleBetaActivate = () => {
    activateBetaMode();
    setBetaActive(true);
    setBetaKey((k) => k + 1);
  };

  const hideAnnouncement = () => {
    setShowAnnouncement(false);
    sessionStorage.setItem("sf_announce_hidden", "1");
  };

  return (
    <div className="bg-white">

      {/* ── Hackathon Winner Banner ── */}
      {showAnnouncement && (
        <div className="bg-black text-white text-sm px-4 py-2.5 flex items-center justify-center gap-2.5 relative">
          <Trophy size={14} weight="fill" className="text-yellow-400 shrink-0" />
          <span className="text-center text-xs sm:text-sm">
            Scene Fixer is one of the winners of the{" "}
            <a
              href="https://www.reddit.com/r/runwayml/comments/1tkv84h/were_excited_to_announce_the_winners_of_the/"
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-2 hover:opacity-80"
            >
              Runway API Hackathon
            </a>
          </span>
          <button
            onClick={hideAnnouncement}
            className="absolute right-4 top-1/2 -translate-y-1/2 text-white/50 hover:text-white transition-colors"
            aria-label="Dismiss"
          >
            <X size={13} weight="bold" />
          </button>
        </div>
      )}

      {/* ── Hero ── */}
      <section id="hero" className="max-w-6xl mx-auto px-4 pt-16 pb-20 flex flex-col lg:flex-row items-start gap-12 lg:gap-20">
        {/* Left: headline */}
        <div className="flex-1 min-w-0 lg:pt-6">
          <div className="flex items-center gap-2 flex-wrap mb-6">
            <a
              href="https://runwayml.com"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 text-gray-400 text-[11px] uppercase tracking-widest border border-gray-200 rounded-full px-3 py-1 bg-white no-underline hover:border-gray-300 transition-colors"
            >
              <span className="w-1.5 h-1.5 rounded-full bg-black" />
              Powered by Runway Aleph
            </a>
            <span className="inline-flex items-center gap-2 text-gray-400 text-[11px] uppercase tracking-widest border border-gray-200 rounded-full px-3 py-1 bg-white">
              <span className="w-1.5 h-1.5 rounded-full bg-orange-400" />
              Claude Opus 4.8
            </span>
          </div>
          <h1 className="text-5xl sm:text-6xl font-semibold text-black tracking-tight leading-[1.05] mb-5">
            Your AI clips<br />don&apos;t match.<br />Scene Fixer<br />makes them one.
          </h1>
          <p className="text-gray-500 text-lg leading-snug max-w-sm mb-8">
            Drop a sequence from Runway, Veo, or Kling. Scene Fixer finds the continuity breaks between your shots — wardrobe, lighting, props — and fixes them to match. No regenerating. No rerolling.
          </p>
          <div className="flex items-center gap-4 text-sm text-gray-400">
            <span>✓ Free to start</span>
            <span>✓ Any AI model</span>
            <span>✓ No credit card required</span>
          </div>
          <p className="mt-3 text-xs text-gray-400">
            This is a beta — detection and fixes may not always be perfect.{" "}
            <a href="mailto:help@scenefixer.com" className="underline underline-offset-2 hover:text-black transition-colors">
              Email us
            </a>{" "}
            if something looks off.
          </p>
        </div>

        {/* Right: drop zone */}
        <div className="w-full lg:w-[480px] shrink-0">
          <DropZone key={betaKey} />

          {!loading && !user && !betaActive && (
            <div className="mt-3 text-center">
              <button
                onClick={handleBetaActivate}
                className="text-xs text-gray-400 hover:text-black underline underline-offset-2 transition-colors"
              >
                Beta tester? Try without signing in →
              </button>
            </div>
          )}

          {recentJobs.length > 0 && (
            <div className="mt-5">
              <p className="text-gray-400 text-xs uppercase tracking-widest mb-2">Recent jobs</p>
              <div className="flex flex-col gap-1.5">
                {recentJobs.map((job) => (
                  <Link
                    key={job.id}
                    href={`/job/${job.id}`}
                    className="flex items-center justify-between rounded-xl border border-gray-100 bg-white px-3 py-2.5 hover:border-gray-300 transition-colors"
                  >
                    <span className="text-gray-700 text-sm truncate">{job.filename}</span>
                    <span className="text-gray-400 text-xs shrink-0 ml-4">
                      {new Date(job.createdAt).toLocaleDateString()}
                    </span>
                  </Link>
                ))}
              </div>
            </div>
          )}
        </div>
      </section>

      {/* ── Demo videos ── */}
      <section className="border-t border-gray-100 py-20">
        <div className="max-w-6xl mx-auto px-4">
          <h2 className="text-3xl sm:text-4xl font-semibold text-black text-center mb-3">
            Watch the fix.
          </h2>
          <p className="text-gray-500 text-center mb-12 max-w-xl mx-auto">
            Real outputs from Scene Fixer — props, atmosphere, wardrobe. Each clip shows the problem and the correction.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-6 max-w-4xl mx-auto">
            {DEMOS.map((demo) => (
              <div key={demo.tag} className="flex flex-col gap-4">
                <div className="rounded-2xl overflow-hidden bg-gray-100 w-full aspect-[9/16]">
                  <video
                    src={demo.src}
                    autoPlay
                    muted
                    loop
                    playsInline
                    className="w-full h-full object-cover"
                  />
                </div>
                <div>
                  <span className="inline-block text-[10px] font-semibold uppercase tracking-widest text-gray-500 bg-gray-100 rounded-full px-2.5 py-0.5 mb-2">
                    {demo.tag}
                  </span>
                  <h3 className="font-semibold text-black text-sm mb-1 leading-snug">{demo.title}</h3>
                  <p className="text-xs text-gray-500 leading-relaxed">{demo.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── The reroll story ── */}
      <section className="border-t border-gray-100 py-20">
        <div className="max-w-2xl mx-auto px-4">
          <h2 className="text-3xl sm:text-4xl font-semibold text-black mb-7 leading-tight">
            Stop rerolling the whole clip<br className="hidden sm:block" /> to fix one thing.
          </h2>
          <div className="space-y-5 text-gray-500 text-lg leading-relaxed">
            <p>
              AI video almost never comes out consistent. A jacket goes navy, then burgundy. The light jumps between shots. A prop appears out of nowhere. Normally, fixing any of that means regenerating the entire clip — full price — and the reroll usually breaks something that was already working.
            </p>
            <p>
              Scene Fixer compares your shots, catches what doesn&apos;t match, and fixes only that — on the footage you already have. Our vision AI flags the break and shows you exactly what&apos;s off. You confirm the spot. Aleph corrects it to match your reference shot and leaves the rest frame-identical.
            </p>
          </div>
        </div>
      </section>

      {/* ── How it works ── */}
      <section id="how-it-works" className="bg-gray-50 py-20">
        <div className="max-w-6xl mx-auto px-4">
          <h2 className="text-3xl sm:text-4xl font-semibold text-black text-center mb-3">
            From broken to finished in minutes
          </h2>
          <p className="text-gray-500 text-center mb-12 max-w-xl mx-auto">
            The whole pipeline runs in the cloud — no software to install, no GPU required.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
            {STEPS.map((s) => (
              <div key={s.step} className="bg-white rounded-2xl border border-gray-100 p-6">
                <div className="text-[11px] font-semibold text-gray-400 uppercase tracking-widest mb-3">{s.step}</div>
                <h3 className="font-semibold text-black mb-2">{s.title}</h3>
                <p className="text-sm text-gray-500 leading-relaxed">{s.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Detection categories ── */}
      <section className="bg-gray-50 py-20">
        <div className="max-w-6xl mx-auto px-4">
          <h2 className="text-3xl sm:text-4xl font-semibold text-black text-center mb-3">
            Six ways your shots break.<br className="hidden sm:block" /> We catch all of them.
          </h2>
          <p className="text-gray-500 text-center mb-12 max-w-xl mx-auto">
            Our vision AI flags each type across every shot pair — you confirm the region, Aleph fixes it.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {DETECTION_CATEGORIES.map(({ Icon, title, desc }) => (
              <div key={title} className="bg-white rounded-2xl border border-gray-100 p-6 hover:border-gray-300 transition-colors">
                <Icon size={24} weight="thin" className="mb-3 text-gray-600" />
                <h3 className="font-semibold text-black mb-1 text-sm">{title}</h3>
                <p className="text-sm text-gray-500 leading-relaxed">{desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Credibility ── */}
      <section className="py-20">
        <div className="max-w-6xl mx-auto px-4 text-center">
          <div className="inline-flex items-center gap-2.5 mb-5">
            <Trophy size={18} weight="fill" className="text-yellow-400" />
            <a
              href="https://www.reddit.com/r/runwayml/comments/1tkv84h/were_excited_to_announce_the_winners_of_the/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm font-semibold text-black underline underline-offset-2 hover:opacity-70 transition-opacity"
            >
              One of the winners of the Runway API Hackathon
            </a>
          </div>
          <p className="text-gray-600 text-base mb-3 max-w-md mx-auto">
            Now in open beta — built on Runway Aleph and Claude Opus 4.8.
          </p>
          <p className="text-gray-400 text-sm max-w-xl mx-auto mb-10 leading-relaxed">
            It&apos;s early, and detection won&apos;t always be perfect. But every fix runs on the footage you already have — so there&apos;s nothing to reroll, and nothing to lose by trying it on your worst clip.
          </p>
          <Link
            href="/pricing"
            className="inline-block bg-black text-white font-semibold px-8 py-3.5 rounded-full hover:bg-gray-800 transition-colors text-sm"
          >
            Start fixing for free →
          </Link>
        </div>
      </section>

      {/* ── Footer ── */}
      <footer className="border-t border-gray-100 py-10">
        <div className="max-w-6xl mx-auto px-4 flex flex-col sm:flex-row items-center justify-between gap-4">
          <div>
            <div className="font-semibold text-black text-sm mb-1">Scene Fixer</div>
            <div className="text-gray-400 text-xs">
              A product by FredWorth GmbH &amp; Albusi GmbH · Zurich, Switzerland
            </div>
          </div>
          <div className="flex items-center gap-6 text-xs text-gray-400">
            <Link href="/pricing" className="hover:text-black transition-colors">Pricing</Link>
            <a href="mailto:help@scenefixer.com" className="hover:text-black transition-colors">Support</a>
            <Link href="/legal/terms" className="hover:text-black transition-colors">Terms</Link>
            <Link href="/legal/privacy" className="hover:text-black transition-colors">Privacy</Link>
            <Link href="/legal/refunds" className="hover:text-black transition-colors">Refunds</Link>
            <span>© {new Date().getFullYear()} Scene Fixer</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
