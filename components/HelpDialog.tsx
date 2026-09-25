"use client";

import { ReactNode, useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import posthog from "posthog-js";
import { auth } from "@/lib/firebase";
import { useAuth } from "@/lib/hooks/useAuth";

// One dialog for the whole site, mounted in the root layout and opened by an
// event. It cannot live inside the link that opens it: the Header's "Help"
// item sits in a dropdown that unmounts the moment it is clicked.
const OPEN_EVENT = "scenefixer:open-help";

export function openHelp(source: string) {
  window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: { source } }));
}

/** Drop-in replacement for the old mailto:help@scenefixer.com anchors. */
export function HelpLink({
  source,
  className,
  children,
  onClick,
}: {
  source: string;
  className?: string;
  children: ReactNode;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      className={className}
      onClick={() => {
        onClick?.();
        openHelp(source);
      }}
    >
      {children}
    </button>
  );
}

export default function HelpDialog() {
  const { user } = useAuth();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [email, setEmail] = useState("");
  const [website, setWebsite] = useState(""); // honeypot
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const jobId = pathname?.match(/^\/job\/([^/]+)/)?.[1] ?? null;

  useEffect(() => {
    const onOpen = (e: Event) => {
      const detail = (e as CustomEvent<{ source?: string }>).detail;
      setSource(detail?.source ?? null);
      setSent(false);
      setError(null);
      setOpen(true);
      posthog.capture("support_dialog_opened", { source: detail?.source, job_id: jobId });
    };
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_EVENT, onOpen);
  }, [jobId]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (!open) return null;

  const send = async () => {
    setSending(true);
    setError(null);
    try {
      const token = await auth.currentUser?.getIdToken().catch(() => undefined);
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (token) headers["Authorization"] = `Bearer ${token}`;
      const res = await fetch("/api/support", {
        method: "POST",
        headers,
        body: JSON.stringify({
          message,
          email: user?.email ? undefined : email,
          jobId,
          page: pathname,
          source,
          website,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Couldn't send that — please try again.");
      setSent(true);
      setMessage("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };

  const canSend =
    message.trim().length > 0 && (!!user?.email || email.trim().length > 0) && !sending;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4"
      onClick={() => setOpen(false)}
    >
      <div
        className="bg-white rounded-2xl shadow-2xl w-full max-w-md max-h-[90vh] overflow-auto"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="help-dialog-title"
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200">
          <h2 id="help-dialog-title" className="text-base font-semibold text-black">
            {sent ? "Message sent" : "Get help"}
          </h2>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="text-gray-500 hover:text-black text-sm"
          >
            Close ✕
          </button>
        </div>

        {sent ? (
          <div className="px-5 py-5">
            <p className="text-sm text-gray-700">
              Thanks — we got it and will reply to{" "}
              <span className="font-medium text-black">{user?.email || email}</span>.
            </p>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="mt-4 px-4 py-1.5 rounded-lg bg-black hover:bg-gray-800 text-white text-sm font-medium"
            >
              Done
            </button>
          </div>
        ) : (
          <div className="px-5 py-4 space-y-3">
            <p className="text-xs text-gray-500">
              Tell us what went wrong or what you need.
              {jobId && " We'll attach this video so you don't have to explain which one."}
            </p>
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value.slice(0, 4000))}
              rows={5}
              autoFocus
              placeholder="What happened?"
              className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-black placeholder:text-gray-400 outline-none focus:border-black resize-y"
            />
            {user?.email ? (
              <p className="text-xs text-gray-500">
                We&apos;ll reply to <span className="text-gray-900">{user.email}</span>.
              </p>
            ) : (
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="Your email, so we can reply"
                className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-black placeholder:text-gray-400 outline-none focus:border-black"
              />
            )}
            {/* Honeypot — hidden from people, filled by bots. */}
            <input
              type="text"
              tabIndex={-1}
              autoComplete="off"
              aria-hidden="true"
              value={website}
              onChange={(e) => setWebsite(e.target.value)}
              className="hidden"
            />
            {error && <p className="text-xs text-red-600">{error}</p>}
            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="px-4 py-1.5 rounded-lg text-gray-700 hover:text-black text-sm"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={send}
                disabled={!canSend}
                className="px-4 py-1.5 rounded-lg bg-black hover:bg-gray-800 text-white text-sm font-medium disabled:opacity-40"
              >
                {sending ? "Sending…" : "Send"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
