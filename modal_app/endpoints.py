"""
Modal HTTPS endpoints — exposed as web endpoints callable from Next.js.
Deploy: modal deploy modal_app/app.py
"""

import os
from fastapi import Depends, HTTPException, Security
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

import modal
from modal_app.app import app, image

security = HTTPBearer()

BEARER_TOKEN = os.environ.get("MODAL_BEARER_TOKEN", "")


def verify_token(credentials: HTTPAuthorizationCredentials = Security(security)):
    if credentials.credentials != BEARER_TOKEN:
        raise HTTPException(status_code=401, detail="Invalid token")


@app.function(
    image=image,
    secrets=[
        modal.Secret.from_name("firebase-admin-key"),
        modal.Secret.from_name("anthropic-api-key"),
    ],
    timeout=600,
    keep_warm=1,
)
@modal.fastapi_endpoint(method="POST")
async def process_job_endpoint(
    body: dict,
    _: None = Depends(verify_token),
):
    """
    Runs the full pipeline: decompose → detect.
    Called by Next.js /api/jobs/[id]/start.
    """
    job_id = body.get("jobId")
    if not job_id:
        raise HTTPException(status_code=400, detail="jobId required")

    try:
        from modal_app.decompose import run_decompose
        from modal_app.detect import run_detect

        run_decompose(job_id)
        run_detect(job_id)

        return {"ok": True}
    except Exception as e:
        from modal_app.firebase import get_db
        get_db().collection("jobs").document(job_id).update({
            "status": "error",
            "errorMessage": str(e),
        })
        raise HTTPException(status_code=500, detail=str(e))


@app.function(
    image=image,
    secrets=[
        modal.Secret.from_name("firebase-admin-key"),
        modal.Secret.from_name("runway-api-key"),
    ],
    timeout=900,
    keep_warm=1,
)
@modal.fastapi_endpoint(method="POST")
async def fix_phase_endpoint(
    body: dict,
    _: None = Depends(verify_token),
):
    """
    Runs fix → stitch → verify phases.
    Called by Next.js /api/jobs/[id]/fix.
    """
    job_id = body.get("jobId")
    if not job_id:
        raise HTTPException(status_code=400, detail="jobId required")

    try:
        from modal_app.firebase import get_db
        from modal_app.fix import fix_single_error
        from modal_app.stitch import restitch
        from modal_app.verify import run_verify

        db = get_db()

        # Get all confirmed+pending errors
        errors_snap = (
            db.collection("jobs")
            .document(job_id)
            .collection("errors")
            .where("userConfirmed", "==", True)
            .where("fixStatus", "==", "pending")
            .get()
        )
        error_ids = [e.id for e in errors_snap]

        # Fix each error (sequential here; production would use .map())
        for error_id in error_ids:
            try:
                fix_single_error(job_id, error_id)
            except Exception as e:
                # Individual fix failures are written to the error doc;
                # don't abort the whole job
                print(f"Fix failed for error {error_id}: {e}")

        # Restitch timeline
        db.collection("jobs").document(job_id).update({"status": "verifying"})
        restitch(job_id)

        # Verify output
        run_verify(job_id)

        return {"ok": True}
    except Exception as e:
        from modal_app.firebase import get_db
        get_db().collection("jobs").document(job_id).update({
            "status": "error",
            "errorMessage": str(e),
        })
        raise HTTPException(status_code=500, detail=str(e))
