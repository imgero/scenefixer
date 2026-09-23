"""
Phase 6 — Verify the output video has no new errors.
Re-runs decompose + detect on the output video, writing to a separate
'verify_errors' subcollection so we don't pollute the original errors.
"""

from datetime import datetime, timezone

from modal_app.firebase import get_db
from modal_app.decompose import (
    download_video,
    transcode_to_720p,
    detect_content_crop,
    detect_shots,
    extract_keyframe,
    upload_keyframe,
)
from modal_app.detect import (
    get_pairs_to_compare,
    compare_pair,
    is_far_grade_error,
    collapse_by_defect_class,
)
from modal_app.prompts import compute_continuity_score
import os
import tempfile


def run_verify(job_id: str) -> dict:
    db = get_db()
    job_ref = db.collection("jobs").document(job_id)
    job = job_ref.get().to_dict()

    if not job.get("outputVideoUrl"):
        raise ValueError("No outputVideoUrl on job — cannot verify")

    with tempfile.TemporaryDirectory() as tmp:
        raw_path = download_video(job_id, job["outputVideoUrl"], tmp)
        norm_path = os.path.join(tmp, "normalized_output.mp4")
        # Measured on the OUTPUT, not copied from the job. The output should
        # already carry no bars; if an engine handed some back, detection still
        # has to see past them to resolve the right shot structure.
        transcode_to_720p(raw_path, norm_path, crop=detect_content_crop(raw_path))

        # Straight off norm_path, same as decompose: it is already cropped and
        # unpadded, so there is no second transcode and no padded fallback that
        # could score the output against the wrong shot structure.
        shots = detect_shots(norm_path)

        # Upload keyframes for output shots (stored under verify_shots)
        #
        # extract_keyframe returns None and writes NO FILE when ffmpeg cannot
        # produce a frame — the failure decompose.py already guards, for the
        # reason its docstring gives: upload_keyframe then raises [Errno 2] on
        # a path that was never created. Here that lands after the user has
        # been charged and after restitch has written the output, so the outer
        # handler in app.py marks the job "error" and download — gated on
        # status "done" — is refused for a file that exists and is correct.
        #
        # Skipping the shot instead is already a supported outcome: fewer
        # verify shots than input shots makes score_reliable False below, and
        # scoreAfter is withheld rather than wrong.
        verify_shots = []
        for shot in shots:
            mid_ms = (shot["startMs"] + shot["endMs"]) / 2
            kf_path = os.path.join(tmp, f"vkf_{shot['index']}.jpg")
            if extract_keyframe(norm_path, mid_ms, kf_path) is None:
                print(
                    f"Verify: keyframe skipped — output shot {shot['index']} at "
                    f"{mid_ms / 1000.0:.3f}s: ffmpeg produced no frame"
                )
                continue
            storage_path = f"jobs/{job_id}/verify_keyframes/{shot['index']}.jpg"
            keyframe_url = upload_keyframe(kf_path, storage_path)
            verify_shots.append({
                "id": f"vshot_{shot['index']:04d}",
                **shot,
                "keyframeUrl": keyframe_url,
            })

        # Compare pairs and collect new errors
        pairs = get_pairs_to_compare(verify_shots)
        kept: list = []          # (shot_a, shot_b, err), for the collapse
        dropped_far = 0
        for shot_a, shot_b in pairs:
            errors = compare_pair(job_id, shot_a, shot_b)
            for err in errors:
                # Same rule detection uses. Without it, a correctly repaired
                # video comes back covered in "new issues" that are really just
                # its own scene cuts, and scoreAfter collapses to 0 — the
                # output would be judged by a standard the input never had to
                # meet.
                if is_far_grade_error(
                    shot_a["index"], shot_b["index"], err.get("type")
                ):
                    dropped_far += 1
                    continue
                kept.append((shot_a, shot_b, err))
        if dropped_far:
            print(
                f"Verify: dropped {dropped_far} grade/style errors between "
                f"non-adjacent shots"
            )

        # The SAME collapse detection applies, for the same reason the
        # adjacency rule above is duplicated here: scoreBefore counts findings
        # after one systemic defect has been folded into a single entry, so a
        # scoreAfter counting them raw is not measuring the same thing.
        #
        # Without this, the first verified fix in the current architecture
        # (shot 7, 14 Sep) reported scoreBefore 29 -> scoreAfter 21: the
        # repair worked, the verifier passed it, and the user would have been
        # shown their video getting worse. Any rule that shapes the error list
        # must land in both paths.
        def _verify_target_shot_id(sa: dict, sb: dict, err: dict) -> str:
            return sa["id"] if (err.get("fix_target_shot") or "B").upper() == "A" else sb["id"]

        collapsed = collapse_by_defect_class(kept, _verify_target_shot_id)
        if len(collapsed) < len(kept):
            print(
                f"Verify: {len(kept)} -> {len(collapsed)} after the same "
                f"same-shot same-class collapse detection applies"
            )
        new_errors = [err for _, _, err in collapsed]

        # Same shot-count denominator as scoreBefore. Without it the two
        # numbers are computed on different scales and the before/after
        # comparison shown to the user is meaningless.
        score_after = compute_continuity_score(new_errors, len(verify_shots))

        # A verify pass that resolved fewer shots than the input had did not
        # measure the same video, and its score is not comparable to
        # scoreBefore. With one shot there are no pairs at all, so detection
        # finds nothing and the score comes back 100 — no matter what the fix
        # stage did or failed to do.
        #
        # This is not hypothetical. Job k6mz9iqk9jp7v5pcksvaxz4h (11 Sep) was
        # written scoreBefore 31 -> scoreAfter 100 while its own fix run
        # recorded attempted 2, verified 0: the user was told their video had
        # reached a perfect score by a run that fixed nothing. Every flattering
        # before/after in the data so far is this artifact.
        input_shots = int(job.get("shotCount") or 0)
        score_reliable = input_shots > 0 and len(verify_shots) >= input_shots
        if not score_reliable:
            print(
                f"Verify: output resolved {len(verify_shots)} shots against "
                f"{input_shots} in the input — scoreAfter is not comparable"
            )

        # Write verify errors to separate subcollection
        verify_ref = db.collection("jobs").document(job_id).collection("verify_errors")
        for err in new_errors:
            verify_ref.add({**err, "createdAt": datetime.now(timezone.utc)})

        # Don't touch verifiedResolved here — it was already set accurately by
        # verify_fix() in fix.py right after inpainting. Overwriting it here
        # would erase the per-error Opus check result.

        # Surface new errors to user if any — do NOT set "done" here;
        # app.py sets it after post_process so outputVideoUrl is the final watermarked file.
        # scoreAfter is written ONLY when it means something. Absent is the
        # honest state for an incomparable run — the UI already handles a
        # missing scoreAfter by showing no "after" badge, whereas a bogus 100
        # is indistinguishable from a real one.
        update: dict = {"scoreAfterReliable": score_reliable}
        if score_reliable:
            update["scoreAfter"] = score_after
        else:
            update["scoreAfterNote"] = (
                f"Could not score the output: it resolved into "
                f"{len(verify_shots)} shot(s) against {input_shots} in the "
                f"original, so the two are not comparable."
            )
        if new_errors:
            # "Aleph introduced N new issues" was wrong on every partial run.
            # This pass re-detects the WHOLE output, so it re-finds every error
            # the user chose not to fix — on the 14 Sep test, three fixes out
            # of twenty-two left nineteen untouched problems, and all nineteen
            # were reported as damage our own fixer had caused.
            #
            # Anything up to the number left unfixed is simply what was already
            # there. Only a count above that can contain something genuinely
            # new, and even then we cannot say which, so the wording stays
            # careful rather than accusing the fix stage by default.
            unfixed = 0
            try:
                all_errs = (
                    db.collection("jobs").document(job_id).collection("errors").get()
                )
                unfixed = sum(
                    1 for d in all_errs if (d.to_dict() or {}).get("fixStatus") != "fixed"
                )
            except Exception as exc:
                print(f"verifyWarning: could not count unfixed errors ({exc})")

            if unfixed == 0:
                # Nothing was left unfixed, so "these are the ones that were
                # not fixed" is simply false — and it was written to a real
                # user's job (b47ouhwebj005zzyul4ot8ea, 19 Sep) whose single
                # confirmed error had been fixed. The old chained condition
                # `len(new_errors) > unfixed > 0` is False when unfixed is 0,
                # so every all-fixed job fell through to the wrong branch.
                #
                # With nothing outstanding, a finding is either something the
                # first detection pass missed or something the fix introduced.
                # We cannot tell which from here, so say both.
                update["verifyWarning"] = (
                    f"{len(new_errors)} issue(s) found in the output. Everything "
                    f"you asked to fix was fixed, so these were either already "
                    f"in the original and missed the first time, or introduced "
                    f"by the fix. Review below."
                )
            elif len(new_errors) > unfixed:
                update["verifyWarning"] = (
                    f"{len(new_errors)} issue(s) found in the output — more than "
                    f"the {unfixed} left unfixed, so some may be new. Review below."
                )
            else:
                update["verifyWarning"] = (
                    f"{len(new_errors)} issue(s) still present in the output — "
                    f"these are the ones that were not fixed. Review below."
                )

        job_ref.update(update)

        return {
            "newErrorCount": len(new_errors),
            "scoreAfter": score_after if score_reliable else None,
            "scoreAfterReliable": score_reliable,
        }
