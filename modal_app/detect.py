"""
Phase 3 — Detect continuity errors between shot pairs using Claude vision API.
Fan-out: each pair runs in parallel via Modal .map().
"""

import hashlib
import json
import os
from datetime import datetime, timezone

import time

import anthropic

from modal_app.firebase import get_db
from modal_app.prompts import build_detection_prompt, build_standalone_prompt, build_holistic_prompt


PROMPT_VERSION = "v16"  # bumped: no double-flagging atmosphere+lighting for the same root cause
HOLISTIC_VERSION = "v1"  # separate version for holistic scene analysis
WINDOW_SECONDS = 60  # sliding window for same-scene detection
SMALL_VIDEO_THRESHOLD = 10  # ≤ this many shots → compare every pair

_RETRY_DELAYS = (5, 15, 45)  # seconds between attempts on 529


def _create_with_retry(client: anthropic.Anthropic, **kwargs):
    """Wrap client.messages.create with retries for transient 529 overload errors."""
    for attempt in range(len(_RETRY_DELAYS) + 1):
        try:
            return client.messages.create(**kwargs)
        except anthropic.OverloadedError as exc:
            if attempt < len(_RETRY_DELAYS):
                wait = _RETRY_DELAYS[attempt]
                print(f"Anthropic overloaded (529), retrying in {wait}s (attempt {attempt + 1}/{len(_RETRY_DELAYS)})…")
                time.sleep(wait)
            else:
                raise


def get_pairs_to_compare(shots: list[dict]) -> list[tuple[dict, dict]]:
    """
    Build the list of (shotA, shotB) pairs to compare.

    - For short videos (≤ 10 shots), compare every pair — temporal/causation
      errors like "bullet holes before the shooting" need cross-scene
      comparison that a tight window can miss.
    - For longer videos, always compare adjacent shots plus pairs within a
      60s sliding window. Avoids O(n^2) blowup on movie-length input.
    """
    pairs = set()
    n = len(shots)

    if n <= SMALL_VIDEO_THRESHOLD:
        for i in range(n):
            for j in range(i + 1, n):
                pairs.add((i, j))
        return [(shots[a], shots[b]) for (a, b) in sorted(pairs)]

    for i in range(n):
        if i + 1 < n:
            pairs.add((i, i + 1))
        for j in range(i + 2, n):
            if shots[j]["startMs"] - shots[i]["startMs"] <= WINDOW_SECONDS * 1000:
                pairs.add((i, j))
            else:
                break

    return [(shots[a], shots[b]) for (a, b) in sorted(pairs)]


def cache_key(urls_a: list[str], urls_b: list[str], user_hint: str = "") -> str:
    # Cache by the full set of URLs across both shots (multi-frame).
    raw = "|".join(urls_a) + "::" + "|".join(urls_b) + f"|{PROMPT_VERSION}|{user_hint or ''}"
    return hashlib.sha256(raw.encode()).hexdigest()[:40]


def _frame_urls(shot: dict) -> list[str]:
    """Return all keyframe URLs for a shot; fall back to single keyframeUrl."""
    urls = shot.get("keyframeUrls")
    if isinstance(urls, list) and urls:
        return [u for u in urls if isinstance(u, str)]
    single = shot.get("keyframeUrl")
    return [single] if isinstance(single, str) else []


def _repairability(err: dict) -> dict:
    """
    Whether a text-instructed edit of existing footage can plausibly fix this.

    The pipeline can change how a shot looks. It cannot move the camera,
    re-frame a shot, or re-stage what happened. An error that needs any of
    those is worth telling the user about and must never be offered a fix —
    every attempt spends Runway credits to produce something the verifier will
    correctly reject, and the credits come back, and the user gets nothing.

    Absent field means repairable, so errors detected before this existed keep
    behaving as they did.
    """
    repairable = err.get("repairable")
    if repairable is None:
        return {"repairable": True}
    if repairable:
        return {"repairable": True}
    reason = (err.get("not_repairable_reason") or "").strip()
    return {
        "repairable": False,
        "notRepairableReason": reason or "would need different footage, not an edit",
    }


