"""
Multi-clip upload: join generated clips and check every boundary is a cut.

    python3 scripts/multi-clip-test/test_combine.py

Needs ffmpeg and numpy. TransNetV2 scores are stubbed, so this checks the
joining and the forced-cut merge, not the network. Firebase is stubbed too:
nothing is uploaded or written.
"""
import os
import subprocess
import sys
import tempfile
import types

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, ROOT)
fb = types.ModuleType("modal_app.firebase")
fb.get_db = fb.get_bucket = lambda: None
sys.modules["modal_app.firebase"] = fb

import numpy as np  # noqa: E402
import modal_app.decompose as d  # noqa: E402
from modal_app.combine import combine_clips, _frame_times, _probe_video  # noqa: E402


def ff(*args):
    subprocess.run(["ffmpeg", "-v", "error", "-y", *args], check=True)


with tempfile.TemporaryDirectory() as tmp:
    a, b, c = (os.path.join(tmp, n) for n in ("a.mp4", "b.mp4", "c.mov"))
    # 3 s 720p30 with audio; 2.5 s 1080p24 silent; 2 s portrait 25 fps, 44.1k audio.
    ff("-f", "lavfi", "-i", "testsrc=size=1280x720:rate=30:duration=3",
       "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
       "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", a)
    ff("-f", "lavfi", "-i", "smptebars=size=1920x1080:rate=24:duration=2.5",
       "-c:v", "libx264", "-pix_fmt", "yuv420p", b)
    ff("-f", "lavfi", "-i", "mandelbrot=size=720x1280:rate=25",
       "-f", "lavfi", "-i", "sine=frequency=660:duration=4", "-t", "2",
       "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ar", "44100", c)

    joined, bounds = combine_clips([a, b, c], tmp)
    info = _probe_video(joined)
    times = _frame_times(joined)
    gaps = {round(y - x, 4) for x, y in zip(times, times[1:])}
    assert (info["width"], info["height"], info["fps"]) == (1280, 720, 30.0), info
    assert info["has_audio"], "silent clip must get a silent track, not drop audio"
    assert bounds == [3000, 5500], bounds
    assert len(times) == 225 and gaps == {0.0333}, (len(times), gaps)
    print(f"joined OK: {info}, boundaries {bounds}")

    def shots(peaks, forced):
        sc = np.zeros(len(times), dtype=np.float32)
        for i, v in peaks.items():
            sc[i] = v
        d._transition_scores = lambda p: sc
        return [(s["startMs"], s["endMs"]) for s in d.detect_shots(joined, forced_cuts_ms=forced)]

    # No forced cuts: unchanged behaviour.
    assert shots({}, None) == [(0, 7500)]
    assert shots({44: 0.9, 90: 0.9}, None) == shots({44: 0.9, 90: 0.9}, [])
    # Clip boundaries are cuts even when the network sees nothing.
    assert shots({}, bounds) == [(0, 3000), (3000, 5500), (5500, 7500)]
    # The network seeing the same cut a frame late adds no sliver shot.
    assert shots({90: 0.9}, bounds) == [(0, 3000), (3000, 5500), (5500, 7500)]
    # A real cut inside a clip is kept alongside.
    assert shots({44: 0.9}, bounds) == [(0, 1500), (1500, 3000), (3000, 5500), (5500, 7500)]
    # Boundaries past a budget trim, or a sliver from the end, are ignored.
    assert shots({}, [3000, 7300, 9000]) == [(0, 3000), (3000, 7500)]
    print("forced cuts OK")
print("all multi-clip tests passed")
