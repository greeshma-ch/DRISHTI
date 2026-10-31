"""Benchmark 20 frames with in-flight 1 vs in-flight 2 against Meta Model API."""

from __future__ import annotations

import asyncio
import io
import statistics
import time
from PIL import Image

from server.meta_client import analyze_frame


def make_test_frame(idx: int) -> bytes:
    # Slightly vary pixel content per frame
    color = ((idx * 13) % 255, (idx * 29) % 255, (idx * 47) % 255)
    img = Image.new("RGB", (640, 360), color=color)
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=70)
    return buf.getvalue()


async def run_inflight_1(frames: list[bytes]) -> list[float]:
    latencies: list[float] = []
    print(f"Running {len(frames)} frames with in-flight 1...")
    for i, frame in enumerate(frames):
        t0 = time.perf_counter()
        res, usage, meta_ms, _ = await analyze_frame(frame, lang="en")
        dt = (time.perf_counter() - t0) * 1000
        latencies.append(meta_ms if meta_ms > 0 else dt)
        print(f"  [inflight=1] Frame {i + 1}/{len(frames)}: meta_ms={meta_ms:.1f} ms, usage={usage}")
    return latencies


async def run_inflight_2(frames: list[bytes]) -> list[float]:
    latencies: list[float] = []
    sem = asyncio.Semaphore(2)
    print(f"\nRunning {len(frames)} frames with in-flight 2...")

    async def worker(idx: int, frame: bytes) -> None:
        async with sem:
            t0 = time.perf_counter()
            res, usage, meta_ms, _ = await analyze_frame(frame, lang="en")
            dt = (time.perf_counter() - t0) * 1000
            val = meta_ms if meta_ms > 0 else dt
            latencies.append(val)
            print(f"  [inflight=2] Frame {idx + 1}: meta_ms={meta_ms:.1f} ms, usage={usage}")

    tasks = [worker(i, frame) for i, frame in enumerate(frames)]
    await asyncio.gather(*tasks)
    return latencies


def calc_stats(times: list[float]) -> tuple[float, float]:
    times_sorted = sorted(times)
    median = statistics.median(times_sorted)
    # p95 index: int(0.95 * len)
    p95_idx = min(len(times_sorted) - 1, int(round(0.95 * (len(times_sorted) - 1))))
    p95 = times_sorted[p95_idx]
    return round(median, 1), round(p95, 1)


async def main() -> None:
    frames = [make_test_frame(i) for i in range(20)]

    l1 = await run_inflight_1(frames)
    med1, p95_1 = calc_stats(l1)

    l2 = await run_inflight_2(frames)
    med2, p95_2 = calc_stats(l2)

    print("\n" + "=" * 50)
    print("BENCHMARK RESULTS (Meta API latency ms)")
    print("=" * 50)
    print(f"In-flight 1 (20 frames): Median = {med1} ms, p95 = {p95_1} ms")
    print(f"In-flight 2 (20 frames): Median = {med2} ms, p95 = {p95_2} ms")
    print("=" * 50)


if __name__ == "__main__":
    asyncio.run(main())