def compare_pair(
    job_id: str,
    shot_a: dict,
    shot_b: dict,
    user_hint: str = "",
) -> list[dict]:
    """
    Compare two shots using up to 3 frames per shot (sampled across the
    shot's duration). Catches errors that only appear in some frames within
    a shot — important for fast-cutting scenes where the mid-frame might
    miss the error.

    Returns list of error dicts (may be empty). Checks /cache collection first.
    """
    db = get_db()
    urls_a = _frame_urls(shot_a)
    urls_b = _frame_urls(shot_b)
    if not urls_a or not urls_b:
        return []

    key = cache_key(urls_a, urls_b, user_hint)
    cache_ref = db.collection("cache").document(key)
    cached = cache_ref.get()

    if cached.exists:
        return cached.to_dict().get("errors", [])

    client = anthropic.Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])

    content: list = []
    for i, url in enumerate(urls_a, start=1):
        content.append({"type": "text", "text": f"SHOT A · frame {i}/{len(urls_a)}"})
        content.append({"type": "image", "source": {"type": "url", "url": url}})
    for i, url in enumerate(urls_b, start=1):
        content.append({"type": "text", "text": f"SHOT B · frame {i}/{len(urls_b)}"})
        content.append({"type": "image", "source": {"type": "url", "url": url}})
    content.append({"type": "text", "text": build_detection_prompt(user_hint)})

    response = _create_with_retry(client,
        model="claude-opus-4-8",
        max_tokens=1024,
        messages=[{"role": "user", "content": content}],
    )

    raw = response.content[0].text.strip()
    # Strip markdown code fences if present
    if raw.startswith("```"):
        raw = raw.split("```")[1]
        if raw.startswith("json"):
            raw = raw[4:]

    parsed = json.loads(raw)

    if parsed.get("different_scene"):
        cache_ref.set({"errors": [], "ts": datetime.now(timezone.utc)})
        return []

    errors = parsed.get("errors", [])
    cache_ref.set({"errors": errors, "ts": datetime.now(timezone.utc)})
    return errors


def detect_standalone(job_id: str, shot: dict, user_hint: str = "") -> list[dict]:
    """
    Ask Opus about STANDALONE errors visible inside a single shot (anachronisms,
    visible production equipment, out-of-place props). Independent of any
    other shot. Catches the cup-in-every-shot case where pair-wise detection
    sees no difference between shots.
    """
    urls = _frame_urls(shot)
    if not urls:
        return []

    db = get_db()
    key = cache_key(urls, urls, (user_hint or "") + "|standalone")
    cache_ref = db.collection("cache").document(key)
    cached = cache_ref.get()
    if cached.exists:
        return cached.to_dict().get("errors", [])

    client = anthropic.Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])

    content: list = []
    for i, url in enumerate(urls, start=1):
        content.append({"type": "text", "text": f"Frame {i}/{len(urls)} of the shot"})
        content.append({"type": "image", "source": {"type": "url", "url": url}})
    content.append({"type": "text", "text": build_standalone_prompt(user_hint)})

    response = _create_with_retry(client,
        model="claude-opus-4-8",
        max_tokens=1024,
        messages=[{"role": "user", "content": content}],
    )

    raw = response.content[0].text.strip()
    if raw.startswith("```"):
        raw = raw.split("```")[1]
        if raw.startswith("json"):
            raw = raw[4:]
    try:
        parsed = json.loads(raw)
    except Exception:
        print(f"detect_standalone: could not parse {raw[:200]!r}")
        parsed = {"errors": []}

    errors = parsed.get("errors", [])
    # Standalone errors target this shot. Force fix_target_shot="B" so
    # downstream write_errors routes correctly when shot is passed as B.
    for err in errors:
        err["fix_target_shot"] = "B"
    cache_ref.set({"errors": errors, "ts": datetime.now(timezone.utc)})
    return errors


def _frames_for_shot(shot: dict) -> list[str]:
    urls = shot.get("keyframeUrls")
    if isinstance(urls, list) and urls:
        return [u for u in urls if isinstance(u, str)]
    single = shot.get("keyframeUrl")
    return [single] if isinstance(single, str) else []


