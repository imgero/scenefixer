"""
Phase 5 (final step) — Restitch the fixed clips back into the full video.
Uses FFmpeg concat demuxer to replace broken segments.
"""

import os
import subprocess
import tempfile
from pathlib import Path

import requests

from modal_app.firebase import get_db, get_bucket


def download_file(url: str, dest: str) -> str:
    r = requests.get(url, timeout=180)
    r.raise_for_status()
    with open(dest, "wb") as f:
        f.write(r.content)
    return dest


def get_signed_url(storage_path: str, expiry_hours: int = 24) -> str:
    import datetime as dt
    bucket = get_bucket()
    blob = bucket.blob(storage_path)
    return blob.generate_signed_url(
        expiration=dt.timedelta(hours=expiry_hours),
        method="GET",
        version="v4",
    )


def restitch(job_id: str) -> str:
    """
    Build the final output video:
    1. Get all shots in order
    2. For each shot: use fixedClipUrl if it exists, otherwise cut the original
    3. Concat all clips with FFmpeg
    4. Upload final video to Firebase Storage
    Returns the download URL of the output video.
    """
    db = get_db()
    job = db.collection("jobs").document(job_id).get().to_dict()

    shots_snap = (
        db.collection("jobs")
        .document(job_id)
        .collection("shots")
        .order_by("index")
        .get()
    )
    shots = [{"id": s.id, **s.to_dict()} for s in shots_snap]

    # Build a map: shotId -> fixedClipUrl (if any confirmed+fixed error targets it)
    errors_snap = (
        db.collection("jobs").document(job_id).collection("errors").get()
    )
    # shotId -> (fixedClipUrl, lead-in seconds). The lead-in is how much of the
    # fixed clip sits before the shot begins: a shot shorter than Runway's
    # minimum accepted length is extracted with padding on both sides, so what
    # comes back is longer than the shot and starts earlier than it. Splicing
    # that in whole would replace the shot with a longer segment and push every
    # following segment out of sync with the audio.
    # shotId -> (fixedAt, url, lead-in, span). The FIRST element is the sort
    # key and exists because this map used to be built by plain assignment in
    # document order, so with two fixed errors on one shot the winner was
    # whichever Firestore happened to return last.
    #
    # Fixes on a shot chain — each starts from the previous one's output — so
    # only the MOST RECENT clip contains all of them. Picking any earlier one
    # silently drops every fix that came after it, while the job still reports
    # them verified, because each error is verified against its own output
    # rather than against what was delivered.
    #
    # Observed live on 14 Sep: shot 2 had a wardrobe fix at 14:39:53 and an
    # atmosphere fix chained onto it at 14:44:35. Document order put the
    # wardrobe clip last, so the delivered video had the outfits corrected and
    # the rain back, on a job reporting 3 of 3 verified.
    _best: dict[str, tuple] = {}
    for err_doc in errors_snap:
        err = err_doc.to_dict()
        if err.get("fixStatus") == "fixed" and err.get("fixedClipUrl"):
            fix_direction = err.get("fixDirection", "aTob")
            target_shot = err["shotBId"] if fix_direction == "aTob" else err["shotAId"]

            def _num(key: str) -> float:
                try:
                    return max(0.0, float(err.get(key) or 0.0))
                except (TypeError, ValueError):
                    return 0.0

            # Jobs fixed before fixedAt existed have none; they sort first and
            # so lose to any clip that does carry one, which is the safe
            # direction — a timestamped clip is always the later work.
            fixed_at = err.get("fixedAt")
            sort_key = fixed_at.timestamp() if hasattr(fixed_at, "timestamp") else 0.0

            prior = _best.get(target_shot)
            if prior is None or sort_key >= prior[0]:
                _best[target_shot] = (
                    sort_key,
                    err["fixedClipUrl"],
                    _num("clipLeadInSeconds"),
                    _num("clipSpanSeconds"),
                )

    fixed_clips: dict[str, tuple[str, float, float]] = {
        shot: (url, lead_in, span)
        for shot, (_, url, lead_in, span) in _best.items()
    }

    with tempfile.TemporaryDirectory() as tmp:
        video_local = os.path.join(tmp, "original.mp4")
        download_file(job["inputVideoUrl"], video_local)

        segment_paths = []

        # Probe original to get its stream info
        probe = subprocess.run(
            ["ffprobe", "-v", "error", "-show_streams", "-select_streams", "a",
             "-of", "default=noprint_wrappers=1:nokey=1", video_local],
            capture_output=True, text=True,
        )
        has_audio = bool(probe.stdout.strip())

        # Runway outputs 1280x720 @ 24fps with no audio.
        # Normalise every segment to the same format so concat works cleanly.
        TARGET_W, TARGET_H, TARGET_FPS = 1280, 720, 24
        VF = (
            f"scale={TARGET_W}:{TARGET_H}:force_original_aspect_ratio=decrease,"
            f"pad={TARGET_W}:{TARGET_H}:(ow-iw)/2:(oh-ih)/2:color=black,"
            f"fps={TARGET_FPS}"
        )

        for shot in shots:
            seg_path = os.path.join(tmp, f"seg_{shot['index']}.mp4")

            if shot["id"] in fixed_clips:
                # Runway clip: visual-only output. Re-mux original audio at
                # the shot's exact timestamp so sync and lip movements stay
                # identical — Aleph never touches anything outside the marked
                # region, so this is always frame-accurate.
                raw_path = os.path.join(tmp, f"seg_{shot['index']}_raw.mp4")
                fixed_url, lead_in, clip_span_s = fixed_clips[shot["id"]]
                download_file(fixed_url, raw_path)

                shot_span_s = (shot["endMs"] - shot["startMs"]) / 1000.0
                # Keyed on the clip being longer than the shot, not on lead_in
                # alone: a short shot at the very start of a video gets all its
                # padding on the trailing side, so lead_in is zero and the clip
                # is still too long. Errors fixed before clipSpanSeconds existed
                # record 0 and are left alone.
                if clip_span_s > shot_span_s + 0.01:
                    # Cut the padding back off so the segment covers exactly the
                    # shot again.
                    trimmed_path = os.path.join(tmp, f"seg_{shot['index']}_trim.mp4")
                    subprocess.run(
                        [
                            "ffmpeg", "-y",
                            "-ss", str(lead_in),
                            "-i", raw_path,
                            "-t", str(shot_span_s),
                            "-c:v", "libx264", "-crf", "18",
                            "-pix_fmt", "yuv420p",
                            "-an",
                            trimmed_path,
                        ],
                        capture_output=True, check=True,
                    )
                    raw_path = trimmed_path

                if has_audio:
                    audio_path = os.path.join(tmp, f"audio_{shot['index']}.aac")
                    subprocess.run(
                        [
                            "ffmpeg", "-y",
                            "-ss", str(shot["startMs"] / 1000.0),
                            "-i", video_local,
                            "-t", str(shot_span_s),
                            "-vn", "-c:a", "aac", "-ar", "44100", "-ac", "2",
                            audio_path,
                        ],
                        capture_output=True, check=True,
                    )
                    cmd = [
                        "ffmpeg", "-y",
                        "-i", raw_path,
                        "-i", audio_path,
                        "-vf", VF,
                        "-c:v", "libx264", "-crf", "23",
                        "-map", "0:v:0", "-map", "1:a:0",
                        "-c:a", "aac", "-shortest",
                        seg_path,
                    ]
                else:
                    cmd = [
                        "ffmpeg", "-y",
                        "-i", raw_path,
                        "-vf", VF,
                        "-c:v", "libx264", "-crf", "23",
                        "-an",
                        seg_path,
                    ]
            else:
                # Original segment: scale + fps-match to Runway output dimensions.
                duration_s = (shot["endMs"] - shot["startMs"]) / 1000.0
                cmd = [
                    "ffmpeg", "-y",
                    "-ss", str(shot["startMs"] / 1000.0),
                    "-i", video_local,
                    "-t", str(duration_s),
                    "-vf", VF,
                    "-c:v", "libx264", "-crf", "23",
                ]
                if has_audio:
                    cmd += ["-c:a", "aac"]
                else:
                    cmd += ["-an"]
                cmd.append(seg_path)

            seg_result = subprocess.run(cmd, capture_output=True)
            if seg_result.returncode != 0:
                raise RuntimeError(
                    f"FFmpeg segment {shot['index']} failed (rc={seg_result.returncode}):\n"
                    + seg_result.stderr.decode(errors="replace")[-2000:]
                )
            segment_paths.append(seg_path)

        # All segments are now 1280×720 / 24fps / same audio layout — safe to copy.
        manifest_path = os.path.join(tmp, "concat.txt")
        with open(manifest_path, "w") as f:
            for seg in segment_paths:
                f.write(f"file '{seg}'\n")

        output_path = os.path.join(tmp, "output.mp4")
        result = subprocess.run(
            [
                "ffmpeg", "-y",
                "-f", "concat", "-safe", "0",
                "-i", manifest_path,
                "-c", "copy",
                output_path,
            ],
            capture_output=True,
        )
        if result.returncode != 0:
            raise RuntimeError(
                f"FFmpeg concat failed (rc={result.returncode}):\n"
                + result.stderr.decode(errors="replace")[-2000:]
            )

        # Upload to Firebase Storage
        output_storage = f"jobs/{job_id}/output.mp4"
        bucket = get_bucket()
        bucket.blob(output_storage).upload_from_filename(
            output_path, content_type="video/mp4"
        )

        bucket_name = bucket.name
        encoded = output_storage.replace("/", "%2F")
        output_url = f"https://firebasestorage.googleapis.com/v0/b/{bucket_name}/o/{encoded}?alt=media"
        db.collection("jobs").document(job_id).update({
            "outputVideoUrl": output_url,
            "stitchVideoUrl": output_url,  # permanent reference to pre-post-process output for re-processing
        })
        return output_url
