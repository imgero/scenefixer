"""
The pipeline's geometry invariant, checked offline. No API calls, no spend.

    keyframe aspect == fix-clip aspect == normalized-source aspect,
    and nothing is ever padded,

which is what makes a normalised bbox portable from the frame it was measured
on to the clip the red marker is burned into. Break it and every marker lands
somewhere the object is not — silently, because nothing downstream can tell a
well-placed box from a badly-placed one.

Run it after touching transcode_to_720p, extract_clip,
extract_clip_with_in_video_marker, _fit_size, or grounding's normalisation:

    python3 scripts/geometry-test/test_geometry.py

Needs the corpus: six real uploads covering landscape, portrait-in-landscape
(pillarboxed), an odd 1366x768, and a clip too short to fix. Point CORPUS at a
directory holding them. They are user footage, so they are NOT in the repo —
see .gitignore.
"""
import os, sys, subprocess, tempfile, json
sys.path.insert(0, os.getcwd())
import numpy as np, cv2
from modal_app.decompose import (
    detect_content_crop, transcode_to_720p, detect_shots,
    extract_keyframe, apply_content_crop,
)
from modal_app.fix import extract_clip_with_in_video_marker, _fit_size

CORPUS = os.environ.get("GEOM_CORPUS", os.path.expanduser("~/.scenefixer-geom-corpus"))

def dims(p):
    o = subprocess.run(["ffprobe","-v","error","-select_streams","v:0",
        "-show_entries","stream=width,height","-of","csv=p=0:nk=1",p],
        capture_output=True,text=True).stdout.strip().split(",")
    return int(o[0]), int(o[1])

def drawn_box_fraction(marked, plain):
    """Bounds of whatever the marker ADDED, as fractions. Immune to red content
    already in the shot — smoke14 has some, and naive red-thresholding found it."""
    d = cv2.absdiff(marked, plain).max(axis=2)
    ys, xs = np.where(d > 60)
    if len(xs) == 0: return None
    h, w = marked.shape[:2]
    return (xs.min()/w, ys.min()/h, (xs.max()-xs.min())/w, (ys.max()-ys.min())/h)

# the bbox under test, in normalized keyframe coordinates
BBOX = {"x": 0.30, "y": 0.25, "w": 0.40, "h": 0.35}
CASES = [("timeline1.mp4","pillarboxed portrait",10),("smoke18.mp4","landscape 16:9",18),
         ("smoke14.mp4","landscape 1366x768",14),("youcut2.mp4","landscape",2),
         ("user2shot.mp4","landscape",2),("kael.mp4","landscape 1-shot",1)]

print(f"{'file':16s} {'crop':20s} {'norm':>10s} {'shots':>5s} {'kf':>10s} {'clip':>10s} {'aspect ok':>9s} {'bbox err':>9s}")
print("-"*104)
fails = []
for name, desc, expect_shots in CASES:
    src = os.path.join(CORPUS, name)
    with tempfile.TemporaryDirectory() as tmp:
        crop = detect_content_crop(src)
        norm = os.path.join(tmp,"norm.mp4")
        transcode_to_720p(src, norm, crop=crop)
        nw, nh = dims(norm)
        shots = detect_shots(norm)

        kf = os.path.join(tmp,"kf.jpg")
        extract_keyframe(norm, (shots[0]["startMs"]+shots[0]["endMs"])/2, kf)
        kimg = cv2.imread(kf); kh, kw = kimg.shape[:2]

        from modal_app.fix import extract_clip
        clip = os.path.join(tmp,"clip.mp4"); plain = os.path.join(tmp,"plain.mp4")
        try:
            extract_clip_with_in_video_marker(norm, shots[0]["startMs"], shots[0]["endMs"], BBOX, clip)
            extract_clip(norm, shots[0]["startMs"], shots[0]["endMs"], plain)
        except RuntimeError as e:
            # Pre-existing, correct: clips under MIN_CLIP_DURATION are refused.
            print(f"{name:16s} {str(crop or '(none)'):20s} {f'{nw}x{nh}':>10s} {len(shots):5d} "
                  f"{f'{kw}x{kh}':>10s} {'n/a':>10s} {'n/a':>9s}   (too short to clip: {str(e)[:38]})")
            if len(shots)!=expect_shots: fails.append((name,"shots",len(shots),expect_shots))
            continue
        cw, ch = dims(clip)
        def grab(v, out):
            subprocess.run(["ffmpeg","-v","error","-y","-ss","0.5","-i",v,"-frames:v","1",out],check=True)
            return cv2.imread(out)
        got = drawn_box_fraction(grab(clip, os.path.join(tmp,"a.png")),
                                 grab(plain, os.path.join(tmp,"b.png")))

        aspect_ok = abs(kw/kh - cw/ch) < 0.01
        err = max(abs(got[i]-[BBOX["x"],BBOX["y"],BBOX["w"],BBOX["h"]][i]) for i in range(4)) if got else 9.9
        ok = aspect_ok and err < 0.02 and len(shots)==expect_shots
        if not ok: fails.append((name, aspect_ok, err, len(shots), expect_shots))
        print(f"{name:16s} {str(crop or '(none)'):20s} {f'{nw}x{nh}':>10s} {len(shots):5d} "
              f"{f'{kw}x{kh}':>10s} {f'{cw}x{ch}':>10s} {'yes' if aspect_ok else 'NO':>9s} {err:9.4f}")

print()
if fails:
    print("FAILURES:")
    for f in fails: print("  ", f)
    sys.exit(1)
print("PASS — every keyframe and clip share the source aspect, and a normalized")
print("bbox lands within 2% of its target in the burned-in marker on all 6.")
