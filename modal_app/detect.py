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


PROMPT_VERSION = "v17"  # bumped: different_scene no longer discards object-level findings
HOLISTIC_VERSION = "v1"  # separate version for holistic scene analysis
WINDOW_SECONDS = 60  # sliding window for same-scene detection
SMALL_VIDEO_THRESHOLD = 10  # ≤ this many shots → compare every pair

# Detection calls are independent and I/O-bound, so they run concurrently.
# They used to run one after another, which was tolerable while a video was
# 2 shots and became a 20-minute wait the moment shot detection started
# finding the cuts it had been missing: 10 shots is 45 pair comparisons plus
# 10 standalone passes, and sequentially that is half an hour of someone
# staring at a progress bar.
DETECT_CONCURRENCY = 8

# Writing an error is not a cheap Firestore add: it runs Grounding DINO over
# every keyframe of the target shot first. Those writes run concurrently too,
# bounded here and again by GROUNDING_CONCURRENCY inside grounding.py so the
# two levels together cannot flood Replicate.
WRITE_CONCURRENCY = 8

# Error types that describe how a shot LOOKS rather than what is in it.
#
# These are only meaningful between shots that are supposed to match. Once
# shot detection started finding every cut, comparing all pairs meant shot 1
# was judged against shot 9 — and a deliberate cut from a stormy exterior to a
# candlelit crypt came back as an "atmosphere error" telling us to replace one
# background with the other. On a 10-shot video that produced 28 such errors
# out of 36, each one instructing a different shot to match a different
# reference, several of them flatly contradictory.
#
# Object-level errors (prop, wardrobe, hair, set_dressing, eyeline) still
# compare across every pair: a temporal/causation error like bullet holes
# appearing before the shooting is only visible across distant shots.
GRADE_TYPES = {"lighting", "atmosphere", "other"}


def is_far_grade_error(idx_a: int, idx_b: int, err_type: str) -> bool:
    """
    True when this error describes how two NON-ADJACENT shots differ in look.

    Used by both detection and verification. Verification matters as much as
    detection here: scoreAfter re-runs compare_pair over the output video, so
    without this the same cross-scene grade differences would come back as
    "Aleph introduced 25 new issues" on a video that was repaired correctly.
    """
    if idx_a == idx_b or abs(idx_b - idx_a) == 1:
        return False
    return (err_type or "").lower() in GRADE_TYPES

# Hard ceiling on pair comparisons for one job. A long video with many shots
# would otherwise grow quadratically without bound; adjacent pairs are kept
# first because they carry most of the continuity signal.
MAX_PAIRS = 60

# Hard ceiling on standalone (per-shot) comparisons for one job.
#
# MAX_PAIRS bounded the pair term but left this one growing linearly with shot
# count, so a long video's analysis cost kept climbing after the dominant term
# had stopped. Each standalone call is 5 images plus a prompt — roughly $0.043
# at Opus 4.8's $5/$25 per Mtok — and analysis is billed to us on every scan,
# including free ones. 40 keeps a long video's standalone term near $1.70.
#
# Over the cap, shots are SAMPLED EVENLY across the video rather than truncated
# to the first 40: standalone errors (a boom mic, an anachronistic prop) are
# spread through the footage, and taking a prefix would leave the back half of
# a long video unexamined while reporting a clean result for it.
MAX_STANDALONE = 40


# Defect classes for the final collapse (see collapse_by_defect_class).
#
# Two findings on the same shot in the same class are ONE edit, not two. The
# grade class merges lighting, atmosphere and "other" (style/render mismatch)
# because they are the same remedy — a regrade of the shot — and because the
# detection prompt already forbids reporting a lighting error and an
# atmosphere error for one root cause. It could not enforce that itself: the
# rule lives in the prompt, but each pair is a separate API call with no
# knowledge of what the others found, so shot 7 came back with BOTH
# "lighting changes from night to sunrise" and "background shifts from stormy
# night to golden sunrise" — one defect, described twice, counted twice.
#
# Matches GRADE_TYPES above, which groups the same three for the adjacency rule.
DEFECT_CLASS = {
    "lighting": "grade",
    "atmosphere": "grade",
    "other": "grade",
    "wardrobe": "wardrobe",
    "hair": "hair",
    "prop": "objects",
    "set_dressing": "objects",
    "eyeline": "eyeline",
}

