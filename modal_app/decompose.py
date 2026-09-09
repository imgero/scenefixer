"""
Phase 2 — Decompose video into shots and extract keyframes.
Runs in Modal with FFmpeg + PySceneDetect.
"""

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


_MAX_VIDEO_MINUTES: dict[str, float] = {
    "free": 0.5, "starter": 5, "pro": 15, "studio": 60,
}


def _fmt_duration(seconds: float, force_seconds: bool = False) -> str:
    """
    Human duration for the length-limit message.

    A 30-second cap rendered as "0.5 min" against a 31-second clip rendered as
    "1.3 min" read as a contradiction — two numbers that look unrelated, on the
    last screen a user sees before deciding whether to pay. Both sides of the
    comparison go through here, and `force_seconds` keeps them in the same unit
    when the cap is under a minute, so a 30-second limit is never compared
    against a duration expressed in minutes.
    """
    if force_seconds or seconds < 60:
        return f"{int(math.ceil(seconds))} seconds"
    minutes = seconds / 60
    return f"{minutes:.1f} minutes" if minutes % 1 else f"{int(minutes)} minutes"


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

        max_minutes = _MAX_VIDEO_MINUTES.get(user_plan, 5)
        probe = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", raw_path],
            capture_output=True, text=True,
        )
        try:
            duration_s = float(probe.stdout.strip())
            max_seconds = max_minutes * 60
            # Compare whole seconds. An export lands a few frames past a round
            # number all the time — 30.13s and 30.21s were both rejected
            # against a 30s cap — and "your 30 second video is too long for
            # your 30 second limit" is not a defensible thing to tell someone
            # who has just sat through the upload. Anything that rounds down to
            # the cap is inside it; the fix pipeline works per shot, so a
            # fraction of a second over changes nothing downstream.
            if math.floor(duration_s) > max_seconds:
                # Both sides through _fmt_duration so the cap and the actual
                # length are always in the same unit. Ceiling the duration also
                # keeps the two from printing equal on a strictly-greater
                # comparison (a 30.2s clip against a 30s cap).
                job_ref.update({
                    "status": "error",
                    "errorMessage": (
                        f"Video too long — your {user_plan} plan supports up to "
                        f"{_fmt_duration(max_seconds)}, but this video is "
                        f"{_fmt_duration(duration_s, force_seconds=max_seconds < 60)}. "
                        f"Upgrade your plan to process longer videos."
                    ),
                })

                from modal_app import analytics
                analytics.capture(
                    job_id,
                    "job_analysis_rejected",
                    {
                        "reason": "video_too_long",
                        "duration_s": round(duration_s, 2),
                        "max_minutes": max_minutes,
                        "max_seconds": int(max_seconds),
                        "plan": user_plan,
                    },
                    job=job,
                )
                return 0
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
