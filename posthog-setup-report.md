<wizard-report>
# PostHog post-wizard report

The wizard has completed a deep integration of PostHog analytics into Scene Fixer — a Next.js 15 App Router application. Here is a summary of all changes made:

- **`instrumentation-client.ts`** (new) — Initializes `posthog-js` on the client using the Next.js 15.3+ instrumentation hook. Configured with EU host reverse proxy (`/ingest`), exception capture enabled, and debug mode in development.
- **`lib/posthog-server.ts`** (new) — Singleton `posthog-node` client for server-side event capture across API routes. Uses `flushAt: 1` / `flushInterval: 0` to ensure events are flushed synchronously before responses return.
- **`next.config.ts`** — Added `/ingest` reverse proxy rewrites pointing to EU PostHog endpoints (`eu-assets.i.posthog.com`, `eu.i.posthog.com`) and set `skipTrailingSlashRedirect: true`.
- **`.env.local`** — Added `NEXT_PUBLIC_POSTHOG_KEY` and `NEXT_PUBLIC_POSTHOG_HOST` environment variables.
- **`components/DropZone.tsx`** — Captures `sign_in_clicked` when the Google sign-in button is clicked; calls `posthog.identify()` with Firebase UID and email after successful sign-in; captures `video_uploaded` with file size, type, and hint presence after a job is fully submitted.
- **`components/ErrorCard.tsx`** — Captures `error_confirmed` (with error type, severity, and fix mode) when a user selects Remove or Replace on a continuity error.
- **`app/job/[id]/page.tsx`** — Captures `fix_requested` (with confirmed error count) when the Fix button is clicked; also fixed a pre-existing TypeScript bug (`!loading` → removed undefined reference).
- **`app/pricing/page.tsx`** — Captures `checkout_success` once on mount when `?success=1` is present; calls `posthog.identify()` after Google sign-in on the pricing page; captures `plan_selected` (with plan name and billing interval) just before redirecting to Stripe checkout.
- **`app/api/jobs/route.ts`** — Server-side `job_created` event after Firestore job document is written.
- **`app/api/jobs/[id]/start/route.ts`** — Server-side `job_analysis_started` event after the Modal pipeline is triggered.
- **`app/api/jobs/[id]/fix/route.ts`** — Server-side `fix_quota_exceeded` event (with plan and usage) when the monthly limit is hit; `fix_started` event (with plan and usage) when the fix phase launches.
- **`app/api/stripe/webhook/route.ts`** — Server-side `subscription_activated` event (with plan and Stripe amount) on `checkout.session.completed`; `subscription_cancelled` event on `customer.subscription.deleted`.

## Events

| Event | Description | File |
|---|---|---|
| `sign_in_clicked` | User clicks "Sign in with Google" in the DropZone | `components/DropZone.tsx` |
| `video_uploaded` | Video successfully uploaded and analysis pipeline started | `components/DropZone.tsx` |
| `error_confirmed` | User confirms a continuity error (Remove or Replace) | `components/ErrorCard.tsx` |
| `fix_requested` | User clicks "Fix N errors" to start the AI fix phase | `app/job/[id]/page.tsx` |
| `plan_selected` | User clicks a paid plan CTA and is redirected to Stripe | `app/pricing/page.tsx` |
| `checkout_success` | User returns to pricing page after completing Stripe checkout | `app/pricing/page.tsx` |
| `job_created` | Server: job created in Firestore, upload URL issued | `app/api/jobs/route.ts` |
| `job_analysis_started` | Server: video URL saved and Modal analysis pipeline triggered | `app/api/jobs/[id]/start/route.ts` |
| `fix_quota_exceeded` | Server: user hit their monthly fix limit | `app/api/jobs/[id]/fix/route.ts` |
| `fix_started` | Server: fix phase launched after quota check passed | `app/api/jobs/[id]/fix/route.ts` |
| `subscription_activated` | Server: Stripe checkout completed, plan upgraded in Firestore | `app/api/stripe/webhook/route.ts` |
| `subscription_cancelled` | Server: Stripe subscription deleted, plan reset to free | `app/api/stripe/webhook/route.ts` |

## Next steps

We've built a dashboard and five insights to keep an eye on user behavior:

- [Analytics basics dashboard](/dashboard/697384)
- [Video Uploads per Day](/insights/LZPhophD) — daily upload volume trend
- [New Subscriptions](/insights/wraignIy) — daily subscription activations
- [Fix Quota Exceeded (Churn Signal)](/insights/9pxteCM6) — unique users hitting their monthly limit
- [Upload to Fix Conversion Funnel](/insights/9MVkRdk5) — drop-off from upload → error confirmed → fix requested
- [Plan Selection to Subscription Funnel](/insights/HNQQ7EcF) — checkout completion rate

### Agent skill

We've left an agent skill folder in your project at `.claude/skills/integration-nextjs-app-router/`. You can use this context for further agent development when using Claude Code. This will help ensure the model provides the most up-to-date approaches for integrating PostHog.

</wizard-report>
