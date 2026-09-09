"""
Open-vocabulary object localization via Replicate's Grounding DINO.

Used as the second stage of detection — Opus identifies WHAT is wrong
(text description), then Grounding DINO returns a pixel-precise bbox for it.

LLMs are bad at outputting precise coordinates; dedicated grounding models
are trained exactly for this task. Empirically: GroundingDINO IoU is ~0.64
vs Opus's free-form bbox at ~0.2–0.3.
"""

import os
import threading
import time

import requests

# Total Grounding DINO predictions in flight across the whole process.
#
# Localization is now concurrent at two levels — write_errors runs several
# errors at once, and each error localizes its 5 keyframes at once — so
# without a shared ceiling a 36-error job would open ~40 Replicate
# predictions simultaneously and start collecting 429s. This semaphore is
# the one place that bound lives.
GROUNDING_CONCURRENCY = 12
_grounding_slots = threading.Semaphore(GROUNDING_CONCURRENCY)

# Keyframes are extracted at this resolution by decompose.transcode_to_720p.
# Grounding DINO returns pixel coords; we normalize against these dimensions.
KEYFRAME_W = 1280
KEYFRAME_H = 720

REPLICATE_BASE = "https://api.replicate.com/v1"
# adirik/grounding-dino is a community model — needs explicit version via
# the predictions endpoint, NOT the /models/{owner}/{name}/predictions one.
GROUNDING_DINO_VERSION = "efd10a8ddc57ea28773327e881ce95e20cc1d734c589f7dd01d2036921ed78aa"


def localize_with_grounding_dino(
    image_url: str,
    query: str,
    box_threshold: float = 0.15,
    text_threshold: float = 0.15,
) -> dict | None:
    """
    Ask Grounding DINO to locate `query` in `image_url`.
    Returns {"x","y","w","h","score"} as fractions of image w/h, or None.

    Callers run this concurrently from several threads; the semaphore holds
    total in-flight predictions to GROUNDING_CONCURRENCY. It is acquired
    around the whole request, polling included, because a prediction that is
    still polling is still occupying Replicate capacity.
    """
    with _grounding_slots:
        return _grounding_dino_request(
            image_url, query, box_threshold, text_threshold
        )


def _grounding_dino_request(
    image_url: str,
    query: str,
    box_threshold: float,
    text_threshold: float,
) -> dict | None:
    token = os.environ.get("REPLICATE_API_TOKEN")
    if not token:
        print("REPLICATE_API_TOKEN not set; skipping Grounding DINO")
        return None
    if not image_url or not query:
        return None

    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
        "Prefer": "wait",
    }
    payload = {
        "version": GROUNDING_DINO_VERSION,
        "input": {
            "image": image_url,
            "query": query,
            "box_threshold": box_threshold,
            "text_threshold": text_threshold,
        }
    }
    try:
        resp = requests.post(
            f"{REPLICATE_BASE}/predictions",
            headers=headers,
            json=payload,
            timeout=60,
        )
    except Exception as e:
        print(f"Grounding DINO request error: {e}")
        return None

    if not resp.ok:
        print(f"Grounding DINO HTTP {resp.status_code}: {resp.text[:300]}")
        return None

    data = resp.json()
    status = data.get("status")

    # If "wait" didn't complete in the request window, poll
    poll_url = data.get("urls", {}).get("get")
    deadline = time.time() + 30
    while status not in ("succeeded", "failed", "canceled") and poll_url and time.time() < deadline:
        time.sleep(1.0)
        try:
            poll = requests.get(poll_url, headers={"Authorization": f"Bearer {token}"}, timeout=10)
            poll.raise_for_status()
            data = poll.json()
            status = data.get("status")
        except Exception as e:
            print(f"Grounding DINO poll error: {e}")
            return None

    if status != "succeeded":
        print(f"Grounding DINO {status}: {data.get('error')}")
        return None

    output = data.get("output")
    # `adirik/grounding-dino` returns an object with `detections`: a list of
    # {label, confidence, bbox: [xmin,ymin,xmax,ymax]} (pixel coords).
    detections: list = []
    if isinstance(output, dict):
        detections = output.get("detections") or []
    if not detections:
        return None

    # Pick the highest-confidence detection
    def _score(d: dict) -> float:
        return float(
            d.get("confidence")
            or d.get("score")
            or 0.0
        )

    best = max(detections, key=_score)

    # Handle multiple possible coordinate field layouts robustly
    if "bbox" in best and isinstance(best["bbox"], (list, tuple)) and len(best["bbox"]) == 4:
        xmin, ymin, xmax, ymax = best["bbox"]
    elif all(k in best for k in ("xmin", "ymin", "xmax", "ymax")):
        xmin, ymin, xmax, ymax = best["xmin"], best["ymin"], best["xmax"], best["ymax"]
    else:
        print(f"Grounding DINO: unexpected detection shape: {best}")
        return None

    xmin, ymin, xmax, ymax = float(xmin), float(ymin), float(xmax), float(ymax)
    if xmax <= xmin or ymax <= ymin:
        return None

    return {
        "x": max(0.0, xmin / KEYFRAME_W),
        "y": max(0.0, ymin / KEYFRAME_H),
        "w": max(0.0, (xmax - xmin) / KEYFRAME_W),
        "h": max(0.0, (ymax - ymin) / KEYFRAME_H),
        "score": _score(best),
    }


