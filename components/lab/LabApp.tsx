"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  IMAGE_MODELS,
  MAX_PROMPT_CHARS,
  VIDEO_MODELS,
  imageCost,
  imageModel,
  videoCost,
  videoModel,
  type AspectRatio,
} from "@/lib/lab/catalog";

type Budget = { limit: number; spent: number; reserved: number; remaining: number };

type Job = {
  id: string;
  kind: "image" | "video";
  modelId: string;
  prompt: string;
  aspect: AspectRatio;
  seconds?: number;
  audio?: boolean;
  estimate: number;
  charged?: number;
  status: string;
  done: boolean;
  output?: string[];
  error?: string;
  createdAt: number;
};

/** An image the tester can feed into a generation: their own upload, or one made here. */
type TrayImage = { key: string; preview: string; kind: "upload" | "job"; dataUri?: string; jobId?: string };

const fmt = (n: number) => n.toLocaleString("en-US");

async function api<T>(path: string, init?: RequestInit): Promise<{ ok: boolean; status: number; data: T & { error?: string } }> {
  const res = await fetch(path, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

/** Shrinks a photo in the browser so a few of them fit in one request. */
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

export default function LabApp({ enabled }: { enabled: boolean }) {
  const [phase, setPhase] = useState<"loading" | "login" | "ready">("loading");
  const [budget, setBudget] = useState<Budget | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [uploads, setUploads] = useState<TrayImage[]>([]);

  const load = useCallback(async () => {
    const r = await api<{ budget: Budget; jobs: Job[] }>("/api/lab/state");
    if (r.status === 401) return setPhase("login");
    if (r.ok) {
      setBudget(r.data.budget);
      setJobs(r.data.jobs);
      setPhase("ready");
    }
  }, []);

  useEffect(() => {
    if (enabled) load();
  }, [enabled, load]);

  // Poll running jobs. Runway answers no more often than every few seconds.
  const jobsRef = useRef(jobs);
  jobsRef.current = jobs;
  useEffect(() => {
    if (phase !== "ready") return;
    const t = setInterval(async () => {
      for (const j of jobsRef.current.filter((x) => !x.done)) {
        const r = await api<{ job: Job; budget: Budget }>(`/api/lab/jobs/${j.id}`);
        if (r.ok) {
          setJobs((cur) => cur.map((c) => (c.id === j.id ? r.data.job : c)));
          setBudget(r.data.budget);
        }
      }
    }, 5000);
    return () => clearInterval(t);
  }, [phase]);

  const onCreated = (job: Job, b: Budget) => {
    setJobs((cur) => [job, ...cur]);
    setBudget(b);
  };

  const tray: TrayImage[] = [
    ...jobs
      .filter((j) => j.kind === "image" && j.status === "SUCCEEDED" && j.output?.[0])
      .map((j): TrayImage => ({ key: `j:${j.id}`, preview: j.output![0], kind: "job", jobId: j.id })),
    ...uploads,
  ];

  if (!enabled) {
    return (
      <Shell>
        <p className="mt-24 text-center text-gray-500">This page isn&apos;t switched on.</p>
      </Shell>
    );
  }
  if (phase === "loading") {
    return (
      <Shell>
        <p className="mt-24 text-center text-gray-400">Loading…</p>
      </Shell>
    );
  }
  if (phase === "login") {
    return (
      <Shell>
        <Login onDone={load} />
      </Shell>
    );
  }

  return (
    <Shell
      right={
        <button
          className="text-sm text-gray-500 hover:text-black"
          onClick={async () => {
            await api("/api/lab/logout", { method: "POST" });
            setPhase("login");
          }}
        >
          Sign out
        </button>
      }
    >
      {budget && <Meter budget={budget} />}
      <p className="mt-6 max-w-2xl text-[15px] leading-relaxed text-gray-600">
        Make a picture, then turn it into a video, or go straight to video. Every button shows what it costs before you
        press it. Your credits are shared across everything below and don&apos;t refill. Finished files are kept about a
        day, so save what you like.
      </p>

      <ImageForm budget={budget} tray={tray} onCreated={onCreated} onUpload={(t) => setUploads((u) => [...u, t])} />
      <VideoForm budget={budget} tray={tray} onCreated={onCreated} onUpload={(t) => setUploads((u) => [...u, t])} />
      <Gallery jobs={jobs} />
    </Shell>
  );
}

function Shell({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
  // Sits over the site header and widgets: this page is separate from the product.
  return (
    <div className="fixed inset-0 z-[200] overflow-y-auto bg-white text-[#0a0a0a]">
      <div className="mx-auto max-w-5xl px-5 pb-24 pt-6">
        <header className="flex items-center justify-between border-b border-gray-100 pb-4">
          <div>
            <span className="text-lg font-semibold tracking-tight">Scene Fixer Lab</span>
            <span className="ml-3 rounded-full bg-amber-50 px-2.5 py-0.5 text-xs font-medium text-amber-700">Private test</span>
          </div>
          {right}
        </header>
        {children}
      </div>
    </div>
  );
}

function Login({ onDone }: { onDone: () => void }) {
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  return (
    <form
      className="mx-auto mt-24 max-w-sm space-y-3"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError("");
        const r = await api("/api/lab/login", { method: "POST", body: JSON.stringify({ login, password }) });
        setBusy(false);
        if (r.ok) onDone();
        else setError(r.data.error ?? "Couldn't sign in");
      }}
    >
      <h1 className="text-xl font-semibold">Sign in</h1>
      <input
        className="w-full rounded-lg border border-gray-200 px-3 py-2.5 outline-none focus:border-black"
        placeholder="Login"
        autoComplete="username"
        value={login}
        onChange={(e) => setLogin(e.target.value)}
      />
      <input
        className="w-full rounded-lg border border-gray-200 px-3 py-2.5 outline-none focus:border-black"
        placeholder="Password"
        type="password"
        autoComplete="current-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      {error && <p className="text-sm text-red-600">{error}</p>}
      <button disabled={busy} className="w-full rounded-lg bg-black py-2.5 font-medium text-white disabled:opacity-50">
        {busy ? "Checking…" : "Enter"}
      </button>
    </form>
  );
}

function Meter({ budget }: { budget: Budget }) {
  const used = Math.min(100, ((budget.spent + budget.reserved) / budget.limit) * 100);
  return (
    <div className="mt-6 rounded-xl border border-gray-100 bg-gray-50 p-4">
      <div className="flex items-baseline justify-between">
        <span className="text-sm text-gray-500">Credits left</span>
        <span className="text-2xl font-semibold tabular-nums">
          {fmt(budget.remaining)} <span className="text-sm font-normal text-gray-400">of {fmt(budget.limit)}</span>
        </span>
      </div>
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-gray-200">
        <div className="h-full rounded-full bg-black transition-all" style={{ width: `${used}%` }} />
      </div>
      {budget.reserved > 0 && (
        <p className="mt-2 text-xs text-gray-400">{fmt(budget.reserved)} are held for generations still running; any that fail are given back.</p>
      )}
    </div>
  );
}

function Section({ n, title, sub, children }: { n: number; title: string; sub: string; children: React.ReactNode }) {
  return (
    <section className="mt-10 rounded-2xl border border-gray-200 p-5 sm:p-6">
      <h2 className="text-lg font-semibold">
        <span className="mr-2 text-gray-300">{n}</span>
        {title}
      </h2>
      <p className="mt-1 text-sm text-gray-500">{sub}</p>
      <div className="mt-5 space-y-5">{children}</div>
    </section>
  );
}

function Pills<T extends string | number>({
  value,
  options,
  onChange,
  render,
}: {
  value: T;
  options: T[];
  onChange: (v: T) => void;
  render?: (v: T) => string;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((o) => (
        <button
          type="button"
          key={String(o)}
          onClick={() => onChange(o)}
          className={`rounded-full border px-3.5 py-1.5 text-sm transition ${
            o === value ? "border-black bg-black text-white" : "border-gray-200 text-gray-700 hover:border-gray-400"
          }`}
        >
          {render ? render(o) : String(o)}
        </button>
      ))}
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <div className="mb-2 text-xs font-medium uppercase tracking-wide text-gray-400">{children}</div>;
}

function Picker({
  tray,
  selected,
  max,
  onToggle,
  onUpload,
  label,
}: {
  tray: TrayImage[];
  selected: string[];
  max: number;
  onToggle: (key: string) => void;
  onUpload: (t: TrayImage) => void;
  label: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [err, setErr] = useState("");
  return (
    <div>
      <Label>{label}</Label>
      <div className="flex flex-wrap gap-2">
        {tray.map((t) => {
          const on = selected.includes(t.key);
          return (
            <button
              type="button"
              key={t.key}
              onClick={() => onToggle(t.key)}
              className={`relative h-20 w-20 overflow-hidden rounded-lg border-2 ${on ? "border-black" : "border-transparent opacity-70 hover:opacity-100"}`}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={t.preview} alt="" className="h-full w-full object-cover" />
              {on && <span className="absolute right-1 top-1 rounded-full bg-black px-1.5 text-[10px] text-white">{selected.indexOf(t.key) + 1}</span>}
            </button>
          );
        })}
        <button
          type="button"
          onClick={() => input.current?.click()}
          className="flex h-20 w-20 items-center justify-center rounded-lg border-2 border-dashed border-gray-200 text-xs text-gray-400 hover:border-gray-400"
        >
          + Upload
        </button>
        <input
          ref={input}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          className="hidden"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (!f) return;
            try {
              const dataUri = await toDataUri(f);
              const t: TrayImage = { key: `u:${Date.now()}`, preview: dataUri, kind: "upload", dataUri };
              onUpload(t);
              if (selected.length < max) onToggle(t.key);
              setErr("");
            } catch (e2) {
              setErr(e2 instanceof Error ? e2.message : "Couldn't read that image");
            }
          }}
        />
      </div>
      {err && <p className="mt-1 text-xs text-red-600">{err}</p>}
      {max > 0 && <p className="mt-1 text-xs text-gray-400">Pick up to {max}.</p>}
    </div>
  );
}

