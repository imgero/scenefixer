"use client";

import { ReactCompareSlider } from "react-compare-slider";

type Props = {
  beforeUrl: string;
  afterUrl: string;
};

function VideoPane({ src, label }: { src: string; label: string }) {
  return (
    <div className="relative w-full h-full bg-black">
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <video
        src={src}
        autoPlay
        loop
        muted
        playsInline
        className="w-full h-full object-contain"
      />
      <span className="absolute bottom-2 left-2 text-xs text-white bg-black/70 px-2 py-0.5 rounded font-medium">
        {label}
      </span>
    </div>
  );
}

export default function DiffPlayer({ beforeUrl, afterUrl }: Props) {
  return (
    <div className="rounded-2xl overflow-hidden border border-gray-200 aspect-video w-full">
      <ReactCompareSlider
        itemOne={<VideoPane src={beforeUrl} label="Before" />}
        itemTwo={<VideoPane src={afterUrl} label="After" />}
        style={{ width: "100%", height: "100%" }}
      />
    </div>
  );
}
