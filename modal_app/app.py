"""
Modal app definition — image and app object shared across all modules.
Deploy with: modal deploy modal_app/app.py
"""

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


@app.function(
    image=image,

    secrets=[
        modal.Secret.from_name("firebase-admin-key"),
        modal.Secret.from_name("anthropic-api-key"),
        modal.Secret.from_name("modal-bearer-token"),
        modal.Secret.from_name("replicate-api-token"),
    ],
    timeout=600,
    min_containers=0,
)
@modal.fastapi_endpoint(method="POST")
async def process_job(body: dict, _: None = Depends(_verify_token)):
    """Decompose → Detect. Called by /api/jobs/[id]/start."""
    job_id = body.get("jobId")
    if not job_id:
        raise HTTPException(status_code=400, detail="jobId required")

    try:
        from modal_app.decompose import run_decompose
        from modal_app.detect import run_detect

        shot_count = run_decompose(job_id)

        # run_decompose signals a terminal rejection (e.g. the video exceeds the
        # plan length limit) by writing status:"error" + errorMessage and
        # returning 0, deliberately without raising — raising would change the
        # failure semantics of every other decompose path. Detect must not run
        # in that case: it would find zero shots and overwrite the status with
        # "awaiting_confirmation", discarding the errorMessage the user needs.
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
        if current.get("status") not in ("awaiting_confirmation", "fixing", "verifying", "done"):
            get_db().collection("jobs").document(job_id).update({
                "status": "error",
                "errorMessage": str(e),
            })
        raise HTTPException(status_code=500, detail=str(e))


@app.function(
    image=image,

    secrets=[
        modal.Secret.from_name("firebase-admin-key"),
        modal.Secret.from_name("anthropic-api-key"),
        modal.Secret.from_name("runway-api-key"),
        modal.Secret.from_name("modal-bearer-token"),
    ],
    timeout=1800,
    min_containers=0,
)
@modal.fastapi_endpoint(method="POST")
async def fix_phase(body: dict, _: None = Depends(_verify_token)):
    """Fix → Stitch → Verify. Called by /api/jobs/[id]/fix."""
    job_id = body.get("jobId")
    if not job_id:
        raise HTTPException(status_code=400, detail="jobId required")

    try:
        from modal_app.firebase import get_db
        from modal_app.fix import fix_single_error
        from modal_app.stitch import restitch
        from modal_app.verify import run_verify

        db = get_db()
        MAX_ERRORS_PER_FIX = 8
        errors_snap = (
            db.collection("jobs").document(job_id).collection("errors")
            .where("userConfirmed", "==", True)
            .limit(MAX_ERRORS_PER_FIX)
            .get()
        )

        for err_doc in errors_snap:
            try:
                fix_single_error(job_id, err_doc.id)
            except Exception as e:
                print(f"Fix failed for error {err_doc.id}: {e}")

        db.collection("jobs").document(job_id).update({"status": "verifying"})
        restitch(job_id)
        run_verify(job_id)

        from modal_app.post_process import run_post_process
        run_post_process(job_id)

        db.collection("jobs").document(job_id).update({"status": "done"})

        return {"ok": True}
    except Exception as e:
        from modal_app.firebase import get_db
        current = get_db().collection("jobs").document(job_id).get().to_dict() or {}
        if current.get("status") != "done":
            get_db().collection("jobs").document(job_id).update({
                "status": "error",
                "errorMessage": str(e),
            })
        raise HTTPException(status_code=500, detail=str(e))


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