type ImageInput = { type: "upload"; dataUri: string } | { type: "job"; jobId: string };

function toInputs(tray: TrayImage[], keys: string[]): ImageInput[] {
  return keys.flatMap((k): ImageInput[] => {
    const t = tray.find((x) => x.key === k);
    if (!t) return [];
    return t.kind === "upload" ? [{ type: "upload", dataUri: t.dataUri! }] : [{ type: "job", jobId: t.jobId! }];
  });
}

function toggle(list: string[], key: string, max: number): string[] {
  if (list.includes(key)) return list.filter((k) => k !== key);
  return list.length >= max ? [...list.slice(1), key] : [...list, key];
}

type FormProps = {
  budget: Budget | null;
  tray: TrayImage[];
  onCreated: (j: Job, b: Budget) => void;
  onUpload: (t: TrayImage) => void;
};

function SubmitRow({ cost, budget, busy, error, label }: { cost: number; budget: Budget | null; busy: boolean; error: string; label: string }) {
  const short = budget ? cost > budget.remaining : false;
  return (
    <div>
      <div className="flex flex-wrap items-center gap-4">
        <button
          disabled={busy || short}
          className="rounded-lg bg-black px-5 py-2.5 font-medium text-white disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? "Starting…" : label}
        </button>
        <span className="text-sm text-gray-600">
          This costs <b className="tabular-nums">{fmt(cost)}</b> credits
          {budget && <span className="text-gray-400"> (you have {fmt(budget.remaining)})</span>}
        </span>
      </div>
      {short && <p className="mt-2 text-sm text-red-600">Not enough credits left for this one. Pick something cheaper.</p>}
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
    </div>
  );
}

