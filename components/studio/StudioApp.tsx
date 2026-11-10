"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import posthog from "posthog-js";
import { auth } from "@/lib/firebase";
import { useAuth } from "@/lib/hooks/useAuth";
import { signInWithGoogle } from "@/lib/signIn";
import {
  CREDITS_PER_VIDEO,
  LAUNCH_BONUS,
  PASS_FAST_PER_DAY,
  launchBonusActive,
  packCredits,
  STUDIO_MAX_PROMPT,
  STUDIO_MODELS,
  STUDIO_PACKS,
  resolutionsFor,
  studioCost,
  studioModel,
  type Aspect,
  type Resolution,
  type StudioPack,
} from "@/lib/studio/catalog";

type Batch = { open: boolean; videosLeft: number };
type Account = { credits: number; passUntil: number | null; fastLeftToday: number | null };
type Job = {
  id: string;
  modelId: string;
  resolution: Resolution;
  aspect: Aspect;
  seconds: number;
  prompt: string;
  cost: number;
  paidWith: "credits" | "pass";
  status: string;
  done: boolean;
  url?: string;
  downloadUrl?: string;
  saved?: boolean;
  error?: string;
  createdAt: number;
};

const fmt = (n: number) => n.toLocaleString("en-US");

async function call<T>(path: string, init?: RequestInit) {
  const token = await auth.currentUser?.getIdToken();
  const res = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string; code?: string };
  return { ok: res.ok, status: res.status, data };
}

/** Shrinks a photo in the browser so it fits in one request. */
async function toDataUri(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1280 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  for (const q of [0.88, 0.75, 0.6]) {
    const uri = canvas.toDataURL("image/jpeg", q);
    if (uri.length < 1_300_000) return uri;
  }
  throw new Error("That image is too large");
}

function perVideo(price: number, videos: number) {
  const cents = Math.round((price / videos) * 100);
  return cents >= 100 ? `$${(cents / 100).toFixed(2)}` : `${cents}¢`;
}

/** The best per-video price across the credit packs, launch bonus included. */
function lowestPerVideo() {
  const best = STUDIO_PACKS.filter((p) => !p.passDays)
    .map((p) => ({ p, v: videosFor(packCredits(p).total) }))
    .sort((a, b) => a.p.price / a.v - b.p.price / b.v)[0];
  return perVideo(best.p.price, best.v);
}

function videosFor(credits: number) {
  return Math.floor(credits / CREDITS_PER_VIDEO);
}

