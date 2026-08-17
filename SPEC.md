# Scenefixer — Architecture Spec

> Drop-in spec for Claude Code. Read this top-to-bottom before writing any code.
> Domain: **scenefixer.com**

---

## 1. Product summary

A web app that finds and fixes continuity errors in video. User drags in a clip, we decompose it into shots, a vision-LLM compares shot pairs and reports inconsistencies (jacket button changed, prop moved, lighting shifted), the user confirms which to fix, and Runway Aleph regenerates the affected segments to match. Then we re-run detection on the output to verify zero new errors.

**Wedge:** AI-generated video continuity. Creators stitching Sora + Veo + Runway clips together hit massive consistency breaks. Position the demo around this — same architecture works for traditional film footage, but the AI-stitched-video story is the one nobody else is telling.

**Flow:** Drag → Detect → Confirm → Fix → Verify → Export.

---

## 2. Stack

| Layer | Choice | Why |
|---|---|---|
| Frontend | Next.js 15 (App Router) + React + Tailwind | Single repo, fast UI |
| API | Next.js Route Handlers | Same repo, no extra service |
| Heavy compute | **Modal (Python)** | Hackathon sponsor, parallel fan-out, GPU access. **Do not replace.** |
| Database | **Firestore** | Real-time listeners replace polling. Subcollections for shots/errors. |
| Storage | **Firebase Storage** | Signed URLs out of the box, simpler than R2/S3 |
| Realtime | **Firestore `onSnapshot`** | UI updates live as detection finds errors — pure demo magic |
| Hosting | Firebase Hosting OR Vercel | Either works, pick whichever you set up faster |
| Vision LLM | Anthropic Claude Sonnet 4.5 (vision API) | Strong vision, JSON-mode reliable |
| Video gen | Runway Aleph (`gen4_aleph`) | The whole reason we exist |
| Reference images | Runway `gen4_image` (only if needed) | For canonical reference frames |
| Video processing | FFmpeg + PySceneDetect (in Modal) | Shot splitting, keyframe extraction, restitching |

**Hard constraint to remember:** Aleph max input = **5 seconds per call**. Any shot longer than 5s must be chunked, fixed in chunks, and restitched.

**Firebase split:** Frontend uses the Firebase JS SDK for reads + uploads. Modal (Python) uses `firebase-admin` for writes during the pipeline. Next.js API routes use `firebase-admin` for issuing signed upload URLs.

---

## 3. Pipeline (7 phases)

```
[1 INTAKE] → [2 DECOMPOSE] → [3 DETECT] → [4 CONFIRM]
                                              ↓
                            [7 EXPORT] ← [6 VERIFY] ← [5 FIX]
```

### Phase 1 — Intake
- User drops a video file (MP4/MOV up to 60s for hackathon demo) onto the home page
- Frontend POSTs to `/api/jobs` to create a Firestore Job doc + receive a Firebase Storage signed upload URL
- Frontend uploads directly to Firebase Storage via the signed URL (no proxying through Next.js)
- On upload completion, frontend updates `job.inputVideoUrl` and `job.status = 'decomposing'`
- Firestore trigger (or a direct call from `/api/jobs/[id]/start`) kicks off Modal function `process_job(jobId)` async

### Phase 2 — Decompose (Modal)
- Modal function authenticates with Firebase Admin SDK, downloads video from Storage to Modal volume
- Run PySceneDetect's `ContentDetector` to find shot boundaries
- For each shot: extract a representative keyframe at the midpoint via FFmpeg (`ffmpeg -ss <mid> -i video -frames:v 1 keyframe.jpg`)
- Upload all keyframes to Firebase Storage at `jobs/{jobId}/keyframes/{shotIndex}.jpg`
- Write Shot docs to `/jobs/{jobId}/shots/{shotId}` subcollection
- Update `job.status = 'detecting'`, `job.shotCount = N`

### Phase 3 — Detect (Modal, fan-out)
- Generate the list of shot pairs to compare. **Don't compare every shot to every shot** — compare each shot to its successor only. (For "same scene" detection, also compare shots within a 30-second sliding window.)
- For each pair, dispatch a Modal function `compare_pair(keyframeA_url, keyframeB_url, context)` running in parallel via `.map()`
- Each call sends both keyframes to Claude Sonnet 4.5 vision API with the **detection prompt** (see §6)
- Parse JSON response, validate
- Write each detected error as a doc in `/jobs/{jobId}/errors/{errorId}` — **one write per error means the UI sees them stream in live via onSnapshot**
- After all pairs done, update `job.status = 'awaiting_confirmation'`, `job.errorCount = N`

