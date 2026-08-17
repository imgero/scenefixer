# Session — May 18 2026

## Sprint Aim
Finish Scene Fixer for May 26 launch: Google + Apple SSO, Stripe paywall, freemium logic, watermark on free output, quality tiers (480p/720p/1080p), end-to-end test with a real upload.

---

## What Was Done

### Auth — Google SSO ✅
- Firebase Auth with Google Sign-In (popup flow)
- `useAuth` hook, `ensureUserDoc` patches incomplete Firestore docs on first sign-in
- Header shows plan badge + fix counter (live Firestore sync)
- Apple SSO skipped — no Apple Developer account

### Job Ownership & Security ✅ (deploy pending for Firestore rules)
- `POST /api/jobs` now requires Bearer token, writes `ownerUid` to every job doc
- `POST /api/jobs/[id]/start` and `/manual-error` both auth-gated and verify caller owns the job
- `ManualMarker` component now passes Bearer token (was returning 401)
- Firestore rules updated: jobs + all subcollections (shots, errors, verify_errors) readable only by owner via `ownerUid` match; subcollections use `get()` to check parent
- DropZone shows Google sign-in gate for signed-out users instead of drop zone
- Job page shows lock screen if Firestore denies access
- **Needs:** `firebase deploy --only firestore:rules`

### Stripe Paywall ✅
- Plans: Free ($0), Starter ($9/$7 annual), Pro ($19/$15), Studio ($49/$39)
- Stripe Checkout sessions with live keys, customer reuse, metadata `uid` + `plan`
- Webhook handles `checkout.session.completed`, `subscription.updated`, `subscription.deleted`
- Usage gating in `/api/jobs/[id]/fix`: checks `fixesUsedThisMonth` vs plan limit, resets monthly, returns `{code:"quota_exceeded"}` with upgrade prompt in UI
- Pricing page: annual toggle, 4 plan cards, upgrade CTA from job page fix errors on quota hit
- Admin route `POST /api/admin/set-fixes` (x-admin-secret header) to manually set plan/usage

### Quality Tiers — Code Complete, Not Deployed ⚠️
- On fix trigger: `outputQuality` (480p/720p/1080p) and `watermark: boolean` written to job doc
- `post_process.py`: FFmpeg bicubic scale + `drawtext` watermark (bottom-right, white 70% opacity)
  - Free → 480p + watermark
  - Starter → 720p, no watermark
  - Pro/Studio → 1080p upscaled, no watermark
- `fix_phase` in `app.py` now calls `run_post_process(job_id)` after stitch + verify
- Font fix: `fonts-liberation` added to Modal image so `drawtext` works on `debian_slim`
- Download banner on job page shows quality badge (480p/720p/1080p) and upgrade nudge
- **Needs:** `modal deploy modal_app/app.py` — scheduled for tomorrow to avoid disrupting live beta

### Download / Export UX ✅
- Job page: green "Your fixed video is ready" banner with quality badge + "Download Xp ↓" button
  - Free: amber banner, `480p` badge, `watermark` pill, "Upgrade to Starter" inline link
  - Starter: `720p` badge, "Upgrade to Pro for 1080p" inline link
  - Pro/Studio: clean green, black `1080p` badge, no upsell
- ErrorCard: "Download ↓" link next to "After (Aleph)" label on each fixed shot

### Job type ✅
- Added `outputQuality?: string` and `watermark?: boolean` to `Job` type in `lib/types.ts`
- Pricing page corrected: Free now shows 480p (was incorrectly showing 720p)

---

## End-to-End Test Result
- Uploaded a Game of Thrones scene, manually marked a continuity error (modern cup), fix ran successfully
- Download banner correctly showed 480p + watermark badge for free account
- Actual output file was 720p, no watermark — confirmed because `post_process.py` not yet deployed
- Full pipeline (fix → stitch → quality scale → watermark) will work after tomorrow's Modal deploy

---

## Pending for Tomorrow / Before Launch

| Task | Command / Action |
|------|-----------------|
| Deploy quality scaling + watermark | `modal deploy modal_app/app.py` |
| Deploy Firestore ownership rules | `firebase deploy --only firestore:rules` |
| Configure Stripe webhook production endpoint | Stripe Dashboard → Webhooks → add `https://scenefixer.com/api/stripe/webhook` |
| Verify a full end-to-end fix on free account (480p + watermark) | Manual test |
| Verify Pro account gets 1080p, no watermark | Manual test |
| Add Geist font + /sf favicon + logo image to header | UI polish |

---

## Sprint Status vs Aim

| Goal | Status |
|------|--------|
| Google SSO | ✅ Done |
| Apple SSO | ⛔ Skipped (no Apple Developer account) |
| Stripe paywall | ✅ Done (live keys, all 6 price IDs) |
| Freemium logic (1 fix/mo free) | ✅ Done |
| Watermark on free output | ✅ Code done — needs Modal deploy |
| Quality tiers (480p free / 720p+ paid / 1080p pro) | ✅ Code done — needs Modal deploy |
| Job ownership / privacy | ✅ Code done — needs Firestore rules deploy |
| End-to-end test | ⚠️ Partial — fix pipeline works, quality + watermark pending deploy |
