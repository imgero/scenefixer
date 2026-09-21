"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/lib/hooks/useAuth";

type Flagged = {
  errorId: string;
  type: string;
  severity?: string;
  description?: string;
  fixSuggestion?: string;
  userConfirmed: boolean;
  fixStatus: string | null;
  verifiedResolved: boolean | null;
};

type Row = {
  pairId: string;
  jobId: string;
  createdAt: number | null;
  userHint: string;
  inputVideoUrl: string | null;
  outputVideoUrl: string | null;
  shotCount: number;
  a: { id: string; index: number; frames: string[] };
  b: { id: string; index: number; frames: string[] };
  sequence: { index: number; frame: string | null }[];
  flagged: Flagged[];
  label: { verdict: string; note?: string } | null;
};

const VERDICTS: Record<string, { label: string; hint: string; tone: string }> = {
  correct: {
    label: "Real error",
    hint: "We flagged it and it genuinely is a mistake",
    tone: "#1a7f37",
  },
  false_positive: {
    label: "Not an error",
    hint: "We flagged it but nothing is wrong — the scene is doing its job",
    tone: "#c0392b",
  },
  missed: {
    label: "We missed one",
    hint: "There is a real mistake here that we did not report",
    tone: "#b7791f",
  },
  clean: {
    label: "Nothing here",
    hint: "We reported nothing and that was right",
    tone: "#555",
  },
};

