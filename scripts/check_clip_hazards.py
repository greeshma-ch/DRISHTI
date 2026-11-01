"""Script to send 10 evenly spaced frames from a video clip to /frame and print returned hazards.

Used to verify Tier 2 perception (e.g. stairs up or down, drop-offs, obstacles).
Supports both a running FastAPI server (http://127.0.0.1:8000/frame) and direct in-process
testing via FastAPI TestClient / ASGI transport if server is offline.
"""

from __future__ import annotations

import argparse
import asyncio
import io
import sys
from pathlib import Path
from typing import Any

import cv2
import httpx
from PIL import Image

# Ensure server module is importable
repo_root = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(repo_root))

from server.app import app


def extract_10_frames(clip_path: Path) -> list[tuple[int, float, bytes]]:
    """Extract 10 evenly spaced frames from a video clip using OpenCV."""
    cap = cv2.VideoCapture(str(clip_path))
    if not cap.isOpened():
        raise RuntimeError(f"Could not open video clip: {clip_path}")

    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    fps = cap.get(cv2.CAP_PROP_FPS) or 25.0

    if total_frames <= 0:
        cap.release()
        raise RuntimeError(f"Video file has 0 frames: {clip_path}")

    # Pick 10 evenly spaced frame indices
    step = max(1, total_frames // 10)
    indices = [min(total_frames - 1, i * step) for i in range(10)]

    extracted: list[tuple[int, float, bytes]] = []

    for frame_idx in indices:
        cap.set(cv2.CAP_PROP_POS_FRAMES, frame_idx)
        ret, frame = cap.read()
        if not ret or frame is None:
            continue
        timestamp_sec = round(frame_idx / fps, 2)
        # Resize to standard Drishti 640x360 if needed
        h, w = frame.shape[:2]
        if (w, h) != (640, 360):
            frame = cv2.resize(frame, (640, 360))

        # Encode to JPEG
        success, jpeg_buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 75])
        if success:
            extracted.append((frame_idx, timestamp_sec, jpeg_buf.tobytes()))

    cap.release()
    return extracted


def create_synthetic_stairs_frame(timestamp_sec: float) -> bytes:
    """Create a synthetic test frame with descending stairs for offline testing."""
    img = Image.new("RGB", (640, 360), color=(120, 120, 120))
    # Draw simple stair bands
    from PIL import ImageDraw

    draw = ImageDraw.Draw(img)
    for step in range(6):
        y = 180 + step * 30
        shade = max(20, 100 - step * 15)
        draw.rectangle([0, y, 640, y + 30], fill=(shade, shade, shade))
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=75)
    return buf.getvalue()


async def send_frame_http(
    url: str,
    frame_bytes: bytes,
    timestamp_sec: float,
    lang: str = "en",
) -> dict[str, Any]:
    """Send frame to running HTTP server, or fall back to in-process ASGI app."""
    files = {"file": ("frame.jpg", frame_bytes, "image/jpeg")}
    data = {"timestamp": str(timestamp_sec), "lang": lang}

    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.post(url, files=files, data=data)
            resp.raise_for_status()
            return resp.json()
    except (httpx.HTTPError, OSError):
        # Fallback to in-process ASGI test client
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.post("/frame", files=files, data=data)
            resp.raise_for_status()
            return resp.json()


async def run_check(clip_path: Path | None, endpoint: str, lang: str = "en") -> None:
    frames: list[tuple[int, float, bytes]] = []

    if clip_path and clip_path.exists():
        print(f"Loading frames from video: {clip_path}")
        frames = extract_10_frames(clip_path)
    else:
        # Check eval/clips directory
        clips_dir = repo_root / "eval" / "clips"
        found_clips = list(clips_dir.glob("*.mp4")) if clips_dir.exists() else []
        if found_clips:
            clip_path = found_clips[0]
            print(f"Using first available clip: {clip_path}")
            frames = extract_10_frames(clip_path)
        else:
            print("No video clip found. Generating 10 synthetic test frames with stairs...")
            for i in range(10):
                t = round(i * 0.4, 2)
                frames.append((i, t, create_synthetic_stairs_frame(t)))

    print("=" * 96)
    print(f"Sending {len(frames)} frames to Tier 2 ({endpoint}) [Language: {lang}]")
    print("=" * 96)
    print(
        f"{'#':<4} {'Time (s)':<10} {'Status':<10} {'Hazard Type':<14} {'Direction':<10} "
        f"{'Distance':<10} {'Urgency':<8} {'Instruction'}"
    )
    print("-" * 96)

    stairs_detected_count = 0

    for idx, (f_num, t_sec, f_bytes) in enumerate(frames, start=1):
        try:
            res = await send_frame_http(endpoint, f_bytes, t_sec, lang=lang)
            perception = res.get("perception", {})
            status = perception.get("status", "unknown")
            hazard = perception.get("hazard") or {}
            h_type = hazard.get("type", "--") if hazard else "--"
            h_dir = hazard.get("direction", "--") if hazard else "--"
            h_dist = hazard.get("distance", "--") if hazard else "--"
            h_urg = hazard.get("urgency", "--") if hazard else "--"
            instruction = perception.get("instruction") or "--"

            if h_type in ("stairs", "step_down"):
                stairs_detected_count += 1

            print(
                f"{idx:<4} {t_sec:<10.2f} {status:<10} {h_type:<14} {h_dir:<10} "
                f"{h_dist:<10} {h_urg!s:<8} {instruction}"
            )
        except (httpx.HTTPError, OSError, ValueError, RuntimeError) as err:
            print(f"{idx:<4} {t_sec:<10.2f} ERROR      {str(err)[:50]}")

    print("=" * 96)
    print(f"Summary: Stairs / step down detected in {stairs_detected_count}/{len(frames)} frames.")
    print("=" * 96)


def main() -> None:
    parser = argparse.ArgumentParser(description="Send 10 frames from a clip to /frame to verify Tier 2 perception.")
    parser.add_argument("--clip", type=Path, default=None, help="Path to video clip file (.mp4)")
    parser.add_argument("--endpoint", type=str, default="http://127.0.0.1:8000/frame", help="FastAPI /frame endpoint")
    parser.add_argument("--lang", type=str, default="en", help="Language: en or hi")
    args = parser.parse_args()

    asyncio.run(run_check(args.clip, args.endpoint, args.lang))


if __name__ == "__main__":
    main()