def validate_bbox_contains(
    image_url: str,
    bbox: dict,
    object_query: str,
) -> bool:
    """
    Ask Haiku to look at the bbox crop and confirm it actually centrally
    contains the described object. Uses object_query (not description) and
    a strict prompt — required to reject Grounding DINO false positives like
    "returned a box on the wall in general when asked for bullet holes".
    """
    import os
    import base64
    import json as _json
    import anthropic
    import cv2
    import numpy as np

    if not object_query or not object_query.strip():
        return False  # Without a specific query, we can't validate — reject.

    try:
        r = requests.get(image_url, timeout=30)
        r.raise_for_status()
        arr = np.frombuffer(r.content, dtype=np.uint8)
        frame = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        if frame is None:
            return False

        h, w = frame.shape[:2]
        # Tight crop — only 15% padding so the validator can't be fooled by
        # surrounding context. The object must be the dominant feature.
        pad_x = bbox["w"] * 0.15
        pad_y = bbox["h"] * 0.15
        x1 = max(0, int((bbox["x"] - pad_x) * w))
        y1 = max(0, int((bbox["y"] - pad_y) * h))
        x2 = min(w, int((bbox["x"] + bbox["w"] + pad_x) * w))
        y2 = min(h, int((bbox["y"] + bbox["h"] + pad_y) * h))
        if x2 <= x1 or y2 <= y1:
            return False
        crop = frame[y1:y2, x1:x2]
        if min(crop.shape[:2]) < 200:
            scale = 200.0 / min(crop.shape[:2])
            crop = cv2.resize(crop, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
        _, buf = cv2.imencode(".jpg", crop, [cv2.IMWRITE_JPEG_QUALITY, 90])
        crop_b64 = base64.b64encode(buf).decode()

        client = anthropic.Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])
        validate_kwargs = dict(
            model="claude-opus-4-8",
            max_tokens=128,
            messages=[{
                "role": "user",
                "content": [
                    {
                        "type": "image",
                        "source": {"type": "base64", "media_type": "image/jpeg", "data": crop_b64},
                    },
                    {
                        "type": "text",
                        "text": (
                            f"Look at this image crop. Is \"{object_query}\" "
                            f"the MAIN visible subject of this crop — clearly "
                            f"present and roughly centered?\n\n"
                            f"BE STRICT. Say true ONLY if you can directly point "
                            f"at \"{object_query}\" in the image. Do NOT say true "
                            f"just because the broader scene is plausible context "
                            f"for that thing — the object itself must be visible.\n"
                            f"If you're unsure, say false.\n\n"
                            f"Return STRICT JSON only: "
                            f'{{"contains": true|false, "reason": "one short sentence"}}'
                        ),
                    },
                ],
            }],
        )
        _retry_delays = (5, 15, 45)
        response = None
        for _attempt in range(len(_retry_delays) + 1):
            try:
                response = client.messages.create(**validate_kwargs)
                break
            except anthropic.OverloadedError:
                if _attempt < len(_retry_delays):
                    import time as _time
                    _time.sleep(_retry_delays[_attempt])
                else:
                    raise
        raw = response.content[0].text.strip()
        if raw.startswith("```"):
            raw = raw.split("```")[1]
            if raw.startswith("json"):
                raw = raw[4:]
        data = _json.loads(raw)
        ok = bool(data.get("contains"))
        print(
            f"Bbox validation for {object_query!r}: contains={ok} "
            f"({(data.get('reason') or '')[:100]})"
        )
        return ok
    except Exception as e:
        print(f"validate_bbox_contains error: {e}")
        # Default to REJECT on errors. Better to ask user to mark manually
        # than to mislead Aleph with a wrong box.
        return False


def localize_best_frame(
    keyframe_urls: list[str],
    query: str,
) -> tuple[dict | None, str | None]:
    """
    Run Grounding DINO on each keyframe; return the bbox + frame URL with
    the highest confidence detection. This handles cases where the target
    object is occluded in some keyframes and visible in others.
    """
    if not keyframe_urls or not query:
        return None, None

    best_bbox: dict | None = None
    best_url: str | None = None
    best_score = 0.0

    # One Replicate prediction per frame, and each takes up to ~60s. Five
    # frames in sequence is five minutes for a single error; run them together
    # and it is one prediction's worth of wall time. _grounding_slots keeps the
    # total across all callers bounded.
    from concurrent.futures import ThreadPoolExecutor

    def _one(url: str):
        try:
            return url, localize_with_grounding_dino(url, query)
        except Exception as exc:
            print(f"Grounding DINO frame failed ({type(exc).__name__}: {exc})")
            return url, None

    with ThreadPoolExecutor(max_workers=len(keyframe_urls)) as pool:
        results = list(pool.map(_one, keyframe_urls))

    for url, bbox in results:
        if not bbox:
            continue
        score = bbox.get("score", 0.0)
        if score > best_score and bbox["w"] > 0 and bbox["h"] > 0:
            best_score = score
            best_bbox = bbox
            best_url = url

    if best_bbox is not None:
        print(
            f"Grounding DINO best match: score={best_score:.2f} "
            f"bbox={best_bbox} url={best_url}"
        )
    return best_bbox, best_url
