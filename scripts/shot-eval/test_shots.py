"""
detect_shots' boundary rules and is_blank_shot, checked offline on synthetic
input. No model, no corpus, no spend — seconds to run:

    python scripts/shot-eval/test_shots.py
"""
import os, sys, types, tempfile

sys.path.insert(0, os.getcwd())
_fb = types.ModuleType("modal_app.firebase")
_fb.get_db = _fb.get_bucket = lambda: None
sys.modules["modal_app.firebase"] = _fb
import numpy as np, cv2
import modal_app.decompose as d


def shots_for(scores, fps=30.0, times=None):
    n = len(scores)
    d._transition_scores = lambda p: np.array(scores, dtype=np.float32)
    d._frame_times = lambda p: times if times is not None else [i / fps for i in range(n)]
    d._duration_ms = lambda p: int(n / fps * 1000)
    return d.detect_shots("unused.mp4")


def test_cut_starts_on_the_frame_after_the_peak():
    s = [0.0] * 90
    s[44] = 0.9                                   # last frame of shot 1
    shots = shots_for(s)
    assert [x["startMs"] for x in shots] == [0, 1500], shots
    assert shots[-1]["endMs"] == 3000


def test_threshold_and_soft_cuts():
    s = [0.0] * 300
    s[59], s[149] = 0.31, 0.29                    # one cut, one weak peak
    shots = shots_for(s)
    assert len(shots) == 2
    assert shots[1]["softCutsMs"] == [5000], shots
    assert shots[0]["softCutsMs"] == []


def test_min_shot_length_at_edges_and_between_cuts():
    s = [0.0] * 300
    s[5] = 0.99                                   # 0.2 s in: thumbnail, dropped
    s[100], s[108] = 0.9, 0.8                     # 0.27 s apart: keep the stronger
    s[295] = 0.99                                 # 0.13 s from the end: dropped
    shots = shots_for(s)
    assert [x["startMs"] for x in shots] == [0, 3366], shots


def test_variable_frame_rate_uses_real_timestamps():
    # 60 frames at 1/60 s, then 30 frames at 1/10 s: an index/avg-fps clock
    # would put frame 70 at 1.56 s; its real time is 2.1 s.
    times = [i / 60 for i in range(60)] + [1.0 + (i + 1) / 10 for i in range(30)]
    s = [0.0] * 90
    s[69] = 0.9
    shots = shots_for(s, times=times)
    assert shots[1]["startMs"] == 2100, shots


def test_blank_shot():
    tmp = tempfile.mkdtemp()
    black = np.zeros((72, 128), np.uint8)
    cv2.putText(black, "+", (110, 65), cv2.FONT_HERSHEY_SIMPLEX, 0.3, 90, 1)  # tiny watermark
    night = np.full((72, 128), 12, np.uint8)
    night[10:20, 10:40] = 140                     # a lit window: real footage
    paths = {}
    for name, img in (("black", black), ("night", night)):
        paths[name] = os.path.join(tmp, f"{name}.jpg")
        cv2.imwrite(paths[name], img)
    assert d.is_blank_shot([paths["black"]] * 3)
    assert not d.is_blank_shot([paths["black"], paths["night"]])
    assert not d.is_blank_shot([])


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print(f"ok  {name}")