### Phase 4 — Confirm (UI, real-time)
- `/job/[id]` page subscribes to `/jobs/{jobId}/errors` via `onSnapshot` — error cards appear live as detection finds them
- Each card: side-by-side keyframes with bounding box overlay, AI's description, severity badge, "Fix it" / "Ignore" toggle (writes `userConfirmed: true/false` to the error doc)
- User reviews, toggles, clicks "Fix selected errors"
- POST `/api/jobs/[id]/fix` — backend updates `job.status = 'fixing'` and triggers Modal `fix_phase(jobId)`

### Phase 5 — Fix (Modal, fan-out via Runway)
For each error where `userConfirmed === true`:
1. Determine which shot is "wrong" (default: the later shot — match it to the earlier one). Let user override in UI via `fixDirection` field.
2. Extract that shot's video segment via FFmpeg into a clip ≤5s. If shot is longer, split into ≤5s chunks.
3. Build the **Aleph prompt** (see §6) using `error.fixSuggestion` directly.
4. Call Runway SDK:
   ```python
   task = client.video_to_video.create(
       model='gen4_aleph',
       prompt_text=prompt,
       video_uri=clip_url,
       prompt_image=correct_keyframe_url,  # visual reference
       ratio='1280:720'
   ).wait_for_task_output()
   ```
5. Download fixed clip, upload to Firebase Storage, write `error.fixedClipUrl` and `error.fixStatus = 'fixed'`
6. After all errors fixed, restitch the timeline with FFmpeg's concat demuxer (replace the broken segments with fixed ones)
7. Upload final video to Storage → `job.outputVideoUrl`
8. Update `job.status = 'verifying'`

