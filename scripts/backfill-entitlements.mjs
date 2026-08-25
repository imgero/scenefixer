/**
 * One-off backfill: give every existing user document the full entitlement shape.
 *
 * Accounts created by /api/jobs/[id]/start were written with a merge of only
 * { scanDate, scansToday }, so they have no plan, no monthResetAt and no credit
 * fields. The fix route read `plan ?? "free"`, which made a broken paid account
 * indistinguishable from a genuine free one.
 *
 * Only ADDS missing fields. Never overwrites a value that is already set — in
 * particular an existing `plan` written by the Stripe webhook is left alone, and
 * a later webhook delivery can still correct any account this marks "free".
 *
 *   node scripts/backfill-entitlements.mjs --dry-run
 *   node scripts/backfill-entitlements.mjs --apply
 */
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";
import fs from "fs";

const APPLY = process.argv.includes("--apply");
if (!APPLY && !process.argv.includes("--dry-run")) {
  console.error("Pass --dry-run or --apply");
  process.exit(1);
}

const env = Object.fromEntries(
  fs.readFileSync(".env.local", "utf8").split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; })
);
initializeApp({ credential: cert({
  projectId: env.FIREBASE_ADMIN_PROJECT_ID,
  clientEmail: env.FIREBASE_ADMIN_CLIENT_EMAIL,
  privateKey: env.FIREBASE_ADMIN_PRIVATE_KEY.replace(/\\n/g, "\n"),
})});
const db = getFirestore();
const auth = getAuth();

const startOfMonth = () => { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), 1).getTime(); };

async function deliverable(email) {
  const domain = email?.split("@")[1]?.trim().toLowerCase();
  if (!domain) return false;
  const dns = await import("node:dns/promises");
  try { const mx = await dns.resolveMx(domain); if (mx.length) return true; }
  catch (e) { if (e.code !== "ENOTFOUND" && e.code !== "ENODATA") return true; }
  try { const a = await dns.resolve4(domain); return a.length > 0; }
  catch (e) { return !(e.code === "ENOTFOUND" || e.code === "ENODATA"); }
}

const snap = await db.collection("users").get();
let changed = 0, untouched = 0;
const undeliverable = [];

for (const doc of snap.docs) {
  const uid = doc.id;
  const d = doc.data();
  const rec = await auth.getUser(uid).catch(() => null);
  const email = d.email ?? rec?.email ?? null;

  const defaults = {
    uid,
    email,
    plan: "free",
    creditsUsedThisMonth: 0,
    creditsBalance: 0,
    monthResetAt: startOfMonth(),
  };

  const patch = {};
  for (const [k, v] of Object.entries(defaults)) if (d[k] === undefined) patch[k] = v;
  if (d.emailVerified === undefined && rec) patch.emailVerified = rec.emailVerified;
  if (d.emailDeliverable === undefined && email) {
    patch.emailDeliverable = await deliverable(email);
    patch.emailCheckedAt = Date.now();
    if (patch.emailDeliverable === false) undeliverable.push(`${uid}  ${email}`);
  }

  if (Object.keys(patch).length === 0) { untouched++; continue; }
  changed++;
  console.log(`${APPLY ? "PATCH" : "would patch"} ${uid} (${email ?? "no email"}): ${Object.keys(patch).join(", ")}`);
  if (APPLY) await doc.ref.set(patch, { merge: true });
}

console.log(`\n${APPLY ? "patched" : "would patch"}: ${changed}   already complete: ${untouched}   total: ${snap.size}`);
if (undeliverable.length) {
  console.log(`\nUNDELIVERABLE EMAIL DOMAINS (${undeliverable.length}) — these accounts get 0 credits:`);
  undeliverable.forEach((u) => console.log("  " + u));
}