export default function StudioApp() {
  const { user, loading } = useAuth();
  const [batch, setBatch] = useState<Batch | null>(null);
  const [account, setAccount] = useState<Account | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [buying, setBuying] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "ok" | "warn"; text: string } | null>(null);
  const [signInError, setSignInError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await call<{ batch: Batch; account?: Account; jobs?: Job[] }>("/api/studio/state");
    if (r.data.batch) setBatch(r.data.batch);
    if (r.data.account) setAccount(r.data.account);
    if (r.data.jobs) setJobs(r.data.jobs);
  }, []);

  useEffect(() => {
    if (!loading) load();
  }, [loading, user, load]);

  // Back from Stripe. The webhook can land a moment after the redirect, so look again shortly.
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const bought = p.get("bought");
    if (bought) {
      setNotice({ tone: "ok", text: "Payment received, thank you! Your credits will show up here in a few seconds." });
      posthog.capture("studio_checkout_returned", { pack: bought });
      const t1 = setTimeout(load, 3000);
      const t2 = setTimeout(load, 8000);
      window.history.replaceState(null, "", "/studio");
      return () => {
        clearTimeout(t1);
        clearTimeout(t2);
      };
    }
    if (p.get("cancelled")) {
      setNotice({ tone: "warn", text: "Checkout cancelled. Nothing was charged." });
      window.history.replaceState(null, "", "/studio");
    }
    posthog.capture("studio_viewed");
  }, [load]);

  // Poll unfinished videos.
  const jobsRef = useRef(jobs);
  jobsRef.current = jobs;
  useEffect(() => {
    if (!user) return;
    const t = setInterval(async () => {
      for (const j of jobsRef.current.filter((x) => !x.done)) {
        const r = await call<{ job: Job; account: Account }>(`/api/studio/jobs/${j.id}`);
        if (r.ok) {
          setJobs((cur) => cur.map((c) => (c.id === j.id ? r.data.job : c)));
          setAccount(r.data.account);
        }
      }
    }, 6000);
    return () => clearInterval(t);
  }, [user]);

  const buy = async (pack: StudioPack) => {
    setSignInError(null);
    if (!auth.currentUser) {
      const res = await signInWithGoogle("studio_buy");
      if (!res.ok) {
        if (res.message) setSignInError(res.message);
        return;
      }
    }
    setBuying(pack.id);
    posthog.capture("studio_buy_clicked", { pack: pack.id, price: pack.price });
    const r = await call<{ url?: string }>("/api/stripe/checkout", {
      method: "POST",
      body: JSON.stringify({ type: "studio", pack: pack.id, source: "studio" }),
    });
    if (r.data.url) {
      window.location.href = r.data.url;
      return;
    }
    setBuying(null);
    setNotice({ tone: "warn", text: r.data.error ?? "Couldn't open checkout. Please try again." });
    if (r.data.code === "sold_out") load();
  };

  const signIn = async () => {
    setSignInError(null);
    const res = await signInWithGoogle("studio");
    if (!res.ok && res.message) setSignInError(res.message);
  };

  return (
    <main className="min-h-screen bg-white px-4 pb-24 pt-12 text-[#0a0a0a]">
      <div className="mx-auto max-w-5xl">
        {launchBonusActive() && <PromoStrip />}

        <section className="mt-8 text-center">
          <div className="inline-flex items-center gap-2 rounded-full bg-amber-50 px-3 py-1 text-xs font-medium text-amber-800">
            {batch?.open && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" />}
            {batch === null
              ? "Limited batch"
              : batch.open
                ? `Limited batch · about ${fmt(batch.videosLeft)} videos left`
                : "This batch is sold out"}
          </div>
          <h1 className="mt-4 text-4xl font-extrabold uppercase leading-[1.05] tracking-tight sm:text-6xl">
            Seedance 2.5
            <span className="block text-gray-400">from {lowestPerVideo()} a video</span>
          </h1>
          <p className="mx-auto mt-4 max-w-2xl text-base text-gray-600 sm:text-lg">
            ByteDance&apos;s newest video model, with sound, at 720p or 1080p. <b className="text-black">Pay once.</b> No
            subscription, credits never expire, and every video is saved to your account.
          </p>
          <div className="mx-auto mt-6 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-sm">
            <span className="text-gray-500">Higgsfield</span>
            <s className="text-xl font-bold text-gray-400 decoration-red-500 decoration-2">$59/mo</s>
            <span className="text-gray-300">&rarr;</span>
            <span className="text-gray-500">here from</span>
            <span className="rounded-lg bg-[#d7ff3a] px-2.5 py-1 text-xl font-extrabold text-black">$9 once</span>
          </div>
        </section>

        {notice && (
          <div
            className={`mx-auto mt-8 max-w-2xl rounded-xl border p-4 text-sm ${
              notice.tone === "ok" ? "border-green-200 bg-green-50 text-green-900" : "border-amber-200 bg-amber-50 text-amber-900"
            }`}
          >
            {notice.text}
          </div>
        )}

        <Packs batch={batch} buying={buying} onBuy={buy} />
        {signInError && <p className="mt-3 text-center text-sm text-red-600">{signInError}</p>}
        <Compare />

        {!loading && !user && (
          <div className="mt-12 rounded-2xl border border-gray-200 p-6 text-center">
            <p className="text-gray-600">Already bought credits? Sign in to make videos.</p>
            <button onClick={signIn} className="mt-4 rounded-lg bg-black px-5 py-2.5 font-medium text-white">
              Sign in with Google
            </button>
          </div>
        )}

        {user && account && (
          <>
            <Balance account={account} />
            <Generator
              account={account}
              onCreated={(job, acc) => {
                setJobs((cur) => [job, ...cur]);
                setAccount(acc);
              }}
              onNeedCredits={() => document.getElementById("packs")?.scrollIntoView({ behavior: "smooth" })}
            />
            <Gallery jobs={jobs} />
          </>
        )}

        <Faq />
      </div>
    </main>
  );
}

