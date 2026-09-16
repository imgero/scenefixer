"""
Measure ContentDetector's threshold against an INDEPENDENT cut detector.

Ground truth is not another PySceneDetect run — that would only prove the
detector agrees with itself. It is a frame-to-frame difference measured with
ffmpeg, where a hard cut is an isolated spike far above the local background.
Only unambiguous spikes count, so the ground truth under-reports soft cuts
rather than inventing cuts that are not there; a threshold that misses one of
these is missing something obvious.
"""
import glob, json, os, statistics, subprocess, sys
from concurrent.futures import ProcessPoolExecutor

CORPUS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "corpus")
THRESHOLDS = [27.0, 24.0, 22.0, 20.0, 18.0, 15.0, 12.0]
# A spike this many times the local median difference is a cut by any standard.
SPIKE_RATIO = 6.0
# Cuts within this many seconds of each other are the same cut seen twice.
MERGE_S = 0.25


def diff_series(path):
    """(time, mean abs difference from previous frame) per frame, downscaled."""
    esc = path.replace(":", "\\:")
    r = subprocess.run(
        ["ffprobe", "-v", "error", "-f", "lavfi", "-i",
         f"movie={esc},scale=160:-2,tblend=all_mode=difference,signalstats",
         "-show_entries", "frame=pts_time:frame_tags=lavfi.signalstats.YAVG",
         "-of", "csv=p=0"],
        capture_output=True, text=True,
    )
    out = []
    for line in r.stdout.splitlines():
        p = line.split(",")
        if len(p) >= 2:
            try:
                out.append((float(p[0]), float(p[1])))
            except ValueError:
                pass
    return out


def truth_cuts(series):
    """Times of unambiguous hard cuts."""
    if len(series) < 12:
        return []
    vals = [v for _, v in series]
    med = statistics.median(vals) or 0.01
    cuts = []
    for i, (t, v) in enumerate(series):
        if i < 2:
            continue
        lo = max(0, i - 12)
        hi = min(len(series), i + 13)
        local = statistics.median([x for _, x in series[lo:hi]]) or med
        if v > SPIKE_RATIO * max(local, 0.5) and v > 8.0:
            if not cuts or t - cuts[-1] > MERGE_S:
                cuts.append(t)
    return cuts


def detector_cuts(path, threshold):
    from scenedetect import open_video, SceneManager
    from scenedetect.detectors import ContentDetector
    v = open_video(path)
    m = SceneManager()
    m.add_detector(ContentDetector(threshold=threshold))
    m.detect_scenes(v)
    scenes = m.get_scene_list()
    return [s.get_seconds() for s, _ in scenes][1:], max(1, len(scenes))


def one(path):
    try:
        gt = truth_cuts(diff_series(path))
        row = {"file": os.path.basename(path), "truth": len(gt), "by": {}}
        for th in THRESHOLDS:
            cuts, nshots = detector_cuts(path, th)
            matched = sum(1 for g in gt if any(abs(g - c) < 0.35 for c in cuts))
            extra = sum(1 for c in cuts if not any(abs(g - c) < 0.35 for g in gt))
            row["by"][th] = {"shots": nshots, "found": matched,
                             "missed": len(gt) - matched, "extra": extra}
        return row
    except Exception as e:
        return {"file": os.path.basename(path), "error": str(e)[:80]}


if __name__ == "__main__":
    files = sorted(glob.glob(os.path.join(CORPUS, "*.mp4")))
    with ProcessPoolExecutor(max_workers=6) as ex:
        rows = list(ex.map(one, files))
    json.dump(rows, open(os.path.join(os.path.dirname(CORPUS), "sweep.json"), "w"), indent=1)
    ok = [r for r in rows if "error" not in r]
    print(f"analysed {len(ok)} of {len(rows)} videos\n")
    total_truth = sum(r["truth"] for r in ok)
    print(f"{'threshold':>10} {'shots':>8} {'cuts found':>12} {'MISSED':>8} {'extra':>8}")
    for th in THRESHOLDS:
        shots = sum(r["by"][th]["shots"] for r in ok)
        found = sum(r["by"][th]["found"] for r in ok)
        missed = sum(r["by"][th]["missed"] for r in ok)
        extra = sum(r["by"][th]["extra"] for r in ok)
        pct = 100.0 * found / total_truth if total_truth else 0
        print(f"{th:>10} {shots:>8} {found:>7} ({pct:4.1f}%) {missed:>8} {extra:>8}")
    print(f"\nground-truth hard cuts across corpus: {total_truth}")
