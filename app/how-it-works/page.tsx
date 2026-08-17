import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";

export const metadata: Metadata = {
  title: "How Scene Fixer Works — AI Video Continuity Pipeline",
  description:
    "A transparent, technical walkthrough of how Scene Fixer detects continuity breaks across AI video shots — wardrobe, lighting, props, eyeline — and fixes them using PySceneDetect, Claude Opus 4.8, and Runway Gen-4 Aleph.",
  alternates: {
    canonical: "/how-it-works",
  },
};

const S = "/How%20to%20screenshots/Screenshot%202026-05-25%20at%20";

function ModelBadge({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 text-[11px] font-semibold bg-gray-100 text-gray-600 px-2.5 py-1 rounded-full">
      {children}
    </span>
  );
}

function StepNumber({ n }: { n: number }) {
  return (
    <div className="w-8 h-8 rounded-full bg-black text-white text-sm font-semibold flex items-center justify-center shrink-0">
      {n}
    </div>
  );
}

function Shot({ src, alt }: { src: string; alt: string }) {
  return (
    <div className="w-full rounded-2xl overflow-hidden border border-gray-100 shadow-sm">
      <Image
        src={src}
        alt={alt}
        width={1600}
        height={900}
        className="w-full h-auto"
        unoptimized
      />
    </div>
  );
}

