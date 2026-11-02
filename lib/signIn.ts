"use client";

import { FirebaseError } from "firebase/app";
import { getAdditionalUserInfo, GoogleAuthProvider, signInWithPopup, type User } from "firebase/auth";
import posthog from "posthog-js";
import { auth } from "@/lib/firebase";
import { registerLoopsContact } from "@/lib/loops";

export type SignInResult =
  | { ok: true; user: User }
  // message is null when there is nothing to tell the user (they closed the
  // window themselves, or a second tap replaced the first popup).
  | { ok: false; code: string; message: string | null };

const SILENT = new Set(["auth/popup-closed-by-user", "auth/cancelled-popup-request"]);

function messageFor(code: string): string {
  switch (code) {
    case "auth/popup-blocked":
      return "Your browser blocked the Google sign-in window. Allow pop-ups for this site and try again.";
    case "auth/network-request-failed":
      return "Couldn't reach Google. Check your connection and try again.";
    default:
      // What iPhone Safari users hit: the window opens and closes, or nothing
      // happens. Switching to Chrome is what one of them did on 2 Nov.
      return "Sign-in didn't finish. Please try again — if it keeps failing on an iPhone, open scenefixer.com in Chrome.";
  }
}

/**
 * Google sign-in for every button on the site.
 *
 * Each button used to call signInWithPopup itself and swallow the error into
 * console.error, so a failed sign-in looked like nothing happened, to the user
 * and to us: on 2 Nov an iPhone Safari user tapped "Sign in" three times and
 * left no trace beyond the taps. Every failure is now reported with its code.
 */
export async function signInWithGoogle(source: string): Promise<SignInResult> {
  try {
    const result = await signInWithPopup(auth, new GoogleAuthProvider());
    const u = result.user;
    posthog.identify(u.uid, { email: u.email ?? undefined });
    if (getAdditionalUserInfo(result)?.isNewUser && u.email) {
      registerLoopsContact(u.email, u.uid);
    }
    return { ok: true, user: u };
  } catch (err) {
    const code = err instanceof FirebaseError ? err.code : "unknown";
    posthog.capture("sign_in_failed", {
      source,
      code,
      message: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
    });
    return { ok: false, code, message: SILENT.has(code) ? null : messageFor(code) };
  }
}
