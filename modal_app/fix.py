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
import re
import shutil
import subprocess
import tempfile
import time
from datetime import datetime, timezone

import anthropic
import requests

from modal_app.firebase import get_db, get_bucket
from modal_app.prompts import build_aleph_prompt
from modal_app.stitch import mean_luma

# Error types whose subject IS the relationship between two shots' looks.
# Mirrors GRADE_TYPES in detect.py, kept literal to avoid importing the
# detection module into the fix worker.
GRADE_TYPES = {"lighting", "atmosphere", "other"}

# How much further from its reference a fix may drift before the result counts
# as a regression rather than noise, in 0-255 mean luma. Sits above the ~1.4
# step real footage shows at its own cuts, so ordinary variation never trips it.
CONTINUITY_REGRESSION_LUMA = 3.0


def _continuity_regressed(shots_ref, input_video_url, fixed_local, tmp, shot_id, ref_id):
    """
    Did this grade fix move its shot FURTHER from the shot it was told to match?

    Returns (gap_before, gap_after) when it did, else None.

    The Opus verifier checks whether the thing it was asked about is still
    visible, which is not the same question as whether the two shots now match.
    Observed on job v2testou8rhv8vd9: a fix passed with "All frames show a sunny
    sky and green trees through the window with no rain visible anywhere" while
    its mean level moved from 12.4 luma away from the reference shot to 23.3.
    The user's complaint was the mismatch; we widened it and reported success.

    Deliberately one-sided: it only ever fails a fix that made the gap WORSE. A
    fix that closes the gap partway is an improvement and passes, and a shot
    that legitimately differs in average brightness from its reference is not
    penalised as long as the fix did not make that difference larger.
    """
    if not ref_id or ref_id == shot_id:
        return None
    try:
        target = shots_ref.document(shot_id).get().to_dict() or {}
        ref = shots_ref.document(ref_id).get().to_dict() or {}
        if "startMs" not in target or "startMs" not in ref:
            return None

        original = os.path.join(tmp, "continuity_source.mp4")
        if not os.path.exists(original):
            r = requests.get(input_video_url, timeout=180, stream=True)
            r.raise_for_status()
            with open(original, "wb") as f:
                for chunk in r.iter_content(chunk_size=8192):
                    f.write(chunk)

        def shot_luma(shot):
            return mean_luma(
                original,
                ss=shot["startMs"] / 1000.0,
                t=(shot["endMs"] - shot["startMs"]) / 1000.0,
            )

        ref_luma = shot_luma(ref)
        plate_luma = shot_luma(target)
        fixed_luma = mean_luma(fixed_local)
        if None in (ref_luma, plate_luma, fixed_luma):
            return None

        gap_before = abs(plate_luma - ref_luma)
        gap_after = abs(fixed_luma - ref_luma)
        if gap_after > gap_before + CONTINUITY_REGRESSION_LUMA:
            return gap_before, gap_after
    except Exception as e:
        # A measurement problem must never fail a fix that Opus passed.
        print(f"continuity check skipped for {shot_id}: {e}")
    return None

MAX_CLIP_DURATION = 28.0  # aleph2 accepts up to 30s; 28s gives a small safety margin
# aleph2 rejects any videoUri under 2 seconds:
#   {"code":"too_small","minimum":2,"message":"Asset duration must be at least
#    2 seconds","path":["videoUri"]}
# The old value of 1.1 was gen4_aleph's limit (it rejected clips under 1s) and
# survived the aleph2 migration unchanged. Every shot shorter than 2s therefore
# 400'd on submit — on 30 August one 5-shot video with shots of 0.50s, 0.97s,
# 1.00s and 1.50s failed all four fixes for exactly this reason. 2.2s keeps the
# same style of margin over the hard minimum that MAX_CLIP_DURATION keeps under
# the maximum.
MIN_CLIP_DURATION = 2.2
TARGET_W, TARGET_H = 1280, 720
RUNWAY_BASE = "https://api.dev.runwayml.com"
RUNWAY_VERSION = "2024-11-06"
# gen4_aleph reached its sunset date on 2026-07-30 and now 400s on every
# request. aleph2 is its replacement for /v1/video_to_video.
RUNWAY_MODEL = "aleph2"  # default engine; see FIX_ENGINES
RUNWAY_PROMPT_MAX = 1000  # aleph2 promptText maxLength


# ── Fix engines ─────────────────────────────────────────────────────────────
#
# /v1/video_to_video fronts several models with incompatible request shapes,
# limits and prices. Measured against the live API on 2026-09-08, on a 9.2s
# portrait clip whose brief was "match the background environment across all
# frames to a single consistent temple plaza layout":
#
#   aleph2              252 credits, ~2.5 min. Changed 5.8% of the image and
#                       left the background inconsistent.
#   gemini_omni_flash   101 credits, ~2 min. Unified the background across the
#                       whole clip. Passed verification.
#
# Same clip, same instruction, 2.5x cheaper, and the only one that did the job.
# So gemini_omni_flash is preferred wherever it fits, and it does not always
# fit: it takes at most 10 seconds of input.
#
# `prompt_max` is the model's own promptText limit — exceeding it is a 400.
# `min_dimension` is the shortest side the model will accept.
FIX_ENGINES: dict[str, dict] = {
    "aleph2": {
        "model": "aleph2",
        "max_input_s": 30.0,
        "prompt_max": 1000,
        "min_dimension": 0,
        "credits_per_second": 28,
        "label": "Aleph 2",
    },
    "gemini_omni_flash": {
        "model": "gemini_omni_flash",
        "max_input_s": 10.0,
        "prompt_max": 3500,
        "min_dimension": 0,
        "credits_per_second": 11,
        "label": "Gemini Omni Flash",
    },
    # Also passed the same test, but at 408 credits and ~25 minutes against
    # gemini's 101 credits and ~2 minutes, for no measured quality advantage.
    # Selectable, never auto-routed. It also refuses anything under 480p on its
    # short side, which a portrait clip scaled into a 1280x720 box is not.
    "seedance2_5": {
        "model": "seedance2_5",
        "max_input_s": 30.0,
        "prompt_max": 15000,
        "min_dimension": 480,
        "credits_per_second": 45,
        "label": "Seedance 2.5",
    },
}