function PromoStrip() {
  const left = useCountdown(LAUNCH_BONUS.until);
  const ends = new Date(LAUNCH_BONUS.until).toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
  return (
    <div className="rounded-2xl bg-black px-4 py-4 text-center text-white sm:px-6">
      <p className="text-lg font-extrabold uppercase tracking-tight text-[#d7ff3a] sm:text-2xl">
        Launch week: +{LAUNCH_BONUS.pct}% free credits on every pack
      </p>
      <p className="mt-1 text-sm text-gray-300">
        Ends {ends}
        {left && (
          <>
            {" · "}
            <span className="font-mono font-semibold text-white">{left}</span> left
          </>
        )}
      </p>
    </div>
  );
}

/** "2d 14h 05m" until `until`; null before mount, so server and browser render the same. */
function useCountdown(until: number) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  if (now === null || now > until) return null;
  const m = Math.floor((until - now) / 60_000);
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  return `${d}d ${h}h ${String(m % 60).padStart(2, "0")}m`;
}

function Packs({ batch, buying, onBuy }: { batch: Batch | null; buying: string | null; onBuy: (p: StudioPack) => void }) {
  const soldOut = batch !== null && !batch.open;
  return (
    <section id="packs" className="mt-10">
      <div className="grid gap-5 pt-3 sm:grid-cols-2 lg:grid-cols-4">
        {STUDIO_PACKS.map((p) => {
          const c = packCredits(p);
          const videos = videosFor(c.total);
          const pass = !!p.passDays;
          const hot = p.note === "most popular";
          return (
            <div
              key={p.id}
              className={`relative flex flex-col rounded-2xl border p-5 ${hot ? "border-black ring-2 ring-black" : "border-gray-200"} ${pass ? "bg-gray-50" : "bg-white"}`}
            >
              {c.bonus > 0 && (
                <span className="absolute -right-2 -top-3 rotate-6 rounded-lg bg-[#d7ff3a] px-2 py-1 text-xs font-extrabold uppercase text-black shadow-sm">
                  +{LAUNCH_BONUS.pct}% free
                </span>
              )}
              <div className="flex items-center gap-2">
                <span className="font-semibold">{p.title}</span>
                {p.note && (
                  <span className="rounded-full bg-black px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white">
                    {p.note}
                  </span>
                )}
              </div>
              <div className="mt-3 flex items-baseline gap-1.5">
                <span className="text-4xl font-extrabold tracking-tight">${p.price}</span>
                <span className="text-sm text-gray-500">{pass ? `/ ${p.passDays} days` : "once"}</span>
              </div>

              <div className="mt-4 rounded-xl bg-gray-100 px-3 py-2.5">
                <div className="text-2xl font-extrabold leading-none">
                  {videos} <span className="text-base font-semibold">Seedance videos</span>
                </div>
                {pass ? (
                  <div className="mt-1.5 text-sm font-semibold">+ unlimited Fast videos*</div>
                ) : (
                  <div className="mt-1.5 inline-block rounded-md bg-black px-1.5 py-0.5 text-xs font-bold text-[#d7ff3a]">
                    {perVideo(p.price, videos)} a video
                  </div>
                )}
              </div>

              <ul className="mt-3 flex-1 space-y-1 text-sm text-gray-600">
                <li>
                  {c.bonus > 0 ? (
                    <>
                      <s className="text-gray-400">{fmt(c.base)}</s> <b className="text-black">{fmt(c.total)} credits</b>
                    </>
                  ) : (
                    <>{fmt(c.total)} credits</>
                  )}
                </li>
                <li>5 s, 720p, with sound</li>
                <li>Credits never expire</li>
              </ul>
              <button
                disabled={soldOut || buying !== null}
                onClick={() => onBuy(p)}
                className={`mt-5 rounded-xl py-3 font-bold transition-transform active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 ${
                  hot ? "bg-black text-white hover:bg-gray-800" : "border-2 border-black hover:bg-black hover:text-white"
                }`}
              >
                {buying === p.id ? "Opening checkout…" : soldOut ? "Sold out" : `Get ${videos} videos for $${p.price}`}
              </button>
            </div>
          );
        })}
      </div>
      <p className="mt-4 text-center text-xs text-gray-500">
        *Unlimited covers Fast videos (Grok Imagine Lite), up to {PASS_FAST_PER_DAY} a day for {STUDIO_PACKS.find((p) => p.passDays)?.passDays} days
        as fair use. Seedance 2.5 videos always use credits. Failed videos are refunded automatically.
      </p>
    </section>
  );
}

