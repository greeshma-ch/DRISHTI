"""Script to verify Tier 2 perception on video clips and labeled misses.

Used to:
1. Verify Tier 2 perception on 10 evenly spaced frames from a video clip.
2. Verify Tier 2 on labeled misses from an exported CSV (Requirement 3):
   Extracts frames at t-1, t, t+1 s (640 px wide), calls /frame on each,
   prints a table (clip, t, expected, Tier 2 type & dir, dist, urg, latency, retries, hit/miss),
   and prints Tier 2 recall summary by hazard type (stairs, wall, person, vehicle).
Supports running server (http://127.0.0.1:8000/frame) and direct in-process ASGI transport.
"""

from __future__ import annotations

import argparse
import asyncio
import csv
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

    step = max(1, total_frames // 10)
    indices = [min(total_frames - 1, i * step) for i in range(10)]

    extracted: list[tuple[int, float, bytes]] = []

    for frame_idx in indices:
        cap.set(cv2.CAP_PROP_POS_FRAMES, frame_idx)
        ret, frame = cap.read()
        if not ret or frame is None:
            continue
        timestamp_sec = round(frame_idx / fps, 2)
        h, w = frame.shape[:2]
        if w != 640:
            new_h = int(round(h * 640.0 / w))
            frame = cv2.resize(frame, (640, new_h))

        success, jpeg_buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 75])
        if success:
            extracted.append((frame_idx, timestamp_sec, jpeg_buf.tobytes()))

    cap.release()
    return extracted


def extract_frame_at_timestamp(clip_path: Path, timestamp_sec: float) -> tuple[float, bytes] | None:
    """Extract a single frame at a specific timestamp (in seconds) and resize to 640px wide."""
    cap = cv2.VideoCapture(str(clip_path))
    if not cap.isOpened():
        return None

    fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    if total_frames <= 0:
        cap.release()
        return None

    frame_idx = max(0, min(total_frames - 1, int(round(timestamp_sec * fps))))
    cap.set(cv2.CAP_PROP_POS_FRAMES, frame_idx)
    ret, frame = cap.read()
    cap.release()

    if not ret or frame is None:
        return None

    h, w = frame.shape[:2]
    if w != 640:
        new_h = int(round(h * 640.0 / w))
        frame = cv2.resize(frame, (640, new_h))

    success, jpeg_buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 75])
    if not success:
        return None

    actual_t = round(frame_idx / fps, 2)
    return actual_t, jpeg_buf.tobytes()


def find_clip_path(clip_name: str) -> Path | None:
    """Resolve a clip name to an existing video file path."""
    raw = Path(clip_name)
    candidates = [
        raw,
        repo_root / raw,
        repo_root / "eval" / "clips" / raw.name,
        repo_root / "eval" / "clips" / "small" / raw.name,
    ]
    if not raw.suffix:
        candidates.extend([
            repo_root / "eval" / "clips" / f"{raw.name}.mp4",
            repo_root / "eval" / "clips" / "small" / f"{raw.name}.mp4",
        ])
    for c in candidates:
        if c.exists() and c.is_file():
            return c
    return None


def is_hazard_type_match(expected: str, detected: str) -> bool:
    """Check if detected hazard matches expected type within semantic aliases."""
    exp = expected.lower().strip().replace(" ", "_")
    det = detected.lower().strip().replace(" ", "_")
    if not exp or not det or det in ("--", "unknown", "none"):
        return False
    if exp == det:
        return True
    if exp in ("stairs", "step_down", "staircase", "steps") and det in ("stairs", "step_down"):
        return True
    if exp in ("wall", "wall_turn") and det in ("wall", "wall_turn"):
        return True
    if exp in ("vehicle", "car", "rickshaw", "auto", "bus", "truck", "motorcycle") and det in (
        "vehicle",
        "rickshaw",
        "car",
        "bus",
        "truck",
    ):
        return True
    if exp == "person" and det == "person":
        return True
    if exp in ("pothole", "open_drain", "drain") and det in ("pothole", "open_drain"):
        return True
    return False


def create_synthetic_stairs_frame(timestamp_sec: float) -> bytes:
    """Create a synthetic test frame with descending stairs for offline testing."""
    img = Image.new("RGB", (640, 360), color=(120, 120, 120))
    from PIL import ImageDraw

    draw = ImageDraw.Draw(img)
    for step in range(6):
        y = 180 + step * 30
        shade = max(20, 100 - step * 15)
        draw.rectangle([0, y, 640, y + 30], fill=(shade, shade, shade))
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=75)
    return buf.getvalue()


_use_in_process: bool | None = None