# How many merged fix instructions to carry into one prompt. Past three the
# instruction stops reading as a brief and starts reading as a list, and the
# fix models measurably do worse with compound asks — the same reason the
# detection prompt is told to SPLIT a mixed error rather than write one
# fix_suggestion covering both halves.
MAX_MERGED_SUGGESTIONS = 3


def _severity_rank(err: dict) -> int:
    return {"high": 3, "medium": 2, "low": 1}.get(
        str(err.get("severity") or "medium").lower(), 2
    )


def collapse_by_defect_class(
    deduped: list, target_shot_id
) -> list:
    """
    Collapse findings that target the same shot and the same defect class.

    Text-similarity dedupe runs before this and catches the same object
    described twice. It cannot catch a SYSTEMIC defect, because each pair
    reports it against a different reference and so describes a different
    object every time. On a 14-shot AI animation whose characters change
    clothes throughout, that produced twelve separate wardrobe errors — one
    per pair that happened to show it — including three on shot 13 alone,
    each comparing the same dress against a different earlier shot.

    The user cannot act on that list, the score reads it as twelve problems
    when there is one, and every entry would be charged and rendered
    separately: 193 credits against a 90-credit grant, and six stacked Runway
    re-renders of the same 5.9 seconds of footage, each degrading what the
    next one receives.

    The surviving finding is the most severe in its group. The others are not
    discarded — their instructions are merged into its fix_suggestion and
    their descriptions kept on `merged_descriptions`, so the user still sees
    everything that was found and the fix still addresses all of it.
    """
    groups: dict = {}
    order: list = []
    for sa, sb, err in deduped:
        cls = DEFECT_CLASS.get(str(err.get("type") or "other").lower(), "other")
        # Repairability is part of the key, so a repairable finding is never
        # merged into an unrepairable one. Grouping them together made the
        # whole group unrepairable — on the first live run that silently cost
        # two genuinely fixable findings, because "change the background to
        # match" got absorbed into "the characters morph, this needs a
        # re-shoot". It is also precisely the compound ask the repairability
        # rule exists to prevent: PARTLY unrepairable errors must be split,
        # never combined into one instruction asking for both.
        repairable = err.get("repairable") is not False
        key = (target_shot_id(sa, sb, err), cls, repairable)
        if key not in groups:
            groups[key] = []
            order.append(key)
        groups[key].append((sa, sb, err))

    collapsed: list = []
    for key in order:
        members = groups[key]
        if len(members) == 1:
            collapsed.append(members[0])
            continue

        # Most severe wins the slot; ties keep detection order, which is
        # deterministic (results are sorted by task index before dedupe).
        members.sort(key=lambda m: -_severity_rank(m[2]))
        sa, sb, primary = members[0]
        primary = dict(primary)

        extra_fixes, extra_descs = [], []
        for _, _, other in members[1:]:
            fix = (other.get("fix_suggestion") or "").strip()
            desc = (other.get("description") or "").strip()
            if fix and fix != (primary.get("fix_suggestion") or "").strip():
                extra_fixes.append(fix)
            if desc:
                extra_descs.append(desc)

        if extra_fixes:
            kept = extra_fixes[: MAX_MERGED_SUGGESTIONS - 1]
            primary["fix_suggestion"] = " ".join(
                [(primary.get("fix_suggestion") or "").strip()] + kept
            ).strip()

        primary["merged_count"] = len(members)
        primary["merged_descriptions"] = extra_descs

        collapsed.append((sa, sb, primary))

    if len(collapsed) < len(deduped):
        print(
            f"collapse_by_defect_class: {len(deduped)} → {len(collapsed)} "
            f"after merging same-shot same-class findings"
        )
    return collapsed