### Phase 6 — Verify (Modal)
- Re-run Phase 2 + 3 on `outputVideoUrl` (write to a separate verify subcollection so we don't pollute original errors)
- Compare new error count to old. Mark each original error as `verifiedResolved: true` if no error in same region remains.
- If new errors introduced (rare but possible), surface them in UI as "Aleph introduced new issues — review needed"
- Update `job.status = 'done'`, write `job.scoreAfter`

### Phase 7 — Export
- User downloads final MP4 from `outputVideoUrl` (Firebase Storage signed download URL)
- Optionally download `fix_log.json` (every error, before/after URL, prompt used)

---

## 4. File structure

```
scenefixer/
├── app/
│   ├── layout.tsx
│   ├── page.tsx                       # Drag-drop landing
│   ├── job/[id]/page.tsx              # Status + error review + diff player (uses onSnapshot)
│   ├── globals.css
│   └── api/
│       ├── jobs/route.ts              # POST: create Firestore job, return signed upload URL
│       ├── jobs/[id]/start/route.ts   # POST: triggers Modal after upload completes
│       ├── jobs/[id]/fix/route.ts     # POST: triggers Modal fix phase
│       └── webhooks/modal/route.ts    # Optional: Modal callbacks (most state writes go directly to Firestore)
├── modal_app/
│   ├── app.py                         # Modal stub + image definition
│   ├── firebase.py                    # Firebase Admin SDK init for Python
│   ├── decompose.py                   # PySceneDetect + FFmpeg keyframes
│   ├── detect.py                      # Pairwise vision-LLM comparison (fan-out)
│   ├── fix.py                         # Aleph orchestration (fan-out)
│   ├── stitch.py                      # FFmpeg restitch
│   ├── verify.py                      # Re-run detect on output
│   └── prompts.py                     # Detection + Aleph prompt templates
├── lib/
│   ├── firebase.ts                    # Client SDK init
│   ├── firebase-admin.ts              # Server-side Admin SDK init
│   ├── runway.ts                      # Runway SDK wrapper (only if calling from Node side)
│   ├── modal.ts                       # Trigger Modal jobs from Next API
│   ├── types.ts                       # Shared TypeScript types
│   └── hooks/
│       ├── useJob.ts                  # onSnapshot hook for a single job
│       └── useErrors.ts               # onSnapshot hook for /jobs/{id}/errors
├── components/
│   ├── DropZone.tsx
│   ├── JobStatus.tsx                  # Live progress bar driven by job.status
│   ├── ErrorList.tsx                  # Subscribes via useErrors
│   ├── ErrorCard.tsx                  # Side-by-side + bbox + toggle
│   ├── DiffPlayer.tsx                 # Before/after split video player
│   └── ScoreBadge.tsx                 # Continuity score
├── firestore.rules                    # Lock down: only Admin SDK writes most fields
├── storage.rules                      # Authenticated reads, writes via signed URL only
├── firebase.json                      # Firebase project config
├── .env.local
└── package.json
```

---

## 5. Data model (Firestore)

Top-level collection: `jobs`. Each job has subcollections `shots` and `errors`.

```typescript
// Path: /jobs/{jobId}
type Job = {
  id: string;
  status:
    | 'uploading'
    | 'decomposing'
    | 'detecting'
    | 'awaiting_confirmation'
    | 'fixing'
    | 'verifying'
    | 'done'
    | 'error';
  inputVideoUrl: string;
  outputVideoUrl?: string;
  scoreBefore?: number;        // 0-100
  scoreAfter?: number;
  shotCount: number;
  errorCount: number;
  fixedCount: number;
  createdAt: Timestamp;
  errorMessage?: string;        // populated if status === 'error'
};

// Path: /jobs/{jobId}/shots/{shotId}
type Shot = {
  index: number;                // ordering
  startMs: number;
  endMs: number;
  keyframeUrl: string;
};

// Path: /jobs/{jobId}/errors/{errorId}
type ContinuityError = {
  shotAId: string;
  shotBId: string;
  type: 'prop' | 'wardrobe' | 'lighting' | 'hair' | 'set_dressing' | 'eyeline' | 'other';
  description: string;
  fixSuggestion: string;
  severity: 'low' | 'medium' | 'high';
  bboxA?: { x: number; y: number; w: number; h: number };
  bboxB?: { x: number; y: number; w: number; h: number };
  userConfirmed: boolean;
  fixDirection?: 'aTob' | 'bToA';   // default 'aTob' (fix B to match A)
  fixStatus: 'pending' | 'fixing' | 'fixed' | 'failed';
  fixedClipUrl?: string;
  alephPrompt?: string;
  verifiedResolved: boolean;
  createdAt: Timestamp;
};
```

**Why subcollections instead of arrays on the Job doc:** Firestore docs are capped at 1MB, but more importantly — writing each error as its own doc means the UI sees them stream in live via `onSnapshot`. With an array, the client only sees the final batch. This is the secret to the demo magic.

---

## 6. The two prompts (the actual secret sauce — paste these in `modal_app/prompts.py`)

### Detection prompt (sent to Claude vision API per pair)

```
You are an expert script supervisor reviewing two keyframes from a film. They are taken from consecutive shots in what should be the same continuous scene moment. Your job: identify UNINTENDED inconsistencies a viewer would notice.

You will be given two images: KEYFRAME_A (earlier shot) and KEYFRAME_B (later shot).

Rules:
- DO flag: prop position changes, wardrobe changes (buttons, jewelry, drink levels), hair changes, lighting direction shifts, set dressing moves, eyeline mismatches, weather changes within a continuous scene.
- DO NOT flag: deliberate camera angle changes, time-of-day jumps that look intentional, different characters in frame, action progression (someone moved naturally), shot type changes (wide vs close).
- If the two keyframes appear to be from different scenes entirely, return {"errors": [], "different_scene": true}.

For each error return:
- type: one of [prop, wardrobe, lighting, hair, set_dressing, eyeline, other]
- description: one sentence describing what changed
- fix_suggestion: one imperative sentence describing how to make B match A (e.g., "move the coffee cup back to the left side of the table")
- severity: low | medium | high (how visible to a typical viewer)
- bbox_a: [x, y, w, h] as fractions of width/height in keyframe A
- bbox_b: same in keyframe B

Return STRICT JSON only:
{
  "different_scene": false,
  "errors": [
    { "type": "...", "description": "...", "fix_suggestion": "...", "severity": "...", "bbox_a": [...], "bbox_b": [...] }
  ]
}

If no errors: {"different_scene": false, "errors": []}
```

### Aleph fix prompt construction

Aleph likes short imperative prompts that start with an action verb. The detection LLM already returns `fix_suggestion` in this exact form, so:

```python
def build_aleph_prompt(error):
    # Use the LLM's fix_suggestion directly — it's already imperative and tested
    return error["fixSuggestion"]
```

When calling Aleph, pass the **correct** keyframe (the one we're matching toward) as `prompt_image` for visual grounding. This is the single most important call detail.

---

## 7. Critical implementation notes

1. **Don't compare every shot to every shot.** Compare adjacent shots only, plus shots within a 30s sliding window. Pairwise is O(n²) and burns API budget.
2. **Cache vision API responses** keyed by `hash(keyframeA_url + keyframeB_url + prompt_version)` in a `/cache` collection. Re-runs during dev will be free.
3. **Fan out aggressively in Modal.** `compare_pair` and `fix_error` should run in parallel via `Modal.function.map()`, not sequentially.
4. **Aleph is slow** (often 30-90s per 5s clip). Show clear progress UI per error so the user doesn't think it's broken — Firestore listener on `error.fixStatus` makes this trivial.
5. **Set a hard timeout per Aleph call** (180s) and write `fixStatus: 'failed'` rather than hanging the whole job.
6. **Score formula** for the visible scoreboard: `score = max(0, 100 - (errors.length * 8) - (high_severity_count * 5))`. Tunable, but it gives a satisfying "47 → 98" jump in the demo.
7. **The bounding boxes from the LLM are approximate.** Don't rely on them for masking. Use them only for the UI overlay so the user can see where the AI is looking.
8. **Modal GPU usage:** Use `gpu="T4"` only on the decompose function (FFmpeg can use it) and skip it for vision calls (those are HTTP). Aleph calls don't need a GPU on Modal at all.
9. **Firestore security rules:** Lock all writes to Admin SDK only; clients can read their own jobs and toggle `userConfirmed` on errors. Locked-down rules also prevent abuse if the demo goes viral.
10. **Modal → Firebase auth:** Store the Firebase service-account JSON as a Modal secret (`modal secret create firebase-admin-key`), then init Admin SDK at the top of each Modal function.

---

## 8. Three things every winning demo has — bake these in from day 1

### A. The famous-error easter egg
On the landing page, include a "Try a sample" button that loads either:
- A clip from a Hollywood film with a known continuity error (Game of Thrones coffee cup, Pulp Fiction bullet holes), OR
- An AI-stitched sequence of 4 different generators producing the same character, with obvious breaks

Either makes the demo unforgettable.

### B. Continuity score
Every job gets a 0-100 score before and after. Show it as a big number in the UI. "Your video: 47/100. After fixes: 98/100." Makes the value quantifiable. Use the formula in §7.

### C. The meta-error in the demo video
Embed a deliberate continuity error in the demo video itself — change your shirt color between two cuts of yourself talking, or move a coffee cup. At the end of the demo say "by the way, this video had a continuity error at 0:34 — did you spot it? Scenefixer did." Then show your tool detecting it.

---

## 9. 3-day build plan

### Friday (Day 1) — Skeleton end-to-end
- [ ] `npx create-next-app` + Tailwind
- [ ] `firebase init` (Firestore, Storage, Hosting), set up project
- [ ] Install: `firebase`, `firebase-admin`, `@anthropic-ai/sdk`, `@runwayml/sdk`
- [ ] Modal app deployed with one dummy function; `firebase-admin` Python set up via Modal secret
- [ ] FFmpeg + PySceneDetect splitting a video into shots, extracting keyframes, writing to Firestore
- [ ] Drag-drop UI uploads a video to Storage, creates a Job, shows shots in a grid via `onSnapshot`
- [ ] Goal: by end of day, you can drop a video and see "Found 12 shots." appear live in the UI

### Saturday (Day 2) — The intelligence
- [ ] Detection prompt working against Claude vision API on a single pair
- [ ] Modal `.map()` fan-out for all adjacent pairs in parallel, writing each error to Firestore as it's found
- [ ] Error cards rendering live with side-by-side keyframes + bbox overlays
- [ ] Confirm UI working — toggling `userConfirmed` writes to Firestore
- [ ] Aleph integration: one error → one fix → fixed clip URL written back to error doc
- [ ] FFmpeg restitch: assemble final video with fixed clips, upload to Storage
- [ ] Goal: by end of day, full pipeline runs end-to-end on a 30s test video

### Sunday (Day 3) — Polish + demo
- [ ] Verify phase (re-run detection on output)
- [ ] Score badge with before/after numbers
- [ ] DiffPlayer split-screen before/after component
- [ ] Sample video on landing page with the easter egg
- [ ] Per-error fix progress UI driven by Firestore listener
- [ ] **Record demo video with embedded meta-error**
- [ ] Submit by Monday 9am ET

---

## 10. Cut to ship — do NOT build these for v1

- Auth / accounts (use Firebase anonymous auth — gives you a uid for security rules without a login flow)
- Multi-user / teams
- Script PDF ingestion (mention as "v2: script-aware continuity")
- Audio continuity (visual only)
- Characters API for intent disambiguation (mention in pitch as "v2: ask-before-fix")
- Long video support (cap UI at 60s, but the architecture handles arbitrary length)
- Stripe / billing
- Custom training / fine-tuning
- Real-time collaboration

If you finish early on Sunday, stretch goals in priority order:
1. Characters API integration: avatar pops up to ask "this jacket button change — was that intentional?" before fixing
2. Script-aware mode: upload a script, errors get cross-checked against narrative intent
3. Premiere Pro / DaVinci Resolve XML export of the fix log

---

## 11. Environment variables

```
# Runway
RUNWAYML_API_SECRET=

# Anthropic
ANTHROPIC_API_KEY=

# Firebase — client (public, NEXT_PUBLIC_ exposed to browser)
NEXT_PUBLIC_FIREBASE_API_KEY=
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=
NEXT_PUBLIC_FIREBASE_PROJECT_ID=
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=
NEXT_PUBLIC_FIREBASE_APP_ID=

# Firebase — server (Admin SDK; never expose)
FIREBASE_ADMIN_PROJECT_ID=
FIREBASE_ADMIN_CLIENT_EMAIL=
FIREBASE_ADMIN_PRIVATE_KEY=

# Modal
MODAL_TOKEN_ID=
MODAL_TOKEN_SECRET=

# App
NEXT_PUBLIC_APP_URL=https://scenefixer.com
```

Modal secrets to create from CLI:
```
modal secret create firebase-admin-key  # paste the service account JSON
modal secret create runway-api-key
modal secret create anthropic-api-key
```

---

## 12. Firestore security rules (paste into `firestore.rules`)

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /jobs/{jobId} {
      // Anyone with the jobId can read (no auth needed for hackathon)
      allow read: if true;
      // Only Admin SDK can create/update most fields
      allow write: if false;

      match /shots/{shotId} {
        allow read: if true;
        allow write: if false;
      }

      match /errors/{errorId} {
        allow read: if true;
        // Allow client to flip userConfirmed only — everything else is Admin SDK
        allow update: if request.resource.data.diff(resource.data).affectedKeys()
                          .hasOnly(['userConfirmed', 'fixDirection']);
      }
    }
  }
}
```

## 13. Storage security rules (paste into `storage.rules`)

```
rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /jobs/{jobId}/{allPaths=**} {
      // Read: anyone with the URL (signed or not)
      allow read: if true;
      // Write: only Admin SDK (signed URLs handle uploads)
      allow write: if false;
    }
  }
}
```

---

## 14. The pitch in one paragraph (use this in submission + demo)

> Eight weeks ago, Netflix paid up to $600M for an AI continuity startup. We built an open agent on Runway Aleph that doesn't just *detect* continuity errors — it *fixes* them. Drop a video, our system decomposes it into shots, a vision-LLM scores every adjacent pair for unintended inconsistencies (props, wardrobe, lighting, hair), the user confirms which to fix, and Aleph regenerates the broken segments to match. Then we re-run detection on the output to verify zero new errors were introduced. The wedge is AI-generated video — every creator stitching Sora, Veo, and Runway clips together has this problem and nobody is solving it. Score before: 47/100. Score after: 98/100. By the way, this demo video had a deliberate continuity error at 0:34 — did you catch it? Scenefixer did.