export default function TrainingPage() {
  const { user, loading: authLoading } = useAuth();
  const [rows, setRows] = useState<Row[]>([]);
  const [stats, setStats] = useState({ total: 0, done: 0 });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [showSeq, setShowSeq] = useState<Record<string, boolean>>({});
  const [onlyOpen, setOnlyOpen] = useState(true);
  // Which frame is open full-size. The frames are the entire input detection
  // gets, and at strip size you cannot actually see what it saw.
  const [zoom, setZoom] = useState<{ src: string; caption: string } | null>(null);

  // Always a FRESH id token: these sit open for a long review session and a
  // cached one expires after an hour, which would look like "not an admin".
  const authHeaders = useCallback(async () => {
    if (!user) throw new Error("Not signed in");
    const token = await user.getIdToken();
    return { authorization: `Bearer ${token}` };
  }, [user]);

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    setError("");
    try {
      const r = await fetch("/api/admin/training?jobs=12", {
        headers: await authHeaders(),
      });
      if (!r.ok) throw new Error((await r.json()).error ?? `HTTP ${r.status}`);
      const d = await r.json();
      setRows(d.rows ?? []);
      setStats({ total: d.total ?? 0, done: d.done ?? 0 });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [user, authHeaders]);

  useEffect(() => {
    if (user) load();
  }, [user, load]);

  async function judge(row: Row, verdict: string) {
    const note = notes[row.pairId] ?? "";
    if (verdict === "missed" && !note.trim()) {
      setError("A 'we missed one' verdict needs a note saying what the error is.");
      return;
    }
    setSaving(row.pairId);
    setError("");
    try {
      const r = await fetch("/api/admin/training", {
        method: "POST",
        headers: { "content-type": "application/json", ...(await authHeaders()) },
        body: JSON.stringify({
          pairId: row.pairId,
          jobId: row.jobId,
          shotAId: row.a.id,
          shotBId: row.b.id,
          errorId: row.flagged[0]?.errorId ?? null,
          errorType: row.flagged[0]?.type ?? null,
          verdict,
          note,
        }),
      });
      if (!r.ok) throw new Error((await r.json()).error ?? `HTTP ${r.status}`);
      setRows((prev) =>
        prev.map((x) =>
          x.pairId === row.pairId ? { ...x, label: { verdict, note } } : x,
        ),
      );
      setStats((s) => ({ ...s, done: s.done + (row.label ? 0 : 1) }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(null);
    }
  }

  async function undo(row: Row) {
    setSaving(row.pairId);
    try {
      await fetch(`/api/admin/training?pairId=${encodeURIComponent(row.pairId)}`, {
        method: "DELETE",
        headers: await authHeaders(),
      });
      setRows((prev) =>
        prev.map((x) => (x.pairId === row.pairId ? { ...x, label: null } : x)),
      );
      setStats((s) => ({ ...s, done: Math.max(0, s.done - 1) }));
    } finally {
      setSaving(null);
    }
  }

  useEffect(() => {
    if (!zoom) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setZoom(null);
    };
    window.addEventListener("keydown", onKey);
    // The page behind a lightbox should not scroll away under it.
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [zoom]);

  const visible = useMemo(
    () => (onlyOpen ? rows.filter((r) => !r.label) : rows),
    [rows, onlyOpen],
  );

  if (authLoading) {
    return (
      <main style={S.page}>
        <p style={S.sub}>Checking your account…</p>
      </main>
    );
  }

  if (!user) {
    return (
      <main style={S.page}>
        <h1 style={S.h1}>Training</h1>
        <p style={S.sub}>
          Sign in with an admin account to review detection results.
        </p>
        <a href="/" style={S.primary}>
          Go to sign in
        </a>
      </main>
    );
  }

  return (
    <main style={S.page}>
      <h1 style={S.h1}>Training</h1>
      <p style={S.sub}>
        Every row is one comparison detection made: <b>Shot A</b> (the reference) against{" "}
        <b>Shot B</b> (under review). These frames are the entire input — no motion, no
        audio. Your verdict becomes calibration the detector is shown on future runs.
      </p>
      <p style={S.sub}>
        The question is not &ldquo;do these differ&rdquo;. Two shots are supposed to
        differ. It is <b>would you call this a mistake</b>.
      </p>

      <div style={S.bar}>
        <span>
          <b>{stats.done}</b> of <b>{stats.total}</b> pairs judged
        </span>
        <span style={S.mut}>{user.email}</span>
        <label style={S.check}>
          <input
            type="checkbox"
            checked={onlyOpen}
            onChange={(e) => setOnlyOpen(e.target.checked)}
          />{" "}
          hide the ones I&rsquo;ve done
        </label>
        <button style={S.ghost} onClick={() => load()} disabled={loading}>
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>

      {error && <p style={S.err}>{error}</p>}
      {!loading && visible.length === 0 && (
        <p style={S.sub}>Nothing left in the queue. Refresh after the next few jobs.</p>
      )}

      {zoom && (
        <div
          style={S.overlay}
          onClick={() => setZoom(null)}
          role="dialog"
          aria-modal="true"
          aria-label={zoom.caption}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={zoom.src} alt={zoom.caption} style={S.zoomImg} />
          <div style={S.caption}>{zoom.caption}</div>
          <button style={S.close} onClick={() => setZoom(null)} aria-label="Close">
            ✕
          </button>
        </div>
      )}

      {visible.map((row) => (
        <section key={row.pairId} style={S.card}>
          <header style={S.head}>
            <div>
              <b>
                shot {row.a.index} → shot {row.b.index}
              </b>{" "}
              <span style={S.mut}>
                of {row.shotCount} · job {row.jobId.slice(0, 12)}
              </span>
            </div>
            <div>
              {row.flagged.length === 0 ? (
                <span style={{ ...S.pill, background: "#eee", color: "#555" }}>
                  we flagged nothing
                </span>
              ) : (
                row.flagged.map((f) => (
                  <span key={f.errorId} style={S.pill}>
                    {f.type}
                    {f.userConfirmed ? " · user paid" : ""}
                  </span>
                ))
              )}
            </div>
          </header>

          <div style={S.frames}>
            <div style={S.col}>
              <div style={S.tag}>SHOT A — reference</div>
              <div style={S.strip}>
                {row.a.frames.map((u, i) => (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    key={u}
                    src={u}
                    alt={`shot ${row.a.index} frame ${i + 1}`}
                    style={S.img}
                    onClick={() =>
                      setZoom({
                        src: u,
                        caption: `SHOT A — shot ${row.a.index}, frame ${i + 1} of ${row.a.frames.length}`,
                      })
                    }
                  />
                ))}
              </div>
            </div>
            <div style={S.col}>
              <div style={S.tag}>SHOT B — under review</div>
              <div style={S.strip}>
                {row.b.frames.map((u, i) => (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    key={u}
                    src={u}
                    alt={`shot ${row.b.index} frame ${i + 1}`}
                    style={S.img}
                    onClick={() =>
                      setZoom({
                        src: u,
                        caption: `SHOT B — shot ${row.b.index}, frame ${i + 1} of ${row.b.frames.length}`,
                      })
                    }
                  />
                ))}
              </div>
            </div>
          </div>

          <button
            style={S.ghost}
            onClick={() =>
              setShowSeq((s) => ({ ...s, [row.pairId]: !s[row.pairId] }))
            }
          >
            {showSeq[row.pairId] ? "Hide" : "Show"} the whole film ({row.shotCount} shots)
          </button>
          {showSeq[row.pairId] && (
            <div style={S.seq}>
              {row.sequence.map((s) =>
                s.frame ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    key={s.index}
                    src={s.frame}
                    alt={`shot ${s.index}`}
                    title={`shot ${s.index} — click to enlarge`}
                    onClick={() =>
                      setZoom({ src: s.frame!, caption: `shot ${s.index} of ${row.shotCount}` })
                    }
                    style={{
                      ...S.thumb,
                      outline:
                        s.index === row.a.index || s.index === row.b.index
                          ? "3px solid #3b82f6"
                          : "none",
                    }}
                  />
                ) : null,
              )}
            </div>
          )}

          {row.flagged.map((f) => (
            <p key={f.errorId} style={S.desc}>
              <b>{f.type}</b> ({f.severity}): {f.description}
            </p>
          ))}
          {row.userHint && (
            <p style={S.hint}>
              <b>Their note:</b> {row.userHint}
            </p>
          )}

          <textarea
            placeholder="Why? One line. This is what the detector gets shown — 'same coat, he is prone in A and kneeling in B' teaches more than 'wrong'."
            value={notes[row.pairId] ?? row.label?.note ?? ""}
            onChange={(e) =>
              setNotes((n) => ({ ...n, [row.pairId]: e.target.value }))
            }
            style={S.textarea}
          />

          {row.label ? (
            <div style={S.done}>
              <span style={{ color: VERDICTS[row.label.verdict]?.tone }}>
                ✓ {VERDICTS[row.label.verdict]?.label ?? row.label.verdict}
              </span>
              <button style={S.ghost} onClick={() => undo(row)} disabled={saving === row.pairId}>
                undo
              </button>
            </div>
          ) : (
            <div style={S.actions}>
              {(row.flagged.length
                ? ["correct", "false_positive", "missed"]
                : ["clean", "missed"]
              ).map((v) => (
                <button
                  key={v}
                  onClick={() => judge(row, v)}
                  disabled={saving === row.pairId}
                  title={VERDICTS[v].hint}
                  style={{ ...S.verdictBtn, borderColor: VERDICTS[v].tone, color: VERDICTS[v].tone }}
                >
                  {VERDICTS[v].label}
                </button>
              ))}
            </div>
          )}
        </section>
      ))}
    </main>
  );
}

const S: Record<string, React.CSSProperties> = {
  page: { maxWidth: 1040, margin: "0 auto", padding: "32px 16px", fontFamily: "system-ui, sans-serif" },
  h1: { fontSize: 26, margin: "0 0 6px" },
  sub: { color: "#666", margin: "0 0 10px", lineHeight: 1.55 },
  bar: { display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap", margin: "18px 0", fontSize: 14 },
  check: { color: "#666", fontSize: 14 },
  err: { background: "#fdecea", color: "#c0392b", padding: "8px 12px", borderRadius: 6, fontSize: 14 },
  card: { border: "1px solid #e3e3e3", borderRadius: 10, padding: 16, marginBottom: 20 },
  head: { display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, marginBottom: 12 },
  pill: { background: "#fff3cd", color: "#7a5b00", borderRadius: 999, padding: "3px 10px", fontSize: 12, marginLeft: 6 },
  mut: { color: "#888", fontWeight: 400, fontSize: 13 },
  frames: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 },
  col: {},
  tag: { fontSize: 11, letterSpacing: ".06em", color: "#888", marginBottom: 4 },
  strip: { display: "flex", gap: 4 },
  img: { width: "100%", minWidth: 0, borderRadius: 6, background: "#000", objectFit: "cover", cursor: "zoom-in" },
  overlay: { position: "fixed", inset: 0, background: "rgba(0,0,0,.92)", zIndex: 1000, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12, padding: 24, cursor: "zoom-out" },
  zoomImg: { maxWidth: "100%", maxHeight: "86vh", objectFit: "contain", borderRadius: 6 },
  caption: { color: "#ddd", fontSize: 13, letterSpacing: ".04em" },
  close: { position: "fixed", top: 16, right: 20, background: "transparent", border: "none", color: "#fff", fontSize: 26, cursor: "pointer", lineHeight: 1 },
  seq: { display: "flex", gap: 4, overflowX: "auto", margin: "10px 0", paddingBottom: 4 },
  thumb: { height: 74, borderRadius: 4, background: "#000", cursor: "zoom-in" },
  desc: { fontSize: 14, margin: "10px 0 0", lineHeight: 1.5 },
  hint: { fontSize: 13, color: "#666", margin: "8px 0 0", fontStyle: "italic" },
  textarea: { width: "100%", minHeight: 54, marginTop: 10, padding: 8, borderRadius: 6, border: "1px solid #ddd", fontFamily: "inherit", fontSize: 13, boxSizing: "border-box" },
  actions: { display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" },
  verdictBtn: { padding: "8px 14px", borderRadius: 7, border: "1.5px solid", background: "#fff", cursor: "pointer", fontSize: 14, fontWeight: 600 },
  done: { display: "flex", gap: 12, alignItems: "center", marginTop: 10, fontWeight: 600 },
  input: { padding: "8px 10px", borderRadius: 6, border: "1px solid #ccc", marginRight: 8 },
  primary: { padding: "8px 16px", borderRadius: 6, border: "none", background: "#111", color: "#fff", cursor: "pointer" },
  ghost: { padding: "6px 12px", borderRadius: 6, border: "1px solid #ddd", background: "#fff", cursor: "pointer", fontSize: 13 },
};
