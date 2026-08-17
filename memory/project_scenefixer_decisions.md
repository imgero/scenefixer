---
name: scene-fixer-architectural-decisions
description: All locked architectural and product decisions for the Scene Fixer (scenefixer.com) build
metadata: 
  node_type: memory
  type: project
  originSessionId: 29c1b3f9-82fe-47a8-a382-52e79f0c1ee4
---

# Scene Fixer — Locked Decisions

**Why:** Hackathon build targeting May 26 launch. Decisions below are final.

## Stack
- Frontend: Next.js 15 (App Router) + React + Tailwind
- Hosting: **Vercel** (deploy with `vercel --prod`). DNS: scenefixer.com
- Database: Firestore (Native mode)
- Storage: Firebase Storage
- Heavy compute: Modal (Python) — do NOT replace
- Vision LLM: Claude Opus 4.7 (vision API) — updated from Sonnet 4.5 on 2026-05-25
- Video gen: Runway Aleph (`gen4_aleph`) via `video_to_video`
- Video processing: FFmpeg + PySceneDetect in Modal
- Payments: **Stripe** (checkout sessions + webhooks)
- Auth: **Firebase Auth — Google Sign-In only**

## Pricing tiers (locked 2026-05-18)
| Tier    | Monthly | Annual | Quality | Fixes/mo | Watermark |
|---------|---------|--------|---------|----------|-----------|
| Free    | $0      | —      | 720p    | 1        | Yes — "Fixed with Scene Fixer" |
| Starter | $9      | $7     | 720p    | 3        | No |
| Pro     | $19     | $15    | 1080p upscaled | 10 | No |
| Studio  | $49     | $39    | 1080p upscaled | 30 | No |

## Credit top-up (added 2026-05-25)
- One-time purchase: $3.50 per fix credit, quantity slider (1–20) on pricing page
- `STRIPE_PRICE_CREDIT` env var needed (one-time price in Stripe dashboard)
- Credits stored in `users/{uid}.creditsBalance`
- Credits used as fallback when monthly quota is exhausted
- Webhook: `checkout.session.completed` with `metadata.type === "credits"` increments creditsBalance

## Beta Tester Flow (added 2026-05-25)
- UUID `sf_beta_id` stored in localStorage; `sf_beta_mode=1` flag
- "Beta tester? Try without signing in →" button in DropZone sign-in gate AND landing page hero
- Beta users send `X-Beta-Token: <uuid>` header (no Firebase auth)
- Pool: Firestore `config/beta` with `{ usedCount, maxCredits: 200 }`
- Per-token tracking: Firestore `betaUses/{token}` — claimed at job creation, fixedAt set after fixing
- Beta jobs: `ownerUid: null`, `betaToken: uuid`, `isPublic: true`
- Firestore rules: jobs with `ownerUid == null` OR `isPublic == true` are readable without auth
- Beta quality: 720p, no watermark

## Job Privacy (added 2026-05-25)
- All jobs created with `isPublic: true` by default
- Firestore rules: `allow read: if ownerUid == null || isPublic == true`
- Signed-in users' jobs are readable if `isPublic: true` (shareable by URL)
- Future: add toggle on job page to set `isPublic: false`

## Detection model situation
- Auto-detection (Claude Opus 4.7 vision) is unreliable for beta — misses errors or pinpoints incorrectly
- **ManualMarker is the primary UX** — "Mark what to fix" is the main CTA on job pages
- Auto-detected errors shown as bonus; users should not rely on them

## Full shot chunking (added 2026-05-18)
- Aleph is capped at 5s per call
- For shots > 5s, `_fix_long_shot_chunked()` in fix.py splits into N×≤5s chunks, processes each, then FFmpeg-concats results

## Freemium gating
- Fix route (`/api/jobs/[id]/fix`) requires Firebase Auth Bearer token OR `X-Beta-Token`
- Usage tracked in `users/{uid}.fixesUsedThisMonth` + `monthResetAt`
- Credits (`creditsBalance`) used as fallback when monthly quota exhausted
- 402 response with `code: "quota_exceeded"` when over limit AND no credits
- Job page shows pre-emptive quota warning without needing to click Fix

## Watermark + quality
- `modal_app/post_process.py` runs after stitch.py
- Free: 480p scale + FFmpeg drawtext watermark "Fixed with Scene Fixer"
- Starter: 720p no watermark
- Pro/Studio: 1080p bicubic upscale, no watermark
- **NOT deployed yet — deploy after hackathon window**

## No-deploy rule (valid until after May 26 judging)
- No deploy of changes that affect deployed Modal functions
- New code (post_process.py, chunking in fix.py) is built locally, deploying later
- Landing page, auth, Stripe, pricing page can be deployed

## Stripe setup
- 6 subscription products configured (Starter/Pro/Studio × monthly/annual)
- `STRIPE_PRICE_CREDIT` needs to be created in Stripe dashboard ($3.50 one-time price)
- Webhook production endpoint: `https://scenefixer.com/api/stripe/webhook`

## Landing page
- Hero: split layout (headline left, dropzone right)
- Announcement banner: Runway API Hackathon winner (link to Reddit post)
- Sections: How it works (4 steps), Demo placeholders, One tool (6 use cases with Phosphor icons), Built by, Footer
- Powered by: Runway Aleph + Claude Opus 4.7 badges
- Company: FredWorth GmbH (Witikonerstrasse 487, 8053 Zurich) + Albusi GmbH
- Favicon: black rounded square with white "/" character

## Header nav order (updated 2026-05-25)
1. Plan badge (amber when quota empty) → 2. Pricing link → 3. Initials circle (dropdown: Help + Sign out)
- No email text — just initials circle
- Credits shown in badge when quota exhausted but credits > 0

## Known Stripe setup needed
- Create `STRIPE_PRICE_CREDIT` in Stripe dashboard as a one-time, per-unit price at $3.50
- Copy price ID to .env.local
