"""
Phase 5 — Fix confirmed errors using Runway aleph2.
Flow per error:
  1. Extract shot clip (no audio, 1280×720, ≤5s)
  2. Upload clip to Firebase Storage (public URL for Runway to fetch)
  3. Submit to Runway aleph2 with inpainting prompt
  4. Poll until SUCCEEDED
  5. Download Runway output, verify with Opus 4.7, re-upload to Firebase
"""

import base64
import json
import math
import os
import subprocess
import tempfile
import time

import anthropic
import requests

from modal_app.firebase import get_db, get_bucket
from modal_app.prompts import build_aleph_prompt

MAX_CLIP_DURATION = 28.0  # aleph2 accepts up to 30s; 28s gives a small safety margin
MIN_CLIP_DURATION = 1.1  # Runway rejects clips < 1s; pad a bit for safety
TARGET_W, TARGET_H = 1280, 720
RUNWAY_BASE = "https://api.dev.runwayml.com"
RUNWAY_VERSION = "2024-11-06"
# gen4_aleph reached its sunset date on 2026-07-30 and now 400s on every
# request. aleph2 is its replacement for /v1/video_to_video.
RUNWAY_MODEL = "aleph2"
RUNWAY_PROMPT_MAX = 1000  # aleph2 promptText maxLength


def _public_url(bucket_name: str, storage_path: str) -> str:
    encoded = storage_path.replace("/", "%2F")
    return f"https://firebasestorage.googleapis.com/v0/b/{bucket_name}/o/{encoded}?alt=media"


def extract_clip(video_path: str, start_ms: float, end_ms: float, out_path: str) -> str:
    """
    Extract a 1280x720 / 24fps clip for Aleph.

    Aleph rejects clips < 1 second, so for short shots we extend the clip
    by going earlier and later in the source video. The fixed clip will be
    trimmed back to the original shot duration at stitch time so video
    sync is preserved.
    """
    shot_dur = (end_ms - start_ms) / 1000.0
    duration_s = max(MIN_CLIP_DURATION, min(shot_dur, MAX_CLIP_DURATION))

    if duration_s > shot_dur:
        # Center the extra padding around the original shot midpoint
        extra = duration_s - shot_dur
        start_s = max(0.0, start_ms / 1000.0 - extra / 2)
    else:
        start_s = start_ms / 1000.0

    result = subprocess.run(
        [
            "ffmpeg", "-y",
            "-ss", str(start_s),
            "-i", video_path,
            "-t", str(duration_s),
            "-vf",
            f"scale={TARGET_W}:{TARGET_H}:force_original_aspect_ratio=decrease,"
            f"pad={TARGET_W}:{TARGET_H}:(ow-iw)/2:(oh-ih)/2:color=black,fps=24",
            "-c:v", "libx264", "-crf", "18",
            "-pix_fmt", "yuv420p",
            "-an",
            out_path,
        ],
        capture_output=True,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"extract_clip failed:\n{result.stderr.decode(errors='replace')[-1000:]}"
        )
    return out_path


def refund_error_credits(db, job_id: str, error_id: str, error: dict, reason: str) -> int:
    """
    Return an error's credits to its owner. Idempotent; returns the amount refunded.

    A missing `creditsDeducted` refunds ZERO. It used to default to 5, which
    meant a malformed error document minted five credits out of nothing every
    time it was refunded. Absent is not "probably five" — it means nothing was
    charged, so nothing is owed.
    """
    if error.get("autoRefunded"):
        return 0

    secs = error.get("creditsDeducted")
    secs = int(secs) if isinstance(secs, (int, float)) and secs > 0 else 0
    if secs <= 0:
        return 0

    job = db.collection("jobs").document(job_id).get().to_dict() or {}
    owner_uid = job.get("ownerUid")
    if not owner_uid:
        return 0  # beta/anonymous job — no account to credit

    from google.cloud.firestore_v1 import Increment
    db.collection("users").document(owner_uid).update({"creditsBalance": Increment(secs)})
    db.collection("jobs").document(job_id).collection("errors").document(error_id).update(
        {"autoRefunded": True, "refundReason": reason}
    )
    print(f"Refunded {secs} credits to {owner_uid} for error {error_id} ({reason})")
    return secs


def _cost_credits(task_data: dict) -> float | None:
    """
    Credits charged, from a terminal task payload.

    Runway returns `cost` as an object — {"credits": 280} — not a scalar. Read
    it defensively: a scalar is accepted too, so a future shape change degrades
    to None rather than throwing inside a fix that already succeeded and was
    already paid for.
    """
    cost = task_data.get("cost")
    if isinstance(cost, dict):
        cost = cost.get("credits")
    if isinstance(cost, (int, float)):
        return float(cost)
    return None


def runway_credit_balance() -> int | None:
    """
    Current Runway org credit balance, or None if it cannot be read.

    Sampled after each completed fix so spend-down is visible over time without
    anyone having to open the Runway dashboard. Best-effort by design: this must
    never be able to fail a fix that already succeeded.
    """
    try:
        resp = requests.get(
            f"{RUNWAY_BASE}/v1/organization",
            headers={
                "Authorization": f"Bearer {os.environ['RUNWAYML_API_SECRET']}",
                "X-Runway-Version": RUNWAY_VERSION,
            },
            timeout=15,
        )
        resp.raise_for_status()
        return resp.json().get("creditBalance")
    except Exception as exc:
        print(f"runway_credit_balance failed: {exc}")
        return None


