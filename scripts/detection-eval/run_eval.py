"""
Score a detection configuration against the labelled set.

    python3 run_eval.py --model claude-opus-4-8 --runs 3
    python3 run_eval.py --model claude-opus-5 --thinking adaptive --effort medium

Negatives (expected_errors == 0) measure FALSE POSITIVES — the expensive kind:
each one costs a Runway call, a refund, and a damaged delivery.
Positives are synthetic grade mismatches; they measure that we did not fix the
false-positive rate by simply going blind.
"""
import argparse, base64, json, os, sys, collections, concurrent.futures
sys.path.insert(0, "/Users/alanany/Desktop/Scene Fixer")
for line in open("/Users/alanany/Desktop/Scene Fixer/.env.local"):
    if "=" in line and not line.strip().startswith("#"):
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip("\"'"))
import anthropic
from modal_app.prompts import build_detection_prompt
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from variants import build_v2

PRICES = {"claude-opus-5": (5.0, 25.0), "claude-opus-4-8": (5.0, 25.0),
          "claude-sonnet-5": (2.0, 10.0), "claude-haiku-4-5": (1.0, 5.0)}

def b64(p):
    return base64.standard_b64encode(open(p, "rb").read()).decode()

def call(client, case, args, prompt_fn):
    content = []
    for i, p in enumerate(case["frames"]["A"], 1):
        content += [{"type": "text", "text": f"SHOT A · frame {i}/{len(case['frames']['A'])}"},
                    {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": b64(p)}}]
    for i, p in enumerate(case["frames"]["B"], 1):
        content += [{"type": "text", "text": f"SHOT B · frame {i}/{len(case['frames']['B'])}"},
                    {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": b64(p)}}]
    content.append({"type": "text", "text": prompt_fn(case.get("hint", ""))})
    kw = dict(model=args.model, max_tokens=args.max_tokens,
              messages=[{"role": "user", "content": content}])
    if args.thinking == "adaptive":
        kw["thinking"] = {"type": "adaptive"}
    elif args.thinking == "disabled":
        kw["thinking"] = {"type": "disabled"}
    if args.effort:
        kw["output_config"] = {"effort": args.effort}
    r = client.messages.create(**kw)
    txt = next((b.text for b in r.content if getattr(b, "type", "") == "text"), "")
    raw = txt.strip()
    if raw.startswith("```"):
        raw = "\n".join(raw.split("\n")[1:-1]).strip()
    try:
        parsed = json.loads(raw)
    except Exception:
        return None, r.usage, raw[:200]
    errs = parsed.get("errors", parsed) if isinstance(parsed, dict) else parsed
    return (errs if isinstance(errs, list) else []), r.usage, None

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="claude-opus-4-8")
    ap.add_argument("--thinking", default="none", choices=["none", "adaptive", "disabled"])
    ap.add_argument("--effort", default=None)
    ap.add_argument("--max-tokens", type=int, default=1024, dest="max_tokens")
    ap.add_argument("--runs", type=int, default=1)
    ap.add_argument("--label", default="")
    ap.add_argument("--prompt", default="v1", choices=["v1","v2"])
    a = ap.parse_args()
    cases = json.load(open("eval_set.json"))
    client = anthropic.Anthropic()
    jobs = [(c, r) for c in cases for r in range(a.runs)]
    def one(t):
        c, _ = t
        try:
            return (c, *call(client, c, a, build_detection_prompt if a.prompt=="v1" else build_v2))
        except Exception as e:
            return (c, None, None, f"EXC {type(e).__name__}: {str(e)[:120]}")
    with concurrent.futures.ThreadPoolExecutor(6) as ex:
        res = list(ex.map(one, jobs))
    per = collections.defaultdict(list)
    tin = tout = 0
    fails = 0
    for c, errs, usage, err in res:
        if usage:
            tin += usage.input_tokens; tout += usage.output_tokens
        if errs is None:
            fails += 1; continue
        per[c["id"]].append(errs)
    neg = [c for c in cases if c["expected_errors"] == 0]
    pos = [c for c in cases if c["expected_errors"] > 0]
    print(f"\n=== {a.label or a.model}  (prompt={a.prompt} thinking={a.thinking} effort={a.effort} max_tokens={a.max_tokens} runs={a.runs}) ===")
    if fails: print(f"  !! {fails} call(s) failed to parse/complete")
    fp_calls = fp_total = n_neg = 0
    print(f"\n  NEGATIVES — every flag here is a false positive")
    for c in neg:
        runs = per.get(c["id"], [])
        if not runs: continue
        flagged = sum(1 for r in runs if r)
        cnt = sum(len(r) for r in runs)
        types = collections.Counter(e.get("type") for r in runs for e in r)
        fp_calls += flagged; fp_total += cnt; n_neg += len(runs)
        print(f"    {c['id']:12s} flagged {flagged}/{len(runs)} runs, {cnt} finding(s) {dict(types) or ''}")
    rec = n_pos = 0
    print(f"  POSITIVES — synthetic grade mismatch, should be caught")
    for c in pos:
        runs = per.get(c["id"], [])
        if not runs: continue
        hit = sum(1 for r in runs if any(e.get("type") in ("lighting", "atmosphere") for e in r))
        rec += hit; n_pos += len(runs)
        print(f"    {c['id']:12s} caught {hit}/{len(runs)} runs")
    ip, op = PRICES.get(a.model, (5.0, 25.0))
    cost = tin/1e6*ip + tout/1e6*op
    n = max(1, len(res)-fails)
    print(f"\n  FALSE POSITIVE RATE : {fp_calls}/{n_neg} negative runs flagged something  ({100*fp_calls/max(1,n_neg):.0f}%)")
    print(f"  RECALL ON POSITIVES : {rec}/{n_pos}  ({100*rec/max(1,n_pos):.0f}%)")
    print(f"  cost: ${cost:.4f} for {n} calls = ${cost/n:.5f}/pair   ({tin} in, {tout} out)")
main()