DEFAULT_ENGINE = "aleph2"


def choose_engine(shot_dur: float, is_wholeclip: bool, override: str | None = None) -> str:
    """
    Which engine to run this fix on.

    An explicit override wins, but only if it can actually take the clip — a
    user picking a 10-second model for a 20-second shot must not turn into a
    400 they cannot act on. Otherwise: whole-clip work goes to the cheapest
    engine that fits, which is currently gemini_omni_flash under 10 seconds.

    Bbox/marker work stays on aleph2 regardless. The red box burned into the
    frame is an aleph2 behaviour we have evidence for; no other engine here has
    been tested against it, and guessing with someone's credits is not on.
    """
    # Any engine can take any length now — a shot longer than the engine's own
    # input limit is split and rejoined by _fix_long_shot_chunked.
    if override and override in FIX_ENGINES:
        # ...with one refusal. aleph2 must never take whole-clip grade work,
        # even when explicitly asked for.
        #
        # The ask is not hypothetical: when Runway's content moderation blocks a
        # gemini regrade, diagnose.py offers the user a "Try another engine"
        # button, and the only other engine here is aleph2. Taking that path on
        # 14 Sep re-rendered a 28-second clip into something the verifier
        # rejected and the score fell 61 -> 47, with the output newly described
        # as "heavily motion-blurred, low-resolution and over-processed" and the
        # dining chairs recoloured from tan to bright orange. The original
        # engine comparison found the same thing: aleph2 changed 5.8% of the
        # image and left the grade inconsistent where gemini fixed it.
        #
        # So the button would hand a user a worse video than they uploaded. A
        # blocked fix they can retry later beats a fix that damages the footage.
        if is_wholeclip and override == "aleph2":
            print(
                "choose_engine: refusing aleph2 override for whole-clip work "
                "(it degrades long regrades); using gemini_omni_flash"
            )
            return "gemini_omni_flash"
        return override

    # Whole-clip work always goes to gemini_omni_flash now: it is the only
    # engine measured to actually repair a clip, it costs 2.5x less, and
    # chunking removes the 10-second input limit that used to send most real
    # footage to aleph2 instead.
    if is_wholeclip:
        return "gemini_omni_flash"
    return DEFAULT_ENGINE


def _build_payload(engine: str, clip_url: str, prompt: str) -> dict:
    """Request body for one engine. The shapes genuinely differ."""
    spec = FIX_ENGINES[engine]
    text = prompt[: spec["prompt_max"]]
    if engine.startswith("seedance"):
        # seedance takes promptVideo rather than videoUri, and in edit mode it
        # rejects both `ratio` and any explicit `duration`.
        return {
            "model": spec["model"],
            "promptVideo": clip_url,
            "promptText": text,
            "mode": "edit",
            "duration": "auto",
        }
    return {"model": spec["model"], "promptText": text, "videoUri": clip_url}


def _public_url(bucket_name: str, storage_path: str) -> str:
    encoded = storage_path.replace("/", "%2F")
    return f"https://firebasestorage.googleapis.com/v0/b/{bucket_name}/o/{encoded}?alt=media"


def _probe_duration(video_path: str) -> float | None:
    """Length of a local video in seconds, or None if ffprobe cannot say."""
    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", video_path],
        capture_output=True, text=True,
    )
    try:
        return float(probe.stdout.strip())
    except (ValueError, AttributeError):
        return None


def _probe_dimensions(video_path: str) -> tuple[int, int] | None:
    """(width, height) of a local video, or None if ffprobe cannot say."""
    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height", "-of", "csv=p=0", video_path],
        capture_output=True, text=True,
    )
    try:
        w, h = (int(x) for x in probe.stdout.strip().split(",")[:2])
        return (w, h) if w > 0 and h > 0 else None
    except (ValueError, AttributeError):
        return None


def _fit_size(video_path: str, min_dimension: int) -> tuple[int, int] | None:
    """
    Output size that fits within TARGET_W x TARGET_H but keeps the short side
    at or above `min_dimension`, preserving aspect and staying even.

    Returns None when the source dimensions cannot be read, so the caller keeps
    its default scaling rather than guessing.
    """
    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height", "-of", "csv=p=0", video_path],
        capture_output=True, text=True,
    )
    try:
        sw, sh = (int(x) for x in probe.stdout.strip().split(",")[:2])
    except (ValueError, AttributeError):
        return None
    if sw <= 0 or sh <= 0:
        return None

    scale = min(TARGET_W / sw, TARGET_H / sh)
    w, h = sw * scale, sh * scale
    if min(w, h) < min_dimension:
        scale *= min_dimension / min(w, h)
        w, h = sw * scale, sh * scale

    even = lambda v: max(2, int(round(v / 2)) * 2)
    return even(w), even(h)