/** Checked on higgsfield.ai/pricing, 10 Nov 2026. Update or remove if their plans change. */
function Compare() {
  const rows: [string, string, string][] = [
    ["Cheapest way to get Seedance 2.5", "$59 a month", "$9, once"],
    ["A year of it", "$708 ($564 billed yearly)", "Only what you buy"],
    ["Unused credits", "Plan credits renew monthly", "Never expire"],
    ["Commitment", "Monthly subscription", "None"],
  ];
  return (
    <section className="mx-auto mt-14 max-w-3xl">
      <h2 className="text-center text-2xl font-extrabold uppercase tracking-tight">Why pay monthly?</h2>
      <div className="mt-5 overflow-hidden rounded-2xl border border-gray-200 text-sm">
        <div className="grid grid-cols-[1.1fr_1fr_1fr] gap-2 bg-gray-50 px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-gray-500">
          <span />
          <span>Higgsfield Plus</span>
          <span className="text-black">Scene Fixer Studio</span>
        </div>
        {rows.map(([k, them, us]) => (
          <div key={k} className="grid grid-cols-[1.1fr_1fr_1fr] gap-2 border-t border-gray-100 px-4 py-3">
            <span className="text-gray-500">{k}</span>
            <span className="text-gray-400">{them}</span>
            <span className="font-bold">{us}</span>
          </div>
        ))}
      </div>
      <p className="mt-3 text-center text-xs text-gray-400">
        Higgsfield Plus includes 80 Seedance 2.5 videos a month plus other models. Prices from higgsfield.ai/pricing on 10 Nov 2026.
      </p>
    </section>
  );
}

function Balance({ account }: { account: Account }) {
  return (
    <section className="mt-12 flex flex-wrap items-center gap-x-8 gap-y-2 rounded-2xl border border-gray-200 bg-gray-50 p-5">
      <div>
        <div className="text-xs uppercase tracking-wide text-gray-500">Your credits</div>
        <div className="text-2xl font-semibold tabular-nums">
          {fmt(account.credits)}{" "}
          <span className="text-sm font-normal text-gray-500">≈ {videosFor(account.credits)} Seedance videos</span>
        </div>
      </div>
      {account.passUntil && (
        <div>
          <div className="text-xs uppercase tracking-wide text-gray-500">Unlimited* pass</div>
          <div className="text-sm">
            Until {new Date(account.passUntil).toLocaleDateString()} · {account.fastLeftToday} Fast videos left today
          </div>
        </div>
      )}
    </section>
  );
}

function Pills<T extends string | number>({ value, options, onChange, render }: { value: T; options: T[]; onChange: (v: T) => void; render?: (v: T) => string }) {
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((o) => (
        <button
          type="button"
          key={String(o)}
          onClick={() => onChange(o)}
          className={`rounded-full border px-3.5 py-1.5 text-sm transition ${o === value ? "border-black bg-black text-white" : "border-gray-200 text-gray-700 hover:border-gray-400"}`}
        >
          {render ? render(o) : String(o)}
        </button>
      ))}
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <div className="mb-2 text-xs font-medium uppercase tracking-wide text-gray-500">{children}</div>;
}

