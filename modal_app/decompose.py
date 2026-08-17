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


def detect_shots(video_path: str) -> list[dict]:
    """Run PySceneDetect ContentDetector and return shot boundaries in ms."""
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


def extract_keyframe(video_path: str, mid_ms: float, output_path: str) -> str:
    """Extract a single frame at mid_ms milliseconds."""
    mid_sec = mid_ms / 1000.0
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
            if duration_s > max_seconds:
                # Format both sides in whole seconds. Rendering a 0.5 min cap
                # and a 31s clip as "0.5 min" vs "0.5 min" made a real limit
                # read as a bug. Ceil the actual duration so the two numbers
                # can never print equal on a strictly-greater comparison.
                job_ref.update({
                    "status": "error",
                    "errorMessage": (
                        f"Video too long — your {user_plan} plan supports up to "
                        f"{int(max_seconds)}s, but this video is "
                        f"{math.ceil(duration_s)}s. "
                        f"Upgrade your plan to process longer videos."
                    ),
                })
                return 0
        except (ValueError, AttributeError):
            pass

        # 2. Transcode to 720p
        norm_path = os.path.join(tmp, "normalized.mp4")
        transcode_to_720p(raw_path, norm_path)

        # 3. Detect shots
        shots = detect_shots(norm_path)

        # 4. For each shot: extract 3 keyframes (25/50/75%), upload all,
        # write Firestore doc with array + mid-frame for backward-compat.
        batch = db.batch()
        shots_ref = job_ref.collection("shots")

        for shot in shots:
            shot_dur_ms = shot["endMs"] - shot["startMs"]
            keyframe_urls: list[str] = []

            for k, offset in enumerate(KEYFRAME_OFFSETS):
                frame_ms = shot["startMs"] + shot_dur_ms * offset
                kf_path = os.path.join(tmp, f"keyframe_{shot['index']}_{k}.jpg")
                extract_keyframe(norm_path, frame_ms, kf_path)
                storage_path = f"jobs/{job_id}/keyframes/{shot['index']}_{k}.jpg"
                keyframe_urls.append(upload_keyframe(kf_path, storage_path))

            shot_id = f"shot_{shot['index']:04d}"
            doc_ref = shots_ref.document(shot_id)
            batch.set(doc_ref, {
                "index": shot["index"],
                "startMs": shot["startMs"],
                "endMs": shot["endMs"],
                "keyframeUrl": keyframe_urls[len(keyframe_urls) // 2],
                "keyframeUrls": keyframe_urls,
            })

        batch.commit()

        # 5. Update job status
        job_ref.update({
            "status": "detecting",
            "shotCount": len(shots),
        })

        return len(shots)
