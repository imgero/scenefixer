"""
Download the labelled uploads and normalize them exactly as production does.

    python scripts/shot-eval/fetch.py          # into ~/.scenefixer-shot-corpus

Reads each job's inputVideoUrl with the firebase-admin credentials in
.env.local, then runs the SHIPPED detect_content_crop + transcode_to_720p, so
the detector is scored on the same pixels it sees in production. The videos are
user footage and stay out of the repo.
"""
import os, sys, json, subprocess, types
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.getcwd())
# decompose imports modal_app.firebase, which wants Modal secrets. Nothing here
# touches Firestore through it.
_fb = types.ModuleType("modal_app.firebase")
_fb.get_db = _fb.get_bucket = lambda: None
sys.modules["modal_app.firebase"] = _fb
from modal_app.decompose import detect_content_crop, transcode_to_720p

import firebase_admin
from firebase_admin import credentials, firestore

HERE = os.path.dirname(os.path.abspath(__file__))
CORPUS = os.environ.get("SHOT_CORPUS", os.path.expanduser("~/.scenefixer-shot-corpus"))


def _env():
    env = {}
    for line in open(".env.local"):
        if "=" in line and not line.strip().startswith("#"):
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip().strip("'\"")
    return env


def main():
    env = _env()
    firebase_admin.initialize_app(credentials.Certificate({
        "type": "service_account",
        "project_id": env["FIREBASE_ADMIN_PROJECT_ID"],
        "client_email": env["FIREBASE_ADMIN_CLIENT_EMAIL"],
        "private_key": env["FIREBASE_ADMIN_PRIVATE_KEY"].replace("\\n", "\n"),
        "token_uri": "https://oauth2.googleapis.com/token",
    }))
    db = firestore.client()
    jobs = sorted({e["job"] for e in json.load(open(os.path.join(HERE, "labels.json")))["events"]})
    os.makedirs(os.path.join(CORPUS, "raw"), exist_ok=True)

    def one(job):
        out = os.path.join(CORPUS, f"{job}.mp4")
        if os.path.exists(out):
            return job, "cached"
        url = (db.collection("jobs").document(job).get().to_dict() or {}).get("inputVideoUrl")
        if not url:
            return job, "no inputVideoUrl"
        raw = os.path.join(CORPUS, "raw", job)
        subprocess.run(["curl", "-sf", "-o", raw, url], check=True)
        transcode_to_720p(raw, out, crop=detect_content_crop(raw))
        return job, "ok"

    with ThreadPoolExecutor(6) as pool:
        for job, status in pool.map(one, jobs):
            if status not in ("ok", "cached"):
                print(f"{job}: {status}")
    print(f"{len(jobs)} videos in {CORPUS}")


if __name__ == "__main__":
    main()
