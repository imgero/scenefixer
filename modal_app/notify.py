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
_LOOPS_EVENT_URL = "https://app.loops.so/api/v1/events/send"


def _send(subject: str, text: str) -> None:
    """Email the owner. Swallows everything."""
    _send_to(OWNER_EMAIL, os.environ.get("LOOPS_OWNER_TRANSACTIONAL_ID"), subject, text)


def _send_to(email: str, transactional_id: str | None, subject: str, text: str) -> None:
    """Post one transactional email to Loops. Swallows everything."""
    api_key = os.environ.get("LOOPS_API_KEY")
    if not api_key or not transactional_id or not email:
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
                "email": email,
                "transactionalId": transactional_id,
                # Never subscribes anyone: a transactional send is not consent
                # to marketing.
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
    try:
        user_fix_finished(job_id, job=job, attempted=attempted, verified=verified, credits_refunded=credits_refunded)
    except Exception as exc:
        print(f"user_fix_finished failed: {exc}")


# ── Emails to the person who uploaded ────────────────────────────────────────
#
# Until 2 Nov nobody who uploaded heard from us: a scan takes one to seven
# minutes, people leave the tab, and the 1 Nov user whose 35-shot scan took 42
# minutes never saw her 15 findings. These need their own Loops template: a
# transactional email with `subject_line` and `body_text` data variables,
# published, its id in LOOPS_USER_TRANSACTIONAL_ID on the loops-api-key secret.
# Until that is set they no-op.

def _uploader_email(job: dict[str, Any] | None) -> str | None:
    uid = (job or {}).get("ownerUid")
    if not uid:
        return None
    try:
        from modal_app.firebase import get_db

        user = get_db().collection("users").document(uid).get().to_dict() or {}
        return user.get("email")
    except Exception:
        return None


def user_scan_finished(
    job_id: str,
    *,
    job: dict[str, Any] | None,
    error_count: int,
    shot_count: int,
    single_shot: bool = False,
) -> None:
    """Tell the uploader their scan is ready, and tell Loops it happened."""
    url = f"https://scenefixer.com/job/{job_id}"
    if single_shot:
        subject = "Your video is one shot, so there was nothing to compare"
        lines = [
            "Scene Fixer checks that things match between shots: wardrobe, props, lighting, "
            "the room. Your video is one continuous shot, so there was no second shot to "
            "compare it with.",
            "",
            "This scan didn't count toward your daily free scan. Upload the full sequence "
            "(two or more shots cut together) and we'll check every cut.",
            "",
            f"Your result: {url}",
        ]
    elif error_count:
        subject = f"Your scan is ready — {error_count} continuity error{'s' if error_count != 1 else ''} found"
        lines = [
            f"We checked {shot_count} shot{'s' if shot_count != 1 else ''} in your video and found "
            f"{error_count} thing{'s' if error_count != 1 else ''} that don't match between shots.",
            "",
            f"See them here: {url}",
            "",
            "Your first fix is free: pick an error and press Fix.",
        ]
    else:
        subject = "Your scan is ready"
        lines = [
            f"We checked {shot_count} shot{'s' if shot_count != 1 else ''} in your video and found no "
            "continuity errors.",
            "",
            f"See the result: {url}",
        ]
    email = _uploader_email(job)
    _send_to(email, os.environ.get("LOOPS_USER_TRANSACTIONAL_ID"), subject, "\n".join(lines))
    event(
        job,
        "scan_finished",
        {"errorCount": error_count, "shotCount": shot_count, "singleShot": single_shot, "jobUrl": url},
        {"lastJobUrl": url, "lastScanErrors": error_count},
        email=email,
    )


def user_fix_finished(job_id: str, *, job: dict[str, Any] | None, attempted: int, verified: int, credits_refunded: int) -> None:
    """Tell the uploader how their fix run went, and tell Loops it happened."""
    url = f"https://scenefixer.com/job/{job_id}"
    if verified:
        subject = f"Your fixed clip is ready ({verified} of {attempted} fixed)"
        lines = [f"{verified} of the {attempted} error{'s' if attempted != 1 else ''} you picked {'is' if verified == 1 else 'are'} fixed.", "", f"Watch and download it: {url}"]
        if credits_refunded:
            lines += ["", f"The rest didn't work, so {credits_refunded} credit{'s' if credits_refunded != 1 else ''} went back to your account."]
    else:
        subject = "Your fix didn't work, so your credits are back"
        lines = [
            "We tried, but the error was still visible afterwards, so we didn't keep the result.",
            f"{credits_refunded} credit{'s' if credits_refunded != 1 else ''} went back to your account automatically." if credits_refunded else "Nothing was charged.",
            "",
            f"Your scan: {url}",
        ]
    email = _uploader_email(job)
    _send_to(email, os.environ.get("LOOPS_USER_TRANSACTIONAL_ID"), subject, "\n".join(lines))
    contact = {"hasFixed": True} if verified else {}
    event(job, "fix_finished", {"attempted": attempted, "verified": verified, "jobUrl": url}, contact, email=email)


def event(
    job: dict[str, Any] | None,
    name: str,
    props: dict[str, Any] | None = None,
    contact: dict[str, Any] | None = None,
    *,
    email: str | None = None,
) -> None:
    """
    Tell Loops something happened to this job's owner, for the lifecycle emails
    built as Loops automations (welcome, unfixed-errors reminder, feedback
    replies). Sends nothing by itself: an event only emails someone once a
    published Loop listens for it. Swallows everything.
    """
    api_key = os.environ.get("LOOPS_API_KEY")
    uid = (job or {}).get("ownerUid")
    email = email or _uploader_email(job)
    if not api_key or not email:
        return
    try:
        import requests

        body: dict[str, Any] = {"email": email, "eventName": name, "eventProperties": props or {}}
        if uid:
            body["userId"] = uid
        body.update(contact or {})
        resp = requests.post(
            _LOOPS_EVENT_URL,
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            json=body,
            timeout=10,
        )
        if resp.status_code >= 300:
            print(f"notify: loops event {name} returned {resp.status_code}: {resp.text[:200]}")
    except Exception as exc:
        print(f"notify: loops event {name} failed ({type(exc).__name__}: {exc})")


def user_scan_failed(job_id: str, *, job: dict[str, Any] | None, message: str) -> None:
    """Tell the uploader their scan didn't finish, in the words the job page uses."""
    url = f"https://scenefixer.com/job/{job_id}"
    _send_to(
        _uploader_email(job),
        os.environ.get("LOOPS_USER_TRANSACTIONAL_ID"),
        "Your scan didn't finish",
        f"{message}\n\nDetails: {url}",
    )
