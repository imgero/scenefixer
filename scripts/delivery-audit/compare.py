import glob, json, os
from concurrent.futures import ProcessPoolExecutor

def one(path):
    from scenedetect import open_video, SceneManager
    from scenedetect.detectors import ContentDetector, AdaptiveDetector
    def run(det):
        v = open_video(path); m = SceneManager(); m.add_detector(det); m.detect_scenes(v)
        s = m.get_scene_list()
        return [x.get_seconds() for x, _ in s][1:], max(1, len(s))
    try:
        c_cuts, c_n = run(ContentDetector(threshold=27.0))
        a_cuts, a_n = run(AdaptiveDetector())
        only_a = [t for t in a_cuts if not any(abs(t - c) < 0.35 for c in c_cuts)]
        only_c = [t for t in c_cuts if not any(abs(t - a) < 0.35 for a in a_cuts)]
        return {"f": os.path.basename(path), "c_n": c_n, "a_n": a_n,
                "only_a": only_a, "only_c": only_c}
    except Exception as e:
        return {"f": os.path.basename(path), "error": str(e)[:60]}

if __name__ == "__main__":
    files = sorted(glob.glob("corpus/*.mp4"))
    with ProcessPoolExecutor(max_workers=6) as ex:
        rows = list(ex.map(one, files))
    json.dump(rows, open("compare.json", "w"), indent=1)
    ok = [r for r in rows if "error" not in r]
    cn = sum(r["c_n"] for r in ok); an = sum(r["a_n"] for r in ok)
    oa = sum(len(r["only_a"]) for r in ok); oc = sum(len(r["only_c"]) for r in ok)
    same = sum(1 for r in ok if r["c_n"] == r["a_n"])
    more = sum(1 for r in ok if r["a_n"] > r["c_n"])
    fewer = sum(1 for r in ok if r["a_n"] < r["c_n"])
    print(f"videos analysed         {len(ok)}")
    print(f"total shots  Content27  {cn}")
    print(f"total shots  Adaptive   {an}   ({an/cn:.2f}x)")
    print(f"same shot count         {same} videos")
    print(f"Adaptive finds more     {more} videos")
    print(f"Adaptive finds fewer    {fewer} videos")
    print(f"cuts only Adaptive saw  {oa}")
    print(f"cuts only Content saw   {oc}")
