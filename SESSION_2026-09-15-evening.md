# Session 2026-09-15 evening — the first real user on the new build, and seven defects between a good fix and a good download

Started from a PostHog export taken while a user was still on the site. One real
user, `bsilent590@gmail.com`, arrived from ChatGPT at 18:46 UTC, signed up 40
seconds later, uploaded 8.9s of AI-generated war footage, confirmed two errors
and requested two fixes. Both failed. He left at 18:53:49.

Reviewing what he was actually handed found four separate defects in the
delivery path, none of which had anything to do with detection or with the fix
engine. Three more known defects were closed the same night rather than left on
a list. Everything here was measured against his real assets and two other jobs'
real assets, by re-running the shipped `restitch()` offline — and, for shot
detection, against all 77 real-user videos we hold.

**Everything in this session is deployed.** `modal deploy` for the pipeline,
`vercel --prod` for the web app, both verified live. Commits `68ff65b` and
`d23a115`, pushed to `github.com/imgero/scenefixer`.

---

## 1. What happened to him

| Time (UTC) | |
|---|---|
| 18:46:21 | Lands on `/?utm_source=chatgpt.com` |
| 18:46:22 | Clicks sign in — one second later |
| 18:47:20 | Upload completes (5s) |
| 18:49:26 | **Analysis completes — 2m 03s**, 5 shots, 3 errors, score 78 |
| 18:49:57 / 18:50:14 | Confirms two errors, requests both fixes |
| 18:52:06 | Fix A returns and **fails verification** |
| 18:53:07 | Fix B **blocked by Runway content moderation** |
| 18:53:49 | Last click. Gone. |

Analysis at 2 minutes is the best real-user number so far. Credits worked
correctly for the first time on a live user: 2 + 3 deducted, 5 refunded, balance
correct against the 90/month free grant. **That closes the open item from the
morning session.**