def _clip_window(video_path: str, start_ms: float, end_ms: float) -> tuple[float, float]:
    """
    Pick the (start_s, duration_s) to hand ffmpeg for one shot.

    A shot shorter than MIN_CLIP_DURATION is padded outwards from its midpoint,
    because Runway rejects the submission outright below that length. Padding
    alone is not enough: `-ss start -t duration` past the end of the source
    yields a SHORTER file than requested, so a short shot at the very end of a
    video would still produce an under-length clip and still 400. The window is
    therefore slid back to fit inside the source before it is returned.
    """
    shot_dur = (end_ms - start_ms) / 1000.0
    duration_s = max(MIN_CLIP_DURATION, min(shot_dur, MAX_CLIP_DURATION))

    if duration_s > shot_dur:
        # Centre the extra padding on the original shot midpoint.
        start_s = max(0.0, start_ms / 1000.0 - (duration_s - shot_dur) / 2)
    else:
        start_s = start_ms / 1000.0

    source_dur = _probe_duration(video_path)
    if source_dur is not None:
        if source_dur < duration_s:
            # The whole video is shorter than Runway's minimum. Nothing we can
            # extract will be accepted, so say so instead of submitting and
            # letting a 400 come back as an opaque failure.
            raise RuntimeError(
                f"Source video is {source_dur:.2f}s but Runway requires at least "
                f"{MIN_CLIP_DURATION:.1f}s of video to edit."
            )
        start_s = min(start_s, source_dur - duration_s)
        start_s = max(0.0, start_s)

    return start_s, duration_s