def sample_shots_for_standalone(shots: list[dict]) -> list[dict]:
    """Evenly-spaced subset of `shots`, at most MAX_STANDALONE of them."""
    n = len(shots)
    if n <= MAX_STANDALONE:
        return shots
    step = n / MAX_STANDALONE
    picked = [shots[min(n - 1, int(i * step))] for i in range(MAX_STANDALONE)]
    print(f"sample_shots_for_standalone: {n} shots sampled to {len(picked)}")
    return picked

_RETRY_DELAYS = (5, 15, 45)  # seconds between attempts on 529


def _first_text(response) -> str:
    """
    The first text block of a response.

    Not content[0]: on models where thinking is on, content[0] is a
    ThinkingBlock and .text raises AttributeError. Opus 5 has thinking on by
    default (Opus 4.8 does not), so reading content[0] is what made a first
    attempt at comparing the two models report Opus 5 as broken.
    """
    for block in response.content:
        if getattr(block, "type", "") == "text":
            return block.text
    return ""


_EXEMPLAR_CACHE: dict = {}


def load_exemplars(limit: int = 40) -> list[dict]:
    """
    The owner's verdicts from the training queue, newest first.

    These are read once per worker process and reused: detection runs many
    pairs per job and they all deserve the same calibration. A failure here
    must never fail detection — an empty list just means the prompt runs on
    its written rules alone, which is what it did before this existed.
    """
    if "rows" in _EXEMPLAR_CACHE:
        return _EXEMPLAR_CACHE["rows"]
    rows: list[dict] = []
    try:
        db = get_db()
        snap = (
            db.collection("detection_labels")
            .order_by("labelledAt", direction="DESCENDING")
            .limit(limit)
            .get()
        )
        rows = [d.to_dict() or {} for d in snap]
        print(f"detection: loaded {len(rows)} owner-labelled exemplar(s)")
    except Exception as exc:
        print(f"detection: could not load exemplars ({exc}) — running on rules alone")
        rows = []
    _EXEMPLAR_CACHE["rows"] = rows
    return rows


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
    else:
        for i in range(n):
            if i + 1 < n:
                pairs.add((i, i + 1))
            for j in range(i + 2, n):
                if shots[j]["startMs"] - shots[i]["startMs"] <= WINDOW_SECONDS * 1000:
                    pairs.add((i, j))
                else:
                    break

    # Trim to MAX_PAIRS by preferring the closest pairs. Adjacent shots carry
    # most of the continuity signal; a comparison between shot 2 and shot 40 is
    # the first thing worth dropping.
    ordered = sorted(pairs, key=lambda p: (p[1] - p[0], p[0]))
    if len(ordered) > MAX_PAIRS:
        print(f"get_pairs_to_compare: {len(ordered)} pairs trimmed to {MAX_PAIRS}")
        ordered = ordered[:MAX_PAIRS]

    return [(shots[a], shots[b]) for (a, b) in sorted(ordered)]


def cache_key(urls_a: list[str], urls_b: list[str], user_hint: str = "") -> str:
    # Cache by the full set of URLs across both shots (multi-frame).
    raw = "|".join(urls_a) + "::" + "|".join(urls_b) + f"|{PROMPT_VERSION}|{user_hint or ''}"
    return hashlib.sha256(raw.encode()).hexdigest()[:40]


