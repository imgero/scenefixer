"""
Modal app definition — image and app object shared across all modules.
Deploy with: modal deploy modal_app/app.py
"""

# modal deploy imports this file with the LOCAL interpreter, which is 3.9 here,
# while the container runs 3.13. Without deferred annotations a `str | None`
# in a signature is evaluated at import time and 3.9 raises TypeError, so the
# deploy fails before it starts.
from __future__ import annotations

import modal

app = modal.App("scenefixer")

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg", "fonts-liberation")
    .pip_install(
        "firebase-admin==6.5.0",
        "scenedetect[opencv]>=0.6.4",
        "anthropic>=0.52.0",
        "runwayml>=4.14.0",
        "requests>=2.31.0",
        "opencv-python-headless>=4.9.0",
        "fastapi>=0.115.0",
        "python-multipart>=0.0.9",
        # Pinned to 3.x: posthog 4+/6+ changed the capture() signature.
        "posthog>=3.7,<4",
    )
)

# Add the local package after image definition so changes always bust the cache
image = image.add_local_python_source("modal_app")


# ── Endpoints defined inline so there's no circular import ──────────────────

import os
from fastapi import Depends, HTTPException, Security
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

security = HTTPBearer()


def _verify_token(credentials: HTTPAuthorizationCredentials = Security(security)):
    expected = os.environ.get("MODAL_BEARER_TOKEN", "")
    if credentials.credentials != expected:
        raise HTTPException(status_code=401, detail="Invalid token")


# Failures that are ours, not the user's. The message the user sees, and
# whether their free daily scan is given back, both hang off this.
#
# On 4 September the Anthropic account ran out of credit mid-session and three
# analyses failed in the detect phase. `errorMessage` was set to the raw
# upstream string — "Your credit balance is too low to access the Anthropic
# API. Please go to Plans & Billing to upgrade or purchase credits." — so the
# users were shown our supplier's dunning notice as though it were about their
# own account, and each still lost one of their three daily scans.
_UPSTREAM_OUTAGE_MARKERS = (
    "credit balance is too low",
    "rate_limit_error",
    "overloaded_error",
    "insufficient_quota",
)

_OUTAGE_MESSAGE = (
    "Analysis is temporarily unavailable — this is a problem on our side, "
    "not with your video. Your scan has not been counted. Please try again "
    "shortly."
)


def _is_upstream_outage(exc: Exception) -> bool:
    text = str(exc).lower()
    return any(marker in text for marker in _UPSTREAM_OUTAGE_MARKERS)


def _refund_daily_scan(owner_uid: str | None) -> bool:
    """
    Give back the free-tier scan consumed by /api/jobs/[id]/start.

    The scan is counted before analysis runs, so a failure that is ours leaves
    the user one scan poorer for work we never did.
    """
    if not owner_uid:
        return False
    try:
        from modal_app.firebase import get_db

        ref = get_db().collection("users").document(owner_uid)
        data = ref.get().to_dict() or {}
        scans_today = data.get("scansToday")
        if isinstance(scans_today, int) and scans_today > 0:
            ref.update({"scansToday": scans_today - 1})
            return True
    except Exception as exc:
        print(f"scan refund failed for {owner_uid}: {exc}")
    return False


# Every secret named here must already exist, or `modal deploy` fails before it
# starts. So adding one is a deploy-breaking change until it is created.
#
# TO TURN ON OUTCOME EMAILS (modal_app/notify.py), two steps, in this order:
#   1. modal secret create loops-api-key \
#        LOOPS_API_KEY=... LOOPS_OWNER_TRANSACTIONAL_ID=...
#   2. add `modal.Secret.from_name("loops-api-key"),` to this list AND to
#      FIX_SECRETS below, then redeploy.
# Until then notify.py finds no key and no-ops silently — which is exactly
# what lib/notify.ts did on the web side from the day it was written, because
# it called Resend and RESEND_API_KEY is set in no environment at all. Both
# sides now go through Loops, whose key already exists and already works.
ANALYSIS_SECRETS = [
    modal.Secret.from_name("firebase-admin-key"),
    modal.Secret.from_name("anthropic-api-key"),
    modal.Secret.from_name("modal-bearer-token"),
    modal.Secret.from_name("replicate-api-token"),
    modal.Secret.from_name("posthog-api-key"),
]


