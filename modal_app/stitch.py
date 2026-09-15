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


def probe_duration(path: str) -> float:
    """Measured duration of a media file, in seconds. 0.0 if unreadable."""
    r = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=nw=1:nk=1", path],
        capture_output=True, text=True,
    )
    try:
        return float(r.stdout.strip())
    except (TypeError, ValueError):
        return 0.0


def probe_dimensions(path: str) -> tuple[int, int]:
    """(width, height) of the first video stream. (0, 0) if unreadable."""
    r = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height", "-of", "csv=p=0:s=x", path],
        capture_output=True, text=True,
    )
    try:
        w, h = r.stdout.strip().split("x")[:2]
        return int(w), int(h)
    except (TypeError, ValueError):
        return 0, 0


def mean_luma(path, ss=None, t=None):
    """
    Average Y across the frames of a clip, 0-255. None if it cannot be measured.

    Used to match a fixed segment back to the brightness of the shot it
    replaces, so every frame is read. Sampling this at 4fps looked like a free
    saving and was not: on a 2.4s shot containing an explosion, ten samples put
    the plate 2.5 luma below its true mean, and the correction inherited the
    error. These are per-shot clips, not whole videos — a full decode is cheap.
    """
    # Special characters are structural inside a filtergraph, so the path is
    # escaped rather than interpolated raw — a tempdir name with a colon in it
    # would otherwise be read as the start of filter arguments.
    esc = path.replace("\\", "\\\\").replace(":", "\\:").replace(",", "\\,").replace("'", "\\'")
    graph = f"movie={esc}"
    if ss is not None:
        graph += f",trim=start={ss}:duration={t if t is not None else 10}"
    graph += ",signalstats"
    r = subprocess.run(
        ["ffprobe", "-v", "error", "-f", "lavfi", "-i", graph,
         "-show_entries", "frame_tags=lavfi.signalstats.YAVG",
         "-of", "default=nw=1:nk=1"],
        capture_output=True, text=True,
    )
    vals = []
    for line in r.stdout.splitlines():
        try:
            vals.append(float(line.strip()))
        except (TypeError, ValueError):
            continue
    if not vals:
        return None
    return sum(vals) / len(vals)


# Largest brightness correction we will apply when matching a fixed segment to
# the shot it replaces, in 0-255 luma. A fix that lands further from the plate
# than this has changed the scene rather than drifted in exposure, and forcing
# it back would fight the repair instead of seating it.
MAX_LEVEL_CORRECTION = 20.0

# How close to the plate is close enough, and how many encodes we will spend
# getting there. The source's own cuts sit around 1.4 luma apart, so anything
# under 1.0 is already below the step the viewer accepted in their own footage.
LEVEL_TOLERANCE = 1.0
LEVEL_MAX_PASSES = 4

# Fix types whose whole PURPOSE is to change how bright or graded a shot is.
# Mirrors GRADE_TYPES in detect.py; kept as a literal so stitching does not have
# to import the detection module.
#
# These are exempt from level matching, and getting that wrong undoes the
# repair. Measured on job fmxdjudb57p3zlf4xsdvgjt2, a real user's verified
# lighting fix: the source cut from shot 0 to shot 1 with a 21.6 luma step, the
# fix correctly closed it to 8.8, and matching the result back to the untouched
# plate pushed it to 22.7 — handing back exactly the mismatch the user paid to
# remove, while the job still reported the fix verified.
#
# So the rule is narrow on purpose: correct a shot that drifted in exposure as a
# SIDE EFFECT of a wardrobe or prop edit; never touch a shot that was asked to
# change its look. A grade fix that drifts is caught by the verifier instead,
# and a rejected fix is no longer shipped at all.
GRADE_FIX_TYPES = {"lighting", "atmosphere", "other"}