# Frames sent per shot in a PAIR comparison.
#
# Standalone detection keeps all five, because that is the pass that finds
# drift INSIDE a shot — the teddy bear growing a crown at frame 2, the window
# turning from rain to sunset between frames 3 and 5. Measured against both
# test videos: 4 of the 5 findings citing a specific frame number came from
# standalone, only 1 from a pair.
#
# Pair comparison is mostly "shot A is warm, shot B is cool", which does not
# need five frames a side. Images are 86% of the tokens in a pair call, so
# 10 images down to 6 takes roughly 38% off the dominant cost of an analysis.
# Both compare_pair's own docstring and DETECTION_PROMPT say "up to 3 frames
# per shot", and the code had drifted to 5 — so 3 looked like a restoration.
#
# IT IS NOT. Measured 15 Sep, same pair, four runs each:
#   shots 7->8   5 frames: found 3 errors on 3 of 4 runs
#                3 frames: different_scene on 4 of 4 — found NOTHING
#   shots 0->1   5 frames: found 1 error on 3 of 4 runs
#                3 frames: found nothing on 4 of 4
#
# Fewer frames means less evidence that two shots belong to the same scene, so
# the model falls back on "this must be a deliberate cut" and returns
# different_scene — silently reporting a broken video as clean. The saving was
# 38% of the dominant cost and it is not worth buying with detections.
#
# The prompt text is what is out of date here, not the code. Left at 5.
PAIR_FRAMES = 5


