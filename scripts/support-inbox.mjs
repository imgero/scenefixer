/**
 * List help requests sent through the site's "Get help" dialog.
 *
 * Firestore `support_requests` is the record; the owner email from
 * lib/notify.ts is only a courtesy and no-ops while
 * LOOPS_OWNER_TRANSACTIONAL_ID is unset. This is the way to see requests
 * regardless.
 *
 *   node scripts/support-inbox.mjs             # open requests, newest first
 *   node scripts/support-inbox.mjs --all       # include closed ones
 *   node scripts/support-inbox.mjs --close ID  # mark one as answered
 */
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import fs from "fs";

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
const col = getFirestore().collection("support_requests");

const closeIdx = process.argv.indexOf("--close");
if (closeIdx !== -1) {
  const id = process.argv[closeIdx + 1];
  if (!id) { console.error("--close needs an id"); process.exit(1); }
  await col.doc(id).update({ status: "closed", closedAt: Date.now() });
  console.log(`closed ${id}`);
  process.exit(0);
}

const all = process.argv.includes("--all");
// Sorted in memory rather than with orderBy + where, which would need a
// composite index for a collection that holds a handful of documents.
const snap = await col.get();
const rows = snap.docs
  .map((d) => ({ id: d.id, ...d.data() }))
  .filter((r) => all || r.status !== "closed")
  .sort((a, b) => (b.createdAt?.toMillis?.() ?? 0) - (a.createdAt?.toMillis?.() ?? 0));

if (rows.length === 0) console.log(all ? "No help requests." : "No open help requests.");
for (const r of rows) {
  const when = r.createdAt?.toDate?.().toISOString().replace("T", " ").slice(0, 16) ?? "?";
  console.log(`\n── ${r.id}  ${when} UTC  [${r.status}]`);
  console.log(`   from: ${r.replyTo}${r.uid ? `  (uid ${r.uid})` : "  (signed out)"}`);
  if (r.jobId) console.log(`   job:  https://scenefixer.com/job/${r.jobId}`);
  if (r.language) console.log(`   lang: ${r.language}`);
  console.log(`   ${String(r.message).replace(/\n/g, "\n   ")}`);
}
