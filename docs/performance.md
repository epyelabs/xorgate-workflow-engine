# Performance

Honest per-host numbers from the M3–M5 golden runs (2026-08-31). The engine is
CPU-only ONNX by decision; **sampled/batch graphs are the target** — this is a
"process a drive at 2 fps" engine, not a real-time 30 fps pipeline, and the
numbers below are exactly good enough for that.

## The measured runs

Fixtures: the 25 s / 50-frame 720p highway clip + 150-sample GPS window
(`fixtures/`), yolov8n (detection, 640×640).

| Golden run | MacBook (Apple Silicon, bare node) | Same, in docker (arm64) | CM5 4 GB (Pi 5 silicon, bare node) |
|---|---|---|---|
| overspeed (telemetry-only, 150 samples) | < 0.1 s | < 0.1 s | 0.3 s |
| perimeter (50 frames → yolov8n → gate) | 4.1 s cold / 1.8 s warm | ~5 s | 14.4 s |
| visualize + `--emit-video` (adds overlays + h264 mux) | 3.8 s | 4.7 s | 24.4 s |
| yolov8n inference per frame | ~29–41 ms | ~75 ms | ~250 ms |
| effective fps through the model node | ~25+ fps | ~13 fps | **~2.4 fps** |

CM5 details (instrumented `--emit-video` run):

- Step wall times: decode 11.3 s, detection 20.9 s end-of-stream (the
  downstream gate/viz/event steps finish with the same pipeline, ~21 s).
- **Peak RSS 408 MB** — comfortable on a 4 GB device.
- SoC temperature 60.9 °C → 69.2 °C across the full 45 s suite, no throttling.
- Measured with the xorgate device agent LIVE on the same device (a busier
  environment than a dedicated runner would be).
- `npm test` (all 25 checks, three full runs + probes): 45 s total.

## What this means for graph design

- A 2 fps sampled detection graph runs at ~0.8× real time on the CM5/Pi 5
  class (25 s of video in ~21 s) — batch processing of drives is practical
  on-device; live 2 fps would be borderline and anything faster needs the
  laptop/cloud class.
- Telemetry-only graphs are effectively free everywhere.
- The h264 mux (`--emit-video`) adds ~10 s for 50 frames on the CM5 (system
  ffmpeg, software x264) — fine for batch, skip it when only records matter.
- Determinism held across all three hosts: identical detection count (81),
  identical pinned overspeed event. Counts are asserted with tolerance anyway
  (float variance is possible on other hardware).

## Reproducing

```
# laptop
npm ci && npm test

# Pi/CM5 (bare node 20 + system ffmpeg; docker works too if installed)
tar czf - package.json package-lock.json tsconfig.json src scripts fixtures \
  | ssh <pi> 'mkdir -p ~/xwe && tar xzf - -C ~/xwe'
ssh <pi> 'cd ~/xwe && npm ci && npm test'
```