export default function HowItWorksPage() {
  return (
    <main className="min-h-screen bg-white">
      {/* Hero */}
      <div className="border-b border-gray-100 px-4 py-16">
        <div className="max-w-2xl mx-auto text-center">
          <p className="text-xs font-semibold uppercase tracking-widest text-gray-400 mb-4">
            Technical guide
          </p>
          <h1 className="text-4xl sm:text-5xl font-semibold text-black tracking-tight mb-5">
            How Scene Fixer works
          </h1>
          <p className="text-gray-500 text-lg leading-relaxed">
            Scene Fixer is the continuity supervisor for AI video. It splits your sequence
            into shots, uses Claude Opus 4.8 to catch every inconsistency — wardrobe,
            lighting, props, eyeline — then inpaints each fix frame-by-frame with Runway
            Aleph. Works on output from any AI video model. Here&apos;s exactly what
            happens under the hood.
          </p>
        </div>
      </div>

      {/* Steps */}
      <div className="max-w-2xl mx-auto px-4 py-16 space-y-20">

        {/* Step 1 */}
        <div>
          <div className="flex items-center gap-3 mb-4">
            <StepNumber n={1} />
            <h2 className="text-xl font-semibold text-black">Upload your video</h2>
          </div>
          <p className="text-gray-600 leading-relaxed mb-4">
            Drag and drop a video file — MP4, MOV, or most common formats. The file is
            uploaded directly to Firebase Storage over a signed URL, so it never passes
            through our web servers. Maximum file size is 200MB.
          </p>
          <p className="text-gray-600 leading-relaxed mb-4">
            If you already know what the error is, describe it in the hint field above the
            drop zone before uploading — e.g. <em>&ldquo;coffee cup on the table in front of the
            queen&rdquo;</em>. The hint is passed to Claude alongside the keyframes and steers
            detection toward the region you flagged.
          </p>
          <p className="text-gray-600 leading-relaxed">
            No account required to try it. First-time visitors get one free beta fix —
            tracked with an anonymous UUID stored in your browser, no email needed.
          </p>
        </div>

        {/* Step 2 */}
        <div>
          <div className="flex items-center gap-3 mb-2">
            <StepNumber n={2} />
            <h2 className="text-xl font-semibold text-black">Shot decomposition</h2>
          </div>
          <div className="flex items-center gap-2 mb-4 ml-11">
            <ModelBadge>PySceneDetect</ModelBadge>
            <ModelBadge>FFmpeg</ModelBadge>
          </div>
          <p className="text-gray-600 leading-relaxed mb-4">
            The video is split into individual shots using{" "}
            <a href="https://www.scenedetect.com/" target="_blank" rel="noopener noreferrer"
              className="text-black font-medium underline underline-offset-2">PySceneDetect</a>,
            which detects cuts by analyzing frame-level histogram differences. For each shot,
            FFmpeg extracts 5 evenly-spaced keyframes — these become the visual input for detection.
          </p>
          <div className="rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-600 mb-6">
            <span className="font-semibold text-black">Why keyframes?</span>{" "}
            Continuity errors live in individual frames. Sending full video to a vision model
            would be 100× more expensive for the same detection quality.
          </div>
          <Shot
            src={`${S}17.50.58.png`}
            alt="Scene Fixer splitting video into shots — pipeline status showing step 2 active"
          />
        </div>

        {/* Step 3 */}
        <div>
          <div className="flex items-center gap-3 mb-2">
            <StepNumber n={3} />
            <h2 className="text-xl font-semibold text-black">Continuity error detection</h2>
          </div>
          <div className="flex items-center gap-2 mb-4 ml-11">
            <ModelBadge>Claude Opus 4.8</ModelBadge>
            <ModelBadge>Vision</ModelBadge>
          </div>
          <p className="text-gray-600 leading-relaxed mb-4">
            Every adjacent shot pair is sent to{" "}
            <a href="https://www.anthropic.com/claude/opus" target="_blank" rel="noopener noreferrer"
              className="text-black font-medium underline underline-offset-2">Claude Opus 4.8</a>,
            Anthropic&apos;s most capable vision model. It receives the last keyframe of shot A
            and the first keyframe of shot B and identifies continuity errors across six
            categories: props, wardrobe, hair & makeup, lighting, set dressing, and eyeline.
          </p>
          <p className="text-gray-600 leading-relaxed mb-4">
            For each inconsistency, Claude returns a structured JSON object with the error
            type, severity (low / medium / high), a human-readable description of what
            doesn&apos;t match and roughly where it is, and a fix suggestion. It does not
            return precise pixel coordinates — that&apos;s the next step. In the review UI
            you confirm the exact region yourself (or adjust it in the{" "}
            <strong>Adjust location</strong> modal), which is what actually guides Aleph.
          </p>
          <div className="rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-600 mb-6">
            <span className="font-semibold text-black">Example output:</span>
            <pre className="mt-2 text-xs text-gray-700 leading-relaxed overflow-x-auto">{`{
  "type": "prop",
  "severity": "high",
  "description": "Modern disposable coffee cup visible on the table in front of the character in Shot B.",
  "fix_suggestion": "Remove the coffee cup from the table.",
  "object_query": "modern coffee cup",
  "fix_target_shot": "B"
}`}</pre>
          </div>
          <Shot
            src={`${S}17.51.03.png`}
            alt="Scene Fixer running Claude Opus 4.8 detection — pipeline at step 3"
          />
        </div>

        {/* Step 4 */}
        <div>
          <div className="flex items-center gap-3 mb-4">
            <StepNumber n={4} />
            <h2 className="text-xl font-semibold text-black">You review and confirm</h2>
          </div>
          <p className="text-gray-600 leading-relaxed mb-4">
            Before anything is fixed, every detected error is shown side-by-side with its
            two keyframes. A red bounding box highlights the exact region. You choose for
            each one: <strong>Remove</strong> (erase and fill in the background) or{" "}
            <strong>Replace with…</strong> (swap for something you describe).
          </p>
          <p className="text-gray-600 leading-relaxed mb-6">
            If the auto-detection bounding box isn&apos;t quite right, you can open the{" "}
            <strong>Adjust location</strong> modal — pick the keyframe where the error is
            clearest and drag to draw a precise box. You can also manually mark errors the
            AI missed using <strong>+ Add another fix</strong>.
          </p>
          <div className="space-y-4">
            <Shot
              src={`${S}17.51.35.png`}
              alt="Scene Fixer error review — Remove and Replace with options, red bounding box on keyframe"
            />
            <Shot
              src={`${S}17.51.29.png`}
              alt="Adjust location modal — drawing a tight bounding box around the continuity error"
            />
            <Shot
              src={`${S}17.51.41.png`}
              alt="Error confirmed — Will remove and fill in the background, Fix 1 error button"
            />
          </div>
        </div>

        {/* Step 5 */}
        <div>
          <div className="flex items-center gap-3 mb-2">
            <StepNumber n={5} />
            <h2 className="text-xl font-semibold text-black">AI inpainting with Runway Gen-4 Aleph</h2>
          </div>
          <div className="flex items-center gap-2 mb-4 ml-11">
            <ModelBadge>Runway Gen-4 Aleph</ModelBadge>
            <ModelBadge>Video inpainting</ModelBadge>
          </div>
          <p className="text-gray-600 leading-relaxed mb-4">
            For each confirmed error, the pipeline extracts the clip segment around that
            shot, composites a red mask over the flagged region, and sends it to{" "}
            <a href="https://runwayml.com" target="_blank" rel="noopener noreferrer"
              className="text-black font-medium underline underline-offset-2">Runway Gen-4 Aleph</a>.
            The text prompt is generated automatically from your Remove / Replace instruction.
          </p>
          <p className="text-gray-600 leading-relaxed mb-4">
            Aleph is video-native — it understands camera motion, lighting, and temporal
            consistency across frames. It fills the masked region across the full clip
            duration while keeping surrounding content identical. Output is 1280×720 at 24fps.
          </p>
          <p className="text-gray-600 leading-relaxed mb-6">
            The fix runs as a background job — you can safely close your browser and come
            back later. Each Runway call takes 30–90 seconds. Up to 8 errors are processed
            per session.
          </p>
          <Shot
            src={`${S}17.51.46.png`}
            alt="Scene Fixer fixing with Runway Aleph — background job notice, fixing status active"
          />
        </div>

        {/* Step 6 */}
        <div>
          <div className="flex items-center gap-3 mb-2">
            <StepNumber n={6} />
            <h2 className="text-xl font-semibold text-black">Verification</h2>
          </div>
          <div className="flex items-center gap-2 mb-4 ml-11">
            <ModelBadge>Claude Opus 4.8</ModelBadge>
            <ModelBadge>Vision</ModelBadge>
          </div>
          <p className="text-gray-600 leading-relaxed mb-4">
            After inpainting, each fixed clip is passed back to Claude Opus 4.8 for
            independent verification. It compares the original and fixed frames and returns
            one of three verdicts:{" "}
            <strong className="text-emerald-700">Verified fixed</strong>,{" "}
            <strong className="text-red-600">Error still visible</strong>, or{" "}
            <strong className="text-gray-700">Inconclusive</strong> — plus a confidence
            rating and a short explanation.
          </p>
          <p className="text-gray-600 leading-relaxed mb-6">
            This isn&apos;t a formality. Runway occasionally misses faint or textured objects —
            the verification step catches those cases so you can decide whether to retry or
            accept. The full result is visible on your job page, including the marker frame
            that was sent to Aleph.
          </p>
          <Shot
            src={`${S}17.53.43.png`}
            alt="Fixed error detail — Before/After clips, marker frame sent to Aleph, Verified fixed result"
          />
        </div>

        {/* Step 7 */}
        <div>
          <div className="flex items-center gap-3 mb-2">
            <StepNumber n={7} />
            <h2 className="text-xl font-semibold text-black">Stitch, scale & download</h2>
          </div>
          <div className="flex items-center gap-2 mb-4 ml-11">
            <ModelBadge>FFmpeg</ModelBadge>
          </div>
          <p className="text-gray-600 leading-relaxed mb-4">
            FFmpeg stitches the fixed clips back into the original video timeline — only
            replacing the modified shots, leaving everything else frame-identical to your
            source. Audio is preserved throughout.
          </p>
          <p className="text-gray-600 leading-relaxed mb-4">
            The output is then scaled to your plan&apos;s quality using bicubic resampling:
          </p>
          <div className="rounded-xl border border-gray-200 overflow-hidden mb-6">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 bg-gray-50">
                  <th className="text-left px-4 py-2.5 font-semibold text-gray-700">Plan</th>
                  <th className="text-left px-4 py-2.5 font-semibold text-gray-700">Output</th>
                  <th className="text-left px-4 py-2.5 font-semibold text-gray-700">Watermark</th>
                </tr>
              </thead>
              <tbody>
                {[
                  ["Free", "480p (downscaled)", "\"Fixed with Scene Fixer\"", "text-gray-600"],
                  ["Starter", "720p (native Aleph output)", "None", "text-emerald-600"],
                  ["Pro / Studio", "1080p (bicubic upscale)", "None", "text-emerald-600"],
                  ["Pay-per-fix", "720p", "None", "text-emerald-600"],
                ].map(([plan, output, wm, wmColor], i, arr) => (
                  <tr key={plan} className={i < arr.length - 1 ? "border-b border-gray-100" : ""}>
                    <td className="px-4 py-2.5 text-gray-600">{plan}</td>
                    <td className="px-4 py-2.5 text-gray-600">{output}</td>
                    <td className={`px-4 py-2.5 ${wmColor}`}>{wm}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Shot
            src={`${S}17.53.36.png`}
            alt="Scene Fixer download ready — 720p badge, Download button, Before/After diff player"
          />
        </div>

        {/* Pipeline summary */}
        <div className="rounded-2xl border border-gray-200 bg-gray-50 px-6 py-6">
          <p className="text-xs font-semibold uppercase tracking-widest text-gray-400 mb-4">
            Full pipeline at a glance
          </p>
          <div className="flex flex-col gap-2.5">
            {[
              ["Upload", "Firebase Storage (signed URL, direct from browser)"],
              ["Shot detection", "PySceneDetect → 5 keyframes / shot"],
              ["Error detection", "Claude Opus 4.8 vision — flags what's inconsistent and describes where"],
              ["User review", "Confirm each flag, mark the exact region, or add missed errors manually"],
              ["Inpainting", "Runway Gen-4 Aleph (per confirmed error, sequential)"],
              ["Verification", "Claude Opus 4.8 vision (per fixed clip)"],
              ["Stitch + scale", "FFmpeg → 480p / 720p / 1080p depending on plan"],
            ].map(([stage, detail]) => (
              <div key={stage} className="flex items-start gap-3 text-sm">
                <span className="font-semibold text-black w-36 shrink-0">{stage}</span>
                <span className="text-gray-500">{detail}</span>
              </div>
            ))}
          </div>
        </div>

        {/* CTA */}
        <div className="text-center pt-2 pb-8">
          <p className="text-gray-500 text-sm mb-5">
            The whole pipeline runs in the cloud — no software to install, no GPU required.
          </p>
          <Link
            href="/"
            className="inline-block bg-black text-white font-semibold text-sm px-7 py-3 rounded-xl hover:bg-gray-800 transition-colors"
          >
            Try it free →
          </Link>
        </div>
      </div>
    </main>
  );
}
