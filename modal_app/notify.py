"""
Owner email for pipeline outcomes, sent through Loops.

Until now the only notification the owner received was "a job was created",
sent from app/api/jobs/route.ts — and it never actually arrived, because that
path calls Resend and RESEND_API_KEY is set in no environment, so notifyOwner
has returned at its own guard clause since the day it was written.

Everything that actually matters — the analysis finishing, a video being
longer than the free budget, a fix run landing or failing, and above all WHY
it failed — is decided inside Modal, which had no email path at all. So the
owner learned that people were being turned away at a 30-second limit two days
after it happened, by reading a PostHog export by hand.

Loops rather than Resend because LOOPS_API_KEY already exists, is already
wired for contact creation, and is already sending. One less account, one less
domain to verify, one less key to rotate.

Everything here is best-effort, on the same rule as analytics.py: a
notification must never be able to fail a job. A missing key or template id
means this module no-ops silently rather than guessing.

To enable:
  1. In Loops, create a transactional email, publish it, and give it two data
     variables: `subject_line` and `body_text`. Put {{subject_line}} in the
     subject field and {{body_text}} in the body.
  2. modal secret create loops-api-key LOOPS_API_KEY=... LOOPS_OWNER_TRANSACTIONAL_ID=...
  3. Add `modal.Secret.from_name("loops-api-key"),` to ANALYSIS_SECRETS and
     FIX_SECRETS in app.py, then redeploy.
"""

from __future__ import annotations

import os
from typing import Any

OWNER_EMAIL = "business@alanany.com"

_LOOPS_URL = "https://app.loops.so/api/v1/transactional"


def _send(subject: str, text: str) -> None:
    """Post one transactional email to Loops. Swallows everything."""
    api_key = os.environ.get("LOOPS_API_KEY")
    transactional_id = os.environ.get("LOOPS_OWNER_TRANSACTIONAL_ID")
    if not api_key or not transactional_id:
        return
    try:
        import requests

        resp = requests.post(
            _LOOPS_URL,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json={
                "email": OWNER_EMAIL,
                "transactionalId": transactional_id,
                # The owner address is already a Loops contact; this keeps a
                # first send working if it ever is not.
                "addToAudience": False,
                "dataVariables": {
                    "subject_line": subject,
                    "body_text": text,
                },
            },
            timeout=10,
        )
        if resp.status_code >= 300:
            print(f"notify: loops returned {resp.status_code}: {resp.text[:200]}")
    except Exception as exc:
        print(f"notify: send failed ({type(exc).__name__}: {exc})")


def _owner_email(job: dict[str, Any] | None) -> str:
    """
    Resolve the job owner to an email address.

    Jobs carry only `ownerUid`. A uid in a notification is unusable — the whole
    point is knowing which person hit the problem, so the address is worth one
    Firestore read. Best-effort: falls back to the uid, then to "anonymous
    (beta)" for jobs started from a beta token, which have no owner at all.
    """
    uid = (job or {}).get("ownerUid")
    if not uid:
        return "anonymous (beta link)"
    try:
        from modal_app.firebase import get_db

        user = get_db().collection("users").document(uid).get().to_dict() or {}
        return user.get("email") or uid
    except Exception:
        return uid


def _job_line(job_id: str, job: dict[str, Any] | None) -> str:
    """Identify the job and, where known, whose it is."""
    url = f"https://scenefixer.com/job/{job_id}"
    return f"Job:   {job_id}\nOwner: {_owner_email(job)}\nLink:  {url}"


def analysis_finished(
    job_id: str,
    *,
    job: dict[str, Any] | None = None,
    shot_count: int,
    error_count: int,
    score: int,
    truncated: bool = False,
    analysed_s: float | None = None,
    total_s: float | None = None,
) -> None:
    """An analysis completed and the user is now looking at findings."""
    head = "partially analysed" if truncated else "analysed"
    subject = f"[Scene Fixer] Analysis {head} — {error_count} error(s), score {score}"

    body = [
        _job_line(job_id, job),
        "",
        f"Shots analysed: {shot_count}",
        f"Errors found:   {error_count}",
        f"Score before:   {score}/100",
    ]
    if truncated and analysed_s and total_s:
        body += [
            "",
            f"TRUNCATED: scanned {analysed_s:.0f}s of {total_s:.0f}s "
            f"({total_s - analysed_s:.0f}s not analysed).",
            "The user was shown the boundary and offered the rest.",
        ]
    if error_count == 0:
        body += ["", "No errors found — there is nothing for this user to fix."]
    _send(subject, "\n".join(body))


def analysis_failed(
    job_id: str,
    *,
    job: dict[str, Any] | None = None,
    reason: str,
    detail: str = "",
) -> None:
    """An analysis ended without producing findings."""
    subject = f"[Scene Fixer] Analysis FAILED — {reason}"
    body = [_job_line(job_id, job), "", f"Reason: {reason}"]
    if detail:
        body += ["", detail]
    _send(subject, "\n".join(body))


def fix_finished(
    job_id: str,
    *,
    job: dict[str, Any] | None = None,
    attempted: int,
    verified: int,
    unverified: int,
    failed: int,
    credits_refunded: int = 0,
    reasons: list[str] | None = None,
) -> None:
    """
    A fix run reached a terminal state.

    The counts are the whole story and are deliberately all in the subject:
    "attempted 2, verified 0" is the failure mode that has dominated this
    product since launch, and it is invisible in a job that reports itself
    as `done`.
    """
    if attempted and verified == attempted:
        head = "ALL VERIFIED"
    elif verified:
        head = f"PARTIAL {verified}/{attempted}"
    else:
        head = f"NOTHING VERIFIED 0/{attempted}"

    subject = f"[Scene Fixer] Fix run {head}"
    body = [
        _job_line(job_id, job),
        "",
        f"Attempted:  {attempted}",
        f"Verified:   {verified}   (the error is actually gone)",
        f"Unverified: {unverified}   (ran, but the error is still visible)",
        f"Failed:     {failed}   (threw before producing anything)",
    ]
    if credits_refunded:
        body += ["", f"Credits refunded to the user: {credits_refunded}"]
    if reasons:
        body += ["", "Reasons:"] + [f"  - {r}" for r in reasons]
    if attempted and not verified:
        body += [
            "",
            "This user has been refunded and has no fixed video. If this keeps "
            "happening, the fix stage — not detection — is what to look at.",
        ]
    _send(subject, "\n".join(body))
