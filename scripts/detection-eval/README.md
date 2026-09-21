# Detection eval

Answers the question every previous session had to guess at: **did that change
make detection better, or did we just get a lucky run?**

Detection is not repeatable — the same model on the same frames returns
different findings run to run. So every number here is measured over N runs per
case, never one.

## What it measures

The eval is scored on **false positives first**, because that is the expensive
error. Every finding is offered to the user as a paid repair: a wrong one
spends real money re-generating footage that was never broken, hands back a
degraded video, and gets refunded. A missed detection costs nothing but the
miss.

- **Negatives** (`expected_errors: 0`) — real pairs from real jobs where a
  human looked at the frames and concluded nothing is wrong. Any finding here
  is a false positive.
- **Positives** — clean real pairs with a known grade shift applied to shot B
  by ffmpeg (`eq`/`colorbalance`, amounts recorded in each case's `rationale`).
  Synthetic on purpose: they are ground truth by construction, and they stop a
  configuration from scoring well by simply going blind.

## Running

```
python3 sample.py      # stratified sample of pairs -> contact sheets to label
python3 label.py       # write ground truth + build the synthetic positives
python3 run_eval.py --model claude-opus-5 --prompt v2 --thinking adaptive \
                    --max-tokens 4000 --runs 3
```

`--prompt v1` is the shipped prompt; `v2` is the candidate in `variants.py`,
written as explicit string edits to the production prompt so the diff stays
legible and cannot silently drift from what ships.

**Opus 5 needs `--thinking adaptive --max-tokens 4000`.** Thinking is on by
default on Opus 5 (it is not on 4.8), and thinking tokens count against
`max_tokens`, so the production budget of 1024 truncates the JSON and every
run scores as a parse failure. A first attempt at this comparison reported
Opus 5 as no better than 4.8 purely because of that.

## Measured 2026-09-21, 3 runs x 10 cases

| config | false positives | recall on positives | $/pair |
|---|---|---|---|
| opus-4-8 + v1 (shipped) | 81% | 67% | $0.046 |
| opus-4-8 + v2 | 33% | 44% | $0.047 |
| opus-5 + v1 | 95% | **100%** | $0.061 |
| opus-5 + v2 | **19%** | 67% | $0.055 |

Read those together rather than picking a winner by one column. Opus 5 sees
more than 4.8 — it is the only configuration that caught all three synthetic
grade shifts, including `case11_syn`, which 4.8 never caught once. The v1
prompt then spends that sensitivity on false positives, because v1 explicitly
tells the model a wrong flag "costs the user one dismissed row". It does not
any more, and v2 says so.

**Open:** v2 suppresses `case11_syn`, a genuine warm/bright grade shift, on
both models. The intent gate is over-broad somewhere — likely the "time
passing within the scene" clause reading a warm push as golden hour. That is
the next thing to tighten, and it is worth a case of its own.

## The labels are the weak point

Seven negatives, labelled by looking at the frames. Only `case00` is confirmed
by the product's owner (the coat: same garment, prone in A and kneeling in B).
`case02` is marked medium confidence. Everything the table above claims rests
on those labels being right — widen the set before trusting a small difference
between two configurations.