function ImageForm({ budget, tray, onCreated, onUpload }: FormProps) {
  const [modelId, setModelId] = useState(IMAGE_MODELS[0].id);
  const [aspect, setAspect] = useState<AspectRatio>("16:9");
  const [prompt, setPrompt] = useState("");
  const [sel, setSel] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const m = imageModel(modelId)!;

  return (
    <Section n={1} title="Make an image" sub="Optional. Describe a shot, or add photos of your characters so they stay recognisable.">
      <form
        className="space-y-5"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          const r = await api<{ job: Job; budget: Budget }>("/api/lab/generate", {
            method: "POST",
            body: JSON.stringify({ kind: "image", modelId, aspect, prompt, images: toInputs(tray, sel.slice(0, m.maxRefs)) }),
          });
          setBusy(false);
          if (r.ok) onCreated(r.data.job, r.data.budget);
          else setError(r.data.error ?? "Failed");
        }}
      >
        <div>
          <Label>Model</Label>
          <div className="grid gap-2 sm:grid-cols-2">
            {IMAGE_MODELS.map((x) => (
              <button
                type="button"
                key={x.id}
                onClick={() => setModelId(x.id)}
                className={`rounded-xl border p-3 text-left transition ${x.id === modelId ? "border-black ring-1 ring-black" : "border-gray-200 hover:border-gray-400"}`}
              >
                <div className="flex items-baseline justify-between">
                  <span className="font-medium">{x.label}</span>
                  <span className="text-sm tabular-nums text-gray-500">{imageCost(x)} cr</span>
                </div>
                <div className="text-xs text-gray-400">{x.maker}</div>
                <div className="mt-1 text-sm text-gray-600">{x.blurb}</div>
              </button>
            ))}
          </div>
        </div>
        <div>
          <Label>Shape</Label>
          <Pills value={aspect} options={["16:9", "9:16"] as AspectRatio[]} onChange={setAspect} render={(v) => (v === "16:9" ? "Landscape 16:9" : "Portrait 9:16")} />
        </div>
        <Picker
          tray={tray}
          selected={sel}
          max={m.maxRefs}
          onToggle={(k) => setSel((s) => toggle(s, k, m.maxRefs))}
          onUpload={onUpload}
          label="Reference photos (optional)"
        />
        <div>
          <Label>Prompt</Label>
          <textarea
            className="h-24 w-full rounded-lg border border-gray-200 p-3 text-[15px] outline-none focus:border-black"
            maxLength={MAX_PROMPT_CHARS}
            placeholder="A woman in a dark blue jacket stands at a rain-streaked café window at dusk, warm light behind her"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
        </div>
        <SubmitRow cost={imageCost(m)} budget={budget} busy={busy} error={error} label="Make image" />
      </form>
    </Section>
  );
}

