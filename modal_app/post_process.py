"""
Post-processing — runs after stitch.py produces the output video.
Applies quality scaling and watermark based on the job owner's plan.

Quality ladder:
  free    → 480p  + "Fixed with Scene Fixer" watermark
  starter → 720p  (native Aleph output, no watermark)
  pro     → 1080p (bicubic upscale, no watermark)
  studio  → 1080p (bicubic upscale, no watermark)
"""

import os
import subprocess
import tempfile

import requests

from modal_app.firebase import get_db, get_bucket

QUALITY_MAP = {
    "free":    {"height": 480,  "watermark": True},
    "starter": {"height": 720,  "watermark": False},
    "pro":     {"height": 1080, "watermark": False},
    "studio":  {"height": 1080, "watermark": False},
}

WATERMARK_TEXT = "Fixed with Scene Fixer"


def _public_url(bucket_name: str, storage_path: str) -> str:
    encoded = storage_path.replace("/", "%2F")
    return f"https://firebasestorage.googleapis.com/v0/b/{bucket_name}/o/{encoded}?alt=media"


def run_post_process(job_id: str) -> str:
    """
    1. Read job doc to get outputVideoUrl and plan/watermark flags.
    2. Download the stitched output.
    3. Scale to the plan's target height (bicubic, maintain aspect).
    4. Optionally burn the watermark text.
    5. Upload the final processed video back to Firebase Storage.
    6. Update job.outputVideoUrl with the processed video URL.
    Returns the new public output URL.
    """
    db = get_db()
    job = db.collection("jobs").document(job_id).get().to_dict()
    if not job:
        raise ValueError(f"Job {job_id} not found")

    # Always use the original stitch output as source so re-processing
    # doesn't degrade quality by re-encoding an already-processed file.
    output_url = job.get("stitchVideoUrl") or job.get("outputVideoUrl")
    if not output_url:
        raise ValueError(f"Job {job_id} has no outputVideoUrl — run stitch first")

    watermark: bool = job.get("watermark", False)
    quality_label: str = job.get("outputQuality", "720p").lower().replace("p", "")
    try:
        target_h = int(quality_label)
    except ValueError:
        target_h = 720

    add_watermark = watermark  # free plan only

    with tempfile.TemporaryDirectory() as tmp:
        raw_path = os.path.join(tmp, "output_raw.mp4")
        r = requests.get(output_url, timeout=300, stream=True)
        r.raise_for_status()
        with open(raw_path, "wb") as f:
            for chunk in r.iter_content(chunk_size=8192):
                f.write(chunk)

        processed_path = os.path.join(tmp, "output_processed.mp4")

        # Scale filter: maintain aspect ratio, pad to even dimensions.
        # For 1080p we upscale; for 480p we downscale.
        scale_filter = (
            f"scale=-2:{target_h}:flags=bicubic,"
            f"pad=iw:ih:0:0:color=black"
        )

        if add_watermark:
            font_size = max(18, target_h // 25)
            padding = max(10, target_h // 50)
            watermark_filter = (
                f"drawtext=text='{WATERMARK_TEXT}'"
                f":fontfile=/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf"
                f":fontsize={font_size}"
                f":fontcolor=white@0.7"
                f":x=w-tw-{padding}"
                f":y=h-th-{padding}"
                f":shadowcolor=black@0.5:shadowx=1:shadowy=1"
            )
            vf = f"{scale_filter},{watermark_filter}"
        else:
            vf = scale_filter

        result = subprocess.run(
            [
                "ffmpeg", "-y",
                "-i", raw_path,
                "-vf", vf,
                "-c:v", "libx264", "-crf", "20", "-preset", "fast",
                "-c:a", "aac", "-b:a", "128k",
                "-movflags", "+faststart",
                processed_path,
            ],
            capture_output=True,
        )
        if result.returncode != 0:
            raise RuntimeError(
                f"post_process FFmpeg failed:\n{result.stderr.decode(errors='replace')[-2000:]}"
            )

        bucket = get_bucket()
        storage_path = f"jobs/{job_id}/output_final.mp4"
        bucket.blob(storage_path).upload_from_filename(
            processed_path, content_type="video/mp4"
        )
        final_url = _public_url(bucket.name, storage_path)

    db.collection("jobs").document(job_id).update({"outputVideoUrl": final_url})
    print(f"post_process done: {job_id} → {target_h}p watermark={add_watermark}")
    return final_url