def write_errors(job_id: str, shot_a: dict, shot_b: dict, errors: list[dict]) -> None:
    """
    Write detected errors to Firestore. For each Opus-flagged error, call
    Grounding DINO to get a precise bbox on the keyframe where the object
    is most clearly visible. fixDirection is set so that the SHOT THAT
    NEEDS FIXING (per Opus's fix_target_shot) ends up as the target.
    """
    from modal_app.grounding import localize_best_frame, validate_bbox_contains

    db = get_db()
    errors_ref = db.collection("jobs").document(job_id).collection("errors")

    frames_a = _frames_for_shot(shot_a)
    frames_b = _frames_for_shot(shot_b)

    for err in errors:
        target = (err.get("fix_target_shot") or "B").upper()
        if target not in ("A", "B"):
            target = "B"

        err_type = (err.get("type") or "other").lower()
        is_wholeclip_type = err_type in ("lighting", "atmosphere")

        # The target shot is the one that needs fixing; localize the object there.
        target_frames = frames_a if target == "A" else frames_b
        query = (err.get("object_query") or "").strip()
        if not query:
            # Fall back to using a few words from description
            query = " ".join((err.get("description") or "").split()[:6])
        bbox = None
        best_url = None

        # Wholeclip types (lighting, atmosphere) need no spatial bbox — the fix
        # is applied to the entire clip via a text instruction. Skip Grounding
        # DINO and Haiku validation entirely; a single frame can't show a
        # "change" so bbox validation always rejects them anyway.
        if not is_wholeclip_type and query and target_frames:
            bbox, best_url = localize_best_frame(target_frames, query)

        # Validate with Haiku — pass the SHORT object_query (not the long
        # description) so we check the specific object, not the whole scene.
        # Reject on failure: better to leave bbox empty and force the user
        # to mark manually than to send a wrong-spot bbox to Aleph.
        if bbox and best_url and query:
            ok = validate_bbox_contains(best_url, bbox, query)
            if not ok:
                print(
                    f"Bbox validation REJECTED Grounding DINO result for "
                    f"query={query!r}; user will need to mark manually."
                )
                bbox = None

        # Existing fix flow: fixDirection="aTob" → fix Shot B; "bToA" → fix Shot A
        fix_direction = "bToA" if target == "A" else "aTob"
        bbox_field = "bboxA" if target == "A" else "bboxB"

        doc: dict = {
            "shotAId": shot_a["id"],
            "shotBId": shot_b["id"],
            "type": err.get("type", "other"),
            "description": err.get("description", ""),
            "fixSuggestion": err.get("fix_suggestion", ""),
            "objectQuery": query,
            "severity": err.get("severity", "medium"),
            "fixDirection": fix_direction,
            "userConfirmed": False,
            "fixStatus": "pending",
            "verifiedResolved": False,
            **_repairability(err),
            "createdAt": datetime.now(timezone.utc),
        }
        if bbox:
            doc[bbox_field] = {
                "x": bbox["x"], "y": bbox["y"], "w": bbox["w"], "h": bbox["h"]
            }
        errors_ref.add(doc)