function VideoForm({ budget, tray, onCreated, onUpload }: FormProps) {
  const [modelId, setModelId] = useState(VIDEO_MODELS[0].id);
  const [aspect, setAspect] = useState<AspectRatio>("16:9");
  const [seconds, setSeconds] = useState(VIDEO_MODELS[0].durations[0]);
  const [audio, setAudio] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [sel, setSel] = useState<string[]>([]);
  const [mode, setMode] = useState<"start" | "reference">("start");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const m = videoModel(modelId)!;

  const pick = (id: string) => {
    const next = videoModel(id)!;
    setModelId(id);
    if (!next.durations.includes(seconds)) setSeconds(next.durations[0]);
    setAudio(next.hasAudio && next.audioExtraPerSecond === 0);
    setSel((s) => s.slice(-next.maxImages));
    setMode("start");
  };

  const images = sel.slice(0, m.maxImages);
  const cost = videoCost(m, seconds, audio);
  const needsImage = !m.textOnly && images.length === 0;

  return (
    <Section n={2} title="Make a video" sub="Pick a model, a length, and optionally the image it should start from.">
      <form
        className="space-y-5"
        onSubmit={async (e) => {
          e.preventDefault();
          if (needsImage) return setError(`${m.label} animates an image. Pick or upload one first.`);
          setBusy(true);
          setError("");
          const r = await api<{ job: Job; budget: Budget }>("/api/lab/generate", {
            method: "POST",
            body: JSON.stringify({
              kind: "video",
              modelId,
              aspect,
              seconds,
              audio,
              prompt,
              imageMode: m.multiReference ? mode : "start",
              images: toInputs(tray, images),
            }),
          });
          setBusy(false);
          if (r.ok) onCreated(r.data.job, r.data.budget);
          else setError(r.data.error ?? "Failed");
        }}
      >
        <div>
          <Label>Model</Label>
          <div className="grid gap-2 sm:grid-cols-2">
            {VIDEO_MODELS.map((x) => (
              <button
                type="button"
                key={x.id}
                onClick={() => pick(x.id)}
                className={`rounded-xl border p-3 text-left transition ${x.id === modelId ? "border-black ring-1 ring-black" : "border-gray-200 hover:border-gray-400"}`}
              >
                <div className="flex items-baseline justify-between">
                  <span className="font-medium">{x.label}</span>
                  <span className="text-sm tabular-nums text-gray-500">
                    {x.creditsPerSecond}
                    {x.audioExtraPerSecond ? `–${x.creditsPerSecond + x.audioExtraPerSecond}` : ""} cr/s
                  </span>
                </div>
                <div className="text-xs text-gray-400">{x.maker}</div>
                <div className="mt-1 text-sm text-gray-600">{x.blurb}</div>
              </button>
            ))}
          </div>
        </div>
        <div className="flex flex-wrap gap-x-10 gap-y-4">
          <div>
            <Label>Length</Label>
            <Pills value={seconds} options={m.durations} onChange={setSeconds} render={(v) => `${v}s`} />
          </div>
          <div>
            <Label>Shape</Label>
            <Pills value={aspect} options={["16:9", "9:16"] as AspectRatio[]} onChange={setAspect} render={(v) => (v === "16:9" ? "Landscape" : "Portrait")} />
          </div>
          {m.hasAudio && (
            <div>
              <Label>Sound</Label>
              {m.audioExtraPerSecond > 0 ? (
                <Pills value={audio ? "on" : "off"} options={["off", "on"]} onChange={(v) => setAudio(v === "on")} render={(v) => (v === "on" ? `With sound (+${m.audioExtraPerSecond}/s)` : "Silent")} />
              ) : (
                <Pills value={audio ? "on" : "off"} options={["on", "off"]} onChange={(v) => setAudio(v === "on")} render={(v) => (v === "on" ? "With sound (free)" : "Silent")} />
              )}
            </div>
          )}
        </div>
        <Picker
          tray={tray}
          selected={images}
          max={m.maxImages}
          onToggle={(k) => setSel((s) => toggle(s, k, m.maxImages))}
          onUpload={onUpload}
          label={m.textOnly ? "Image to start from (optional)" : "Image to animate (required)"}
        />
        {m.multiReference && images.length > 0 && (
          <div>
            <Label>How to use the image{images.length > 1 ? "s" : ""}</Label>
            <Pills
              value={mode}
              options={["start", "reference"] as ("start" | "reference")[]}
              onChange={setMode}
              render={(v) => (v === "start" ? "Start the video from it" : "Keep these characters and look")}
            />
          </div>
        )}
        <div>
          <Label>What happens</Label>
          <textarea
            className="h-24 w-full rounded-lg border border-gray-200 p-3 text-[15px] outline-none focus:border-black"
            maxLength={MAX_PROMPT_CHARS}
            placeholder="Slow push in as she turns from the window and smiles at someone off-camera"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
        </div>
        <SubmitRow cost={cost} budget={budget} busy={busy} error={error} label="Make video" />
      </form>
    </Section>
  );
}