def apply_runway_fix(
    clip_public_url: str,
    prompt: str,
    marker_url: str | None = None,
    fallback_prompt: str | None = None,
) -> dict:
    """
    Submit clip to Runway aleph2. Returns {"url", "cost", "task_id"}.

    `cost` is the credits Runway actually charged for this generation, read off
    the SUCCEEDED task. It is the real number, not an estimate derived from
    clip duration, and it is what the pricing model should be rebuilt from.

    Migrated from gen4_aleph, which reached its sunset date on 2026-07-30 and
    returns 400 for every request. The request shape is NOT a drop-in — checked
    against the live OpenAPI spec (docs.dev.runwayml.com/openapi.json):

      * `ratio` is deprecated on aleph2 and is no longer sent. Output geometry
        follows the input clip, which extract_clip already normalises to
        1280x720/24fps.
      * `references` does not exist on aleph2. The nearest equivalent is
        `keyframes` — a timed guidance image anchored at a timestamp. Only the
        wholeclip (lighting/atmosphere) path ever passed an image here, and it
        passes a clean unannotated keyframe, so anchoring it at t=0 is safe.
        The in-video red box is burned into the clip itself and is unaffected.
      * `range` is deliberately omitted: it restricts the edit to a time
        window, which for a whole-clip regrade is the opposite of intended.
      * videoUri must be <= 30s, which MAX_CLIP_DURATION already guarantees.

    If Runway rejects the keyframes payload (400), automatically retries with
    `fallback_prompt` and no keyframes — so malformed guidance never kills the
    whole fix.

    Uses requests (not httpx/SDK) to avoid SSL issues in Modal.
    Polls up to 12 minutes.
    """
    api_key = os.environ["RUNWAYML_API_SECRET"]
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "X-Runway-Version": RUNWAY_VERSION,
    }

    base_payload: dict = {
        "model": RUNWAY_MODEL,
        "promptText": prompt[:RUNWAY_PROMPT_MAX],
        "videoUri": clip_public_url,
    }

    if marker_url:
        payload = {
            **base_payload,
            "keyframes": [{"uri": marker_url, "seconds": 0}],
        }
    else:
        payload = base_payload

    print(f"Runway submit prompt: {prompt!r} marker={bool(marker_url)}")
    resp = requests.post(
        f"{RUNWAY_BASE}/v1/video_to_video",
        headers=headers,
        json=payload,
        timeout=60,
    )

    if not resp.ok and resp.status_code == 400 and marker_url:
        body = resp.text
        print(f"Runway rejected request with marker ({body[:300]}); retrying without marker")
        retry_prompt = fallback_prompt or prompt
        retry_payload = {**base_payload, "promptText": retry_prompt}
        print(f"Runway retry prompt: {retry_prompt!r}")
        resp = requests.post(
            f"{RUNWAY_BASE}/v1/video_to_video",
            headers=headers,
            json=retry_payload,
            timeout=60,
        )

    if not resp.ok:
        raise RuntimeError(
            f"Runway submit failed ({resp.status_code}): {resp.text[:500]}"
        )
    submitted = resp.json()
    task_id = submitted["id"]
    est = submitted.get("estimatedCost")
    if isinstance(est, dict):
        est = est.get("credits")
    print(f"Runway task submitted: {task_id} (estimatedCost={est} credits)")

    for attempt in range(120):  # 120 × 10s = 20 minutes max
        time.sleep(10)
        poll = requests.get(
            f"{RUNWAY_BASE}/v1/tasks/{task_id}",
            headers=headers,
            timeout=30,
        )
        poll.raise_for_status()
        data = poll.json()
        status = data.get("status")
        print(f"  [{attempt + 1}] Runway task {task_id}: {status}")
        if status == "SUCCEEDED":
            outputs = data.get("output", [])
            if not outputs:
                raise RuntimeError("Runway SUCCEEDED but returned no output URLs")
            # `cost` is only present on terminal tasks and is the actual charge.
            cost = _cost_credits(data)
            print(f"Runway task {task_id} SUCCEEDED: cost={cost} credits")
            return {"url": outputs[0], "cost": cost, "task_id": task_id}
        if status in ("FAILED", "CANCELLED"):
            failure = data.get("failure") or data.get("failureCode") or ""
            raise RuntimeError(f"Runway task {task_id} {status}: {failure}")

    raise RuntimeError(f"Runway task {task_id} timed out after 20 minutes")


def _encode_jpeg(frame) -> str:
    import cv2
    _, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 90])
    return base64.b64encode(buf).decode()


