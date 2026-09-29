"""
Score the SHIPPED decompose.detect_shots against hand-labelled cuts.

    python scripts/shot-eval/run.py

Exits non-zero if a change finds fewer real transitions or more false cuts
than the 2026-09-29 baseline. Run it after touching detect_shots, its
thresholds, transcode_to_720p or detect_content_crop. Local only, no spend.
"""
import os, sys, json, types, collections

sys.path.insert(0, os.getcwd())
_fb = types.ModuleType("modal_app.firebase")
_fb.get_db = _fb.get_bucket = lambda: None
sys.modules["modal_app.firebase"] = _fb
from modal_app.decompose import detect_shots

HERE = os.path.dirname(os.path.abspath(__file__))
CORPUS = os.environ.get("SHOT_CORPUS", os.path.expanduser("~/.scenefixer-shot-corpus"))

# TransNetV2 at 0.3, measured when it shipped. Old ContentDetector at 27.0 on
# the same labels: 257 hard cuts, 4 transitions, 30 false cuts.
BASELINE = {"C": 287, "D": 24, "N": 7}

# A detected cut counts for a labelled event within this distance. Detectors
# disagree by a frame or two about where a cut is, and a dissolve is ~0.5 s long.
TOLERANCE_S = 0.5


def main():
    events = [e for e in json.load(open(os.path.join(HERE, "labels.json")))["events"] if e["l"] != "?"]
    by_job = collections.defaultdict(list)
    for e in events:
        by_job[e["job"]].append(e)

    hit, total, missing = collections.Counter(), collections.Counter(), []
    for job, evs in sorted(by_job.items()):
        path = os.path.join(CORPUS, f"{job}.mp4")
        if not os.path.exists(path):
            missing.append(job)
            continue
        cuts = [s["startMs"] / 1000 for s in detect_shots(path)][1:]
        for e in evs:
            total[e["l"]] += 1
            if any(abs(t - e["t"]) <= TOLERANCE_S for t in cuts):
                hit[e["l"]] += 1

    if missing:
        print(f"{len(missing)} videos missing from {CORPUS} — run fetch.py first")
    print(f"hard cuts   {hit['C']:4d}/{total['C']}   (baseline {BASELINE['C']})")
    print(f"dissolves   {hit['D']:4d}/{total['D']}   (baseline {BASELINE['D']})")
    print(f"FALSE cuts  {hit['N']:4d}/{total['N']}   (baseline {BASELINE['N']}, lower is better)")

    worse = hit["C"] < BASELINE["C"] or hit["D"] < BASELINE["D"] or hit["N"] > BASELINE["N"]
    if worse and not missing:
        print("WORSE than baseline")
        sys.exit(1)


if __name__ == "__main__":
    main()
