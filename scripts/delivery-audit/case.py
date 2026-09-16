"""
Run the real modal_app.stitch.restitch() for any cached job, offline.

    python3 case.py <job_id> <output.mp4>
"""
import json, os, shutil, sys, types

SCRATCH = os.path.dirname(os.path.abspath(__file__))
REPO = "/Users/alanany/Desktop/Scene Fixer"
JOB = sys.argv[1]
OUT = sys.argv[2]
DIR = os.path.join(SCRATCH, "cases", JOB)

raw = json.load(open(os.path.join(DIR, "data.json")))


class Ts:
    def __init__(self, v): self.v = v
    def timestamp(self): return self.v


def revive(o):
    if isinstance(o, dict):
        if "__ts" in o and len(o) == 1:
            return Ts(o["__ts"])
        return {k: revive(v) for k, v in o.items()}
    if isinstance(o, list):
        return [revive(x) for x in o]
    return o


data = revive(raw)


class Doc:
    def __init__(self, d): self.id = d.get("__id"); self._d = d
    def to_dict(self): return {k: v for k, v in self._d.items() if k != "__id"}


class SubColl:
    def __init__(self, rows): self._rows = rows
    def order_by(self, *a, **k): return self
    def get(self): return [Doc(r) for r in self._rows]


class JobRef:
    def get(self): return Doc(data["job"])
    def collection(self, name):
        return SubColl(data["shots"] if name == "shots" else data["errors"])
    def update(self, payload): pass


class Coll:
    def document(self, _id): return JobRef()


class DB:
    def collection(self, _n): return Coll()


class Blob:
    def __init__(self, p): self.path = p
    def upload_from_filename(self, local, content_type=None): shutil.copy(local, OUT)


class Bucket:
    name = "scenefixer.firebasestorage.app"
    def blob(self, p): return Blob(p)


fake = types.ModuleType("modal_app.firebase")
fake.get_db = lambda: DB()
fake.get_bucket = lambda: Bucket()
sys.modules["modal_app.firebase"] = fake

sys.path.insert(0, REPO)
import modal_app.stitch as stitch  # noqa: E402

LOCAL = raw["map"]
stitch.download_file = lambda url, dest: (shutil.copy(LOCAL[url], dest), dest)[1]
stitch.restitch(JOB)
print(f"  -> {OUT}")
