"""
Phase 2 — Decompose video into shots and extract keyframes.
Runs in Modal with FFmpeg + PySceneDetect.
"""

# The container is 3.11 but the local interpreter is 3.9, and `str | None` in a
# signature is evaluated at import time. This module has survived without the
# guard only because it is imported lazily from inside Modal functions rather
# than at deploy time; anything that imports it locally — a test, a script —
# hits the TypeError. Same reason app.py and diagnose.py carry this.
from __future__ import annotations

import os
import hashlib
import math
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from scenedetect import open_video, SceneManager
from scenedetect.detectors import ContentDetector

from modal_app.firebase import get_db, get_bucket


def download_video(job_id: str, input_url: str, dest_dir: str) -> str:
    """Download video from Firebase Storage to a local path."""
    import requests

    dest = os.path.join(dest_dir, "input.mp4")
    r = requests.get(input_url, stream=True, timeout=120)
    r.raise_for_status()
    with open(dest, "wb") as f:
        for chunk in r.iter_content(chunk_size=8192):
            f.write(chunk)
    return dest


def transcode_to_720p(input_path: str, output_path: str) -> str:
    """
    Re-encode to 1280x720 H.264 — preserves aspect ratio with black bars
    instead of stretching. Pulp Fiction is 1.85:1, GoT is 1.78:1 etc.;
    forcing all to 16:9 with `scale=1280:720` (no padding) squashed them.
    """
    subprocess.run(
        [
            "ffmpeg", "-y", "-i", input_path,
            "-vf",
            "scale=1280:720:force_original_aspect_ratio=decrease,"
            "pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black",
            "-c:v", "libx264", "-crf", "23",
            "-c:a", "aac",
            output_path,
        ],
        check=True,
        capture_output=True,
    )
    return output_path


def transcode_for_detection(input_path: str, output_path: str) -> str:
    """
    A 720p copy with NO letterboxing, used only to find shot boundaries.

    Scene detection compares consecutive frames across the whole frame. On a
    portrait video padded into a 16:9 box, roughly two thirds of every frame is
    identical black, so every real cut's score is divided by three and lands
    under the threshold. Measured on a live user's 12.63s clip, same detector,
    same threshold: 6 scenes at its native 410x720, and ZERO once padded to
    1280x720.

    The effect is that portrait uploads — most short-form AI video — were being
    analysed as one enormous shot containing many undetected cuts. Detection
    then reported the cuts as "the background environment shifts across frames",
    the fix asked a model to merge several different scenes into one, which
    cannot be done, and the verifier correctly rejected the result. A large part
    of the unfixable-error problem is this one line of ffmpeg.

    Boundaries found here are timestamps, so they apply unchanged to the padded
    transcode that everything downstream uses.
    """
    subprocess.run(
        [
            "ffmpeg", "-y", "-i", input_path,
            "-vf",
            "scale=1280:720:force_original_aspect_ratio=decrease:force_divisible_by=2",
            "-c:v", "libx264", "-crf", "23",
            "-an",
            output_path,
        ],
        check=True,
        capture_output=True,
    )
    return output_path


def detect_shots(video_path: str) -> list[dict]:
    """
    Run PySceneDetect ContentDetector and return shot boundaries in ms.

    Must be given an UNPADDED video — see transcode_for_detection. Letterboxing
    dilutes every content delta and suppresses detection entirely on portrait
    footage.
    """
    video = open_video(video_path)
    manager = SceneManager()
    manager.add_detector(ContentDetector(threshold=27.0))
    manager.detect_scenes(video)

    scene_list = manager.get_scene_list()
    shots = []
    for i, (start, end) in enumerate(scene_list):
        shots.append({
            "index": i,
            "startMs": int(start.get_seconds() * 1000),
            "endMs": int(end.get_seconds() * 1000),
        })

    # If no scene changes detected, treat the whole video as one shot
    if not shots:
        import subprocess as sp
        result = sp.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", video_path],
            capture_output=True, text=True,
        )
        duration_ms = int(float(result.stdout.strip()) * 1000)
        shots = [{"index": 0, "startMs": 0, "endMs": duration_ms}]

    return shots


