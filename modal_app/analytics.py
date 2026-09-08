"""
Server-side PostHog events for the analysis pipeline.

The analysis outcome is decided inside Modal, not in Next.js, so completion
and failure events have to be emitted from here. Everything in this module is
best-effort: telemetry must never be able to fail a job.
"""

import os
import time
from datetime import datetime, timezone
from typing import Any

# job_id -> monotonic start. The timer is started once per process_job
# invocation so duration_ms spans decompose + detect together, which is what
# the user actually waits through.
_STARTED: dict[str, float] = {}

_client = None
_client_init_failed = False


def start_timer(job_id: str) -> None:
    _STARTED[job_id] = time.monotonic()


def elapsed_ms(job_id: str) -> int | None:
    started = _STARTED.get(job_id)
    if started is None:
        return None
    return int((time.monotonic() - started) * 1000)


def _get_client():
    global _client, _client_init_failed
    if _client is not None or _client_init_failed:
        return _client
    try:
        # Both come from the Modal secret. No hardcoded fallback for either:
        # if the secret is absent or incomplete this module no-ops silently
        # rather than guessing an endpoint.
        key = os.environ.get("POSTHOG_API_KEY")
        host = os.environ.get("POSTHOG_HOST")
        if not key or not host:
            _client_init_failed = True
            return None
        from posthog import Posthog

        _client = Posthog(
            project_api_key=key,
            host=host,
            # Modal containers are short-lived and scale to zero; a background
            # flush thread would lose events on shutdown.
            sync_mode=True,
        )
    except Exception as exc:
        print(f"analytics: client init failed: {exc}")
        _client_init_failed = True
    return _client


def _distinct_id(job: dict) -> str:
    """Match the convention in app/api/jobs/[id]/start/route.ts."""
    owner = job.get("ownerUid")
    if owner:
        return str(owner)
    token = job.get("betaToken") or ""
    return f"beta_{token[:8]}" if token else "anonymous"


def capture(
    job_id: str,
    event: str,
    properties: dict[str, Any] | None = None,
    job: dict | None = None,
) -> None:
    """Emit one event. Swallows every error — telemetry never breaks a job."""
    try:
        client = _get_client()
        if client is None:
            return

        if job is None:
            from modal_app.firebase import get_db

            job = get_db().collection("jobs").document(job_id).get().to_dict() or {}

        props: dict[str, Any] = {
            "job_id": job_id,
            "is_beta": not job.get("ownerUid"),
        }
        duration_ms = elapsed_ms(job_id)
        if duration_ms is not None:
            props["duration_ms"] = duration_ms
        props.update(properties or {})

        client.capture(
            distinct_id=_distinct_id(job),
            event=event,
            properties=props,
            # Without an explicit timestamp PostHog dates the event when its
            # ingestion pipeline receives it. That lag is variable, so events
            # captured seconds apart can land milliseconds apart and out of
            # order — which is what made unrelated server-side events read as
            # double-fires. Stamp at capture time instead.
            timestamp=datetime.now(timezone.utc),
        )
        client.flush()
    except Exception as exc:
        print(f"analytics: {event} capture failed: {exc}")
