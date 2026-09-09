"""
Explain a failure we did not anticipate.

Everything else in this pipeline handles a KNOWN case: a clip under Runway's
minimum, a shot longer than an engine takes, an error detection marked
unrepairable. Each of those has a specific message written in advance.

This module is for the rest — the case nobody wrote a branch for. A model
quietly changes its accepted aspect ratios, a user uploads something with a
codec we have never seen, an endpoint starts refusing a field it accepted last
week. Historically all of those reached the user as "Fix failed. Please try
again.", which is true, useless, and indistinguishable from a transient blip.

Claude is given the raw failure, the engine and its real constraints, the shape
of the footage, and what the account can afford, and writes the explanation and
the next steps itself. Nothing here is a template — the point is precisely to
cover what we did not think of.

Never raises. A diagnosis that cannot be produced returns None and the caller
keeps whatever generic message it already had; an explanation is worth having
but never worth failing a job over.
"""

import json
import os
import re

# What the UI knows how to render as a button. Claude picks from these, so a
# suggestion is always something the user can actually do from where they are.
ACTION_KINDS = {
    "retry": "Try this fix again",
    "retry_other_engine": "Try a different engine",
    "buy_credits": "Buy more credits",
    "upgrade": "Upgrade the plan",
    "shorten_video": "Upload a shorter or trimmed video",
    "reupload": "Re-upload the video",
    "mark_manually": "Mark the problem area by hand",
    "pick_other_error": "Choose a different error to fix",
    "wait_and_retry": "Wait and try again shortly",
    "contact_support": "Contact support",
}

_MAX_CHARS = 1200


def _client():
    import anthropic

    return anthropic.Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])


def _parse(raw: str) -> dict | None:
    """Last brace-balanced object in the reply, else None."""
    depth = 0
    end = -1
    for i in range(len(raw) - 1, -1, -1):
        c = raw[i]
        if c == "}":
            if depth == 0:
                end = i
            depth += 1
        elif c == "{":
            depth -= 1
            if depth == 0 and end != -1:
                try:
                    obj = json.loads(raw[i : end + 1])
                    if isinstance(obj, dict) and obj.get("message"):
                        return obj
                except Exception:
                    pass
                end, depth = -1, 0
    return None


def diagnose_failure(
    *,
    failure_text: str,
    engine: str,
    engine_specs: dict,
    error_doc: dict,
    shots: list[dict],
    plan: str,
    credits_available: int | None,
    credits_needed: int | None,
) -> dict | None:
    """
    Turn one unexpected failure into something the user can act on.

    Returns {"cause", "message", "actions": [{"label", "kind"}], "retryable",
    "confidence"} or None. `message` is shown verbatim, so it is instructed to
    address the user directly and never to name an engine, an API or a credit
    system the user does not deal in.
    """
    try:
        shot_lines = "\n".join(
            f"  shot {i}: {(s.get('endMs', 0) - s.get('startMs', 0)) / 1000:.2f}s"
            for i, s in enumerate(shots[:12])
        ) or "  (no shot data)"

        engine_lines = "\n".join(
            f"  {name}: takes up to {spec['max_input_s']:.0f}s of video per pass, "
            f"{spec['credits_per_second']} provider-credits per second"
            + (f", needs at least {spec['min_dimension']}p on the short side"
               if spec.get("min_dimension") else "")
            for name, spec in engine_specs.items()
        )

        prompt = f"""A video repair attempt failed and nobody wrote a specific handler for this case. Diagnose it and tell the user what happened.

WHAT FAILED, verbatim:
{failure_text[:2500]}

The engine used was {engine}.

Engines available:
{engine_lines}

The footage, as we split it:
{shot_lines}

The problem the user asked us to fix:
  type: {error_doc.get('type')}
  they described it as: {error_doc.get('description', '')[:400]}
  the instruction we sent: {error_doc.get('replaceWith') or error_doc.get('fixSuggestion') or '(none)'}

The account: plan {plan}, {credits_available if credits_available is not None else 'unknown'} credits available, this fix needed {credits_needed if credits_needed is not None else 'unknown'}.

Work out the most likely cause from the failure text itself. It may be something none of the above anticipated — a provider changing what it accepts, an unusual file, a limit that is new. Say so plainly if that is what it looks like.

Rules for `message`:
- Address the user as "you". Two sentences at most.
- Never name the engine, the provider, an API, an HTTP status, or a credit system the user does not see. They bought seconds of fixing, not model calls.
- Never blame them for something that is our fault, and never claim it is our fault if the footage genuinely cannot be processed.
- If the honest answer is that this footage cannot be repaired this way, say that rather than inviting a retry that will fail again.

Choose `actions` only from these kinds, most useful first, at most three, and only ones that would genuinely help here:
{json.dumps(ACTION_KINDS, indent=2)}

Return ONLY this JSON on the final line:
{{"cause": "short technical label for our logs", "message": "what the user sees", "actions": [{{"label": "button text, max 4 words", "kind": "one of the kinds above"}}], "retryable": true|false, "confidence": "low|medium|high"}}"""

        resp = _client().messages.create(
            model="claude-opus-4-8",
            max_tokens=1200,
            messages=[{"role": "user", "content": prompt}],
        )
        out = _parse(resp.content[0].text.strip())
        if not out:
            return None

        # The UI renders these, so anything unrecognised is dropped rather than
        # shown as a button that does nothing.
        actions = []
        for a in (out.get("actions") or [])[:3]:
            if isinstance(a, dict) and a.get("kind") in ACTION_KINDS:
                actions.append({
                    "label": str(a.get("label") or ACTION_KINDS[a["kind"]])[:40],
                    "kind": a["kind"],
                })
        return {
            "cause": str(out.get("cause", ""))[:120],
            "message": str(out["message"])[:_MAX_CHARS],
            "actions": actions,
            "retryable": bool(out.get("retryable", False)),
            "confidence": out.get("confidence", "low"),
            "source": "claude",
        }
    except Exception as exc:
        print(f"diagnose_failure: {type(exc).__name__}: {exc}")
        return None