def relocate_object(keyframe_url: str, description: str) -> dict | None:
    """
    Ask Opus 4.7 for a tight bounding box around the described object.
    Returns {"x", "y", "w", "h"} as fractions, or None if not found.
    """
    if not keyframe_url or not description:
        return None
    client = anthropic.Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])
    response = client.messages.create(
        model="claude-opus-4-8",
        max_tokens=256,
        messages=[{
            "role": "user",
            "content": [
                {"type": "image", "source": {"type": "url", "url": keyframe_url}},
                {
                    "type": "text",
                    "text": (
                        f"Locate this object in the image: {description}\n\n"
                        f"Return its TIGHTEST bounding box as STRICT JSON:\n"
                        f'{{"x": <float>, "y": <float>, "w": <float>, "h": <float>}}\n'
                        f"All values are fractions of image width/height (0.0–1.0). "
                        f"x,y is the top-left corner of the box. Hug the object "
                        f"tightly — do not include surrounding context or other "
                        f"people.\n\n"
                        f"CRITICAL: only return a bbox if you can clearly SEE "
                        f"the object in this image. If the object is occluded, "
                        f"hidden, or not visible in this frame, return "
                        f'{{"x": null, "y": null, "w": null, "h": null}}. '
                        f"Do not guess — null is the correct answer when not visible."
                    ),
                },
            ],
        }],
    )
    raw = response.content[0].text.strip()
    if raw.startswith("```"):
        raw = raw.split("```")[1]
        if raw.startswith("json"):
            raw = raw[4:]
    try:
        bbox = json.loads(raw)
    except Exception:
        print(f"relocate_object: could not parse {raw[:200]!r}")
        return None
    if not isinstance(bbox, dict):
        return None
    if not all(isinstance(bbox.get(k), (int, float)) for k in ("x", "y", "w", "h")):
        return None
    if bbox["w"] <= 0 or bbox["h"] <= 0:
        return None
    return {k: float(bbox[k]) for k in ("x", "y", "w", "h")}


def relocate_object_best_frame(
    keyframe_urls: list[str],
    description: str,
) -> tuple[dict | None, str | None]:
    """
    Run relocate_object on every keyframe and return the bbox from the frame
    where the object is most clearly visible (largest bbox area among
    confident hits). Returns (bbox, frame_url_picked) or (None, None).

    This is critical for occluded-reveal cases: the cup may be hidden in
    some frames and clearly visible in others. We can't use the middle
    keyframe by default — we must find the frame where the object is there.
    """
    if not keyframe_urls or not description:
        return None, None
    best_bbox = None
    best_url = None
    best_area = 0.0
    for url in keyframe_urls:
        bbox = relocate_object(url, description)
        if bbox is None:
            continue
        area = bbox["w"] * bbox["h"]
        if area > best_area:
            best_area = area
            best_bbox = bbox
            best_url = url
    return best_bbox, best_url


def extract_clip_with_in_video_marker(
    video_path: str,
    start_ms: float,
    end_ms: float,
    bboxes: list[dict] | dict,
    out_path: str,
) -> str:
    """
    Extract a clip AND burn red rectangles into every frame at each bbox.
    Accepts a single bbox dict (legacy) or a list of bboxes (e.g. multiple
    scattered bullet holes).
    """
    shot_dur = (end_ms - start_ms) / 1000.0
    duration_s = max(MIN_CLIP_DURATION, min(shot_dur, MAX_CLIP_DURATION))
    if duration_s > shot_dur:
        extra = duration_s - shot_dur
        start_s = max(0.0, start_ms / 1000.0 - extra / 2)
    else:
        start_s = start_ms / 1000.0

    if isinstance(bboxes, dict):
        bboxes = [bboxes]

    drawbox_parts: list[str] = []
    for bbox in bboxes:
        x_px = int(bbox["x"] * TARGET_W)
        y_px = int(bbox["y"] * TARGET_H)
        w_px = int(bbox["w"] * TARGET_W)
        h_px = int(bbox["h"] * TARGET_H)
        x_px = max(0, min(TARGET_W - 1, x_px))
        y_px = max(0, min(TARGET_H - 1, y_px))
        w_px = max(2, min(TARGET_W - x_px, w_px))
        h_px = max(2, min(TARGET_H - y_px, h_px))
        drawbox_parts.append(
            f"drawbox=x={x_px}:y={y_px}:w={w_px}:h={h_px}:color=red@1.0:thickness=8"
        )

    vf = (
        f"scale={TARGET_W}:{TARGET_H}:force_original_aspect_ratio=decrease,"
        f"pad={TARGET_W}:{TARGET_H}:(ow-iw)/2:(oh-ih)/2:color=black,fps=24,"
        + ",".join(drawbox_parts)
    )

    result = subprocess.run(
        [
            "ffmpeg", "-y",
            "-ss", str(start_s),
            "-i", video_path,
            "-t", str(duration_s),
            "-vf", vf,
            "-c:v", "libx264", "-crf", "18",
            "-pix_fmt", "yuv420p",
            "-an",
            out_path,
        ],
        capture_output=True,
    )
    if result.returncode != 0:
        raise RuntimeError(
            "extract_clip_with_in_video_marker failed:\n"
            + result.stderr.decode(errors="replace")[-1000:]
        )
    return out_path