def extract_keyframe(video_path: str, mid_ms: float, output_path: str) -> str | None:
    """Extract a single frame at mid_ms milliseconds.

    Returns the output path, or None when ffmpeg produced no usable frame.

    check=True alone is not sufficient: when -ss lands at or past the last
    decodable frame of the input, ffmpeg writes no output file and still
    exits 0. The caller then tried to upload a file that was never created
    and got [Errno 2], killing the whole job. Verify the file exists and is
    non-empty before reporting success.
    """
    mid_sec = mid_ms / 1000.0
    try:
        subprocess.run(
            [
                "ffmpeg", "-y",
                "-ss", str(mid_sec),
                "-i", video_path,
                "-frames:v", "1",
                "-q:v", "2",
                output_path,
            ],
            check=True,
            capture_output=True,
        )
    except subprocess.CalledProcessError as exc:
        stderr = (exc.stderr or b"").decode("utf-8", "replace")[-300:]
        print(f"extract_keyframe: ffmpeg exited {exc.returncode} at {mid_sec:.3f}s: {stderr}")
        return None

    if not os.path.exists(output_path) or os.path.getsize(output_path) == 0:
        return None

    return output_path


def upload_keyframe(local_path: str, storage_path: str) -> str:
    """Upload keyframe and return a public Firebase Storage URL.
    Works because storage rules have allow read: if true."""
    bucket = get_bucket()
    blob = bucket.blob(storage_path)
    blob.upload_from_filename(local_path, content_type="image/jpeg")
    bucket_name = bucket.name
    encoded = storage_path.replace("/", "%2F")
    return f"https://firebasestorage.googleapis.com/v0/b/{bucket_name}/o/{encoded}?alt=media"


KEYFRAME_OFFSETS = (0.10, 0.30, 0.50, 0.70, 0.90)  # 5 keyframes per shot — covers edges where reveals/occlusions happen


# Seconds of video analysed without spending credits, per plan.
#
# This replaces _MAX_VIDEO_MINUTES as a REJECTION threshold. Between 8 and 13
# September the 30-second free cap rejected 6 of 20 jobs outright and hit 4 of
# the 8 users who ever uploaded anything — the single largest drop-off in the
# product. The rejected durations cluster at 35s, 64.6s, 64.6s, 66.9s and 68s:
# people are uploading roughly one-minute clips, which is the natural length of
# the thing they want fixed, and the ceiling was under half of it. One user
# uploaded the same 64.62s file twice, five minutes apart, and left.
#
# So length is no longer a wall. A video longer than the budget is ANALYSED UP
# TO the budget and the user is shown the findings for that portion, with the
# boundary stated and the rest offered. A partial result converts; a rejection
# cannot.
#
# The ceiling is real money, not a product tier: analysis is Claude vision plus
# Grounding DINO, billed to us per scan, whereas fixes draw on a prepaid Runway
# balance. Measured at Opus 4.8's $5/$25 per Mtok, a 60s five-shot video costs
# about $1.30 to analyse and MAX_PAIRS=60 caps the dominant term — but the
# per-shot standalone call and the holistic call are uncapped, so cost still
# grows with length. 300s is the point where the worst case stays near $5.
_FREE_ANALYSIS_SECONDS: dict[str, float] = {
    "free": 300, "starter": 900, "pro": 1800, "studio": 3600,
}


def trim_video(input_path: str, output_path: str, seconds: float) -> str:
    """
    Cut the first `seconds` of a video, re-encoding so the cut lands exactly.

    Stream-copy (-c copy) would be faster but can only cut on a keyframe, which
    on a long GOP drifts the boundary by seconds. The analysed length is shown
    to the user and charged against a budget, so it has to be the length we say
    it is.
    """
    subprocess.run(
        [
            "ffmpeg", "-y", "-i", input_path,
            "-t", f"{seconds:.3f}",
            "-c:v", "libx264", "-crf", "23",
            "-c:a", "aac",
            output_path,
        ],
        check=True,
        capture_output=True,
    )
    return output_path