def extract_clip(
    video_path: str,
    start_ms: float,
    end_ms: float,
    out_path: str,
    pad_to_frame: bool = True,
    min_dimension: int = 0,
) -> str:
    """
    Extract a 24fps clip for Aleph, at most TARGET_W x TARGET_H.

    aleph2 rejects clips under MIN_CLIP_DURATION, so for short shots the
    window is extended earlier and later in the source video (see
    _clip_window). The fixed clip is trimmed back to the original shot
    duration at stitch time so video sync is preserved.

    `pad_to_frame` letterboxes the clip into a full TARGET_W x TARGET_H frame.
    That is required whenever a bbox is involved, because every bbox in this
    system is normalised against the padded frame the keyframes were cut from,
    and unpadded video would put every red box in the wrong place.

    It is wrong everywhere else. A portrait video padded into a 16:9 frame
    arrives at aleph2 as a picture with two black panels in it, and aleph2
    treats them as canvas: the first corrected clip generated after the
    keyframe fix came back with the bars filled in with invented houses and
    lawn. Whole-clip regrades use no bbox, so they send the shot at its own
    aspect ratio and there is nothing to fill. Stitch pads it back on the way
    out, so final output geometry is unchanged either way.
    """
    start_s, duration_s = _clip_window(video_path, start_ms, end_ms)

    if pad_to_frame:
        vf = (
            f"scale={TARGET_W}:{TARGET_H}:force_original_aspect_ratio=decrease,"
            f"pad={TARGET_W}:{TARGET_H}:(ow-iw)/2:(oh-ih)/2:color=black,fps=24"
        )
    else:
        # Fit inside the same bounds, keep the source aspect, force even
        # dimensions (libx264 with yuv420p rejects odd width or height).
        vf = (
            f"scale=w={TARGET_W}:h={TARGET_H}:force_original_aspect_ratio=decrease:"
            f"force_divisible_by=2,fps=24"
        )
        if min_dimension:
            # Some engines refuse anything under a minimum short side —
            # seedance2_5 rejects a portrait clip fitted into a 1280x720 box
            # (404x720) as "must be at least 480p". Work out the real output
            # size here rather than in an ffmpeg expression, so we only ever
            # scale UP: a landscape clip already at 720 on its short side must
            # not be dragged down to 480 to satisfy a minimum it already meets.
            size = _fit_size(video_path, min_dimension)
            if size is not None:
                w, h = size
                # setsar=1 matters: without it the display width came back one
                # pixel under the minimum and was refused again.
                vf = f"scale={w}:{h}:flags=lanczos,setsar=1,fps=24"

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
    engine: str = DEFAULT_ENGINE,
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
      * `references` does not exist on aleph2 and `keyframes` IS NOT ITS
        EQUIVALENT. Per the live spec, keyframes are "timed guidance images
        placed at specific points in the input video" and `seconds` is "the
        absolute timestamp when this guidance image should apply" — a keyframe
        is a target the output must match at that time, not context the model
        may consult. gen4_aleph's `references` was the latter.

        The migration treated them as equivalent and kept feeding the wholeclip
        path the target shot's own first keyframe at seconds=0 — a frame of the
        unfixed footage. That instructed aleph2 to reproduce, at t=0, the exact
        look it was being asked to remove, while the prompt added "use the
        reference image as the visual target for the correct look". Every
        wholeclip fix between 25 August and now came back with the original
        look at the head of the clip, drifting away over its length, and was
        correctly refunded as unverified.

        No image is sent for wholeclip work now. There is no image of the
        desired result to send — that is what we are asking aleph2 to produce.
        The in-video red box is burned into the clip itself and is unaffected;
        the marker path never used keyframes.
      * `range` is deliberately omitted: it restricts the edit to a time
        window, which for a whole-clip regrade is the opposite of intended.
      * videoUri must be <= 30s, which MAX_CLIP_DURATION already guarantees.

    No guidance image is ever sent. Every image this pipeline can produce is
    either the footage we are trying to change or a frame with a review marker
    drawn on it, and `keyframes` would make aleph2 reproduce it. The spatial
    signal is the red box burned into the clip itself; the look is carried by
    promptText. Marker images are still built and stored, for the UI only.

    Uses requests (not httpx/SDK) to avoid SSL issues in Modal.
    Polls up to 12 minutes.
    """
    api_key = os.environ["RUNWAYML_API_SECRET"]
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "X-Runway-Version": RUNWAY_VERSION,
    }

    payload = _build_payload(engine, clip_public_url, prompt)

    print(f"Runway submit [{engine}] prompt: {prompt!r}")
    resp = requests.post(
        f"{RUNWAY_BASE}/v1/video_to_video",
        headers=headers,
        json=payload,
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
            print(f"Runway task {task_id} SUCCEEDED: cost={cost} credits [{engine}]")
            return {"url": outputs[0], "cost": cost, "task_id": task_id, "engine": engine}
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
    start_s, duration_s = _clip_window(video_path, start_ms, end_ms)

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


# The observations are prose and the verdict is a small JSON object at the end.
# Putting the per-frame descriptions INSIDE the JSON made the object long enough
# that a truncated or slightly malformed reply could not be parsed at all — and
# an unparsable reply becomes errorStillVisible None, which is not False, which
# is recorded as unverified and refunded. Long prose plus a tiny tail object
# keeps grounding without letting length decide the verdict.
_VERDICT_FORMAT = (
    "Then, on its own final line, output ONLY this JSON object and nothing after it:\n"
    '{"errorStillVisible": true|false, "confidence": "low|medium|high", '
    '"notes": "one sentence grounded in your observations"}'
)


def _parse_verdict(raw: str) -> dict:
    """
    Pull the verdict out of a reply that is prose followed by a JSON object.

    Tries, in order: the last brace-balanced object in the text, then a plain
    regex for the one field that decides the outcome. A reply we cannot read at
    all returns None for errorStillVisible, and callers treat that as unverified
    — so every recoverable shape must be recovered here rather than there.
    """
    depth = 0
    end = -1
    for i in range(len(raw) - 1, -1, -1):
        c = raw[i]
        if c == "}":
            if depth == 0:
                end = i
            depth += 1
        elif c == "{":
            depth -= 1
            if depth == 0 and end != -1:
                try:
                    obj = json.loads(raw[i : end + 1])
                    if isinstance(obj, dict) and "errorStillVisible" in obj:
                        return obj
                except Exception:
                    pass
                end = -1
                depth = 0

    m = re.search(r'"errorStillVisible"\s*:\s*(true|false)', raw)
    if m:
        conf = re.search(r'"confidence"\s*:\s*"(low|medium|high)"', raw)
        return {
            "errorStillVisible": m.group(1) == "true",
            "confidence": conf.group(1) if conf else "low",
            "notes": raw[-300:],
        }
    return {"errorStillVisible": None, "confidence": "low", "notes": raw[-300:]}


def verify_fix(fixed_clip_path: str, error: dict) -> dict:
    """
    Sample 5 frames evenly across the fixed clip and ask Opus 4.7 if the
    original error is still visible in ANY of them.

    We send full frames only (no bbox crops) — bbox accuracy from detection
    is unreliable enough that crops can point at the wrong region and produce
    false 'fixed' verdicts.

    The prompt asks for `observed` — a per-frame description — BEFORE any
    verdict, and states that the original clip was not shown. Without that, the
    prompt handed the model the original error description and asked "is it
    still visible?", and the model restated the description instead of reading
    the frames. Proven on a clip whose background had genuinely been unified:
    the production prompt returned errorStillVisible true at high confidence
    while reciting the original wording, and the same model on the same five
    frames, asked neutrally, described the corrected background accurately and
    called it consistent. That failure mode refunds users for fixes that
    worked, and hides whether a model change helped.

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
            f"You are auditing a video edit.\n\n"
            f"FIRST, under a line reading OBSERVED:, write one short sentence per frame "
            f"saying what you actually see in that frame. Describe only these "
            f"{len(frames)} images. You have NOT been shown the original clip and you "
            f"must not describe it or assume what it looked like.\n\n"
            f"THEN judge, using only your own observations above.\n"
            f"  The edit was supposed to achieve: {replace_with}\n\n"
            f"Question: judged only from the frames above, did the edit fail to achieve "
            f"that?\n\n"
            f"Strict rules:\n"
            f"- Achieved in at least some frames → errorStillVisible: false (succeeded).\n"
            f"- Plainly not achieved → errorStillVisible: true (failed).\n"
            f"- If your own observations do not support a verdict, say confidence low.\n"
            f"- Never restate a problem you did not observe in these frames.\n\n"
            + _VERDICT_FORMAT
        )
    else:
        audit_text = (
            f"You are auditing a video edit, which was meant to REMOVE something.\n\n"
            f"FIRST, under a line reading OBSERVED:, write one short sentence per frame "
            f"saying what you actually see in that frame. Describe only these "
            f"{len(frames)} images. You have NOT been shown the original clip and you "
            f"must not describe it or assume what it looked like.\n\n"
            f"THEN judge, using only your own observations above.\n"
            f"  What should no longer be present: {description}\n"
            f"  Type: {err_type}\n\n"
            f"It may be small (under 5% of the frame), partly occluded, or in shadow, "
            f"so look at every part of every frame.\n\n"
            f"Question: judged only from the frames above, is it still present in ANY "
            f"frame?\n\n"
            f"Strict rules:\n"
            f"- Present anywhere, even partially, as a faint outline, a distortion "
            f"artifact, or an obvious stand-in → errorStillVisible: true.\n"
            f"- Absent from every frame → errorStillVisible: false.\n"
            f"- Never restate a problem you did not observe in these frames. If your own "
            f"observations do not mention it, you did not see it.\n\n"
            + _VERDICT_FORMAT
        )

    content.append({"type": "text", "text": audit_text})

    client = anthropic.Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])
    response = client.messages.create(
        model="claude-opus-4-8",
        # The reply now carries a per-frame `observed` list before the verdict,
        # which does not fit in 512. A truncated reply fails json.loads, returns
        # errorStillVisible None, and None is not False — so the fix is recorded
        # unverified and refunded. Truncation must never be able to mean failure.
        max_tokens=2000,
        messages=[{"role": "user", "content": content}],
    )

    raw = response.content[0].text.strip()
    verdict = _parse_verdict(raw)
    if verdict.get("errorStillVisible") is None:
        # Unreadable means "we do not know", and the caller turns that into an
        # unverified fix. Print the whole reply and why it stopped, so the next
        # occurrence is diagnosable instead of another silent refund.
        print(
            f"verify_fix: unreadable verdict (stop_reason="
            f"{getattr(response, 'stop_reason', None)}): {raw!r}"
        )
    return verdict