def make_marker_from_image_url(
    image_url: str,
    bboxes: list[dict] | dict,
    out_path: str,
) -> str:
    """
    Download an image and draw thick red rectangles on it at each bbox.
    Accepts a single bbox (legacy) or list. Returns out_path.
    """
    import cv2
    import numpy as np

    if isinstance(bboxes, dict):
        bboxes = [bboxes]

    r = requests.get(image_url, timeout=60)
    r.raise_for_status()
    arr = np.frombuffer(r.content, dtype=np.uint8)
    frame = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if frame is None:
        raise RuntimeError("make_marker_from_image_url: could not decode image")

    h, w = frame.shape[:2]
    drew_any = False
    for bbox in bboxes:
        x1 = max(0, min(w - 1, int(bbox["x"] * w)))
        y1 = max(0, min(h - 1, int(bbox["y"] * h)))
        x2 = max(0, min(w, int((bbox["x"] + bbox["w"]) * w)))
        y2 = max(0, min(h, int((bbox["y"] + bbox["h"]) * h)))
        if x2 <= x1 or y2 <= y1:
            continue
        cv2.rectangle(frame, (x1, y1), (x2, y2), (0, 0, 255), 8)
        drew_any = True
    if not drew_any:
        raise RuntimeError("make_marker_from_image_url: no valid bboxes to draw")
    cv2.imwrite(out_path, frame, [cv2.IMWRITE_JPEG_QUALITY, 95])
    return out_path


def make_marker_frame(
    video_path: str,
    bbox: dict,
    out_path: str,
    frame_pct: float = 0.5,
) -> str:
    """
    Extract a frame from a clip and draw a thick red rectangle on it
    at the given bbox. frame_pct chooses which frame (0.0 = first, 1.0 = last).
    """
    import cv2

    cap = cv2.VideoCapture(video_path)
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) or 1
    idx = max(0, min(total - 1, int(total * frame_pct)))
    cap.set(cv2.CAP_PROP_POS_FRAMES, idx)
    ok, frame = cap.read()
    cap.release()
    if not ok:
        raise RuntimeError("make_marker_frame: could not read frame")

    h, w = frame.shape[:2]
    x1 = max(0, min(w - 1, int(bbox["x"] * w)))
    y1 = max(0, min(h - 1, int(bbox["y"] * h)))
    x2 = max(0, min(w, int((bbox["x"] + bbox["w"]) * w)))
    y2 = max(0, min(h, int((bbox["y"] + bbox["h"]) * h)))
    if x2 <= x1 or y2 <= y1:
        raise RuntimeError("make_marker_frame: degenerate bbox")

    # OpenCV uses BGR; (0, 0, 255) = red. Thick line so Aleph sees it clearly.
    cv2.rectangle(frame, (x1, y1), (x2, y2), (0, 0, 255), 8)
    cv2.imwrite(out_path, frame, [cv2.IMWRITE_JPEG_QUALITY, 95])
    return out_path


def verify_fix(fixed_clip_path: str, error: dict) -> dict:
    """
    Sample 5 frames evenly across the fixed clip and ask Opus 4.7 if the
    original error is still visible in ANY of them.

    We send full frames only (no bbox crops) — bbox accuracy from detection
    is unreliable enough that crops can point at the wrong region and produce
    false 'fixed' verdicts.

    Returns {"errorStillVisible": bool|null, "confidence": str, "notes": str}.
    """
    import cv2

    cap = cv2.VideoCapture(fixed_clip_path)
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) or 1

    frames = []
    for pct in (0.1, 0.3, 0.5, 0.7, 0.9):
        cap.set(cv2.CAP_PROP_POS_FRAMES, int(total * pct))
        ok, frame = cap.read()
        if ok:
            frames.append(frame)
    cap.release()

    if not frames:
        return {
            "errorStillVisible": None,
            "confidence": "low",
            "notes": "Could not extract frames from fixed clip",
        }

    description = error.get("description", "")
    err_type = error.get("type", "prop")
    fix_mode = (error.get("fixMode") or "remove").lower()
    replace_with = (error.get("replaceWith") or "").strip()
    from modal_app.prompts import _starts_with_add_verb
    # Any replace operation with a specified target should verify that the
    # replacement is present — not whether the original error is absent.
    # The old _starts_with_add_verb check was too narrow: noun-phrase replacements
    # like "the drinking glass" don't start with a verb but are still add operations.
    is_add_mode = fix_mode == "replace" and bool(replace_with)

    content: list = []
    for i, frame in enumerate(frames, start=1):
        content.append({"type": "text", "text": f"Frame {i} of {len(frames)} from the EDITED clip:"})
        content.append({
            "type": "image",
            "source": {"type": "base64", "media_type": "image/jpeg", "data": _encode_jpeg(frame)},
        })

    if is_add_mode:
        audit_text = (
            f"You are auditing a video edit. The intended fix was to replace or add:\n"
            f"  Target: {replace_with}\n"
            f"  Original issue: {description}\n\n"
            f"Scan all {len(frames)} frames above. The fix SUCCEEDED if the target "
            f"({replace_with}) is now clearly visible and naturally placed in the scene — "
            f"or if the corrected area matches the intended replacement.\n\n"
            f"Question: did the fix fail — is the target STILL ABSENT or unchanged?\n\n"
            f"Strict rules:\n"
            f"- If the target is now clearly present or applied in at least some frames → errorStillVisible: false (fix succeeded).\n"
            f"- If the target is absent, only a ghost, or the area is unchanged → errorStillVisible: true (fix failed).\n"
            f"- If unsure, lean toward false (benefit of the doubt for a successful replacement).\n\n"
            f'Return STRICT JSON only: {{"errorStillVisible": true|false, '
            f'"confidence": "low|medium|high", "notes": "one sentence — name the '
            f'frame(s) and exactly what you see or do not see"}}'
        )
    else:
        audit_text = (
            f"You are auditing a video edit. The ORIGINAL error was:\n"
            f"  Description: {description}\n"
            f"  Type: {err_type}\n\n"
            f"Scan all {len(frames)} frames above CAREFULLY. The error may be small "
            f"(less than 5% of the frame), partially occluded, or in shadow. "
            f"Look at every part of every frame, especially tables, hands, and "
            f"foreground surfaces.\n\n"
            f"Question: is the described error still visible in ANY frame?\n\n"
            f"Strict rules:\n"
            f"- Even partial visibility, faint outlines, distortion artifacts, "
            f"or a clearly modern stand-in (e.g. a paper cup replaced with a "
            f"goblet would still count) → errorStillVisible: true.\n"
            f"- If you see ANY object on the table or in the scene that fits the "
            f"original description in ANY frame → true.\n"
            f"- If unsure, return true. False negatives are worse than false positives.\n\n"
            f'Return STRICT JSON only: {{"errorStillVisible": true|false, '
            f'"confidence": "low|medium|high", "notes": "one sentence — name the '
            f'frame(s) and exactly what you see or do not see"}}'
        )

    content.append({"type": "text", "text": audit_text})

    client = anthropic.Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])
    response = client.messages.create(
        model="claude-opus-4-8",
        max_tokens=512,
        messages=[{"role": "user", "content": content}],
    )

    raw = response.content[0].text.strip()
    if raw.startswith("```"):
        raw = raw.split("```")[1]
        if raw.startswith("json"):
            raw = raw[4:]

    try:
        return json.loads(raw)
    except Exception:
        return {"errorStillVisible": None, "confidence": "low", "notes": raw[:200]}