function Gallery({ jobs }: { jobs: Job[] }) {
  const now = useNow(1000);
  if (!jobs.length) return null;
  return (
    <section className="mt-12">
      <h2 className="text-lg font-semibold">Your creations</h2>
      <div className="mt-4 grid gap-5 sm:grid-cols-2">
        {jobs.map((j) => {
          const label = (j.kind === "image" ? imageModel(j.modelId) : videoModel(j.modelId))?.label ?? j.modelId;
          const url = j.output?.[0];
          const running = !j.done;
          return (
            <div key={j.id} className="overflow-hidden rounded-xl border border-gray-200">
              <div className={`relative flex items-center justify-center bg-gray-50 ${j.aspect === "16:9" ? "aspect-video" : "aspect-[9/16] max-h-[420px]"} w-full`}>
                {j.status === "SUCCEEDED" && url ? (
                  j.kind === "video" ? (
                    <video src={url} controls loop playsInline className="h-full w-full bg-black object-contain" />
                  ) : (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={url} alt={j.prompt} className="h-full w-full object-contain" />
                  )
                ) : running ? (
                  <div className="text-center text-sm text-gray-500">
                    <div className="mx-auto mb-2 h-5 w-5 animate-spin rounded-full border-2 border-gray-300 border-t-black" />
                    {j.kind === "video" ? "Making your video… usually 1–3 minutes" : "Making your image…"}
                    <div className="text-xs text-gray-400">{Math.max(0, Math.round((now - j.createdAt) / 1000))}s</div>
                  </div>
                ) : (
                  <div className="px-6 text-center text-sm text-red-600">{j.error ?? "This one didn't work."}</div>
                )}
              </div>
              <div className="space-y-1 p-3 text-sm">
                <div className="flex items-baseline justify-between">
                  <span className="font-medium">{label}</span>
                  <span className="tabular-nums text-gray-500">
                    {j.status === "SUCCEEDED" ? `${fmt(j.charged ?? j.estimate)} cr` : j.done ? "0 cr (not charged)" : `${fmt(j.estimate)} cr held`}
                  </span>
                </div>
                <p className="line-clamp-2 text-gray-500">{j.prompt}</p>
                {j.status === "SUCCEEDED" && url && (
                  <a href={url} target="_blank" rel="noreferrer" className="inline-block pt-1 text-black underline">
                    Open / save
                  </a>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function useNow(ms: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}
