"""
Phase 6 — Verify the output video has no new errors.
Re-runs decompose + detect on the output video, writing to a separate
'verify_errors' subcollection so we don't pollute the original errors.
"""

from datetime import datetime, timezone

from modal_app.firebase import get_db
from modal_app.decompose import (
    download_video,
    transcode_to_720p,
    transcode_for_detection,
    detect_shots,
    extract_keyframe,
    upload_keyframe,
)
from modal_app.detect import get_pairs_to_compare, compare_pair
from modal_app.prompts import compute_continuity_score
import os
import tempfile


def run_verify(job_id: str) -> dict:
    db = get_db()
    job_ref = db.collection("jobs").document(job_id)
    job = job_ref.get().to_dict()

    if not job.get("outputVideoUrl"):
        raise ValueError("No outputVideoUrl on job — cannot verify")

    with tempfile.TemporaryDirectory() as tmp:
        raw_path = download_video(job_id, job["outputVideoUrl"], tmp)
        norm_path = os.path.join(tmp, "normalized_output.mp4")
        transcode_to_720p(raw_path, norm_path)

        # Unpadded, for the same reason as decompose: letterboxing hides cuts,
        # and a verify pass that sees one shot where there are six scores the
        # output against the wrong structure.
        det_path = os.path.join(tmp, "verify_detect_source.mp4")
        try:
            transcode_for_detection(raw_path, det_path)
            shots = detect_shots(det_path)
        except Exception as exc:
            print(f"Unpadded detection failed ({exc}); falling back to the padded copy")
            shots = detect_shots(norm_path)

        # Upload keyframes for output shots (stored under verify_shots)
        verify_shots = []
        for shot in shots:
            mid_ms = (shot["startMs"] + shot["endMs"]) / 2
            kf_path = os.path.join(tmp, f"vkf_{shot['index']}.jpg")
            extract_keyframe(norm_path, mid_ms, kf_path)
            storage_path = f"jobs/{job_id}/verify_keyframes/{shot['index']}.jpg"
            keyframe_url = upload_keyframe(kf_path, storage_path)
            verify_shots.append({
                "id": f"vshot_{shot['index']:04d}",
                **shot,
                "keyframeUrl": keyframe_url,
            })

        # Compare pairs and collect new errors
        pairs = get_pairs_to_compare(verify_shots)
        new_errors = []
        for shot_a, shot_b in pairs:
            errors = compare_pair(job_id, shot_a, shot_b)
            new_errors.extend(errors)

        score_after = compute_continuity_score(new_errors)

        # Write verify errors to separate subcollection
        verify_ref = db.collection("jobs").document(job_id).collection("verify_errors")
        for err in new_errors:
            verify_ref.add({**err, "createdAt": datetime.now(timezone.utc)})

        # Don't touch verifiedResolved here — it was already set accurately by
        # verify_fix() in fix.py right after inpainting. Overwriting it here
        # would erase the per-error Opus check result.

        # Surface new errors to user if any — do NOT set "done" here;
        # app.py sets it after post_process so outputVideoUrl is the final watermarked file.
        update = {
            "scoreAfter": score_after,
        }
        if new_errors:
            update["verifyWarning"] = (
                f"Aleph introduced {len(new_errors)} new issue(s) — review below."
            )

        job_ref.update(update)

        return {
            "newErrorCount": len(new_errors),
            "scoreAfter": score_after,
        }