def _fix_long_shot_chunked(
    job_id: str,
    error_id: str,
    fix_shot: dict,
    video_local: str,
    target_bboxes: list[dict],
    in_video_marker: bool,
    prompt: str,
    bucket,
    tmp: str,
    reference_url: str | None = None,
) -> tuple[str, float | None]:
    """
    Fix a shot longer than MAX_CLIP_DURATION by splitting into ≤5s chunks,
    running each through Runway aleph2, then concatenating the results.
    Returns (local path to the final concatenated fixed clip, total credits charged).
    """
    shot_start_ms = fix_shot["startMs"]
    shot_end_ms = fix_shot["endMs"]
    shot_dur = (shot_end_ms - shot_start_ms) / 1000.0

    n_chunks = math.ceil(shot_dur / MAX_CLIP_DURATION)
    chunk_dur_ms = (shot_end_ms - shot_start_ms) / n_chunks

    print(f"  Chunking {shot_dur:.1f}s shot into {n_chunks} × {chunk_dur_ms/1000:.1f}s chunks")

    fixed_chunk_paths: list[str] = []
    total_cost = 0.0
    cost_known = True

    for i in range(n_chunks):
        chunk_start_ms = shot_start_ms + i * chunk_dur_ms
        chunk_end_ms = min(shot_start_ms + (i + 1) * chunk_dur_ms, shot_end_ms)

        chunk_local = os.path.join(tmp, f"chunk_{i}.mp4")
        chunk_fixed_local = os.path.join(tmp, f"chunk_{i}_fixed.mp4")

        # Extract chunk (burn bbox marker into every frame if available)
        if in_video_marker and target_bboxes:
            extract_clip_with_in_video_marker(
                video_local, chunk_start_ms, chunk_end_ms, target_bboxes, chunk_local
            )
        else:
            extract_clip(video_local, chunk_start_ms, chunk_end_ms, chunk_local)

        # Upload chunk so Runway can fetch it via public URL
        chunk_storage = f"jobs/{job_id}/clips/{error_id}_chunk{i}.mp4"
        bucket.blob(chunk_storage).upload_from_filename(chunk_local, content_type="video/mp4")
        chunk_public_url = _public_url(bucket.name, chunk_storage)

        print(f"  Chunk {i+1}/{n_chunks}: sending to Runway…")
        rw = apply_runway_fix(chunk_public_url, prompt, marker_url=reference_url)
        runway_url = rw["url"]
        if rw.get("cost") is None:
            cost_known = False
        else:
            total_cost += float(rw["cost"])

        r = requests.get(runway_url, timeout=180, stream=True)
        r.raise_for_status()
        with open(chunk_fixed_local, "wb") as f:
            for data in r.iter_content(chunk_size=8192):
                f.write(data)

        fixed_chunk_paths.append(chunk_fixed_local)

    # Concat all fixed chunks into one clip
    concat_txt = os.path.join(tmp, "chunks_concat.txt")
    with open(concat_txt, "w") as f:
        for p in fixed_chunk_paths:
            f.write(f"file '{p}'\n")

    final_path = os.path.join(tmp, f"chunked_fixed_{error_id}.mp4")
    result = subprocess.run(
        ["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", concat_txt, "-c", "copy", final_path],
        capture_output=True,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"Chunk concat failed:\n{result.stderr.decode(errors='replace')[-1000:]}"
        )

    print(
        f"  Chunked fix done: {len(fixed_chunk_paths)} chunks → {final_path} "
        f"(total cost={total_cost if cost_known else 'unknown'} credits)"
    )
    # None rather than a partial sum: a half-known total silently understates
    # cost, and the pricing model is going to be rebuilt from these numbers.
    return final_path, (total_cost if cost_known else None)


