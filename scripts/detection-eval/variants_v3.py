"""Prompt variants, built as explicit edits to the production prompt."""
import sys
sys.path.insert(0,"/Users/alanany/Desktop/Scene Fixer")
from modal_app.prompts import DETECTION_PROMPT, build_detection_prompt

# The sentence that tells the model a false positive is cheap. It no longer is.
OLD_BIAS = """  Shots merely LOOKING different is NOT that evidence. For AI-generated footage, dramatically different backgrounds, weather, time of day or render style within one sequence are usually generation inconsistencies, NOT intentional cuts. If in any doubt, set different_scene: false and flag the mismatch as an "atmosphere" or "lighting" error — a wrong flag costs the user one dismissed row, whereas a wrong different_scene hides every problem in the pair and reports broken footage as clean."""

NEW_BIAS = """  Shots merely LOOKING different is NOT that evidence — but neither is a difference automatically a defect. For AI-generated footage a dramatically different background, weather or render style CAN be a generation inconsistency. It can equally be the sequence doing what it was written to do. Decide which, and say so.
  What a wrong flag costs: every error you report is offered to the user as a paid repair. If they buy it, we spend real money re-generating footage that was never broken, hand them back a video we have degraded, and refund them. A false positive is not one dismissed row — it is a damaged delivery. Weigh it accordingly against a missed detection."""

INTENT_GATE = """

---

IS THIS A MISTAKE, OR IS THE SCENE DOING ITS JOB?

Apply this test to every candidate before you report it — UNLESS a specific
user note above already describes it, in which case the note wins and you
report it. Two shots in a sequence are SUPPOSED to differ. A continuity error is a difference that
NOBODY INTENDED — something a careful viewer would call a mistake, not a
change they would read as the film progressing.

These are NOT errors. Do not report them:
- SHOT SCALE. A close-up cut against a wide of the same subject. Skin, faces
  and walls fill different amounts of frame, so exposure and apparent grade
  differ. That is lensing, not a grade mismatch.
- POINT OF VIEW. A shot through a scope, binoculars, a viewfinder, a window,
  underwater, or any in-world optic. Vignetting, desaturation and softness are
  the device, not a defect.
- TIME PASSING BETWEEN THE SHOTS. A fireball in A becoming a smoke column in
  B, a candle burning lower, dust settling. The scene is allowed to advance
  across a cut.
  This excuse applies ONLY to a difference BETWEEN the two shots, where each
  shot is internally consistent. It does NOT cover a change that happens
  ACROSS THE FRAMES OF ONE SHOT. Weather, daylight and location do not change
  within a single continuous shot a few seconds long. If SHOT B's own frames
  go from storm to sunshine, from interior to exterior, or from one backdrop
  to another, that is the generator losing the scene, not time passing —
  report it, and say which frames of B it happens between.
- A TRANSITION THE FOOTAGE ITSELF SHOWS. Doors opening onto somewhere new, a
  character walking through a portal or gateway, a vehicle arriving somewhere
  else. If the frames show the move happening, the new location is intended.
- ACTION PROGRESSING. Characters have moved, picked things up, changed pose.
  A garment reads differently because the body under it moved or because part
  of it is now out of frame or occluded. Judge the GARMENT, not how much of it
  you can see.
- DELIBERATE STYLISTIC CHANGE. A title montage escalating, a graphic-novel or
  animated sequence changing density or palette for effect.

Still report, as before:
- Two shots that are plainly the same setup and moment, where the grade,
  exposure or colour temperature genuinely does not match across the cut.
- An object, garment or hairstyle that is genuinely a DIFFERENT object,
  garment or hairstyle — not the same one seen from elsewhere.
- Anything in the STANDALONE, TEMPORAL/CAUSATION lists above.

If you cannot name, in one clause, what the mistake is and why a viewer would
read it as a mistake rather than as the scene progressing, do not report it."""

def _v2_text():
    assert OLD_BIAS in DETECTION_PROMPT, "bias anchor not found — prompt changed"
    p = DETECTION_PROMPT.replace(OLD_BIAS, NEW_BIAS)
    anchor = "\n\nFor each error return:"
    assert anchor in p, "anchor not found"
    return p.replace(anchor, INTENT_GATE + anchor, 1)

V2 = _v2_text()

def build_v2(user_hint: str = "") -> str:
    hint = (user_hint or "").strip()
    if not hint:
        return V2
    return (
        "USER HINT — the person who uploaded this footage said:\n"
        f'  "{hint}"\n\n'
        "How to use this hint:\n"
        "1. The hint tells you WHERE to look and WHAT KIND of error to search "
        "for. Search the frames methodically with that in mind.\n"
        "2. CRITICAL: you must VISUALLY CONFIRM the error in the actual frames "
        "before flagging. The hint is a guide, NOT a guarantee. Do not invent "
        "errors that match the hint's description if you cannot see them.\n"
        "3. WEIGH THE HINT BY HOW SPECIFIC IT IS.\n"
        "   - A SPECIFIC claim — naming a thing, a shot, or a change ('his "
        "jacket changes colour', 'the sky is wrong in the third shot', 'her "
        "hair goes from up to down') — is the person who made this film "
        "telling you what is wrong with it. They know their own intent and "
        "you do not. If you can see what they describe, REPORT IT, even if "
        "the test below would otherwise read it as intentional. Their note "
        "overrides that test.\n"
        "   - A GENERIC checklist ('check wardrobe, hair, props, lighting, "
        "background') is the uploader naming everything they can think of, "
        "not a claim that each one is wrong. It does not raise the odds that "
        "any particular error is present, and the test below still applies.\n"
        "4. The bbox you return must precisely point at the visual evidence in "
        "the frame. If you cannot pinpoint it, do NOT flag it.\n"
        "5. If the hint describes an error but neither frame visually shows it, "
        "return no errors for this pair. The error may exist elsewhere in the "
        "clip — that's fine, other pairs may catch it.\n"
        "6. Honest 'I don't see it' is much better than confident hallucination. "
        "A false-positive is worse than a missed detection.\n\n"
        + V2
    )