@app.function(image=image, secrets=ANALYSIS_SECRETS, timeout=7200, min_containers=0)
def run_process_job(job_id: str):
    """
    Decompose → Detect. A plain function, not a web endpoint, so it can be
    spawned detached and survive its caller going away.

    This is the same split fix_phase already had, applied here for the same
    reason. Analysis used to run inline inside the web endpoint, which capped
    it at that endpoint's 600s timeout and — worse — cancelled it outright
    whenever the caller disconnected, which Vercel's after() does at 300s.

    It survived only because analysis was short. Once shot detection stopped
    being blinded by letterboxing, a 23-second video went from 2 shots to 10,
    detection went from 3 comparisons to 55, and analysis stopped being able to
    finish at all. Correct shot splitting is what made this limit reachable;
    it was always there.
    """
    from modal_app import analytics

    analytics.start_timer(job_id)

    try:
        from modal_app.decompose import run_decompose
        from modal_app.detect import run_detect

        shot_count = run_decompose(job_id)

        # run_decompose signals a terminal rejection by writing status:"error"
        # + errorMessage and returning 0, deliberately without raising —
        # raising would change the failure semantics of every other decompose
        # path. Detect must not run in that case: it would find zero shots and
        # overwrite the status with "awaiting_confirmation", discarding the
        # errorMessage the user needs.
        #
        # Video length is NO LONGER one of these rejections. A video longer
        # than the analysis budget is trimmed to it and analysed normally; see
        # _FREE_ANALYSIS_SECONDS in decompose.py. This branch still guards
        # genuine decompose failures (an unreadable file, a download that died).
        if shot_count == 0:
            from modal_app.firebase import get_db
            current = get_db().collection("jobs").document(job_id).get().to_dict() or {}
            if current.get("status") == "error":
                return {"ok": False, "skipped": "decompose_terminal_error"}

        run_detect(job_id)
        return {"ok": True}
    except Exception as e:
        # Don't clobber a job that already finished successfully — Modal
        # worker preemption can raise mid-flight even after run_detect set
        # status to awaiting_confirmation.
        from modal_app.firebase import get_db
        current = get_db().collection("jobs").document(job_id).get().to_dict() or {}
        outage = _is_upstream_outage(e)
        scan_refunded = _refund_daily_scan(current.get("ownerUid")) if outage else False

        if current.get("status") not in ("awaiting_confirmation", "fixing", "verifying", "done"):
            get_db().collection("jobs").document(job_id).update({
                "status": "error",
                # Never show the user an upstream provider's billing or rate
                # limit text — it reads as a complaint about their account.
                "errorMessage": _OUTAGE_MESSAGE if outage else str(e),
                "errorIsOurs": outage,
                "retryable": outage,
            })

        analytics.capture(
            job_id,
            "job_analysis_failed",
            {
                "failure_reason": str(e),
                "exception_type": type(e).__name__,
                "phase": "detect" if current.get("shotCount") else "decompose",
                "shot_count": current.get("shotCount", 0),
                # Separates "we broke" from "this video could not be analysed",
                # which is the difference between an alert and a data point.
                "upstream_outage": outage,
                "scan_refunded": scan_refunded,
            },
            job=current,
        )

        try:
            from modal_app import notify
            notify.analysis_failed(
                job_id,
                job=current,
                reason=(
                    "upstream provider outage (ours, not the user's)"
                    if outage
                    else f"{type(e).__name__}: {e}"
                ),
                detail=(
                    f"Phase: {'detect' if current.get('shotCount') else 'decompose'}\n"
                    f"Shots at failure: {current.get('shotCount', 0)}\n"
                    f"Free daily scan refunded: {scan_refunded}\n\n"
                    + (
                        "The user was shown a neutral 'try again shortly' "
                        "message, not the provider's text."
                        if outage
                        else f"The user was shown: {e}"
                    )
                ),
            )
        except Exception as exc:
            print(f"analysis_failed notify failed: {exc}")

        # Detached: there is no caller to receive an HTTP error. The job
        # document already carries the failure, which is what the UI reads.
        raise


FIX_SECRETS = [
    modal.Secret.from_name("firebase-admin-key"),
    modal.Secret.from_name("anthropic-api-key"),
    modal.Secret.from_name("runway-api-key"),
    modal.Secret.from_name("modal-bearer-token"),
    # Without this the fix_completed cost event silently no-ops —
    # analytics._get_client() returns None when POSTHOG_API_KEY is absent.
    modal.Secret.from_name("posthog-api-key"),
    # Outcome emails: add loops-api-key here too — see ANALYSIS_SECRETS.
]


