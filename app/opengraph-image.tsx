import { ImageResponse } from "next/og";
import { readFile } from "fs/promises";
import { join } from "path";

export const alt = "Scene Fixer — Finish your AI video";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function Image() {
  const [fontRegular, fontBold] = await Promise.all([
    readFile(join(process.cwd(), "node_modules/geist/dist/fonts/geist-sans/Geist-Regular.ttf")),
    readFile(join(process.cwd(), "node_modules/geist/dist/fonts/geist-sans/Geist-Bold.ttf")),
  ]);

  return new ImageResponse(
    (
      <div
        style={{
          background: "#ffffff",
          width: "100%",
          height: "100%",
          display: "flex",
          fontFamily: "Geist",
          padding: "0",
          overflow: "hidden",
        }}
      >
        {/* Left panel — hero content */}
        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            padding: "72px 64px",
            borderRight: "1px solid #f0f0f0",
          }}
        >
          {/* Model badges */}
          <div style={{ display: "flex", gap: 10, marginBottom: 36 }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                border: "1px solid #e5e7eb",
                borderRadius: 100,
                padding: "7px 16px",
                fontSize: 12,
                fontWeight: 600,
                letterSpacing: "0.05em",
                color: "#374151",
              }}
            >
              <div
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  background: "#111",
                }}
              />
              RUNWAY GEN-4 ALEPH
            </div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                border: "1px solid #e5e7eb",
                borderRadius: 100,
                padding: "7px 16px",
                fontSize: 12,
                fontWeight: 600,
                letterSpacing: "0.05em",
                color: "#374151",
              }}
            >
              <div
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  background: "#f97316",
                }}
              />
              CLAUDE OPUS 4.8
            </div>
          </div>

          {/* Headline */}
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              fontSize: 62,
              fontWeight: 700,
              lineHeight: 1.05,
              color: "#000",
              letterSpacing: "-0.02em",
              marginBottom: 28,
            }}
          >
            <span>Your AI clips</span>
            <span>don&apos;t match.</span>
            <span>Scene Fixer</span>
            <span>makes them one.</span>
          </div>

          {/* Subline */}
          <div
            style={{
              fontSize: 18,
              color: "#6b7280",
              lineHeight: 1.5,
              marginBottom: 40,
              maxWidth: 420,
            }}
          >
            Drop clips from Runway, Veo, or Kling. Match lighting, fix wardrobe, adjust atmosphere — without regenerating.
          </div>

          {/* Trust badges */}
          <div style={{ display: "flex", gap: 20, fontSize: 13, color: "#6b7280" }}>
            <span>Free to start</span>
            <span>·</span>
            <span>Any AI model</span>
            <span>·</span>
            <span>No credit card required</span>
          </div>
        </div>

        {/* Right panel — drop zone mock */}
        <div
          style={{
            width: 420,
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            padding: "48px 40px",
            background: "#fafafa",
          }}
        >
          {/* Logo top-right */}
          <div
            style={{
              fontSize: 17,
              marginBottom: 40,
              color: "#111",
              display: "flex",
            }}
          >
            <span style={{ fontWeight: 700 }}>/</span>
            <span style={{ fontWeight: 400 }}>scene</span>
            <span style={{ fontWeight: 700 }}>fixer</span>
          </div>

          {/* Drop zone */}
          <div
            style={{
              border: "2px dashed #d1d5db",
              borderRadius: 16,
              padding: "36px 24px",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              background: "#fff",
              marginBottom: 24,
            }}
          >
            {/* Clapperboard icon (simple SVG-like box) */}
            <div
              style={{
                width: 52,
                height: 44,
                background: "#111",
                borderRadius: 6,
                marginBottom: 14,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <div
                style={{
                  width: 36,
                  height: 6,
                  background: "#fff",
                  borderRadius: 2,
                }}
              />
            </div>
            <div style={{ fontSize: 15, fontWeight: 700, color: "#111", marginBottom: 4 }}>
              Drop your video here
            </div>
            <div style={{ fontSize: 13, color: "#9ca3af" }}>MP4 or MOV · 200MB max</div>
          </div>

          {/* Recent jobs mock */}
          <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", color: "#9ca3af", marginBottom: 10 }}>
            RECENT JOBS
          </div>
          {["scene_01.mp4", "brand_shoot.mov", "ep3_rough.mp4"].map((name, i) => (
            <div
              key={i}
              style={{
                display: "flex",
                justifyContent: "space-between",
                padding: "9px 12px",
                background: "#fff",
                borderRadius: 8,
                marginBottom: 6,
                fontSize: 13,
                color: "#374151",
                border: "1px solid #f3f4f6",
              }}
            >
              <span>{name}</span>
              <span style={{ color: "#d1d5db" }}>Fixed</span>
            </div>
          ))}
        </div>
      </div>
    ),
    {
      ...size,
      fonts: [
        { name: "Geist", data: fontRegular, weight: 400 as const },
        { name: "Geist", data: fontBold, weight: 700 as const },
      ],
    }
  );
}