CHUNK_CROSSFADE_S = 0.25  # dissolve across a chunk join to hide a grade step


def _crossfade_concat(paths: list[str], out_path: str, tmp: str) -> bool:
    """
    Join clips with a short dissolve at each seam. Returns False if ffmpeg
    refuses, so the caller can fall back to a hard cut rather than lose the fix.

    Each piece came back from a separate generation, so the join is where a
    difference in grade or exposure shows as a step. A quarter-second dissolve
    hides that. It cannot hide the pieces disagreeing about what is in frame.
    """
    durs = []
    for p in paths:
        d = _probe_duration(p)
        if d is None or d <= CHUNK_CROSSFADE_S * 2:
            return False
        durs.append(d)

    # Chunks do not necessarily come back the same shape. gemini_omni_flash
    # picks its own output aspect per generation, so a portrait shot split in
    # two returned one pillarboxed 16:9 piece and one full-width piece, and
    # joining them produced a video that visibly changes format halfway
    # through — the "cut and pasted" seam. Every piece is conformed to the
    # first piece's geometry before any of them are joined.
    target = _probe_dimensions(paths[0])
    if target is None:
        return False
    tw, th = target
    scaled: list[str] = []
    for i, p in enumerate(paths):
        if _probe_dimensions(p) == target:
            scaled.append(p)
            continue
        conformed = os.path.join(tmp, f"conform_{i}.mp4")
        r = subprocess.run(
            ["ffmpeg", "-y", "-i", p, "-vf",
             f"scale={tw}:{th}:force_original_aspect_ratio=decrease,"
             f"pad={tw}:{th}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1",
             "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", "-an", conformed],
            capture_output=True,
        )
        if r.returncode != 0:
            print(f"  chunk conform failed: {r.stderr.decode(errors='replace')[-300:]}")
            return False
        scaled.append(conformed)
    paths = scaled

    inputs: list[str] = []
    for p in paths:
        inputs += ["-i", p]

    # xfade offsets are cumulative and each transition eats CHUNK_CROSSFADE_S
    # of total length, so the offset for join i has to subtract every earlier
    # overlap or the tail of the video is silently dropped.
    steps: list[str] = []
    prev = "[0:v]"
    elapsed = durs[0]
    for i in range(1, len(paths)):
        offset = elapsed - CHUNK_CROSSFADE_S
        label = f"[x{i}]"
        steps.append(
            f"{prev}[{i}:v]xfade=transition=fade:"
            f"duration={CHUNK_CROSSFADE_S}:offset={offset:.3f}{label}"
        )
        prev = label
        elapsed = offset + durs[i]

    result = subprocess.run(
        ["ffmpeg", "-y", *inputs, "-filter_complex", ";".join(steps),
         "-map", prev, "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p",
         "-an", out_path],
        capture_output=True,
    )
    if result.returncode != 0:
        print(f"  xfade failed: {result.stderr.decode(errors='replace')[-400:]}")
        return False
    return True


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
    engine: str = DEFAULT_ENGINE,
) -> tuple[str, float | None]:
    """
    Fix a shot too long for the chosen engine by splitting it, running each
    piece, then joining them back together.

    The split point is the ENGINE's own limit, not one global number.
    gemini_omni_flash takes 10 seconds where aleph2 takes 30, and real footage
    is mostly longer than 10s — the first two shots a live user brought us were
    10.70s and 12.63s. Without this, the engine that actually repairs a clip is
    unreachable for most of the material people upload.

    Each piece is regenerated independently, so the look can step at a join.
    CHUNK_CROSSFADE_S of overlap is dissolved across every join to hide that;
    it disguises a grade or exposure step well and cannot disguise the two
    pieces diverging in content.

    Returns (local path to the final joined clip, total credits charged).
    """
    shot_start_ms = fix_shot["startMs"]
    shot_end_ms = fix_shot["endMs"]
    shot_dur = (shot_end_ms - shot_start_ms) / 1000.0

    limit = min(FIX_ENGINES[engine]["max_input_s"], MAX_CLIP_DURATION)
    n_chunks = math.ceil(shot_dur / limit)
    chunk_dur_ms = (shot_end_ms - shot_start_ms) / n_chunks

    print(
        f"  Chunking {shot_dur:.1f}s shot into {n_chunks} × "
        f"{chunk_dur_ms/1000:.1f}s chunks for {engine} (limit {limit}s)"
    )

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
        rw = apply_runway_fix(chunk_public_url, prompt, engine=engine)
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

    final_path = os.path.join(tmp, f"chunked_fixed_{error_id}.mp4")

    if len(fixed_chunk_paths) > 1 and CHUNK_CROSSFADE_S > 0:
        blended = _crossfade_concat(fixed_chunk_paths, final_path, tmp)
        if blended:
            return final_path, (total_cost if cost_known else None)
        print("  Cross-fade join failed; falling back to a hard cut")

    # Hard concat — also the path for a single chunk.
    concat_txt = os.path.join(tmp, "chunks_concat.txt")
    with open(concat_txt, "w") as f:
        for p in fixed_chunk_paths:
            f.write(f"file '{p}'\n")

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