def _sample_frames(urls, n: int = PAIR_FRAMES):
    """Evenly-spaced subset keeping the first and last, which bound the shot."""
    if len(urls) <= n:
        return urls
    if n == 1:
        return [urls[len(urls) // 2]]
    step = (len(urls) - 1) / (n - 1)
    return [urls[round(i * step)] for i in range(n)]


def _frame_urls(shot: dict) -> list[str]:
    """Return all keyframe URLs for a shot; fall back to single keyframeUrl."""
    urls = shot.get("keyframeUrls")
    if isinstance(urls, list) and urls:
        return [u for u in urls if isinstance(u, str)]
    single = shot.get("keyframeUrl")
    return [single] if isinstance(single, str) else []


# Words that mark a complaint as "this shot does not hold together across its
# own frames" rather than "these two shots do not match each other".
_WITHIN_SHOT_PHRASES = (
    "across frames",
    "across all frames",
    "between frames",
    "frame 1",
    "from frame",
    "shifts dramatically",
    "changes throughout",
    "different location",
    "distinct urban",
)


def _is_within_shot_environment_drift(err: dict, shot_a: dict, shot_b: dict) -> bool:
    """
    True when an error says one shot's own environment changes mid-shot.

    This is never repairable, and offering it as a fix is actively harmful.
    Observed end to end on job oxm8ye6yq1whnx1ryrvwz6j7: shot detection at
    threshold 27.0 merged four scenes — running boots, soldiers boarding a
    truck, a wide exterior, a truck interior — into one "shot". Comparing that
    shot against itself produced a true observation, "the background shifts
    dramatically across frames", which was marked repairable and sold as a fix.

    The instruction that produces — "match the background environment across all
    frames to a single consistent location" — asks a video model to REPLACE two
    of the four scenes. Gemini complied: it erased the boarding close-up and
    fabricated ~0.8s of wide-shot footage over it. The invented motion does not
    meet the real footage, so the running soldier jumps backward at the handover
    and the delivered video reads as broken in a way the upload was not.

    Either cause — a cut we failed to detect, or genuine generative morphing
    inside a real shot — needs different footage, not an edit. So this is a
    structural refusal, independent of what the detection model claimed and
    independent of the detection threshold, which is why it stays even once
    that threshold is corrected.
    """
    if shot_a.get("id") != shot_b.get("id"):
        return False
    if (err.get("type") or "") not in ("atmosphere", "lighting", "background", "other"):
        return False
    text = " ".join(
        str(err.get(k, "")) for k in ("description", "fix_suggestion")
    ).lower()
    return any(p in text for p in _WITHIN_SHOT_PHRASES)


def _repairability(err: dict, shot_a: dict = None, shot_b: dict = None) -> dict:
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
    if shot_a is not None and shot_b is not None:
        if _is_within_shot_environment_drift(err, shot_a, shot_b):
            return {
                "repairable": False,
                "notRepairableReason": (
                    "this shot cuts between different scenes partway through, so "
                    "it needs re-editing rather than a look change"
                ),
            }
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
    # Subsample BEFORE the cache key is built, so the key describes what was
    # actually sent. A key built from five URLs would happily return a result
    # produced from five frames to a call that only showed three.
    urls_a = _sample_frames(_frame_urls(shot_a))
    urls_b = _sample_frames(_frame_urls(shot_b))
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

    # Cache the shot-A prefix.
    #
    # Shot A's frames are re-sent on every pair it appears in — on a 14-shot
    # video each image went over the wire about 8.6 times (60 pairs x 10
    # images against 70 unique images). Marking the last shot-A block makes
    # everything up to here a cacheable prefix, so the second and later pairs
    # sharing this shot A read it back at a tenth of the price. Measured at
    # ~45% off those calls.
    #
    # The breakpoint sits AFTER shot A and BEFORE shot B deliberately: the
    # prompt stays exactly where it has always been, last in the user turn.
    # Moving it into `system` would cache more, but it would also change what
    # the model is shown — and a same-model, same-input control run differed
    # on 2 of 6 pairs today, so this codebase cannot currently detect a small
    # quality regression. Take the cheap half that is provably inert.
    if content:
        content[-1] = {**content[-1], "cache_control": {"type": "ephemeral"}}

    for i, url in enumerate(urls_b, start=1):
        content.append({"type": "text", "text": f"SHOT B · frame {i}/{len(urls_b)}"})
        content.append({"type": "image", "source": {"type": "url", "url": url}})
    content.append({
        "type": "text",
        "text": build_detection_prompt(user_hint, load_exemplars()),
    })

    # Opus 5 on this call specifically, measured against
    # scripts/detection-eval on 2026-09-21: 94% of findings on labelled clean
    # pairs were false positives on opus-4-8 with the old prompt, 11% on this
    # pairing, at equal recall. Same price per token as 4.8.
    #
    # It needs its own configuration. Thinking is ON by default on Opus 5 and
    # OFF on 4.8, and thinking counts against max_tokens — at the old budget of
    # 1024 every response truncated mid-JSON and parsed as nothing.
    response = _create_with_retry(client,
        model="claude-opus-5",
        max_tokens=4000,
        thinking={"type": "adaptive"},
        messages=[{"role": "user", "content": content}],
    )

    raw = _first_text(response).strip()
    # Strip markdown code fences if present
    if raw.startswith("```"):
        raw = raw.split("```")[1]
        if raw.startswith("json"):
            raw = raw[4:]

    parsed = json.loads(raw)

    errors = parsed.get("errors", [])

    if parsed.get("different_scene"):
        # different_scene used to discard EVERYTHING and return []. That made it
        # an all-or-nothing escape hatch: one uncertain judgement call about
        # whether a cut was deliberate silently threw away every finding in the
        # pair, and reported broken footage as clean.
        #
        # Measured 15 Sep on one real video: shots 7->8 returned different_scene
        # on 4 of 4 runs at 3 frames and on 1 of 4 at 5 frames, while the runs
        # that did NOT bail found 3 genuine errors. The flag flips on roughly
        # 1 in 4 runs for pairs where two shots simply look unalike — which is
        # exactly the most-broken footage, the users who most need the findings.
        #
        # It now means only "these two shots were never meant to match in LOOK",
        # so it drops grade-type findings and keeps object-level ones. A jacket
        # that changes colour is a continuity error whether or not the scene
        # changed around it. This is the same distinction GRADE_TYPES already
        # draws for non-adjacent pairs; different_scene was a second, blunter
        # copy of it.
        kept = [
            e for e in errors
            if str(e.get("type") or "").lower() not in GRADE_TYPES
        ]
        if len(kept) != len(errors):
            print(
                f"different_scene: dropped {len(errors) - len(kept)} grade "
                f"finding(s), kept {len(kept)} object finding(s)"
            )
        cache_ref.set({"errors": kept, "ts": datetime.now(timezone.utc)})
        return kept

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

    raw = _first_text(response).strip()
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
            **_repairability(err, shot_a, shot_b),
            "createdAt": datetime.now(timezone.utc),
        }
        # Present only when collapse_by_defect_class merged findings into this
        # one. The UI shows the extra descriptions so nothing detected is
        # hidden from the user just because it is repaired by the same edit.
        if err.get("merged_count", 1) > 1:
            doc["mergedCount"] = err["merged_count"]
            doc["mergedDescriptions"] = err.get("merged_descriptions", [])
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
        raw = _first_text(response).strip()
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

        # A job that reaches awaiting_confirmation with zero shots shows the
        # user an empty result page. That is a failure even though nothing
        # threw, and it is exactly the branch that used to mask a decompose
        # rejection — so it is worth an email, not just an event.
        try:
            from modal_app import notify
            notify.analysis_failed(
                job_id,
                job=job_doc,
                reason="no shots — nothing could be analysed",
                detail=(
                    "Decompose produced no shots for this video, so the user "
                    "is looking at an empty result. Check the upload itself "
                    "and the keyframe extraction for this job."
                ),
            )
        except Exception as exc:
            print(f"analysis_failed notify failed: {exc}")
        return 0

    # 1. Collect all errors — both standalone (per-shot) and pair-wise (cross-shot).
    raw: list[tuple[dict, dict, dict]] = []  # (shot_a, shot_b, err)

    # Standalone (one per shot) and pair-wise (cross-shot) detection are
    # independent API calls, so they are issued concurrently and collected in a
    # fixed order afterwards — dedupe depends on the order being deterministic,
    # so results are indexed rather than appended as they land.
    from concurrent.futures import ThreadPoolExecutor

    pair_list = get_pairs_to_compare(shots) if len(shots) >= 2 else []
    standalone_shots = sample_shots_for_standalone(shots)
    tasks: list[tuple[dict, dict]] = [
        (shot, shot) for shot in standalone_shots
    ] + pair_list
    print(
        f"Detection: {len(standalone_shots)} standalone + {len(pair_list)} pair "
        f"comparisons across {DETECT_CONCURRENCY} workers"
    )

    def _run(idx_task):
        idx, (sa, sb) = idx_task
        try:
            if sa["id"] == sb["id"]:
                return idx, sa, sb, detect_standalone(job_id, sa, user_hint)
            return idx, sa, sb, compare_pair(job_id, sa, sb, user_hint)
        except Exception as exc:
            # One comparison failing must not lose the other fifty-five.
            print(f"Detection task {idx} failed ({type(exc).__name__}: {exc})")
            return idx, sa, sb, []

    with ThreadPoolExecutor(max_workers=DETECT_CONCURRENCY) as pool:
        results = sorted(pool.map(_run, enumerate(tasks)), key=lambda r: r[0])

    shot_index = {shot["id"]: i for i, shot in enumerate(shots)}
    dropped_far = 0

    for _, sa, sb, errs in results:
        ia = shot_index.get(sa["id"], 0)
        ib = shot_index.get(sb["id"], 0)
        for err in errs:
            if is_far_grade_error(ia, ib, err.get("type")):
                # A grade/style difference between shot 1 and shot 9 is what a
                # cut between two scenes looks like, not an error. See
                # GRADE_TYPES.
                dropped_far += 1
                continue
            raw.append((sa, sb, err))

    if dropped_far:
        print(
            f"Detection: dropped {dropped_far} grade/style errors "
            f"between non-adjacent shots"
        )

    # Holistic — catches outlier shots that pair-wise misses (e.g. one rogue
    # clip that doesn't stand out in any single pair but is wrong vs. the whole).
    #
    # Exempt from the adjacency rule above on purpose: holistic compares one
    # shot against the whole sequence, so "this shot is the odd one out" is
    # exactly the cross-scene grade judgement adjacency is meant to suppress
    # between arbitrary pairs. It is the sanctioned way to catch a rogue clip.
    for result in detect_holistic(job_id, shots, user_hint):
        raw.append(result)

    # 2. Dedupe: when multiple pairs flag the SAME underlying error (e.g.
    # the bullet holes appearing in 3 different pair comparisons), keep one.
    # Key: (error type, normalized object_query, target shot id).
    def _norm(s: str) -> frozenset[str]:
        stop = {
            "the", "a", "an", "in", "on", "of", "at", "and", "or",
            "is", "are", "with", "to", "from", "behind",
            # Colours and generic intensity words carry no identity: two pairs
            # describing the same defect rarely agree on them ("black painted
            # fingernails" vs "fingernail color"), and when they do agree it is
            # usually coincidence ("black sleep mask" vs "black fingernails" on
            # the same shot are different defects). Dropping them makes the
            # overlap that remains a real one.
            "black", "white", "red", "blue", "green", "golden", "gold",
            "warm", "cool", "dark", "light", "bright", "overall",
        }
        # Trailing "s" is stripped so "fingernail color" and "black painted
        # fingernails" — the same defect reported by two different pairs —
        # share a word and can dedupe. Without it they had zero overlap and
        # both survived.
        def _stem(w: str) -> str:
            w = w.lower().strip(".,'\"")
            return w[:-1] if len(w) > 3 and w.endswith("s") else w

        return frozenset(
            _stem(w) for w in (s or "").split()
            if _stem(w) and w.lower() not in stop
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

    # 2b. Collapse systemic defects. Text similarity above catches the same
    # object described twice; this catches one defect reported once per pair
    # that happened to show it. See collapse_by_defect_class.
    deduped = collapse_by_defect_class(deduped, _target_shot_id)

    # 3. Write deduped errors.
    #
    # Each write runs Grounding DINO over the target shot's 5 keyframes to
    # localize the object, and that is a Replicate prediction per frame. Run
    # sequentially, one error cost ~5 minutes and the loop dominated the whole
    # analysis: a 23-second video with 36 errors spent 80 minutes here while
    # detection itself, being cached and concurrent, finished in seconds.
    #
    # The writes are independent — each adds its own document — so they run
    # concurrently. Ordering does not matter: dedupe already ran, and document
    # ids are generated per add().
    from concurrent.futures import ThreadPoolExecutor as _TPE

    def _write_one(item):
        sa, sb, err = item
        try:
            write_errors(job_id, sa, sb, [err])
            return True
        except Exception as exc:
            # One failed localization must not lose the other thirty-five.
            print(f"write_errors failed ({type(exc).__name__}: {exc})")
            return False

    with _TPE(max_workers=WRITE_CONCURRENCY) as pool:
        written = list(pool.map(_write_one, deduped))
    total_errors = sum(1 for ok in written if ok)
    print(f"Detection: {len(raw)} raw → {len(deduped)} after dedup → {total_errors} written")

    from modal_app.prompts import compute_continuity_score
    all_errors_snap = (
        db.collection("jobs").document(job_id).collection("errors").get()
    )
    all_errors = [e.to_dict() for e in all_errors_snap]
    # Pass the shot count: the score is error DENSITY, and without it a
    # fifteen-shot video is scored as if it were a two-shot one.
    score = compute_continuity_score(all_errors, len(shots))

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

    try:
        from modal_app import notify
        # Re-read: decompose writes the truncation fields, and job_doc was
        # loaded at the top of this function, before any of that happened.
        fresh = job_ref.get().to_dict() or {}
        notify.analysis_finished(
            job_id,
            job=fresh,
            shot_count=len(shots),
            error_count=total_errors,
            score=score,
            truncated=bool(fresh.get("analysisTruncated")),
            analysed_s=fresh.get("analysedSeconds"),
            total_s=fresh.get("totalSeconds"),
        )
    except Exception as exc:
        print(f"analysis_finished notify failed: {exc}")

    return total_errors