Fix B's failure is vendor-side and legitimate — `Input media did not pass
content moderation` on footage containing a fireball, a soldier thrown to the
ground and a prone body. Not a false positive. The Claude diagnosis path
identified the cause at high confidence and wrote a good user-facing message;
that code earned its place on its first live run.

---

## 2. Four defects in the delivery path

All four were invisible to every existing check, and all four were found by
measuring the delivered file rather than by reading code.

### 2.1 Portrait video delivered as landscape — `stitch.py`

`TARGET_W, TARGET_H = 1280, 720` was hardcoded, justified by a comment saying
"Runway outputs 1280x720". That was never a reason to reshape the *user's*
video, and it is no longer true: `gemini_omni_flash` returns portrait for
portrait input. His 720×1280 upload was pillarboxed into landscape, then
downscaled by `post_process`, leaving roughly **270×480 of picture inside a
letterboxed file — 86% of the frame discarded, in the wrong orientation**, on
the format most of our uploads arrive in.

The source's own geometry is now the target. This also fixed a silent downscale
on a landscape job: 1366×768 had been resized to 1280×720 for no reason.

### 2.2 The trim guard that could never fire — `stitch.py`

The guard meant to cut over-long returned clips read `clipSpanSeconds` — the
span we *requested* — and compared it against the shot span. On an ordinary fix
those two are equal by construction, so the condition was **always false**. It
could only ever fire when we had padded the request ourselves, and it never
looked at the returned file at all.

Models do not honour the requested length. Gemini returned **60 frames for a
58-frame shot**. It now probes the returned file and trims on the measured
duration.

### 2.3 Accumulating A/V drift — `stitch.py`

Fixing 2.2 made sync *worse*: −50ms became −90ms. The frame overrun had been
masking a larger problem.

Every segment carried its own independently-encoded AAC track, which the concat
demuxer joined end to end. AAC prepends priming samples to each track, so
**every segment boundary inserted a gap and the error accumulated down the
timeline** — while the first segment still measured in sync, which is exactly
why it was never caught.

Fixes are visual-only and the assembled picture now occupies exactly the
source's timeline, so the source's own audio lines up by construction. It is
copied over the finished video in one piece, bit-identical to the upload.

Measured on a **real user's job** (`fmxdjudb57p3zlf4xsdvgjt2`, a verified 24.2s
chunked lighting fix): **+90ms at 0.9338 correlation → 0ms at 1.0000.** That
user was shipped 90ms of drift on a fix that otherwise worked.

### 2.4 Shipping fixes we had already refunded — `stitch.py`

The stitcher selected clips on `fixStatus == "fixed"` alone, which only records
that Runway returned a file. **The verifier's judgement and the refund decision
were both ignored.** On this job the fix was `verifiedResolved: false`, "the
error is still visible", `autoRefunded: true` — and the clip went into his
download anyway. He paid nothing and still received a video visibly worse than
the one he uploaded.

**The rule now: if we would not charge for it, we do not ship it.** The worst
case a user can get is their own footage back, unchanged, with an honest report
of what was found — never footage we damaged. This is the backstop for every
upstream mistake, including ones not yet known.

---

## 3. The lag at 2.04s — root cause is shot detection

He would have seen a distinct stutter: the running soldier advances toward the
truck, snaps **backward** at 2.04s, then advances again.

Frame-by-frame, the clip we *sent* Runway contains a close-up of soldiers
boarding the truck, then a hard cut at its frame 22 to a wide shot — two scenes,
one clean edit. The clip Gemini *returned* is all wide shot. It erased the
boarding close-up and extended the wide shot backwards over it, which is exactly
what "match the background environment across all frames to a single consistent
location" told it to do. To comply it **fabricated ~0.8s of footage**, and the
invented motion does not meet the real footage. The jump is that handover.

Why that fix was offered at all: `ContentDetector(threshold=27.0)` in
`decompose.py` **merged four scenes into one shot** — running boots, boarding,
wide exterior, truck interior, all inside `shot_0001`. Comparing that shot
against itself produced a true observation that was never a continuity defect.

```
threshold 27.0 (shipping) → 5 shots: 1.253  3.675  5.971  7.516
threshold 22.0            → 6 shots: 1.253  2.171  3.257  5.971  7.516
threshold 18.0 / 15.0     → 6 shots: same
```

Independently confirmed by luma measurement: the cut at **3.257 scores 103** —
the largest frame-to-frame change anywhere in the video — and 27.0 walked past
it while accepting one at 3.675 scoring 59.

### The threshold stays at 27.0 — and that is a measured result

The first instinct was to lower it, and the first reason not to was wrong: I
said an A/B here needed a repeat-run control because "detection is
non-deterministic". That conflated two different stages. The non-determinism is
in **Opus error detection**; `ContentDetector` is a classical algorithm and is
deterministic. So this needed no live experiment at all — it was measurable
offline, immediately, and was.

All **77 distinct real-user videos** we hold were pulled from Storage (16.4
minutes of footage) and swept across thresholds 27 → 12, scored against an
independent cut detector built from frame-to-frame difference.

```
 threshold    shots   cuts found   MISSED    extra
      27.0      220     114 (53.5%)      99       40
      22.0      238     127 (59.6%)      86       49
      20.0      254     137 (64.3%)      76       57
      15.0      267     124 (58.2%)      89       74
      12.0      291     132 (62.0%)      81       91