def _prior_fixed_clip(db, job_id: str, shot_id: str, this_error_id: str):
    """
    The most recent successfully-fixed clip for this shot, if any.

    Returns (url, lead_in_seconds, span_seconds) or (None, 0.0, 0.0).

    Exists so that a second fix on the same shot builds on the first instead
    of replacing it. restitch keys its output map by shot id, so without
    chaining the second render silently discards the first — see the note at
    the call site.
    """
    try:
        snap = (
            db.collection("jobs").document(job_id).collection("errors")
            .where("fixStatus", "==", "fixed")
            .get()
        )
    except Exception as exc:
        print(f"_prior_fixed_clip: lookup failed ({exc}); starting from original")
        return None, 0.0, 0.0

    candidates = []
    for doc in snap:
        if doc.id == this_error_id:
            continue
        err = doc.to_dict() or {}
        if not err.get("fixedClipUrl"):
            continue
        target = (
            err.get("shotBId")
            if err.get("fixDirection", "aTob") == "aTob"
            else err.get("shotAId")
        )
        if target == shot_id:
            candidates.append(err)

    if not candidates:
        return None, 0.0, 0.0

    # Chain onto the MOST RECENT fix, so a third fix builds on the second
    # rather than reverting to the first. Anything without a fixedAt sorts
    # first and therefore loses, which is the safe direction: worst case we
    # chain onto an older clip and lose one change, rather than crashing.
    def _when(err: dict):
        return err.get("fixedAt") or 0

    candidates.sort(key=_when)
    err = candidates[-1]

    def _num(key: str) -> float:
        try:
            return max(0.0, float(err.get(key) or 0.0))
        except (TypeError, ValueError):
            return 0.0

    return err["fixedClipUrl"], _num("clipLeadInSeconds"), _num("clipSpanSeconds")


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
            # Source for this fix: a clip already fixed on THIS shot if one
            # exists, otherwise the original video.
            #
            # Every fix used to start from job["inputVideoUrl"] unconditionally.
            # With two confirmed errors on one shot that produced two
            # independent re-renders of the same original footage, each
            # carrying its own change and neither carrying the other's — and
            # restitch then keeps only ONE of them, because it builds
            # `fixed_clips[target_shot] = ...` in a loop over errors and the
            # last write wins. So the user paid for both renders, both could
            # be reported verified against their own output, and the delivered
            # video contained whichever happened to be written last.
            #
            # Chaining instead: each fix on a shot starts from the previous
            # fix's output, so changes accumulate and the final clip really is
            # the one that carries them all. It also keeps each Runway
            # instruction single-purpose, which is what the repairability rule
            # asks for — a compound "regrade AND change the wardrobe" ask is
            # the shape that fails.
            prior_clip_url, prior_lead_in, prior_span = _prior_fixed_clip(
                db, job_id, fix_shot_id, error_id
            )
            source_url = prior_clip_url or job["inputVideoUrl"]
            if prior_clip_url:
                print(
                    f"fix {error_id}: chaining onto an existing fixed clip for "
                    f"shot {fix_shot_id}"
                )

            video_local = os.path.join(tmp, "video.mp4")
            r = requests.get(source_url, timeout=180, stream=True)
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
            # The engine is picked BEFORE the clip is cut, because it decides
            # the size: seedance2_5 refuses anything under 480p on its short
            # side, and a portrait shot fitted into a 1280x720 box is 404x720.
            # `fixEngine` lets a retry run the same error on a different model
            # instead of repeating the one that already failed; unset on a first
            # attempt, which routes automatically.
            shot_dur = (fix_shot["endMs"] - fix_shot["startMs"]) / 1000.0
            engine = choose_engine(shot_dur, is_wholeclip_type, error.get("fixEngine"))
            print(f"Fix engine for {error_id}: {engine} (shot {shot_dur:.2f}s)")

            clip_local = os.path.join(tmp, f"clip_{error_id}.mp4")
            # The same window the extract helpers will compute. Captured here,
            # while the downloaded source still exists, because restitch needs
            # to know how much of the returned clip sits BEFORE the shot: a
            # shot shorter than MIN_CLIP_DURATION is padded on both sides so
            # Runway will accept it, so the fixed clip is longer than the shot
            # and does not start where the shot starts. Splicing it in whole
            # would drift every segment after it.
            if prior_clip_url:
                # The source IS the shot already — a previous fix's output,
                # cut to this shot and sized for Runway on that run. Cutting
                # it again with the ORIGINAL video's timestamps would slice at
                # the wrong place entirely, since those are offsets into the
                # full film and this file starts at the shot. So reuse the
                # geometry the earlier fix recorded and take the clip whole.
                clip_span_s = prior_span or shot_dur
                clip_lead_in_s = prior_lead_in
                if in_video_marker:
                    # Markers must still be burned in, but over the whole of
                    # this file rather than a window inside it.
                    prior_dur_ms = int(
                        (_probe_duration(video_local) or clip_span_s) * 1000
                    )
                    extract_clip_with_in_video_marker(
                        video_local, 0, prior_dur_ms, target_bboxes, clip_local
                    )
                    print(
                        f"Chained clip re-marked with {len(target_bboxes)} "
                        f"in-video marker(s)"
                    )
                else:
                    shutil.copyfile(video_local, clip_local)
            else:
                clip_start_s, clip_span_s = _clip_window(
                    video_local, fix_shot["startMs"], fix_shot["endMs"]
                )
                clip_lead_in_s = max(0.0, fix_shot["startMs"] / 1000.0 - clip_start_s)

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
                    extract_clip(
                        video_local,
                        fix_shot["startMs"],
                        fix_shot["endMs"],
                        clip_local,
                        # No bbox on this path, so nothing depends on the padded
                        # frame — and the black bars would be outpainted.
                        pad_to_frame=not is_wholeclip_type,
                        min_dimension=FIX_ENGINES[engine]["min_dimension"],
                    )

            # Upload input clip to Firebase so Runway can fetch it via public URL
            clip_storage = f"jobs/{job_id}/clips/{error_id}_input.mp4"
            bucket.blob(clip_storage).upload_from_filename(clip_local, content_type="video/mp4")
            clip_public_url = _public_url(bucket.name, clip_storage)

            marker_url: str | None = None
            relocated_bbox: dict | None = None
            best_keyframe_url: str | None = None

            # Wholeclip types (lighting/atmosphere) send no guidance image at
            # all — see the note on `keyframes` in apply_runway_fix. The only
            # frame we have of this shot is the frame we are trying to change,
            # and aleph2 treats a keyframe as a target to reproduce, not as
            # context. There is no correct image to send here, so nothing is
            # sent, and promptText carries the whole instruction.

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
                # Always False: no reference image is sent to aleph2 any more,
                # so no prompt may tell it to "use the reference image as the
                # visual target". That sentence, paired with a keyframe of the
                # unfixed footage, is what made every wholeclip fix reproduce
                # the error it was asked to remove.
                has_marker=False,
                in_video_marker=in_video_marker,
            )
            fixed_local = os.path.join(tmp, f"clip_{error_id}_fixed.mp4")

            runway_cost: float | None = None
            runway_task_id: str | None = None

            if shot_dur > min(FIX_ENGINES[engine]["max_input_s"], MAX_CLIP_DURATION):
                # Long shot: chunk into ≤5s segments, fix each, concatenate
                chunked_path, runway_cost = _fix_long_shot_chunked(
                    job_id=job_id,
                    error_id=error_id,
                    engine=engine,
                    fix_shot=fix_shot,
                    video_local=video_local,
                    target_bboxes=target_bboxes,
                    in_video_marker=in_video_marker,
                    prompt=prompt,
                    bucket=bucket,
                    tmp=tmp,
                )
                # shutil is imported at module level. A second `import shutil`
                # HERE made the name local to the whole of fix_single_error,
                # so the shutil.copyfile in the chaining path above — hundreds
                # of lines earlier — raised UnboundLocalError before Runway was
                # ever called.
                shutil.copy2(chunked_path, fixed_local)
            else:
                # Short shot (≤5s): single Runway call
                result = apply_runway_fix(clip_public_url, prompt, engine=engine)
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

        # Second gate: did the fix actually move TOWARD the shot it was told to
        # match? The Opus verifier answers the question it was asked — "is the
        # rain gone?" — and nothing else. On job v2testou8rhv8vd9 it passed an
        # atmosphere fix with "All frames show a sunny sky and green trees", on
        # a clip whose mean level had moved AWAY from its reference shot: a 12.4
        # luma gap in the source became 23.3 in the output. The defect the user
        # reported was the mismatch between two shots, and we made it worse
        # while reporting success.
        #
        # Only grade work is judged this way — its whole subject is the
        # relationship between two shots. Object fixes (a prop, wardrobe) are
        # not expected to move the level at all, and stitch.py corrects them if
        # they drift.
        if verified_resolved and str(error.get("type") or "").lower() in GRADE_TYPES:
            ref_id = (
                error.get("shotAId")
                if error.get("fixDirection", "aTob") == "aTob"
                else error.get("shotBId")
            )
            drift = _continuity_regressed(
                shots_ref=shots_ref,
                input_video_url=job["inputVideoUrl"],
                fixed_local=fixed_local,
                tmp=tmp,
                shot_id=fix_shot_id,
                ref_id=ref_id,
            )
            if drift is not None:
                gap_before, gap_after = drift
                verified_resolved = False
                verify_result = {
                    **verify_result,
                    "errorStillVisible": True,
                    "continuityRegressed": True,
                    "gapBefore": round(gap_before, 2),
                    "gapAfter": round(gap_after, 2),
                    "notes": (
                        (verify_result.get("notes") or "")
                        + f" [continuity check: this shot moved further from "
                          f"{ref_id} than before the fix — {gap_before:.1f} → "
                          f"{gap_after:.1f} mean luma. The mismatch the fix was "
                          f"asked to close got wider.]"
                    ),
                }
                print(
                    f"  {error_id}: verifier passed but continuity REGRESSED "
                    f"({gap_before:.1f} → {gap_after:.1f}) — marking unverified"
                )

        update_data = {
            "fixStatus": "fixed",
            # When this fix landed. Read by _prior_fixed_clip to chain a later
            # fix on the same shot onto the most recent output rather than an
            # arbitrary earlier one; createdAt is detection time and says
            # nothing about fix order.
            "fixedAt": datetime.now(timezone.utc),
            "fixedClipUrl": fixed_firebase_url,
            "originalClipUrl": clip_public_url,
            "clipLeadInSeconds": round(clip_lead_in_s, 3),
            "clipSpanSeconds": round(clip_span_s, 3),
            "alephPrompt": prompt,
            "verifyResult": verify_result,
            "verifiedResolved": verified_resolved,
            # Real Runway spend for this fix, straight off the SUCCEEDED task.
            # Recorded per error so cost-per-fix can be rebuilt from Firestore
            # even if telemetry is lost, and so credits charged to the user can
            # be reconciled against credits actually burned.
            "runwayModel": FIX_ENGINES[engine]["model"],
            "fixEngineUsed": engine,
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
                    "runway_model": FIX_ENGINES[engine]["model"],
                    # Which engine actually ran, so cost-per-verified-fix can be
                    # compared per engine instead of argued about.
                    "fix_engine": engine,
                    "runway_credits_charged": runway_cost,
                    "runway_task_id": runway_task_id,
                    "shot_duration_seconds": round(shot_dur, 3),
                    "credits_charged_to_user": error.get("creditsDeducted"),
                    "runway_balance_after": runway_credit_balance(),
                    "was_chunked": shot_dur > min(
                        FIX_ENGINES[engine]["max_input_s"], MAX_CLIP_DURATION
                    ),
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

        # Ask Claude what this was. Only reached when no earlier branch
        # recognised the failure, which is exactly the case the user used to
        # get "Fix failed. Please try again." for. Best effort: if it cannot
        # answer, the raw message stands as before.
        diagnosis = None
        try:
            from modal_app.diagnose import diagnose_failure
            from modal_app.firebase import get_db as _get_db

            _db = _get_db()
            _shots = [
                d.to_dict() or {}
                for d in _db.collection("jobs").document(job_id)
                .collection("shots").order_by("index").get()
            ]
            _owner = (job or {}).get("ownerUid")
            _user = (
                (_db.collection("users").document(_owner).get().to_dict() or {})
                if _owner else {}
            )
            diagnosis = diagnose_failure(
                failure_text=full[-2500:],
                engine=locals().get("engine") or DEFAULT_ENGINE,
                engine_specs=FIX_ENGINES,
                error_doc=error,
                shots=_shots,
                plan=_user.get("plan", "free"),
                credits_available=_user.get("creditsBalance"),
                credits_needed=error.get("creditsDeducted"),
            )
        except Exception as diag_err:
            print(f"diagnosis skipped: {diag_err}")

        error_ref.update({
            "fixStatus": "failed",
            # errorMessage is what the UI shows. Claude's sentence replaces the
            # raw exception when we have one; the exception is kept alongside
            # it so nothing is lost for debugging.
            "errorMessage": (diagnosis or {}).get("message") or str(e),
            "errorDetail": full[-1000:],
            "rawErrorMessage": str(e),
            **({"diagnosis": diagnosis} if diagnosis else {}),
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
                    "diagnosed_cause": (diagnosis or {}).get("cause"),
                    "diagnosis_retryable": (diagnosis or {}).get("retryable"),
                    # locals() because the failure may predate engine selection.
                    "fix_engine": locals().get("engine"),
                    "runway_model": FIX_ENGINES.get(
                        locals().get("engine") or DEFAULT_ENGINE, {}
                    ).get("model"),
                    "retry_count": error.get("retryCount", 0),
                },
            )
        except Exception as exc:
            print(f"fix_error_failed capture failed: {exc}")

        raise
