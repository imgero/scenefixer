# Delivery audit

Measure what a user actually received, rather than what the pipeline reported.

Every defect found on 2026-09-15 — a portrait video delivered as landscape, 90ms
of accumulated A/V drift, a grade step at both ends of a fixed shot, a refunded
clip spliced into the download — was invisible to code review and to every check
the pipeline runs on itself. Each one was found by probing the delivered file.

These scripts run the **shipped** `modal_app.stitch.restitch()` offline against a
real job's real assets, with only Firestore and Storage stubbed out. No network,
no Modal, no cost, and no need to wait for a user to hit the problem.

## Fetching a job

Assets are pulled with the firebase-admin credentials in `.env.local` into
`cases/<job_id>/`: `input.mp4`, the fixed clips, and `data.json` holding the job
document, its shots and its errors, plus a `map` from each remote URL to the
local file that stands in for it.

Note that a job's `inputVideoUrl` may point at **another** job's storage path —
the test harness reuses uploads — so resolve the URL rather than listing
`jobs/<id>/input/`.

## Running

```
python3 case.py <job_id> <out.mp4>     # rebuild a job's output with current code
python3 measure.py <job_id>            # geometry, frames, seam steps, A/V sync
```

`measure.py` compares three files — the user's original, `<job>_OLD.mp4` and
`<job>_NEW.mp4` — so build the "old" one by checking out the previous
`stitch.py` first:

```
git show <sha>:modal_app/stitch.py > modal_app/stitch.py   # keep a backup!
python3 case.py <job_id> <job_id>_OLD.mp4
git checkout modal_app/stitch.py
python3 case.py <job_id> <job_id>_NEW.mp4
```

What it reports, and why each one caught something real:

- **geometry** — the delivered file's shape against the upload's. Caught the
  hardcoded 1280×720 landscape canvas.
- **frame count** — caught a model returning 60 frames for a 58-frame shot.
- **seam steps** — mean luma either side of each fixed shot's cuts, against the
  same cuts in the source. A fix that seats badly shows up as a step the source
  did not have. Judge against the SOURCE's step, not against zero: two shots
  that belong together can honestly differ.
- **A/V sync** — cross-correlates audio envelopes against the original, split
  before and after the join. Caught drift that measured fine on the first
  segment and 90ms out by the end.

## Shot detection

```
python3 sweep.py       # ContentDetector thresholds vs an independent detector
python3 compare.py     # ContentDetector 27.0 vs AdaptiveDetector, whole corpus
```

Both expect a `corpus/` directory of real-user videos.

**Read the numbers with suspicion.** `sweep.py`'s ground truth is frame-to-frame
difference, and on AI-generated footage it flags explosion flashes as cuts while
missing real cuts in high-motion passages. It is a screening tool, not an
oracle. Anything either script suggests should be confirmed by extracting the
frames either side of a candidate cut and looking at them — doing exactly that
is what showed 10 of 12 sampled `AdaptiveDetector` cuts were false, and stopped
a detector swap that the summary statistics made look obviously correct.