function Generator({
  account,
  onCreated,
  onNeedCredits,
}: {
  account: Account;
  onCreated: (j: Job, a: Account) => void;
  onNeedCredits: () => void;
}) {
  const [modelId, setModelId] = useState<string>("seedance");
  const [resolution, setResolution] = useState<Resolution>("720p");
  const [aspect, setAspect] = useState<Aspect>("16:9");
  const [seconds, setSeconds] = useState(5);
  const [audio, setAudio] = useState(true);
  const [prompt, setPrompt] = useState("");
  const [image, setImage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const m = studioModel(modelId)!;
  const cost = studioCost(m, resolution, seconds, !!image);
  const free = m.inPass && !!account.passUntil && (account.fastLeftToday ?? 0) > 0;
  const short = !free && cost > account.credits;

  const pick = (id: string) => {
    const next = studioModel(id)!;
    setModelId(id);
    if (!next.ratios[resolution]) setResolution("720p");
    if (!next.durations.includes(seconds)) setSeconds(next.durations[0]);
  };

  return (
    <section className="mt-8 rounded-2xl border border-gray-200 p-5 sm:p-6">
      <h2 className="text-lg font-semibold">Make a video</h2>
      <form
        className="mt-5 space-y-5"
        onSubmit={async (e) => {
          e.preventDefault();
          if (short) return onNeedCredits();
          setBusy(true);
          setError("");
          const r = await call<{ job: Job; account: Account }>("/api/studio/generate", {
            method: "POST",
            body: JSON.stringify({ modelId, resolution, aspect, seconds, audio, prompt, ...(image ? { image } : {}) }),
          });
          setBusy(false);
          if (r.ok) onCreated(r.data.job, r.data.account);
          else if (r.data.code === "no_credits") {
            setError(r.data.error ?? "Not enough credits");
            onNeedCredits();
          } else setError(r.data.error ?? "That didn't work. Nothing was charged.");
        }}
      >
        <div>
          <Label>Model</Label>
          <div className="grid gap-2 sm:grid-cols-2">
            {STUDIO_MODELS.map((x) => (
              <button
                type="button"
                key={x.id}
                onClick={() => pick(x.id)}
                className={`rounded-xl border p-3 text-left transition ${x.id === modelId ? "border-black ring-1 ring-black" : "border-gray-200 hover:border-gray-400"}`}
              >
                <div className="font-medium">{x.label}</div>
                <div className="mt-1 text-sm text-gray-600">{x.blurb}</div>
              </button>
            ))}
          </div>
        </div>
        <div className="flex flex-wrap gap-x-10 gap-y-4">
          <div>
            <Label>Quality</Label>
            <Pills value={resolution} options={resolutionsFor(m)} onChange={setResolution} />
          </div>
          <div>
            <Label>Length</Label>
            <Pills value={seconds} options={m.durations} onChange={setSeconds} render={(v) => `${v}s`} />
          </div>
          <div>
            <Label>Shape</Label>
            <Pills value={aspect} options={["16:9", "9:16"] as Aspect[]} onChange={setAspect} render={(v) => (v === "16:9" ? "Landscape" : "Portrait")} />
          </div>
          {m.hasAudio && (
            <div>
              <Label>Sound</Label>
              <Pills value={audio ? "on" : "off"} options={["on", "off"]} onChange={(v) => setAudio(v === "on")} render={(v) => (v === "on" ? "With sound" : "Silent")} />
            </div>
          )}
        </div>
        <div>
          <Label>Start from an image (optional)</Label>
          <div className="flex items-center gap-3">
            {image ? (
              <>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={image} alt="" className="h-20 w-20 rounded-lg object-cover" />
                <button type="button" className="text-sm text-gray-500 underline" onClick={() => setImage(null)}>
                  Remove
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                className="flex h-20 w-20 items-center justify-center rounded-lg border-2 border-dashed border-gray-200 text-xs text-gray-500 hover:border-gray-400"
              >
                + Image
              </button>
            )}
            <input
              ref={fileRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="hidden"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (!f) return;
                try {
                  setImage(await toDataUri(f));
                  setError("");
                } catch (e2) {
                  setError(e2 instanceof Error ? e2.message : "Couldn't read that image");
                }
              }}
            />
          </div>
        </div>
        <div>
          <Label>What happens</Label>
          <textarea
            className="h-28 w-full rounded-lg border border-gray-200 p-3 text-[15px] outline-none focus:border-black"
            maxLength={STUDIO_MAX_PROMPT}
            placeholder="A lighthouse keeper climbs the spiral stairs at night, lantern swinging, waves crashing outside. Slow push in."
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <button disabled={busy || !prompt.trim()} className="rounded-lg bg-black px-5 py-2.5 font-medium text-white disabled:cursor-not-allowed disabled:opacity-40">
            {busy ? "Starting…" : short ? "Get credits" : "Make video"}
          </button>
          <span className="text-sm text-gray-600">
            {free ? (
              <>Free with your pass ({account.fastLeftToday} left today)</>
            ) : (
              <>
                Costs <b className="tabular-nums">{cost}</b> credits <span className="text-gray-500">(you have {fmt(account.credits)})</span>
              </>
            )}
          </span>
        </div>
        {short && <p className="text-sm text-amber-700">You need {cost - account.credits} more credits for this one.</p>}
        {error && <p className="text-sm text-red-600">{error}</p>}
        <p className="text-xs text-gray-500">If a video fails or the content filter blocks it, your credits come straight back.</p>
      </form>
    </section>
  );
}