def detect_holistic(
    job_id: str,
    shots: list[dict],
    user_hint: str = "",
) -> list[tuple[dict, dict, dict]]:
    """
    Holistic scene-level consistency check. Sends one representative keyframe
    per shot to Opus and asks it to identify outlier shots whose lighting,
    atmosphere, or style doesn't match the rest of the sequence.

    Catches cases pair-wise detection misses — e.g. shot 3 is the odd one
    out but shots 2→3 and 3→4 each look 'close enough' individually.

    Returns list of (ref_shot, outlier_shot, err) tuples.
    Only runs for sequences of 3+ shots.
    """
    if len(shots) < 3:
        return []

    def middle_frame(shot: dict) -> str | None:
        urls = shot.get("keyframeUrls")
        if isinstance(urls, list) and urls:
            return urls[len(urls) // 2]
        return shot.get("keyframeUrl")

    indexed = [(shot, middle_frame(shot)) for shot in shots]
    indexed = [(shot, url) for shot, url in indexed if url]
    if len(indexed) < 3:
        return []

    # Cache holistic results to avoid re-running on repeated jobs
    db = get_db()
    all_urls = [url for _, url in indexed]
    raw_key = "|".join(all_urls) + f"|{HOLISTIC_VERSION}|{user_hint or ''}"
    cache_key = hashlib.sha256(raw_key.encode()).hexdigest()[:40] + "_holistic"
    cache_ref = db.collection("cache").document(cache_key)
    cached = cache_ref.get()
    if cached.exists:
        outliers_raw = cached.to_dict().get("outliers", [])
    else:
        client = anthropic.Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])
        content: list = []
        for i, (_, url) in enumerate(indexed, start=1):
            content.append({"type": "text", "text": f"Shot {i} of {len(indexed)}:"})
            content.append({"type": "image", "source": {"type": "url", "url": url}})
        content.append({"type": "text", "text": build_holistic_prompt(user_hint)})

        response = _create_with_retry(client,
            model="claude-opus-4-8",
            max_tokens=1024,
            messages=[{"role": "user", "content": content}],
        )
        raw = response.content[0].text.strip()
        if raw.startswith("```"):
            raw = raw.split("```")[1]
            if raw.startswith("json"):
                raw = raw[4:]
        try:
            parsed = json.loads(raw)
        except Exception:
            print(f"detect_holistic: could not parse {raw[:200]!r}")
            parsed = {"outliers": []}

        outliers_raw = parsed.get("outliers", [])
        cache_ref.set({"outliers": outliers_raw, "ts": datetime.now(timezone.utc)})

    results: list[tuple[dict, dict, dict]] = []
    for outlier in outliers_raw:
        idx = outlier.get("shot_index")
        if not isinstance(idx, int) or idx < 0 or idx >= len(indexed):
            continue
        outlier_shot = indexed[idx][0]
        # Pair with the nearest neighbor as the reference shot for the side-by-side UI
        ref_idx = idx - 1 if idx > 0 else idx + 1
        ref_shot = indexed[ref_idx][0]

        err_type = outlier.get("type", "other")
        object_query = (
            "lighting and color grade" if err_type == "lighting"
            else "sky and atmosphere" if err_type == "atmosphere"
            else "visual style"
        )
        err = {
            "type": err_type,
            "repairable": outlier.get("repairable"),
            "not_repairable_reason": outlier.get("not_repairable_reason", ""),
            "description": outlier.get("description", ""),
            "fix_suggestion": outlier.get("fix_suggestion", ""),
            "severity": outlier.get("severity", "medium"),
            "object_query": object_query,
            "fix_target_shot": "B",
        }
        results.append((ref_shot, outlier_shot, err))

    print(f"Holistic detection: {len(results)} outlier(s) found across {len(indexed)} shots")
    return results