def fix_single_error(job_id: str, error_id: str) -> None:
    """Fix one confirmed error using Runway aleph2. Updates error.fixStatus in Firestore."""
    db = get_db()
    error_ref = (
        db.collection("jobs").document(job_id)
          .collection("errors").document(error_id)
    )
    error = error_ref.get().to_dict()

    if not error or not error.get("userConfirmed"):
        return
    if error.get("fixStatus") == "fixed":
        return

    error_ref.update({"fixStatus": "fixing"})

    try:
        fix_direction = error.get("fixDirection", "aTob")
        fix_shot_id = error["shotBId"] if fix_direction == "aTob" else error["shotAId"]

        shots_ref = db.collection("jobs").document(job_id).collection("shots")
        fix_shot = shots_ref.document(fix_shot_id).get().to_dict()

        job = db.collection("jobs").document(job_id).get().to_dict()
        bucket = get_bucket()

        with tempfile.TemporaryDirectory() as tmp:
            # Download original video
            video_local = os.path.join(tmp, "video.mp4")
            r = requests.get(job["inputVideoUrl"], timeout=180, stream=True)
            r.raise_for_status()
            with open(video_local, "wb") as f:
                for chunk in r.iter_content(chunk_size=8192):
                    f.write(chunk)

            # Lighting and atmosphere errors are whole-clip color transforms —
            # spatial bboxes are irrelevant and will cause Aleph to inpaint a
            # region instead of regrading the full frame. Skip all bbox logic.
            err_type = error.get("type", "other")
            is_wholeclip_type = err_type in ("lighting", "atmosphere")

            # Pick the bbox(es) to use. New multi-box manual errors store an
            # array under `bboxes`; legacy auto errors store a single dict in
            # bboxA/bboxB based on which shot is the target.
            multi_bboxes_raw = error.get("bboxes") if not is_wholeclip_type else None
            target_bboxes: list[dict] = []
            if isinstance(multi_bboxes_raw, list):
                target_bboxes = [b for b in multi_bboxes_raw if isinstance(b, dict)]
            if not target_bboxes and not is_wholeclip_type:
                # Single-bbox fallback (auto-detected errors).
                bbox_field = "bboxB" if fix_direction == "aTob" else "bboxA"
                single = error.get(bbox_field)
                if not isinstance(single, dict):
                    for fb in ("bboxB", "bboxA"):
                        if isinstance(error.get(fb), dict):
                            single = error[fb]
                            break
                if isinstance(single, dict):
                    target_bboxes = [single]

            # Legacy variable for downstream code that expects "the" bbox.
            target_bbox = target_bboxes[0] if target_bboxes else None
            # In-video marker whenever we have any precise bbox(es).
            in_video_marker = len(target_bboxes) > 0

            # Extract shot clip. For in-video marker mode, burn the red box
            # into every frame — strongest possible signal for Aleph.
            clip_local = os.path.join(tmp, f"clip_{error_id}.mp4")
            if in_video_marker:
                extract_clip_with_in_video_marker(
                    video_local,
                    fix_shot["startMs"],
                    fix_shot["endMs"],
                    target_bboxes,
                    clip_local,
                )
                print(
                    f"Extracted clip with {len(target_bboxes)} in-video marker(s)"
                )
            else:
                extract_clip(video_local, fix_shot["startMs"], fix_shot["endMs"], clip_local)

            # Upload input clip to Firebase so Runway can fetch it via public URL
            clip_storage = f"jobs/{job_id}/clips/{error_id}_input.mp4"
            bucket.blob(clip_storage).upload_from_filename(clip_local, content_type="video/mp4")
            clip_public_url = _public_url(bucket.name, clip_storage)

            marker_url: str | None = None
            relocated_bbox: dict | None = None
            best_keyframe_url: str | None = None

            # For wholeclip types, skip the marker pipeline entirely and instead
            # use the first keyframe of the shot as an Aleph reference image.
            # This gives Aleph a visual anchor for the "correct" look without
            # confusing it with spatial inpainting signals.
            if is_wholeclip_type:
                kf_urls = fix_shot.get("keyframeUrls") or []
                if not isinstance(kf_urls, list) or not kf_urls:
                    single = fix_shot.get("keyframeUrl")
                    kf_urls = [single] if isinstance(single, str) else []
                if kf_urls:
                    marker_url = kf_urls[0]
                    print(f"Wholeclip reference frame: {marker_url}")

            # When the red box is burned into the video itself, we don't
            # also send a separate reference image — the in-video marker is
            # already the dominant signal and a competing reference can
            # confuse Aleph.
            try:
                if is_wholeclip_type:
                    pass  # handled above — no marker image construction needed
                elif in_video_marker:
                    # Marker is INSIDE the video; no separate reference needed.
                    relocated_bbox = target_bbox
                    # Still produce a marker preview image for the UI so the
                    # user can confirm where the red box is. Prefer the
                    # manualFrameUrl the user picked; for auto errors, use the
                    # target shot's middle keyframe.
                    preview_source = error.get("manualFrameUrl")
                    if not preview_source:
                        ks = fix_shot.get("keyframeUrls") or []
                        if isinstance(ks, list) and ks:
                            preview_source = ks[len(ks) // 2]
                        else:
                            preview_source = fix_shot.get("keyframeUrl")
                    if preview_source:
                        try:
                            marker_local = os.path.join(tmp, f"marker_{error_id}.jpg")
                            make_marker_from_image_url(
                                preview_source, target_bboxes, marker_local
                            )
                            marker_storage = (
                                f"jobs/{job_id}/clips/{error_id}_marker.jpg"
                            )
                            bucket.blob(marker_storage).upload_from_filename(
                                marker_local, content_type="image/jpeg"
                            )
                            marker_preview_url = _public_url(bucket.name, marker_storage)
                            print(
                                f"In-video marker mode — UI preview: {marker_preview_url}"
                            )
                            error["_marker_preview_url"] = marker_preview_url
                        except Exception as e:
                            print(f"Could not build marker preview: {e}")
                elif error.get("manualMarker") and target_bboxes:
                    # USER-MARKED legacy branch (no in_video_marker — shouldn't
                    # happen anymore since target_bboxes implies in_video_marker
                    # above, but kept as a safety net).
                    manual_frame_url = error.get("manualFrameUrl")
                    if not manual_frame_url:
                        raise RuntimeError("manualMarker set but manualFrameUrl missing")
                    marker_local = os.path.join(tmp, f"marker_{error_id}.jpg")
                    make_marker_from_image_url(
                        manual_frame_url, target_bboxes, marker_local
                    )
                    marker_storage = f"jobs/{job_id}/clips/{error_id}_marker.jpg"
                    bucket.blob(marker_storage).upload_from_filename(
                        marker_local, content_type="image/jpeg"
                    )
                    marker_url = _public_url(bucket.name, marker_storage)
                    relocated_bbox = target_bbox
                    print(f"Manual marker frame uploaded: {marker_url}")
                else:
                    # AUTO: re-localize across keyframes, pick best, draw marker.
                    keyframe_urls = fix_shot.get("keyframeUrls") or []
                    if not isinstance(keyframe_urls, list) or not keyframe_urls:
                        single = fix_shot.get("keyframeUrl")
                        keyframe_urls = [single] if isinstance(single, str) else []

                    relocated_bbox, best_keyframe_url = relocate_object_best_frame(
                        keyframe_urls,
                        error.get("description", ""),
                    )
                    bbox_for_marker = relocated_bbox or (
                        error.get("bboxB") if isinstance(error.get("bboxB"), dict) else None
                    )

                    frame_pct = 0.5
                    if best_keyframe_url and best_keyframe_url in keyframe_urls:
                        idx = keyframe_urls.index(best_keyframe_url)
                        if len(keyframe_urls) > 1:
                            frame_pct = idx / (len(keyframe_urls) - 1)
                        print(
                            f"Best keyframe for marker: frame {idx + 1}/{len(keyframe_urls)} "
                            f"(clip pct={frame_pct:.2f})"
                        )

                    if bbox_for_marker:
                        marker_local = os.path.join(tmp, f"marker_{error_id}.jpg")
                        make_marker_frame(
                            clip_local, bbox_for_marker, marker_local, frame_pct=frame_pct
                        )
                        marker_storage = f"jobs/{job_id}/clips/{error_id}_marker.jpg"
                        bucket.blob(marker_storage).upload_from_filename(
                            marker_local, content_type="image/jpeg"
                        )
                        marker_url = _public_url(bucket.name, marker_storage)
                        print(f"Marker frame uploaded: {marker_url}")
            except Exception as marker_err:
                # If marker construction fails, fall back to text-only Aleph.
                print(f"Marker pipeline failed (continuing without): {marker_err}")
                marker_url = None

            # Build Aleph prompts
            prompt = build_aleph_prompt(
                error,
                has_marker=bool(marker_url),
                in_video_marker=in_video_marker,
            )
            fallback_prompt = (
                build_aleph_prompt(error, has_marker=False, in_video_marker=in_video_marker)
                if marker_url
                else None
            )

            shot_dur = (fix_shot["endMs"] - fix_shot["startMs"]) / 1000.0
            fixed_local = os.path.join(tmp, f"clip_{error_id}_fixed.mp4")

            runway_cost: float | None = None
            runway_task_id: str | None = None

            if shot_dur > MAX_CLIP_DURATION:
                # Long shot: chunk into ≤5s segments, fix each, concatenate
                chunked_path, runway_cost = _fix_long_shot_chunked(
                    job_id=job_id,
                    error_id=error_id,
                    fix_shot=fix_shot,
                    video_local=video_local,
                    target_bboxes=target_bboxes,
                    in_video_marker=in_video_marker,
                    prompt=prompt,
                    bucket=bucket,
                    tmp=tmp,
                    reference_url=marker_url if is_wholeclip_type else None,
                )
                import shutil
                shutil.copy2(chunked_path, fixed_local)
            else:
                # Short shot (≤5s): single Runway call
                result = apply_runway_fix(
                    clip_public_url,
                    prompt,
                    marker_url=marker_url,
                    fallback_prompt=fallback_prompt,
                )
                runway_url = result["url"]
                runway_cost = result.get("cost")
                runway_task_id = result.get("task_id")
                r2 = requests.get(runway_url, timeout=180, stream=True)
                r2.raise_for_status()
                with open(fixed_local, "wb") as f:
                    for chunk in r2.iter_content(chunk_size=8192):
                        f.write(chunk)

            # Verify with Opus 4.7
            verify_result = verify_fix(fixed_local, error)

            # Re-upload to Firebase as permanent public URL (Runway CDN URLs expire)
            fixed_storage = f"jobs/{job_id}/clips/{error_id}_fixed.mp4"
            bucket.blob(fixed_storage).upload_from_filename(fixed_local, content_type="video/mp4")
            fixed_firebase_url = _public_url(bucket.name, fixed_storage)

        error_still_visible = verify_result.get("errorStillVisible")
        verified_resolved = error_still_visible is False

        update_data = {
            "fixStatus": "fixed",
            "fixedClipUrl": fixed_firebase_url,
            "originalClipUrl": clip_public_url,
            "alephPrompt": prompt,
            "verifyResult": verify_result,
            "verifiedResolved": verified_resolved,
            # Real Runway spend for this fix, straight off the SUCCEEDED task.
            # Recorded per error so cost-per-fix can be rebuilt from Firestore
            # even if telemetry is lost, and so credits charged to the user can
            # be reconciled against credits actually burned.
            "runwayModel": RUNWAY_MODEL,
            "runwayCreditsCharged": runway_cost,
            "runwayTaskId": runway_task_id,
            "shotDurationSeconds": round(shot_dur, 3),
            "creditsChargedToUser": error.get("creditsDeducted"),
        }
        if marker_url:
            update_data["markerUrl"] = marker_url
        elif error.get("_marker_preview_url"):
            update_data["markerUrl"] = error["_marker_preview_url"]
        if relocated_bbox:
            update_data["relocatedBbox"] = relocated_bbox
        error_ref.update(update_data)

        from google.cloud.firestore_v1 import Increment
        db.collection("jobs").document(job_id).update({"fixedCount": Increment(1)})

        # Real unit economics, one event per completed fix. After ~20 of these
        # the cost-per-fix distribution is measured rather than modelled, which
        # is the input the paid tiers get repriced from.
        try:
            from modal_app import analytics
            analytics.capture(
                job_id,
                "fix_completed",
                {
                    "error_id": error_id,
                    "error_type": error.get("type"),
                    "runway_model": RUNWAY_MODEL,
                    "runway_credits_charged": runway_cost,
                    "runway_task_id": runway_task_id,
                    "shot_duration_seconds": round(shot_dur, 3),
                    "credits_charged_to_user": error.get("creditsDeducted"),
                    "runway_balance_after": runway_credit_balance(),
                    "was_chunked": shot_dur > MAX_CLIP_DURATION,
                    "verified_resolved": verified_resolved,
                    "retry_count": error.get("retryCount", 0),
                    # Runway credits per second of output actually delivered.
                    "credits_per_second": (
                        round(float(runway_cost) / shot_dur, 3)
                        if runway_cost is not None and shot_dur > 0
                        else None
                    ),
                },
                job=job,
            )
        except Exception as exc:  # telemetry must never fail a completed fix
            print(f"fix_completed capture failed: {exc}")

        # Auto-refund credits if verification failed on the original fix (not a
        # retry — retries are free so there's nothing to refund).
        if error_still_visible and error.get("retryCount", 0) == 0:
            refunded = refund_error_credits(
                db, job_id, error_id, error, "verification_failed"
            )
            if refunded > 0:
                update_data["autoRefunded"] = True

    except Exception as e:
        import traceback
        full = traceback.format_exc()
        print(f"fix_single_error failed for {error_id}:\n{full}")
        error_ref.update({
            "fixStatus": "failed",
            "errorMessage": str(e),
            "errorDetail": full[-1000:],
        })

        # A fix that threw delivered nothing, so its credits go back. Previously
        # only a FAILED VERIFICATION refunded; an exception kept the credits and
        # the job still reported success. That is the 12 August shape exactly:
        # fixStatus "failed", a Runway sunset error, creditsDeducted 2,
        # autoRefunded false, job status "done".
        try:
            refund_error_credits(db, job_id, error_id, error, "fix_threw")
        except Exception as refund_err:
            print(f"Refund after failure also failed for {error_id}: {refund_err}")

        try:
            from modal_app import analytics
            analytics.capture(
                job_id,
                "fix_error_failed",
                {
                    "error_id": error_id,
                    "error_type": error.get("type"),
                    "error_message": str(e)[:300],
                    "runway_model": RUNWAY_MODEL,
                    "retry_count": error.get("retryCount", 0),
                },
            )
        except Exception as exc:
            print(f"fix_error_failed capture failed: {exc}")

        raise