const ETA: Record<string, string> = { seedance: "usually 4–5 minutes", fast: "usually under a minute" };

function JobCard({ j }: { j: Job }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (j.done) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [j.done]);
  const elapsed = Math.max(0, Math.round((now - j.createdAt) / 1000));
  const label = studioModel(j.modelId)?.label ?? j.modelId;
  return (
    <div className="overflow-hidden rounded-xl border border-gray-200">
      <div className={`flex w-full items-center justify-center bg-gray-50 ${j.aspect === "16:9" ? "aspect-video" : "aspect-[9/16] max-h-[420px]"}`}>
        {j.status === "SUCCEEDED" && j.url ? (
          <video src={j.url} controls loop playsInline className="h-full w-full bg-black object-contain" />
        ) : !j.done ? (
          <div className="px-6 text-center text-sm text-gray-500">
            <div className="mx-auto mb-2 h-5 w-5 animate-spin rounded-full border-2 border-gray-300 border-t-black" />
            Making it… {ETA[j.modelId] ?? ""}
            <div className="text-xs text-gray-400">{elapsed}s so far · you can leave and come back</div>
          </div>
        ) : j.status === "SUCCEEDED" ? (
          <div className="px-6 text-center text-sm text-gray-500">This video has expired.</div>
        ) : (
          <div className="px-6 text-center text-sm text-red-600">{j.error ?? "This one didn't work. Your credits are back."}</div>
        )}
      </div>
      <div className="space-y-1 p-3 text-sm">
        <div className="flex items-baseline justify-between">
          <span className="font-medium">
            {label} · {j.resolution} · {j.seconds}s
          </span>
          <span className="tabular-nums text-gray-500">
            {j.done && j.status !== "SUCCEEDED" ? "refunded" : j.paidWith === "pass" ? "pass" : `${j.cost} cr`}
          </span>
        </div>
        <p className="line-clamp-2 text-gray-500">{j.prompt}</p>
        {j.status === "SUCCEEDED" && j.url && (
          <div className="flex items-center justify-between pt-1">
            <a href={j.downloadUrl ?? j.url} download className="text-black underline">
              Download
            </a>
            <span className="text-xs text-gray-400">{j.saved ? "Saved to your account" : "Saving…"}</span>
          </div>
        )}
      </div>
    </div>
  );
}

function Gallery({ jobs }: { jobs: Job[] }) {
  if (!jobs.length) return null;
  return (
    <section className="mt-12">
      <h2 className="text-lg font-semibold">Your videos</h2>
      <div className="mt-4 grid gap-5 sm:grid-cols-2">
        {jobs.map((j) => (
          <JobCard key={j.id} j={j} />
        ))}
      </div>
    </section>
  );
}

function Faq() {
  const items: [string, string][] = [
    ["What is a credit?", `A 5-second Seedance 2.5 video at 720p costs ${CREDITS_PER_VIDEO} credits. 480p costs 10, 1080p costs 34, and longer videos cost more. The exact price shows before you press the button.`],
    ["Do credits expire?", "No. There's no subscription and nothing resets each month. Use them whenever you like."],
    ["Where are my videos kept?", "In your account. Every finished video is saved here, so you can come back and download it any time."],
    ["What happens if a video fails?", "You get the credits back automatically, including when the content filter blocks a prompt or image."],
    ["Can I animate a photo?", "Yes, add a start image. Seedance won't animate photos of real people; if the filter refuses an image, your credits come back."],
    ["What does Unlimited* mean?", `The pass gives you Fast videos (a quicker, lower-quality model, good for testing ideas) without spending credits, up to ${PASS_FAST_PER_DAY} a day for 30 days, plus ${packCredits(STUDIO_PACKS.find((p) => p.passDays)!).total} credits for Seedance 2.5.`],
    ["Why is it this cheap?", "We bought a large block of video-generation capacity for Scene Fixer and are selling part of it. When this batch is gone, it's gone."],
  ];
  return (
    <section className="mx-auto mt-16 max-w-2xl">
      <h2 className="text-lg font-semibold">Questions</h2>
      <dl className="mt-4 divide-y divide-gray-100">
        {items.map(([q, a]) => (
          <div key={q} className="py-4">
            <dt className="font-medium">{q}</dt>
            <dd className="mt-1 text-sm text-gray-600">{a}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
