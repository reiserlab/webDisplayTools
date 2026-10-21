# Plan: a purpose-built Foxglove dashboard for the okey-cokey rig (camera + G6, no FicTrac)

Status: PLAN, 2026-10-21. Nothing built. Part of LAB-303 (ROS 2 graph); ticket to be filed.

## Goal

One Foxglove layout for a freely-walking-fly rig (overhead BIAS camera + G6 2×10 four-color arena, no
FicTrac) showing three things:

1. **The camera.**
2. **The expected display**: what the arena should be showing right now (pattern, frame, color, duty),
   rendered as an image of the unrolled arena.
3. **Health and rate** for the arena and for BIAS: is each one alive, at what rate, and has anything
   dropped.

The same layout should work **live** (foxglove_bridge during the run) and on **replay** (the run's MCAP
afterwards).

## What exists today (release 2026-10-20, `ros2-poc/`)

| Need | Today | Gap |
|---|---|---|
| BIAS health | `/bias/status` at 5 Hz (`bias_node.py`): reachable, capturing, logging, frameCount, framesPerSec, rtt_ms; on Atlas10 also frameIdGaps, cameraSkipped, loggerSkipped, writerSkipped, logQueueSize. `viz_node` turns these into `/viz/bias/*` and a `bias` entry in `/diagnostics`. `foxglove/arena-bias.json` shows them. | Mostly there. Missing: a rate from the frameCount slope (independent of BIAS's own estimate) and the drop counters on a plot. |
| Arena health | `viz_node`'s `arena` entry is fed only by `/arena/frame`, which only FicTrac lines produce. | **Always "never seen" on this rig.** |
| What the arena is doing | Every Studio message (trialParams `a` echoes, runner status events with `conditionName` / `params` / `durationSec`, controller telemetry `cc`/`cf`/`cs` row batches) reaches `bridge_node`. | It is **written to the bag only** (`/arena/browser`, `/arena/event` via `rec.write_raw`), never published, so nothing live can subscribe. The `a` hex is truncated to 8 bytes (no gain/duration). |
| Expected display image | `tools/patfile.py` reads `.pat`; `tools/tiff_run_to_mcap.py` already renders `/arena/display` as a `foxglove.CompressedImage` (200×40, upscaled, labeled RECONSTRUCTED). | Offline only, and wired to the 2P color-sweep file names and DO1 timing. Monochrome. |
| Camera image | Nothing. BIAS's HTTP API has no frame grab (only status, timestamps, frame count, video file). | **No live frames anywhere.** After the run, the `.ufmf` plus the per-frame stamps on `/bias/frames` (recorded at stopRecording) are enough to rebuild a timed image stream. |

## Design

### A. Make the arena's activity a live topic (bridge_node, small)

`bridge_node` publishes what it already records:

- `/arena/browser`: String JSON, verbatim, the same record it writes to the bag (QoS reliable, depth 50).
  It stays in the bag as now.

That one change lets any node watch the run without touching the Studio or bridge 3.4.

### B. `stimulus_node.py`: expected display + arena health (new node, the core of the work)

It subscribes to `/arena/browser` and keeps the current stimulus state:

- From runner status events and the trialParams echoes: condition name, pattern name, mode, frame
  rate, start frame, duty, and the trial start time (the echo's `ms`, i.e. when the command left the
  browser).
- Expected frame for Mode 2: `idx = (init + round(fps · (t − t_start))) mod n_frames`. `allOff` = dark.
  Mode 3 is out of scope here (it needs FicTrac).
- Observed frame: telemetry `cf` rows carry the frame the controller actually put up (idx + pattern
  per frame change). Arrival is in ~10 Hz batches, so the observed stream lags by ~100 ms, but each row
  has its own controller timestamp.

It publishes:

| Topic | Type | Rate | What |
|---|---|---|---|
| `/arena/stimulus` | String JSON (later typed) | on change | `{condition, pattern, mode, fps, init, duty, t_start}` |
| `/arena/display` | `foxglove.CompressedImage` (PNG) | 10–15 Hz | the expected display: unrolled 200×40, ×4 upscale, top row = top |
| `/viz/arena/expected_idx`, `/viz/arena/observed_idx` | Float64 | 10–15 Hz / per row | for one plot of the two indices together |
| `/viz/arena/display_rate_hz` | Float64 | 1 Hz | frame changes per second from `cf` rows; should equal \|fps\| (80) during a trial and 0 in the dark |
| `/viz/arena/lag_frames` | Float64 | 1 Hz | expected − observed (mod n), the "is the arena keeping up" number |
| `/diagnostics` entry `arena` | DiagnosticStatus | 1 Hz | OK / WARN (rate off by > 5 %, lag > 2 frames, a `display_gap` or flagged `trial_quality`) / STALE (no telemetry for > 2 s while a run is open) / ERROR (non-ok command status) |

**Color, not green.** The four-color panels light one bank per pattern, so a green ramp would show the
wrong thing. Port the minimum of `js/panel-color.js` to Python (the layout table, and
`bankAt(row, col) = 2·((row+1)%2) + (col%2)` in host coordinates), and pin it to the JS module with a
test. Duty scales the brightness. Without that test, the two copies will drift.

**Patterns.** The node needs the `.pat` files. It looks them up by name under a `--pattern-dir` (the
protocol's `*_patterns/` folder) and caches them. If a pattern is missing, the image shows the name on
a gray placeholder; the run is never refused.

**If the firmware has no telemetry** (GET_FIRMWARE_VERSION flag bit 2 off, or the poller is off), there
are no `cf` rows: show the expected display only, observed = "unknown", and arena health from command
status alone. It must never claim "OK" without evidence (the same rule as `trial-quality.js`).

### C. BIAS health additions (viz_node, small)

- `/viz/bias/fps_from_count`: frameCount slope over the last 2 s of 5 Hz polls, next to BIAS's own
  `framesPerSec`.
- `/viz/bias/drops`: the sum of the Atlas10 counters (frameIdGaps + cameraSkipped + loggerSkipped +
  writerSkipped) as a plot; WARN on any increase while logging. Absent keys (Spinnaker build) mean
  "not reported", not 0.
- `/viz/bias/rtt_ms` from the status polls; WARN at > 100 ms.

### D. Camera

- **Replay (phase 2).** `ufmf_to_mcap.py` reads the run's `.ufmf` and writes a sidecar MCAP with
  `/camera/image` as `foxglove.CompressedImage` JPEG, timed by the `/bias/frames` stamps from the run
  bag, downsampled (for example 10 Hz, half resolution) so the file stays small. Foxglove opens the run
  bag and the sidecar together. uFMF needs a reader: write a small one (the format is documented, and
  motmot's reader is Python 2-era), and test it on a ww18 recording.
- **Live (phase 3, only if wanted).** BIAS has to push frames out: a small BIAS patch (in our
  atlas-bench fork) publishing a rate-limited JPEG preview over ZMQ. A node then mirrors it as
  `/camera/image`, copying `scanimage_frames_node.py` (rate limit + loss stats). Until then, keep the
  BIAS window beside Foxglove during the run.

### E. The layout: `foxglove/arena-okey-cokey.json`

```
┌──────────────────────────────┬─────────────────────────────────────┐
│ Image /camera/image          │ Image /arena/display (expected)     │
│ (replay; live after phase 3) │ caption: condition · pattern · duty │
├──────────────┬───────────────┼─────────────────────────────────────┤
│ Indicators   │ Plot: BIAS fps (own + from count), drops            │
│ BIAS reach/  ├─────────────────────────────────────────────────────┤
│ capture/log; │ Plot: arena expected vs observed idx; display rate  │
│ arena state  ├─────────────────────────────────────────────────────┤
│              │ StateTransitions: /arena/stimulus condition         │
├──────────────┴──────────────────┬──────────────────────────────────┤
│ DiagnosticSummary (/diagnostics)│ RawMessages /bias/reply          │
└─────────────────────────────────┴──────────────────────────────────┘
```

### F. Replay parity

The derived topics (B, C) do not exist in bags recorded before this work, and live ones are not
recorded unless we choose to. Do both:

- Record `/arena/stimulus` live (it is small). Do not record `/arena/display`: it is rebuilt from
  stimulus + patterns.
- Extend `nodes/foxglove_json.py` (the offline converter) to run the same `stimulus_node` logic over
  the bag's `/arena/browser` records and emit `/arena/display` and the `/viz/arena/*` topics. Then the
  layout works on any run, including today's.

The logic lives in one pure module (`nodes/stimulus_core.py`) used both by the live node and by the
converter, the same split as `studio-replay.js`.

## Phases and size

| Phase | What | Size | Gate |
|---|---|---|---|
| 1 | A + B (no color port yet) + C + layout; harness test with the Studio emulator sending trialParams + `cf` rows | ~1 day | live on the Mac bench with the 2×10 arena |
| 1b | Python color port + test pinned to `js/panel-color.js` | ~2 h | the four banks show their colors |
| 2 | F (offline converter) + D replay (uFMF reader → sidecar MCAP) | ~1 day | today's okey-cokey run opens with camera + expected display in sync |
| 3 | D live (BIAS ZMQ preview patch + node) | ~1–2 days, BIAS C++ | only if a live camera in Foxglove is worth more than the BIAS window |

## Open questions

1. **Is a live camera in Foxglove needed, or is replay enough?** This decides whether phase 3 exists.
2. **Does the okey-cokey controller run telemetry-capable firmware?** (0xCB flag bit 2.) Without it,
   the observed index and display rate are unavailable and arena health falls back to command status.
3. Which BIAS build is on the okey-cokey PC: the Atlas10 fork has the drop counters, the Spinnaker
   build may not.
4. Typed messages: `viz_node` subscribes to `/arena/frame` as String, which breaks in the `typed` env.
   That doesn't affect this rig (no `/arena/frame`), but fix it when touching viz_node.