def match_level(src_path: str, target_luma: float, out_path: str) -> bool:
    """
    Re-grade `src_path` so its mean luma lands on `target_luma`.

    Converges by measurement rather than arithmetic, because an offset does not
    move the mean by the amount you ask for. `eq=brightness` clamps at the top
    of the range, so on a shot with a blown-out sky a large share of the pixels
    cannot move at all: asking for +5.0 on this job's shot delivered +2.0, and a
    single open-loop correction left two thirds of the mismatch on screen.

    Each pass re-encodes from the ORIGINAL source with a revised offset rather
    than stacking encodes on the previous attempt, so converging costs accuracy
    nothing. Returns True if `out_path` was written.
    """
    offset = target_luma - (mean_luma(src_path) or target_luma)
    wrote = False
    for _ in range(LEVEL_MAX_PASSES):
        r = subprocess.run(
            [
                "ffmpeg", "-y", "-i", src_path,
                "-vf", f"eq=brightness={offset / 255.0:.6f}",
                "-c:v", "libx264", "-crf", "18",
                "-pix_fmt", "yuv420p", "-an",
                out_path,
            ],
            capture_output=True,
        )
        if r.returncode != 0:
            return wrote
        wrote = True
        achieved = mean_luma(out_path)
        if achieved is None:
            return wrote
        residual = target_luma - achieved
        if abs(residual) <= LEVEL_TOLERANCE:
            return wrote
        # Scale the next attempt by how much of the last one actually landed.
        delivered = achieved - (mean_luma(src_path) or achieved)
        efficiency = (delivered / offset) if abs(offset) > 1e-6 else 1.0
        if efficiency < 0.1:
            # The range is saturated; more offset will not move it.
            return wrote
        offset = max(
            -MAX_LEVEL_CORRECTION * 3,
            min(MAX_LEVEL_CORRECTION * 3, offset + residual / efficiency),
        )
    return wrote


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
        # A fix we already refunded must never reach the delivered video.
        #
        # This condition used to be fixStatus == "fixed" alone, which is only a
        # record that Runway returned a file — not that the file is any good.
        # The verifier's judgement and the refund decision were both ignored
        # here, so a clip we had looked at, rejected, and given the money back
        # for was still spliced into what the user downloads.
        #
        # That is how job oxm8ye6yq1whnx1ryrvwz6j7 shipped. The fix was marked
        # verifiedResolved false with "the error is still visible", autoRefunded
        # true, refundReason "verification_failed" — and the clip went into the
        # output anyway, carrying a fabricated 0.8s where the running soldier
        # jumps backward. The user paid nothing and still received a video
        # visibly worse than the one he uploaded.
        #
        # If we would not charge for it, we do not ship it. Refusing here means
        # the worst case is the user's own footage back, unchanged, with an
        # honest report of what we found — never footage we damaged. It is the
        # backstop for every upstream mistake: bad shot boundaries, a model that
        # fabricates rather than adjusts, an engine we have not tested yet.
        verdict = err.get("verifyResult") or {}
        rejected = bool(err.get("autoRefunded")) or verdict.get("errorStillVisible") is True
        if rejected:
            print(
                f"  skipping {err_doc.id}: fix was rejected "
                f"({err.get('refundReason') or 'verification failed'}) — "
                f"delivering the original footage for this shot"
            )
        if err.get("fixStatus") == "fixed" and err.get("fixedClipUrl") and not rejected:
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
                    str(err.get("type") or "other").lower(),
                    # The shot this fix was told to MATCH — the other end of the
                    # pair. Equal to the target when detection compared a shot
                    # against itself, which means there is no reference at all.
                    err["shotAId"] if fix_direction == "aTob" else err["shotBId"],
                )

    fixed_clips: dict[str, tuple] = {
        shot: (url, lead_in, span, err_type, ref_id)
        for shot, (_, url, lead_in, span, err_type, ref_id) in _best.items()
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

        # Normalise every segment to one geometry so concat works cleanly.
        #
        # This used to be hardcoded to 1280x720 on the reasoning that "Runway
        # outputs 1280x720". That was never a reason to reshape the USER's
        # video, and it is no longer true either: gemini_omni_flash returns a
        # portrait clip for a portrait input. A 720x1280 upload was therefore
        # pillarboxed into a landscape canvas and then scaled down by
        # post_process, leaving about 270x480 of actual picture inside a
        # letterboxed file — 86% of the frame thrown away, in the wrong
        # orientation, on the format most of our uploads arrive in.
        #
        # The source video's own geometry is the target. Every fixed clip is
        # scaled and padded into it exactly as before, so a model that returns
        # a different shape still composites safely.
        src_w, src_h = probe_dimensions(video_local)
        if src_w <= 0 or src_h <= 0:
            print("stitch: could not probe source dimensions; falling back to 1280x720")
            src_w, src_h = 1280, 720
        # libx264 needs even dimensions on yuv420p.
        TARGET_W, TARGET_H, TARGET_FPS = src_w - (src_w % 2), src_h - (src_h % 2), 24
        print(f"stitch: target geometry {TARGET_W}x{TARGET_H} (from source)")
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
                fixed_url, lead_in, clip_span_s, fix_type, ref_shot_id = fixed_clips[shot["id"]]
                download_file(fixed_url, raw_path)

                shot_span_s = (shot["endMs"] - shot["startMs"]) / 1000.0

                # Trim on what CAME BACK, not on what we asked for.
                #
                # This guard used to read clip_span_s — the span we requested —
                # and compare it against the shot span. On an ordinary fix those
                # two are equal by construction, so the condition was always
                # false and the trim never ran. It could only ever fire when we
                # had padded the request ourselves, and it never looked at the
                # returned file at all.
                #
                # Models do not honour the requested length. Measured on job
                # oxm8ye6yq1whnx1ryrvwz6j7: gemini_omni_flash returned 60 frames
                # (2.517s) for a 58-frame, 2.416s shot. Those 2 extra frames
                # went straight into the concat, so the picture after the join
                # ran 83ms long against audio that did not stretch — sync went
                # from +20ms at 0.99 correlation before the join to -50ms at
                # 0.75 after it. Every impact in the rest of the video landed
                # off its frame.
                #
                # The segment has to occupy exactly the hole it is filling, so
                # take the measured excess off the tail. Re-timing instead would
                # trade the sync error for a speed change against continuing
                # audio, which is worse.
                actual_span_s = probe_duration(raw_path) or clip_span_s
                if actual_span_s > shot_span_s + 0.01:
                    print(
                        f"  shot {shot['index']}: returned clip is "
                        f"{actual_span_s:.3f}s for a {shot_span_s:.3f}s shot "
                        f"(requested {clip_span_s:.3f}s) — trimming"
                    )
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

                # Seat the fixed segment back into the sequence.
                #
                # A fix is generated with no knowledge of the shots either side
                # of it, so it can be internally perfect and still not belong.
                # On the same job, gemini darkened the shot to sell the smoke it
                # added: the cut INTO that shot went from a 1.1 luma step in the
                # source — invisible — to 8.6, and the cut out of it got 42%
                # harsher. That step at both ends is what reads as "obviously
                # stitched", and it is ours, not the model's.
                #
                # Matching the segment's mean level back to the plate it
                # replaces restores both joins to the source's own continuity
                # while keeping everything the fix actually changed. This is a
                # level match, not a crossfade: these joins are real cuts in the
                # source and dissolving them would be a different kind of wrong.
                # What level SHOULD this segment sit at?
                #
                # A grade fix was asked to make this shot match a reference
                # shot, so the reference is the target and the plate is not:
                # matching a lighting fix back to the footage it was correcting
                # hands the user back the exact mismatch they paid to remove.
                # Measured on fmxdjudb57p3zlf4xsdvgjt2, a real user's verified
                # lighting fix — 21.6 luma apart in the source, correctly closed
                # to 8.8 by the fix, pushed back out to 22.7 by matching to the
                # plate.
                #
                # Any other fix — wardrobe, prop, set dressing — was not asked to
                # change the look at all, so the plate is the target and any
                # level shift is drift to be undone.
                if fix_type in GRADE_FIX_TYPES:
                    ref_shot = next(
                        (s for s in shots if s["id"] == ref_shot_id and s["id"] != shot["id"]),
                        None,
                    )
                    target_luma = (
                        mean_luma(
                            video_local,
                            ss=ref_shot["startMs"] / 1000.0,
                            t=(ref_shot["endMs"] - ref_shot["startMs"]) / 1000.0,
                        )
                        if ref_shot
                        else None
                    )
                else:
                    target_luma = mean_luma(
                        video_local, ss=shot["startMs"] / 1000.0, t=shot_span_s
                    )

                plate_luma = mean_luma(
                    video_local, ss=shot["startMs"] / 1000.0, t=shot_span_s
                )
                fixed_luma = mean_luma(raw_path)

                # Only ever correct a REGRESSION, never chase a perfect match.
                #
                # Two shots that belong together can still differ in average
                # brightness for honest reasons — a wide with more sky against a
                # close-up. Forcing their means equal would be a stronger claim
                # than the footage supports. So the bar is the gap the source
                # already had: if the fix left this shot further from its target
                # than the original was, pull it back to at most that distance,
                # and otherwise leave it alone.
                #
                # This is what separates the two live cases. The lighting fix on
                # fmxdjudb closed its gap 21.6 -> 8.8 and is left untouched. The
                # atmosphere fix on v2testou8rhv8vd9 shot 2 was told to match
                # shot 1 and moved AWAY from it, 12.4 -> 23.3, while the verifier
                # passed it because the rain it was asked about was gone. Only
                # the second one is corrected.
                if target_luma is not None and fixed_luma is not None and plate_luma is not None:
                    gap_before = abs(plate_luma - target_luma)
                    gap_after = abs(fixed_luma - target_luma)
                    if gap_after <= gap_before + LEVEL_TOLERANCE:
                        print(
                            f"  shot {shot['index']}: {fix_type} fix held its level "
                            f"(gap {gap_before:.1f} → {gap_after:.1f}) — leaving it alone"
                        )
                        plate_luma = fixed_luma = None
                    else:
                        # Pull back toward the target, no further than the gap
                        # the source already had.
                        direction = 1.0 if fixed_luma < target_luma else -1.0
                        plate_luma = target_luma + direction * -gap_before
                        print(
                            f"  shot {shot['index']}: {fix_type} fix drifted AWAY from "
                            f"{ref_shot_id if fix_type in GRADE_FIX_TYPES else 'its plate'} "
                            f"(gap {gap_before:.1f} → {gap_after:.1f}) — correcting"
                        )
                if plate_luma is not None and fixed_luma is not None:
                    delta = plate_luma - fixed_luma
                    if abs(delta) > MAX_LEVEL_CORRECTION:
                        print(
                            f"  shot {shot['index']}: level delta {delta:+.1f} exceeds "
                            f"±{MAX_LEVEL_CORRECTION:.0f}; leaving the fix alone"
                        )
                    elif abs(delta) >= LEVEL_TOLERANCE:
                        levelled_path = os.path.join(tmp, f"seg_{shot['index']}_lvl.mp4")
                        if match_level(raw_path, plate_luma, levelled_path):
                            raw_path = levelled_path
                            print(
                                f"  shot {shot['index']}: matched level to plate "
                                f"({fixed_luma:.1f} → {mean_luma(levelled_path):.1f}, "
                                f"target {plate_luma:.1f})"
                            )

                # Video only. See the audio note below the segment loop.
                cmd = [
                    "ffmpeg", "-y",
                    "-i", raw_path,
                    "-vf", VF,
                    "-c:v", "libx264", "-crf", "23",
                    "-an",
                    seg_path,
                ]
            else:
                # Original segment: scale + fps-match into the target geometry.
                duration_s = (shot["endMs"] - shot["startMs"]) / 1000.0
                cmd = [
                    "ffmpeg", "-y",
                    "-ss", str(shot["startMs"] / 1000.0),
                    "-i", video_local,
                    "-t", str(duration_s),
                    "-vf", VF,
                    "-c:v", "libx264", "-crf", "23",
                    "-an",
                    seg_path,
                ]

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

        silent_path = os.path.join(tmp, "video_only.mp4")
        result = subprocess.run(
            [
                "ffmpeg", "-y",
                "-f", "concat", "-safe", "0",
                "-i", manifest_path,
                "-c", "copy",
                silent_path,
            ],
            capture_output=True,
        )
        if result.returncode != 0:
            raise RuntimeError(
                f"FFmpeg concat failed (rc={result.returncode}):\n"
                + result.stderr.decode(errors="replace")[-2000:]
            )

        # Lay the ORIGINAL audio over the finished picture, in one piece.
        #
        # Every segment used to carry its own independently-encoded AAC track,
        # which the concat demuxer then joined end to end. AAC encoding prepends
        # priming samples to each track, so every segment boundary inserted a
        # small gap and the error accumulated down the timeline: measured on job
        # oxm8ye6yq1whnx1ryrvwz6j7, sound ran 90ms ahead of picture by the end
        # across five segments, while the first segment was still in sync. The
        # frame overrun fixed above had been masking about 40ms of it, so
        # trimming the video alone made the symptom worse, not better.
        #
        # Fixes are visual-only, and the assembled picture now occupies exactly
        # the source's timeline, so the source's own audio track lines up by
        # construction. One stream, one mux, no per-segment encodes, nothing to
        # accumulate. Copied rather than re-encoded so it stays bit-identical to
        # what the user uploaded.
        output_path = os.path.join(tmp, "output.mp4")
        if has_audio:
            mux = subprocess.run(
                [
                    "ffmpeg", "-y",
                    "-i", silent_path,
                    "-i", video_local,
                    "-map", "0:v:0", "-map", "1:a:0",
                    "-c:v", "copy", "-c:a", "copy",
                    output_path,
                ],
                capture_output=True,
            )
            if mux.returncode != 0:
                # A source codec the MP4 container will not take: re-encode the
                # audio once, over the whole timeline, which still introduces no
                # per-segment boundary.
                mux = subprocess.run(
                    [
                        "ffmpeg", "-y",
                        "-i", silent_path,
                        "-i", video_local,
                        "-map", "0:v:0", "-map", "1:a:0",
                        "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
                        output_path,
                    ],
                    capture_output=True,
                )
            if mux.returncode != 0:
                raise RuntimeError(
                    f"FFmpeg audio mux failed (rc={mux.returncode}):\n"
                    + mux.stderr.decode(errors="replace")[-2000:]
                )
        else:
            output_path = silent_path

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
