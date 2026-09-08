import { PostHog } from "posthog-node";

let posthogClient: PostHog | null = null;

export function getPostHogClient(): PostHog {
  if (!posthogClient) {
    posthogClient = new PostHog(process.env.NEXT_PUBLIC_POSTHOG_KEY!, {
      host: process.env.NEXT_PUBLIC_POSTHOG_HOST,
      flushAt: 1,
      flushInterval: 0,
    });
  }
  return posthogClient;
}

type CaptureArgs = Parameters<PostHog["capture"]>[0];

/**
 * Capture AND flush before resolving.
 *
 * `capture()` alone only queues the event; the HTTP POST that actually ships it
 * is not awaited. On serverless the instance is frozen the moment the route
 * returns its response, so a queued-but-unsent event is simply lost. That is
 * why server-side events emitted from route handlers arrive intermittently
 * while the Modal-emitted analysis events — long-running container, never
 * frozen — arrive reliably.
 *
 * Every server-side capture in a route handler must go through this and be
 * awaited before the response is returned. Never `capture()` directly here.
 *
 * A telemetry failure must never fail the request, so flush errors are
 * swallowed after logging.
 */
export async function captureServer(payload: CaptureArgs): Promise<void> {
  try {
    const client = getPostHogClient();
    // Stamp the event at the moment it happened. Without an explicit timestamp
    // PostHog dates the event when its ingestion pipeline receives it, and that
    // lag is variable — 0.2s to 5s in production. Two events captured seconds
    // apart could land milliseconds apart, and one captured first could land
    // second. Every "this event double-fired" and "these two fired 21ms apart"
    // reading of the server-side stream was that lag, not the application.
    client.capture({ timestamp: new Date(), ...payload });
    await client.flush();
  } catch (err) {
    console.error(
      `PostHog captureServer failed for "${payload.event}":`,
      err instanceof Error ? err.message : err
    );
  }
}