# 7200s, not 1800s. run_fix_phase processes up to MAX_ERRORS_PER_FIX (8)
# errors sequentially and an aleph2 generation runs into the minutes, so the
# old 30-minute ceiling could kill a multi-error job partway — after its
# Runway credits had already been charged.
@app.function(image=image, secrets=FIX_SECRETS, timeout=7200, min_containers=0)
def run_fix_phase(job_id: str):
    """
    The actual fix work. A plain function, not a web endpoint, so it can be
    spawned detached and survive its caller going away.

    This split exists because the whole fix used to run inline inside the web
    endpoint, and that could never complete in production. The chain was:
    Vercel route -> after() -> fetch(fix_phase) -> Modal runs the fix inline.
    Modal returns a 303 once a web endpoint passes ~150s, and Vercel kills
    after() at its 300s function limit. When that connection dropped, Modal
    cancelled the in-flight function. An aleph2 generation takes 5-8 minutes,
    so every fix was guaranteed to be killed part-way — after the Runway
    credits had already been charged, leaving the job stuck in "fixing" with
    no output and no error.
    """
    try:
        from modal_app.firebase import get_db
        from modal_app.fix import fix_single_error
        from modal_app.stitch import restitch
        from modal_app.verify import run_verify

        db = get_db()
        # Mirrored in app/api/jobs/[id]/fix/route.ts (calcCreditsNeeded). If
        # these two drift, the user is charged for work this loop never does:
        # the route used to have no limit at all, so confirming 20 errors cost
        # 20 and ran 8, with the other 12 neither attempted nor refunded.
        MAX_ERRORS_PER_FIX = 8
        errors_snap = (
            db.collection("jobs").document(job_id).collection("errors")
            .where("userConfirmed", "==", True)
            .limit(MAX_ERRORS_PER_FIX)
            .get()
        )

        # Defence in depth: the fix route already refuses to charge for an
        # unrepairable error, so one reaching here means something upstream is
        # wrong. Skipping is still correct — running it would burn credits on a
        # result the verifier will correctly reject.
        errors_snap = [
            d for d in errors_snap if d.to_dict().get("repairable") is not False
        ]

        # Order matters now that fixes on one shot CHAIN — each starts from the
        # previous one's output rather than the original footage (see
        # _prior_fixed_clip in fix.py). Grouping by shot keeps a shot's fixes
        # adjacent so the chain is unbroken, and putting the whole-clip regrade
        # LAST means the final pass unifies the colour of whatever the object
        # edits changed, rather than an object being pasted in after the grade
        # was already settled.
        _GRADE_LAST = {"lighting", "atmosphere"}

        def _fix_order(doc):
            err = doc.to_dict()
            target = (
                err.get("shotBId")
                if err.get("fixDirection", "aTob") == "aTob"
                else err.get("shotAId")
            )
            is_grade = str(err.get("type") or "").lower() in _GRADE_LAST
            return (str(target), 1 if is_grade else 0)

        errors_snap.sort(key=_fix_order)
        if not errors_snap:
            db.collection("jobs").document(job_id).update({
                "status": "awaiting_confirmation",
                "errorMessage": (
                    "None of the selected errors can be repaired by editing the "
                    "footage. Nothing was charged."
                ),
            })
            return {"ok": False, "skipped": "nothing_repairable"}

        # Per-error outcomes are tracked, not swallowed. A thrown fix used to be
        # printed and forgotten: the loop carried on, the job was marked "done",
        # the credits stayed spent, and the user was handed an "output" that was
        # just their original video re-encoded. fix_single_error marks the error
        # failed and refunds its credits; this loop makes the JOB's terminal
        # state tell the truth about what actually happened.
        attempted = len(errors_snap)
        # Three distinct outcomes, deliberately not collapsed into "succeeded".
        # An Aleph call that returns a clip has not necessarily fixed anything —
        # the verifier decides that — and reporting "succeeded" for a clip that
        # still shows the error is how a non-fix came to present as a success.
        verified: list[str] = []      # ran, and the verifier says the error is gone
        unverified: list[str] = []    # ran, produced output, error still visible
        failed: list[dict] = []       # threw; no output at all
        credits_refunded = 0

        def _error_after(error_id: str) -> dict:
            return (
                db.collection("jobs").document(job_id)
                .collection("errors").document(error_id).get().to_dict()
                or {}
            )

        for err_doc in errors_snap:
            try:
                fix_single_error(job_id, err_doc.id)
                after = _error_after(err_doc.id)
                if after.get("verifiedResolved") is True:
                    verified.append(err_doc.id)
                else:
                    unverified.append(err_doc.id)
            except Exception as e:
                print(f"Fix failed for error {err_doc.id}: {e}")
                failed.append({"error_id": err_doc.id, "message": str(e)[:300]})
                after = _error_after(err_doc.id)
            if after.get("autoRefunded"):
                try:
                    credits_refunded += int(after.get("creditsDeducted") or 0)
                except (TypeError, ValueError):
                    pass

        # Nothing ran to completion — there is no fixed footage to stitch, so
        # stitching would produce a re-encode of the original and present it as
        # a result. Fail the job instead.
        if attempted > 0 and not verified and not unverified:
            message = (
                failed[0]["message"] if failed else "No fixes could be applied."
            )
            db.collection("jobs").document(job_id).update({
                "status": "error",
                "errorMessage": f"No fixes could be applied. {message}",
                "fixesAttempted": attempted,
                "fixesVerified": 0,
                "fixesUnverified": 0,
                "fixesFailed": len(failed),
                "verificationPassed": False,
                "creditsRefunded": credits_refunded,
            })
            try:
                from modal_app import analytics
                analytics.capture(
                    job_id,
                    "fix_job_failed",
                    {
                        "attempted": attempted,
                        "failed": len(failed),
                        "credits_refunded": credits_refunded,
                        "reasons": [f["message"] for f in failed][:8],
                    },
                )
            except Exception as exc:
                print(f"fix_job_failed capture failed: {exc}")
            try:
                from modal_app import notify
                notify.fix_finished(
                    job_id,
                    job=db.collection("jobs").document(job_id).get().to_dict(),
                    attempted=attempted,
                    verified=0,
                    unverified=0,
                    failed=len(failed),
                    credits_refunded=credits_refunded,
                    reasons=[f["message"] for f in failed][:8],
                )
            except Exception as exc:
                print(f"fix_job_failed notify failed: {exc}")
            return {"ok": False, "attempted": attempted, "verified": 0, "failed": len(failed)}

        db.collection("jobs").document(job_id).update({"status": "verifying"})
        restitch(job_id)
        run_verify(job_id)

        from modal_app.post_process import run_post_process
        run_post_process(job_id)

        # status stays "done" because a dozen call sites gate re-fix, reprocess,
        # retry and download on it. What "done" MEANS is carried by
        # verificationPassed: the pipeline finished, but it did not necessarily
        # fix anything. verificationPassed is False whenever not one error came
        # back verified, and the UI shows the unfixed state off that flag rather
        # than off status.
        verification_passed = len(verified) > 0

        # A run that made the video WORSE has not passed, whatever the
        # per-error verifier says.
        #
        # Those two checks answer different questions. The per-error verifier
        # asks "is this specific error gone from this specific clip?" — it
        # never looks at the delivered film. scoreAfter re-runs detection over
        # the whole output, so it is the only thing that can see damage a fix
        # caused somewhere else.
        #
        # On 14 Sep they disagreed: 2 of 3 fixes verified, so the job reported
        # success, while scoreBefore 61 -> scoreAfter 47 because the third fix
        # had blurred the footage and recoloured the furniture. The user would
        # have been told their video was fixed while holding one that was worse
        # than what they uploaded. When the two disagree, the one that looked
        # at the whole video wins.
        fresh_scores = db.collection("jobs").document(job_id).get().to_dict() or {}
        _before = fresh_scores.get("scoreBefore")
        _after = fresh_scores.get("scoreAfter")
        if (
            verification_passed
            and fresh_scores.get("scoreAfterReliable") is not False
            and isinstance(_before, (int, float))
            and isinstance(_after, (int, float))
            and _after < _before
        ):
            print(
                f"Overall score fell {_before} -> {_after} despite "
                f"{len(verified)} verified fix(es); marking the run not passed"
            )
            verification_passed = False

        done_update = {
            "status": "done",
            "fixesAttempted": attempted,
            "fixesVerified": len(verified),
            "fixesUnverified": len(unverified),
            "fixesFailed": len(failed),
            "verificationPassed": verification_passed,
            "creditsRefunded": credits_refunded,
        }

        # Backstop on the same contradiction verify.py guards at the source: a
        # run where not one error came back verified cannot also have improved
        # the score. verify.py catches the case where the output's shot
        # structure made the comparison invalid; this catches everything else,
        # including detection simply not re-finding an error it originally
        # reported. Either way the user must not be shown a rise they did not
        # get — 31 -> 100 on a run that fixed nothing is the exact shape to
        # prevent.
        if not verification_passed:
            fresh = db.collection("jobs").document(job_id).get().to_dict() or {}
            before = fresh.get("scoreBefore")
            after = fresh.get("scoreAfter")
            if before is not None and after is not None and after > before:
                print(
                    f"Suppressing scoreAfter {after} > scoreBefore {before} on a "
                    f"run with 0 verified fixes"
                )
                done_update["scoreAfter"] = before
                done_update["scoreAfterReliable"] = False
                done_update["scoreAfterNote"] = (
                    "No fix was verified on this run, so the score is unchanged."
                )

        db.collection("jobs").document(job_id).update(done_update)

        if not verification_passed or failed:
            try:
                from modal_app import analytics
                analytics.capture(
                    job_id,
                    "fix_job_unverified" if not verification_passed else "fix_job_partial",
                    {
                        "attempted": attempted,
                        "verified": len(verified),
                        "unverified": len(unverified),
                        "failed": len(failed),
                        "credits_refunded": credits_refunded,
                        "reasons": [f["message"] for f in failed][:8],
                    },
                )
            except Exception as exc:
                print(f"fix job outcome capture failed: {exc}")

        # Emailed on EVERY terminal fix run, not only the bad ones. A run where
        # everything verified is the outcome this product has been trying to
        # produce since launch and has managed twice; it should not be the one
        # case that arrives silently.
        try:
            from modal_app import notify
            notify.fix_finished(
                job_id,
                job=db.collection("jobs").document(job_id).get().to_dict(),
                attempted=attempted,
                verified=len(verified),
                unverified=len(unverified),
                failed=len(failed),
                credits_refunded=credits_refunded,
                reasons=[f["message"] for f in failed][:8],
            )
        except Exception as exc:
            print(f"fix job outcome notify failed: {exc}")

        return {
            "ok": True,
            "attempted": attempted,
            "verified": len(verified),
            "unverified": len(unverified),
            "failed": len(failed),
            "verificationPassed": verification_passed,
        }
    except Exception as e:
        from modal_app.firebase import get_db
        current = get_db().collection("jobs").document(job_id).get().to_dict() or {}
        if current.get("status") != "done":
            get_db().collection("jobs").document(job_id).update({
                "status": "error",
                "errorMessage": str(e),
            })
        raise


