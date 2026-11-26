"""
Join several uploaded clips into one video, in order, before decompose.

A scan compares shots, so it needs one video with two or more of them. People
generating video with Runway, Veo, Kling or Seedance get one clip per shot,
and the site invites them to "drop clips". Before this, a single clip came
back as "one continuous shot, nothing to compare" — on 25 Nov one visitor
uploaded three separate clips in eight minutes and got that answer three
times (and earlier on 10 and 12 Nov).

So a job may carry `inputClipUrls` (2+), and run_decompose joins them here
into one file that then goes through the pipeline exactly as an uploaded
video would. The joined file replaces `inputVideoUrl`, which is the single
field fix.py, stitch.py, the before/after player and the download name all
read the original from — so none of them needs to know there were clips.

Every point where one clip ends and the next begins is a guaranteed cut
(`clipBoundariesMs`, passed to detect_shots as forced cuts). Two generated
clips of the same scene can look continuous enough that the shot detector
would merge them, and comparing them is the whole point of the upload.

No Firebase imports here, so this module can be tested locally with nothing
but ffmpeg.
"""

from __future__ import annotations

import os
import subprocess

# Also enforced by POST /api/jobs (MAX_CLIPS in lib/uploads.ts).
MAX_CLIPS = 10
_FPS_MIN, _FPS_MAX, _FPS_DEFAULT = 24, 60, 30


def _probe_video(path: str) -> dict:
    """Displayed width/height (rotation applied), frame rate, duration, audio."""
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height,avg_frame_rate,r_frame_rate,duration:stream_side_data=rotation:stream_tags=rotate",
         "-of", "json", path],
        capture_output=True, text=True, check=True,
    ).stdout
    import json
    streams = json.loads(out).get("streams") or []
    if not streams:
        raise subprocess.CalledProcessError(1, "ffprobe", stderr=b"no video stream")
    s = streams[0]
    w, h = int(s.get("width") or 0), int(s.get("height") or 0)

    rotation = 0
    for sd in s.get("side_data_list") or []:
        if "rotation" in sd:
            rotation = int(float(sd["rotation"]))
    if not rotation and (s.get("tags") or {}).get("rotate"):
        rotation = int(float(s["tags"]["rotate"]))
    if abs(rotation) % 180 == 90:
        w, h = h, w

    def _rate(v: str | None) -> float:
        try:
            num, den = (v or "0/0").split("/")
            return float(num) / float(den) if float(den) else 0.0
        except (ValueError, ZeroDivisionError):
            return 0.0

    fps = _rate(s.get("avg_frame_rate")) or _rate(s.get("r_frame_rate"))

    has_audio = bool(subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "a",
         "-show_entries", "stream=index", "-of", "csv=p=0", path],
        capture_output=True, text=True,
    ).stdout.strip())

    dur = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", path],
        capture_output=True, text=True,
    ).stdout.strip()
    try:
        duration = float(s.get("duration") or dur)
    except (TypeError, ValueError):
        duration = 0.0

    return {"width": w, "height": h, "fps": fps, "duration": duration, "has_audio": has_audio}


def _even(n: int) -> int:
    return max(2, n - (n % 2))


def _count_frames(path: str) -> int:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-count_packets",
         "-show_entries", "stream=nb_read_packets", "-of", "csv=p=0", path],
        capture_output=True, text=True, check=True,
    ).stdout.strip().strip(",")
    return int(out)


def _frame_times(path: str) -> list[float]:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "packet=pts_time", "-of", "csv=p=0", path],
        capture_output=True, text=True, check=True,
    ).stdout
    times = []
    for line in out.split():
        try:
            times.append(float(line.strip().strip(",")))
        except ValueError:
            continue
    return sorted(times)