def run_decompose(job_id: str) -> int:
    """Full decompose phase. Returns number of shots found."""
    db = get_db()
    job_ref = db.collection("jobs").document(job_id)
    job = job_ref.get().to_dict()

    with tempfile.TemporaryDirectory() as tmp:
        # 1. Download original
        raw_path = download_video(job_id, job["inputVideoUrl"], tmp)

        # 1b. Enforce video length limit per plan
        owner_uid = job.get("ownerUid")
        if owner_uid:
            user = db.collection("users").document(owner_uid).get().to_dict() or {}
            user_plan = user.get("plan", "free")
        else:
            user_plan = "free"  # beta users get free-tier limits

        budget_seconds = _FREE_ANALYSIS_SECONDS.get(user_plan, 300)
        probe = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", raw_path],
            capture_output=True, text=True,
        )
        try:
            duration_s = float(probe.stdout.strip())
            # Compare whole seconds. An export lands a few frames past a round
            # number all the time — 30.13s and 30.21s were both rejected
            # against a 30s cap — and "your 30 second video is too long for
            # your 30 second limit" is not a defensible thing to tell someone
            # who has just sat through the upload. Anything that rounds down to
            # the budget is inside it; the fix pipeline works per shot, so a
            # fraction of a second over changes nothing downstream.
            if math.floor(duration_s) > budget_seconds:
                # Not an error. Analyse the affordable prefix, and record both
                # numbers so the UI can state the boundary and offer the rest.
                trimmed = os.path.join(tmp, "budgeted.mp4")
                trim_video(raw_path, trimmed, budget_seconds)
                raw_path = trimmed

                job_ref.update({
                    "analysisTruncated": True,
                    "analysedSeconds": round(budget_seconds, 2),
                    "totalSeconds": round(duration_s, 2),
                })

                from modal_app import analytics
                analytics.capture(
                    job_id,
                    "job_analysis_truncated",
                    {
                        "reason": "analysis_budget",
                        "duration_s": round(duration_s, 2),
                        "analysed_s": round(budget_seconds, 2),
                        "remaining_s": round(duration_s - budget_seconds, 2),
                        "plan": user_plan,
                    },
                    job=job,
                )
            else:
                job_ref.update({
                    "analysisTruncated": False,
                    "analysedSeconds": round(duration_s, 2),
                    "totalSeconds": round(duration_s, 2),
                })
        except (ValueError, AttributeError):
            pass

        # 2. Transcode to 720p
        norm_path = os.path.join(tmp, "normalized.mp4")
        transcode_to_720p(raw_path, norm_path)

        # 3. Detect shots
        # Detect on an unpadded copy. norm_path is letterboxed, and letterboxing
        # hides cuts (see transcode_for_detection). The boundaries are
        # timestamps, so they apply to norm_path unchanged.
        det_path = os.path.join(tmp, "detect_source.mp4")
        try:
            transcode_for_detection(raw_path, det_path)
            shots = detect_shots(det_path)
        except Exception as exc:
            print(f"Unpadded detection failed ({exc}); falling back to the padded copy")
            shots = detect_shots(norm_path)

        # 4. For each shot: extract 3 keyframes (25/50/75%), upload all,
        # write Firestore doc with array + mid-frame for backward-compat.
        batch = db.batch()
        shots_ref = job_ref.collection("shots")
        shots_written = 0

        for shot in shots:
            shot_dur_ms = shot["endMs"] - shot["startMs"]
            keyframe_urls: list[str] = []

            for k, offset in enumerate(KEYFRAME_OFFSETS):
                frame_ms = shot["startMs"] + shot_dur_ms * offset
                kf_path = os.path.join(tmp, f"keyframe_{shot['index']}_{k}.jpg")
                # A frame we cannot extract is skipped, not fatal. The 0.90
                # offset can land past the last decodable frame of a shot;
                # frames 0.10-0.70 are already uploaded and are enough to
                # analyse the shot.
                if extract_keyframe(norm_path, frame_ms, kf_path) is None:
                    print(
                        f"Keyframe skipped — shot {shot['index']}, offset {offset} "
                        f"(k={k}) at {frame_ms / 1000.0:.3f}s: ffmpeg produced no frame"
                    )
                    continue
                storage_path = f"jobs/{job_id}/keyframes/{shot['index']}_{k}.jpg"
                keyframe_urls.append(upload_keyframe(kf_path, storage_path))

            if not keyframe_urls:
                print(
                    f"Shot {shot['index']} skipped — no keyframes could be extracted "
                    f"across any of the {len(KEYFRAME_OFFSETS)} offsets"
                )
                continue

            shot_id = f"shot_{shot['index']:04d}"
            doc_ref = shots_ref.document(shot_id)
            batch.set(doc_ref, {
                "index": shot["index"],
                "startMs": shot["startMs"],
                "endMs": shot["endMs"],
                "keyframeUrl": keyframe_urls[len(keyframe_urls) // 2],
                "keyframeUrls": keyframe_urls,
            })
            shots_written += 1

        batch.commit()

        # 5. Update job status.
        # Two distinct numbers, deliberately not collapsed into one:
        #   shotCount     — what scene detection found in the video
        #   shotsAnalyzed — how many of those have keyframes and can be compared
        # They diverge when keyframe extraction fails on some shots. Reporting
        # only shotsAnalyzed would tell a user whose 4-shot video lost two shots
        # that their clip is a single continuous shot, or hand them a clean
        # "no errors found" on a half-analysed video — silently, which is the
        # exact failure class this pass exists to remove.
        job_ref.update({
            "status": "detecting",
            "shotCount": len(shots),
            "shotsAnalyzed": shots_written,
        })

        return shots_written