@app.function(image=image, secrets=ANALYSIS_SECRETS, timeout=60, min_containers=0)
@modal.fastapi_endpoint(method="POST")
async def process_job(body: dict, _: None = Depends(_verify_token)):
    """
    Accept an analysis request and hand it to a detached worker.

    Returns immediately, for the same reason fix_phase does: the caller must
    not hold a connection open for the duration, because that connection dying
    is what cancels the work.
    """
    job_id = body.get("jobId")
    if not job_id:
        raise HTTPException(status_code=400, detail="jobId required")

    call = run_process_job.spawn(job_id)
    return {"ok": True, "spawned": True, "callId": call.object_id}


@app.function(image=image, secrets=FIX_SECRETS, timeout=60, min_containers=0)
@modal.fastapi_endpoint(method="POST")
async def fix_phase(body: dict, _: None = Depends(_verify_token)):
    """
    Accept a fix request and hand it to a detached worker.

    Returns immediately. The caller (/api/jobs/[id]/fix, via after()) only needs
    to know the work was accepted — it must NOT hold a connection open for the
    duration, because that connection dying is what cancels the work.
    """
    job_id = body.get("jobId")
    if not job_id:
        raise HTTPException(status_code=400, detail="jobId required")

    call = run_fix_phase.spawn(job_id)
    return {"ok": True, "spawned": True, "callId": call.object_id}


@app.function(
    image=image,
    secrets=[
        modal.Secret.from_name("firebase-admin-key"),
        modal.Secret.from_name("modal-bearer-token"),
    ],
    timeout=300,
    min_containers=0,
)
@modal.fastapi_endpoint(method="POST")
async def reprocess_job(body: dict, _: None = Depends(_verify_token)):
    """Re-run post_process only — applies current plan quality/watermark to existing stitch output."""
    job_id = body.get("jobId")
    if not job_id:
        raise HTTPException(status_code=400, detail="jobId required")

    try:
        from modal_app.post_process import run_post_process
        from modal_app.firebase import get_db

        run_post_process(job_id)
        get_db().collection("jobs").document(job_id).update({"status": "done"})
        return {"ok": True}
    except Exception as e:
        from modal_app.firebase import get_db
        get_db().collection("jobs").document(job_id).update({
            "status": "done",  # revert to done even on failure — don't break the job
            "errorMessage": str(e),
        })
        raise HTTPException(status_code=500, detail=str(e))