```

Recall plateaus near 60% wherever the threshold goes, while false positives climb
steadily. **But that table is not trustworthy on its own** — checking the
independent detector against the one video reviewed frame by frame showed it
flagging explosion flashes at 0.25s and 1.667s while missing real cuts at 5.971
and 7.516. Automatic ground truth is not reliable on this footage, so no
threshold should be chosen from those numbers.

`AdaptiveDetector`, designed for exactly this fast-motion case, looked much more
promising: on the war footage it finds `1.253 2.171 3.257 5.971 7.516` — both
cuts 27.0 missed, without losing the ones it found, and with no tuned constant.
Across the corpus it agrees with 27.0 on **60 of 77 videos** and adds 47 cuts on
the rest.

**Twelve of those 47 were sampled and looked at, frame before and frame after.
Ten are false** — motion graphics, AI animation, a woman talking to camera:
content that changes continuously without ever cutting. Switching would trade
missed cuts for invented shot boundaries, and an invented boundary splits one
continuous shot into two that are then compared against each other. That is the
false-atmosphere-error shape from 9 Sep, bought back at 1.22x the shot count and
therefore 1.22x the analysis cost.

**So 27.0 stays, on evidence rather than on a guess in either direction.** What
makes the missed cuts survivable is not the detector — it is the `detect.py`
guard above and the ship-gate in §2.4, which between them mean a missed cut can
no longer reach a user as a damaged video. Improving detection itself needs a
hand-labelled evaluation set; that is the honest next step, and it is not a
threshold change.

### The guard that was added instead — `detect.py`

When a finding says one shot's own environment changes across its own frames
(`shotAId == shotBId` on a grade-type error), it is now marked **unrepairable**
and shown as a finding with no fix button. Either it is a cut we failed to
detect or it is generative morphing; both need re-editing, not a look change.

This is deliberately independent of the threshold, so it keeps holding once the
threshold is corrected. It is not hypothetical: `v2testou8rhv8vd9` shot 7 is a
second instance of the same class — `A=shot_0007 B=shot_0007` — and it **passed
verification**.

---

## 4. Seating a fix back into its neighbours — and the trap in doing it

A fix is generated with no knowledge of the shots either side of it, so it can
be internally perfect and still not belong. On his job the cut *into* the fixed
shot went from a 1.1 luma step in the source — invisible — to 8.6.

**The first version of this correction was wrong**, and only testing it against
a job with a *working* fix caught it. On the real user's job the fix was a
*lighting* fix: the source cut with a 21.6 luma step, the fix correctly closed
it to 8.8, and matching the result back to the untouched plate shoved it out to
**22.7 — handing back the exact mismatch they had paid to remove**. A blanket
"make the fixed shot match the footage it replaced" undoes any repair whose
purpose *is* the look.

The rule that replaced it:

- A **grade fix** (lighting / atmosphere / other) was told to match a
  **reference shot**, so the reference is the target, not the plate.
- Any other fix was not asked to change the look, so the plate is the target.
- The correction only ever undoes a **regression**: if the fix left the shot
  further from its target than the source already was, pull it back that far —
  otherwise leave it alone. Two shots that belong together can differ in average
  brightness for honest reasons, and forcing their means equal claims more than
  the footage supports.
- Convergence is by measurement, not arithmetic. `eq=brightness` clamps at the
  top of the range, so on a shot with a blown-out sky a request for +5.0
  delivered +2.0. It now iterates from the original source with a revised offset
  until it converges or saturates.

---

## 5. Measured results

Every number below comes from re-running the shipped `restitch()` over real
assets, built twice — once on the pre-change code, once on the new.

**`oxm8ye6yq1whnx1ryrvwz6j7`** — the real user, both fixes rejected:

| | His original | What he got | After |
|---|---|---|---|
| Geometry | 720×1280 | **1280×720** | **720×1280** |
| Frames | 212 | **214** | **212** |
| Motion at 2.04s | smooth | **backward jump** | **smooth** |
| Picture vs original | — | — | 1.4% mean (encode noise) |
| A/V sync | — | −50ms · 0.75 | **0ms · 1.0000** |

**`v2testou8rhv8vd9`** — 3 verified fixes, 14 shots, both engines, two fixes
chained on one shot:

| | Original | Old | New |
|---|---|---|---|
| Geometry | 1366×768 | **1280×720** | **1366×768** |
| Seam into shot 2 | 12.39 | **23.21** | **11.42** |
| Seam into shot 7 | 42.20 | **48.63** | **41.87** |

**`fmxdjudb57p3zlf4xsdvgjt2`** — a real user, 1 verified chunked lighting fix:

| | Original | Old | New |
|---|---|---|---|
| A/V sync | — | **+90ms · 0.9338** | **0ms · 1.0000** |
| Seam into shot 1 | 21.61 | 8.75 | **8.75 — repair preserved** |

---

## 6. Three more known defects, closed the same night

These were on a "not fixed" list and were going to stay there until a user
tripped over one. That was the wrong call and they were done instead.

### 6.1 Portrait users were getting half the plan they paid for

`post_process` read the plan tier as a target **height**. On a landscape video
the height *is* the short side, so "480p" produced 854×480 — the tier as
promised. On a **portrait** video the height is the LONG side, so the same line
produced **270×480**: a short side of 270 against a landscape user's 480, on the
identical plan, at the identical price.

Vertical is the format most uploads arrive in, so the tier was quietly worth
about half to the majority of users. The number now means the short side in both
orientations — 854×480 landscape, 480×854 portrait.

### 6.2 The verifier now has to show it did not make things worse

The Opus verifier answers the question it is asked and no other. On
`v2testou8rhv8vd9` it passed an atmosphere fix with *"All frames show a sunny sky
and green trees through the window with no rain visible anywhere"* — on a clip
whose mean level had moved **away** from the shot it was told to match, a 12.3
luma gap widening to 23.1. The user's complaint *was* that mismatch. We widened
it and reported success.

Grade fixes now carry a second gate: measure the target shot against its
reference in the source, measure the fixed clip against the same reference, and
fail the fix if the gap got worse by more than 3.0 luma.

Deliberately one-sided. A fix that closes the gap partway is an improvement and
passes. Two shots that honestly differ in average brightness are not penalised —
only a fix that *widened* the difference is. Validated against the live data
before shipping:

| job | fix | gap before → after | verdict |
|---|---|---|---|
| `v2testou8rhv8vd9` | atmosphere, shot_0002 → match shot_0001 | 12.3 → **23.1** | now unverified |
| `v2testou8rhv8vd9` | atmosphere, shot_0007 vs *itself* | — | no reference; blocked upstream by §3's guard |
| `fmxdjudb57p3zlf4xsdvgjt2` | lighting, shot_0001 → match shot_0000 | 21.6 → **8.7** | passes, repair preserved |

Combined with the ship-gate, a fix caught here is refunded *and* never reaches
the delivered video.

### 6.3 Downloads are finally instrumented

There was no download event anywhere in the codebase. The single moment the
product exists for was the only step in the funnel with nothing on it — so every
delivery fix in this session was measured on our own machines with no way to
know whether any user has ever actually retrieved a file.

`download_started` now fires before the fetch (so a download that dies midway
still counts as an attempt) carrying the job's verified / attempted / failed
counts, whether verification passed, and the credits refunded.
`download_completed` carries the byte count, `download_failed` the reason. A
download can now be read against whether the fix actually worked.

---

## 7. What is NOT fixed — read before promising anything

- **Shot detection is still imperfect and 27.0 is still the threshold.** §3
  explains why no available change improves it: lowering it plateaus, swapping
  detectors buys false boundaries. What stops a missed cut reaching a user is
  the `detect.py` guard plus the ship-gate, not the detector. Fixing detection
  properly needs a hand-labelled evaluation set.
- **Models can still return content artifacts inside a fix that passes both
  gates** — fabricated motion, morphing, a subject that jumps, as at 2.04s on
  the burning-truck job. Neither the Opus verifier nor the new continuity check
  looks for temporal coherence. This is the largest remaining hole.
- **Fixes chain, and the ship-gate does not follow the chain.** Two fixes on one
  shot stack: the second starts from the first's output. If the first is now
  caught and dropped, the second still ships *carrying the first's change*. The
  level match mitigates it; it is not resolved.
- **Output fps is normalised to 24** regardless of source. A 30fps upload comes
  back 24fps at identical duration. Pre-existing, unchanged, not evaluated.
- Refunds credit `creditsBalance` but never decrement `creditsUsedThisMonth`,
  and `ceilingLeft` is computed from the latter — so refunded seconds still
  count against the 300s hard monthly ceiling. Not binding at current volumes.
- **Both new gates make fixes fail MORE often.** That is correct — we were
  over-reporting success — but it means more refunds and fewer shipped fixes
  until fix quality itself improves. Watch `download_started` against
  `fixes_verified` to see what users are actually receiving.

---

## 8. Reproducing any of this

The measurement rig is in the repo at **`scripts/delivery-audit/`** with its own
README — it is not scratch work, it is the only thing that found any of this.

```
python3 case.py <job_id> <out.mp4>     # rebuild a job's output with current code
python3 measure.py <job_id>            # geometry, frames, seam steps, A/V sync
python3 sweep.py / compare.py          # shot-detection experiments
```

`restitch()` runs offline against any cached job with only Firestore and Storage
stubbed: the shipped code path, real inputs, no network, no cost, and no need to
wait for a user to hit the problem.

**When the next user reports a bad output, fetch their job and run `measure.py`
before theorising.** Every defect in this document was invisible to code review
and visible in the file.