def _normalize_clip(src: str, dst: str, width: int, height: int, fps: int,
                    info: dict) -> None:
    """
    Re-encode one clip to the shared frame size, frame rate and audio format so
    the concat demuxer can join the pictures by stream copy.

    Fit inside the frame and pad: a clip whose aspect ratio differs gets bars
    rather than being stretched or cut. Audio is padded with silence and cut
    to the video's own length, so no clip's audio runs over and pushes the
    next clip's pictures later than its frame count says.
    """
    vf = (
        f"scale={width}:{height}:force_original_aspect_ratio=decrease,"
        f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:black,"
        f"setsar=1,fps={fps},format=yuv420p"
    )
    dur = max(info["duration"], 0.04)
    cmd = ["ffmpeg", "-y", "-i", src]
    if info["has_audio"]:
        a_in = "[0:a:0]"
    else:
        cmd += ["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo"]
        a_in = "[1:a]"
    af = f"aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=0:{dur:.3f}"
    cmd += [
        "-filter_complex", f"[0:v:0]{vf}[v];{a_in}{af}[a]",
        "-map", "[v]", "-map", "[a]",
        "-t", f"{dur:.3f}",
        "-c:v", "libx264", "-crf", "18", "-preset", "veryfast",
        "-video_track_timescale", "90000",
        # PCM, not AAC, in the intermediate: AAC works in 1024-sample frames
        # plus encoder priming, so a 3.000 s clip's audio ran to 3.021 s and
        # the concat demuxer started the next clip's pictures 21 ms late — a
        # gap in the video at every boundary. PCM is sample-exact. The joined
        # file is encoded to AAC once, at the end.
        "-c:a", "pcm_s16le", "-ar", "48000", "-ac", "2",
        dst,
    ]
    subprocess.run(cmd, check=True, capture_output=True)


def combine_clips(clip_paths: list[str], work_dir: str) -> tuple[str, list[int]]:
    """
    Join `clip_paths` in order. Returns (joined_path, boundaries_ms), where
    boundaries_ms[i] is the start of clip i+1 in the joined file.

    The frame is the FIRST clip's displayed size and its frame rate (rounded,
    held to 24-60). fix.py and stitch.py rebuild the delivered video from this
    file at its own resolution, so it is not capped at 720p the way the
    analysis copy is.

    Boundaries are taken from the joined file's own frame timestamps at each
    clip's running frame count, so they land on the first frame of the next
    clip exactly — not on an estimate that drifts with every clip.
    """
    if len(clip_paths) < 2:
        raise ValueError("combine_clips needs at least two clips")

    infos = [_probe_video(p) for p in clip_paths]
    first = infos[0]
    width, height = _even(first["width"]), _even(first["height"])
    fps = int(round(first["fps"])) if first["fps"] else _FPS_DEFAULT
    fps = min(_FPS_MAX, max(_FPS_MIN, fps))

    seg_paths: list[str] = []
    frame_counts: list[int] = []
    for i, (src, info) in enumerate(zip(clip_paths, infos)):
        seg = os.path.join(work_dir, f"segment_{i:02d}.mov")
        _normalize_clip(src, seg, width, height, fps, info)
        seg_paths.append(seg)
        frame_counts.append(_count_frames(seg))

    list_path = os.path.join(work_dir, "segments.txt")
    with open(list_path, "w") as f:
        for seg in seg_paths:
            f.write(f"file '{seg}'\n")

    joined = os.path.join(work_dir, "combined.mp4")
    subprocess.run(
        ["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", list_path,
         "-c:v", "copy", "-c:a", "aac", "-b:a", "160k",
         "-movflags", "+faststart", joined],
        check=True, capture_output=True,
    )

    times = _frame_times(joined)
    boundaries_ms: list[int] = []
    cum = 0
    for n in frame_counts[:-1]:
        cum += n
        if len(times) == sum(frame_counts) and cum < len(times):
            boundaries_ms.append(int(round(times[cum] * 1000)))
        else:
            boundaries_ms.append(int(round(cum * 1000 / fps)))

    print(
        f"combine_clips: {len(clip_paths)} clips -> {width}x{height}@{fps}, "
        f"frames {frame_counts}, boundaries {boundaries_ms} ms"
    )
    return joined, boundaries_ms
