"""Extract frames from video clips at deterministic sample intervals (default 0.4s),
saving raw RGB binaries for zero-overhead tensor creation in Node/Tier1.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import cv2


def extract_clip_frames(clip_path: Path, output_dir: Path, step_sec: float = 0.4) -> list[dict]:
    cap = cv2.VideoCapture(str(clip_path))
    if not cap.isOpened():
        raise RuntimeError(f"Could not open clip: {clip_path}")

    fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    duration = total_frames / fps if total_frames > 0 else 0.0

    output_dir.mkdir(parents=True, exist_ok=True)
    manifest = []

    curr_t = 0.0
    idx = 0
    while curr_t <= duration:
        frame_idx = max(0, min(total_frames - 1, int(round(curr_t * fps))))
        cap.set(cv2.CAP_PROP_POS_FRAMES, frame_idx)
        ret, frame = cap.read()
        if not ret or frame is None:
            break

        # Downscale to 320 px wide (keeping aspect ratio)
        h, w = frame.shape[:2]
        new_w = 320
        new_h = int(round(h * 320.0 / w))
        resized = cv2.resize(frame, (new_w, new_h), interpolation=cv2.INTER_AREA)
        rgb = cv2.cvtColor(resized, cv2.COLOR_BGR2RGB)

        bin_filename = f"frame_{idx:04d}_{curr_t:.2f}s.bin"
        bin_path = output_dir / bin_filename
        bin_path.write_bytes(rgb.tobytes())

        manifest.append({
            "index": idx,
            "sample_time": round(curr_t, 2),
            "frame_idx": frame_idx,
            "filename": bin_filename,
            "width": new_w,
            "height": new_h,
            "bytes_len": len(rgb.tobytes()),
        })

        curr_t = round(curr_t + step_sec, 2)
        idx += 1

    cap.release()

    manifest_path = output_dir / "manifest.json"
    manifest_data = {
        "clip": clip_path.name,
        "duration": duration,
        "fps": fps,
        "step_sec": step_sec,
        "total_frames": len(manifest),
        "frames": manifest,
    }
    manifest_path.write_text(json.dumps(manifest_data, indent=2), encoding="utf-8")

    print(f"Extracted {len(manifest)} frames to {output_dir} (step={step_sec}s, duration={duration:.2f}s)")
    return manifest


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--clip", required=True, help="Path to mp4 clip")
    parser.add_argument("--out", required=True, help="Output directory")
    parser.add_argument("--step", type=float, default=0.4, help="Step in seconds")
    args = parser.parse_args()

    extract_clip_frames(Path(args.clip), Path(args.out), args.step)
