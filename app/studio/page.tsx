import type { Metadata } from "next";
import StudioApp from "@/components/studio/StudioApp";

export const metadata: Metadata = {
  title: "Seedance 2.5 videos for about $1 | Scene Fixer Studio",
  description:
    "Make Seedance 2.5 videos with sound at 720p or 1080p for about $1 each. Pay once, no subscription, credits never expire. Limited batch.",
};

export default function StudioPage() {
  return <StudioApp />;
}