def run_detect(job_id: str) -> int:
    """Full detect phase. Returns total error count."""
    db = get_db()
    job_ref = db.collection("jobs").document(job_id)
    job_doc = job_ref.get().to_dict() or {}
    user_hint = job_doc.get("userHint", "")

    shots_snap = (
        db.collection("jobs")
        .document(job_id)
        .collection("shots")
        .order_by("index")
        .get()
    )
    shots = [{"id": s.id, **s.to_dict()} for s in shots_snap]

    if not shots:
        job_ref.update({"status": "awaiting_confirmation", "errorCount": 0})

        # outcome:"empty" keeps this branch distinguishable from a real
        # analysis that ran and found nothing. This is the branch that used to
        # mask a decompose rejection, so it must stay separately queryable.
        from modal_app import analytics
        analytics.capture(
            job_id,
            "job_analysis_completed",
            {
                "outcome": "empty",
                "shot_count": 0,
                "error_count": 0,
                "had_zero_shots": True,
            },
            job=job_doc,
        )
        return 0

    # 1. Collect all errors — both standalone (per-shot) and pair-wise (cross-shot).
    raw: list[tuple[dict, dict, dict]] = []  # (shot_a, shot_b, err)

    # Standalone — catches anachronisms even in 1-shot videos and when
    # the same anachronism is present across all shots (no pair difference).
    for shot in shots:
        for err in detect_standalone(job_id, shot, user_hint):
            raw.append((shot, shot, err))

    # Pair-wise — catches cross-shot continuity errors (props changing,
    # temporal/causation errors, wardrobe shifts).
    if len(shots) >= 2:
        pairs = get_pairs_to_compare(shots)
        for shot_a, shot_b in pairs:
            for err in compare_pair(job_id, shot_a, shot_b, user_hint):
                raw.append((shot_a, shot_b, err))

    # Holistic — catches outlier shots that pair-wise misses (e.g. one rogue
    # clip that doesn't stand out in any single pair but is wrong vs. the whole).
    for result in detect_holistic(job_id, shots, user_hint):
        raw.append(result)

    # 2. Dedupe: when multiple pairs flag the SAME underlying error (e.g.
    # the bullet holes appearing in 3 different pair comparisons), keep one.
    # Key: (error type, normalized object_query, target shot id).
    def _norm(s: str) -> frozenset[str]:
        stop = {
            "the", "a", "an", "in", "on", "of", "at", "and", "or",
            "is", "are", "with", "to", "from", "behind",
        }
        return frozenset(
            w.lower().strip(".,'\"") for w in (s or "").split()
            if w.lower().strip(".,'\"") and w.lower() not in stop
        )

    def _similar(a: frozenset[str], b: frozenset[str]) -> bool:
        if not a or not b:
            return False
        # Jaccard >= 0.5 counts as duplicate
        return len(a & b) / max(1, len(a | b)) >= 0.5

    def _target_shot_id(sa: dict, sb: dict, err: dict) -> str:
        target = (err.get("fix_target_shot") or "B").upper()
        return sa["id"] if target == "A" else sb["id"]

    # Dedup on (target_shot_id, object_query similarity).
    # Use object_query ONLY for similarity — Opus writes the description
    # very differently across pairs ("the holes shouldn't exist yet" vs
    # "the effect appears before the cause") but object_query stays close
    # to "bullet holes" / "bullet holes in wall" across pairs.
    def _query_words(err: dict) -> frozenset[str]:
        return _norm(err.get("object_query") or "")

    deduped: list[tuple[dict, dict, dict]] = []
    for sa, sb, err in raw:
        target_id = _target_shot_id(sa, sb, err)
        qw = _query_words(err)
        # Looser threshold (0.3) since we're now comparing short standardized phrases
        is_dup = any(
            _target_shot_id(k_sa, k_sb, k_err) == target_id
            and qw
            and _query_words(k_err)
            and (len(qw & _query_words(k_err)) / max(1, len(qw | _query_words(k_err)))) >= 0.3
            for k_sa, k_sb, k_err in deduped
        )
        if not is_dup:
            deduped.append((sa, sb, err))

    # 3. Write deduped errors
    total_errors = 0
    for sa, sb, err in deduped:
        write_errors(job_id, sa, sb, [err])
        total_errors += 1
    print(f"Detection: {len(raw)} raw → {total_errors} after dedup")

    from modal_app.prompts import compute_continuity_score
    all_errors_snap = (
        db.collection("jobs").document(job_id).collection("errors").get()
    )
    all_errors = [e.to_dict() for e in all_errors_snap]
    score = compute_continuity_score(all_errors)

    job_ref.update({
        "status": "awaiting_confirmation",
        "errorCount": total_errors,
        "scoreBefore": score,
    })

    from modal_app import analytics
    analytics.capture(
        job_id,
        "job_analysis_completed",
        {
            "outcome": "analysed",
            # Both numbers, so a partial analysis is queryable rather than
            # silently indistinguishable from a clean full one.
            "shot_count": job_doc.get("shotCount", len(shots)),
            "shots_analyzed": len(shots),
            "partially_analysed": job_doc.get("shotCount", len(shots)) > len(shots),
            "error_count": total_errors,
            "score_before": score,
            "pair_count": len(get_pairs_to_compare(shots)) if len(shots) >= 2 else 0,
            "raw_before_dedupe": len(raw),
            "had_zero_shots": False,
        },
        job=job_doc,
    )

    return total_errors
