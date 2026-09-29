# Shot-detection eval

Measures `modal_app/decompose.detect_shots` — where the cuts are — against
hand-labelled events on real uploads. Local, no API calls, no spend.

Built 2026-09-29 after three real users in a row were failed by shot
segmentation, not by the detection model: letterbox bars hid 9 cuts (09-23), a
dark low-contrast cut scored 25.6 against a 27.0 threshold (09-25), and a
tribute film joined by cross-dissolves became one 33-second "shot" (09-29). Each
missed boundary turned into a confident, wrong "high" error in the user's video.

## Labels

`labels.json` — 596 events across 70 videos (84 unique uploads, md5-deduped;
14 had nothing either detector reacted to).

Candidates were every point where EITHER detector reacted at all: ContentDetector
peaks >= 15, TransNetV2 peaks >= 0.05, and every cut production made. Each was
labelled from 9 frames spanning -1.0 s to +1.0 s:

| label | meaning | count |
|---|---|---|
| C | hard cut | 303 |
| D | gradual transition — dissolve, fade, dip to white, glitch wipe | 35 |
| N | not a cut — camera move, fast motion, flash, AI morph, text fade | 229 |
| ? | ambiguous (mostly motion graphics), excluded | 29 |

The 257 points where production, TransNetV2 >= 0.5 AND ContentDetector >= 27 all
agreed were labelled C after a 40-point random sample came back 40/40 real.

Limits: a cut NO detector reacted to is not in the set, so recall is relative to
what the two detectors can see. Two variable-frame-rate uploads are excluded —
their frame clocks disagreed across tools while labelling.

## Results (TOLERANCE 0.5 s)

| detector | hard cuts | transitions | false cuts |
|---|---|---|---|
| ContentDetector 27.0 (shipped until 09-29) | 257 | 4 | 30 |
| ContentDetector 20 | 292 | 12 | 108 |
| TransNetV2 0.5 | 286 | 17 | 0 |
| **TransNetV2 0.3 (shipped)** | **287** | **24** | **7** |
| TransNetV2 0.1 | 299 | 27 | 31 |

A false cut is the expensive error: it makes a pair out of one continuous shot,
and that pair can produce a REPAIRABLE false finding a user pays to have fixed.
So thresholds were chosen on false cuts first. The shipped row is the production
code path, including its 0.5 s minimum shot length, which drops 8 cuts that sit
within 0.5 s of the start or end of a video.

What the 7 false cuts at 0.3 are: a magic-light effect, a flash to white, a
push-in, two dance moves, cards being dealt, a colour morph. Production at 27.0
fired on three of the same.

## Running

```
python scripts/shot-eval/test_shots.py     # boundary rules + blank shots, synthetic, seconds
python scripts/shot-eval/fetch.py          # download + normalize the corpus (once)
python scripts/shot-eval/run.py            # score the shipped detect_shots; exit 1 if worse
```

Needs torch and `transnetv2-pytorch==1.0.5` locally (Python >= 3.10; the system
3.9 cannot install them). `SHOT_CORPUS` overrides the corpus location.