async def send_frame_http(
    url: str,
    frame_bytes: bytes,
    timestamp_sec: float,
    lang: str = "en",
) -> dict[str, Any]:
    """Send frame to running HTTP server, or fall back to in-process ASGI app."""
    global _use_in_process
    files = {"file": ("frame.jpg", frame_bytes, "image/jpeg")}
    data = {"timestamp": str(timestamp_sec), "lang": lang}

    if _use_in_process is None:
        try:
            async with httpx.AsyncClient(timeout=1.0) as client:
                status_url = url.replace("/frame", "/status")
                resp = await client.get(status_url)
                _use_in_process = resp.status_code != 200
        except (httpx.HTTPError, OSError):
            _use_in_process = True

    if not _use_in_process:
        try:
            async with httpx.AsyncClient(timeout=15.0) as client:
                resp = await client.post(url, files=files, data=data)
                resp.raise_for_status()
                return resp.json()
        except (httpx.HTTPError, OSError):
            _use_in_process = True

    # Fallback to in-process ASGI test client
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        resp = await client.post("/frame", files=files, data=data)
        resp.raise_for_status()
        return resp.json()


async def check_labeled_misses(csv_path: Path, endpoint: str, lang: str = "en") -> None:
    """Check Tier 2 perception on labeled misses from exported CSV (Requirement 3).

    Extracts frames at t-1, t, t+1 s (downscaled to 640px), calls /frame, prints results table
    and recall summary by hazard type (stairs, wall, person, vehicle).
    """
    if not csv_path.exists():
        print(f"Error: CSV file not found: {csv_path}")
        return

    with csv_path.open("r", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        all_rows = list(reader)

    missed_rows = [
        r
        for r in all_rows
        if r.get("decision") == "missed_hazard"
        or r.get("label") in ("Should have alerted", "Missed", "missed")
    ]

    print("=" * 115)
    print(f"Checking Tier 2 Perception on {len(missed_rows)} Labeled Misses from {csv_path.name}")
    print(f"Endpoint: {endpoint} | Window: ±1.5 s (t-1, t, t+1)")
    print("=" * 115)

    if not missed_rows:
        print("No missed hazard rows found in CSV.")
        return

    print(
        f"{'Clip':<14} {'t (s)':<8} {'Expected':<18} {'Tier 2 Detections (t-1, t, t+1)':<32} "
        f"{'Dist':<8} {'Urg':<5} {'Latency':<9} {'Retries':<8} {'Result'}"
    )
    print("-" * 115)

    type_stats: dict[str, dict[str, int]] = {
        "stairs": {"total": 0, "hits": 0},
        "wall": {"total": 0, "hits": 0},
        "person": {"total": 0, "hits": 0},
        "vehicle": {"total": 0, "hits": 0},
    }

    for idx, row in enumerate(missed_rows, start=1):
        clip_name = row.get("clip") or "clip_006.mp4"
        t_val = float(row.get("sample_time") or row.get("t") or 0.0)
        expected_type = (row.get("class") or "other").strip()
        expected_dir = (row.get("direction") or "center").strip()

        clip_path = find_clip_path(clip_name)
        if not clip_path:
            print(f"{clip_name:<14} {t_val:<8.2f} {expected_type} ({expected_dir}): Clip file not found")
            continue

        # Extract frames at t-1, t, t+1
        cap = cv2.VideoCapture(str(clip_path))
        fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
        total_f = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        duration = total_f / fps if total_f > 0 else 30.0
        cap.release()

        target_times = sorted(
            list(
                {
                    round(max(0.0, t_val - 1.0), 2),
                    round(max(0.0, min(duration, t_val)), 2),
                    round(min(duration, t_val + 1.0), 2),
                }
            )
        )

        detections: list[dict[str, Any]] = []

        for ts in target_times:
            frame_res = extract_frame_at_timestamp(clip_path, ts)
            if not frame_res:
                continue
            act_t, f_bytes = frame_res

            try:
                res = await send_frame_http(endpoint, f_bytes, act_t, lang=lang)
                perception = res.get("perception") or {}
                hazard = perception.get("hazard") or {}
                h_type = hazard.get("type", "--") if hazard else "--"
                h_dir = hazard.get("direction", "--") if hazard else "--"
                h_dist = hazard.get("distance", "--") if hazard else "--"
                h_urg = hazard.get("urgency", 0) if hazard else 0
                latency = f"{int(res.get('latency_ms', 0))}ms"
                retries = str(res.get("retries_display") or "0")

                detections.append({
                    "ts": act_t,
                    "type": h_type,
                    "direction": h_dir,
                    "distance": h_dist,
                    "urgency": h_urg,
                    "latency": latency,
                    "retries": retries,
                })
            except Exception as err:
                detections.append({
                    "ts": act_t,
                    "type": "error",
                    "direction": "--",
                    "distance": "--",
                    "urgency": 0,
                    "latency": "--",
                    "retries": "--",
                    "error": str(err),
                })

        # Hit determination: same type within ±1.5s
        hit_det: dict[str, Any] | None = None
        for d in detections:
            if is_hazard_type_match(expected_type, d["type"]):
                hit_det = d
                break

        is_hit = hit_det is not None
        result_str = "HIT" if is_hit else "MISS"

        # Best representative detection to display
        rep_det = hit_det or (detections[1] if len(detections) > 1 else (detections[0] if detections else {}))
        tier2_summary = ", ".join(f"t={d['ts']:.1f}:{d['type']}" for d in detections if d.get("type") not in ("--", "unknown")) or "none"
        if len(tier2_summary) > 30:
            tier2_summary = tier2_summary[:28] + ".."

        exp_display = f"{expected_type} ({expected_dir})"
        print(
            f"{clip_name:<14} {t_val:<8.2f} {exp_display:<18} {tier2_summary:<32} "
            f"{str(rep_det.get('distance', '--')):<8} {str(rep_det.get('urgency', '--')):<5} "
            f"{str(rep_det.get('latency', '--')):<9} {str(rep_det.get('retries', '--')):<8} {result_str}"
        )

        # Track category statistics
        norm_type = expected_type.lower()
        if norm_type in ("stairs", "step_down"):
            cat = "stairs"
        elif norm_type in ("wall", "wall_turn"):
            cat = "wall"
        elif norm_type == "person":
            cat = "person"
        elif norm_type in ("vehicle", "car", "rickshaw"):
            cat = "vehicle"
        else:
            cat = norm_type

        if cat not in type_stats:
            type_stats[cat] = {"total": 0, "hits": 0}
        type_stats[cat]["total"] += 1
        if is_hit:
            type_stats[cat]["hits"] += 1

    # Print summary table (Requirement 3)
    print("=" * 65)
    print("Tier 2 Recall by Hazard Type on Labeled Misses (Requirement 3)")
    print("=" * 65)
    print(f"{'Hazard Type':<16} {'Total Misses':<14} {'Hits':<10} {'Tier 2 Recall'}")
    print("-" * 65)

    grand_total = 0
    grand_hits = 0

    for cat in ["stairs", "wall", "person", "vehicle"]:
        stat = type_stats.get(cat, {"total": 0, "hits": 0})
        total = stat["total"]
        hits = stat["hits"]
        recall_pct = f"{(hits / total * 100):.1f}%" if total > 0 else "N/A (0 samples)"
        grand_total += total
        grand_hits += hits
        print(f"{cat:<16} {total:<14} {hits:<10} {recall_pct}")

    # Other categories if any
    for cat, stat in type_stats.items():
        if cat in ("stairs", "wall", "person", "vehicle"):
            continue
        total = stat["total"]
        hits = stat["hits"]
        recall_pct = f"{(hits / total * 100):.1f}%" if total > 0 else "N/A"
        grand_total += total
        grand_hits += hits
        print(f"{cat:<16} {total:<14} {hits:<10} {recall_pct}")

    print("-" * 65)
    overall_recall = f"{(grand_hits / grand_total * 100):.1f}%" if grand_total > 0 else "N/A"
    print(f"{'Overall':<16} {grand_total:<14} {grand_hits:<10} {overall_recall}")
    print("=" * 65)


async def run_check(clip_path: Path | None, endpoint: str, lang: str = "en") -> None:
    """Spot check 10 evenly spaced frames from a video clip."""
    frames: list[tuple[int, float, bytes]] = []

    if clip_path and clip_path.exists():
        print(f"Loading frames from video: {clip_path}")
        frames = extract_10_frames(clip_path)
    else:
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

    for idx, (_f_num, t_sec, f_bytes) in enumerate(frames, start=1):
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
    parser = argparse.ArgumentParser(
        description="Verify Tier 2 perception on video clips or labeled misses."
    )
    parser.add_argument("--clip", type=Path, default=None, help="Path to video clip file (.mp4)")
    parser.add_argument(
        "--csv",
        type=Path,
        default=None,
        help="Path to exported labeled CSV with missed_hazard rows (Requirement 3)",
    )
    parser.add_argument(
        "--endpoint", type=str, default="http://127.0.0.1:8000/frame", help="FastAPI /frame endpoint"
    )
    parser.add_argument("--lang", type=str, default="en", help="Language: en or hi")
    args = parser.parse_args()

    if args.csv:
        asyncio.run(check_labeled_misses(args.csv, args.endpoint, args.lang))
    else:
        asyncio.run(run_check(args.clip, args.endpoint, args.lang))


if __name__ == "__main__":
    main()


