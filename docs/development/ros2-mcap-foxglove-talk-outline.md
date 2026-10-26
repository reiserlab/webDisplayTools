# ROS 2, MCAP and Foxglove for the arena rigs: talk outline

Draft 2026-10-21, to expand into a 4-slide deck with 3 live dashboard demos (LAB-303).
Suggested timing: about 10 min of slides, 10 min of demos, then discussion.

Numbers marked **measured** come from our own runs (`rig/README.md`, the ww18 and Oct 16
results). Numbers marked **verify** are general claims to check, or measure, before the talk.

---

## Slide 1: ROS 2 basics, and why it fits our rigs

**Core ideas (one line each)**
- **Node:** one process per job (a device adapter, the recorder, a viewer).
- **Topic:** publish/subscribe stream. Publishers don't know who listens, and any number of
  subscribers can join.
- **Service / action:** request-reply, and long-running requests with feedback.
- **QoS:** reliable vs best-effort, history depth.
- **Discovery:** nodes find each other with no central address book.
- **Messages:** typed `.msg` definitions, or anything (our PoC sends `std_msgs/String` with JSON).
- **Tools included:** `ros2 topic list | echo | hz`, `rqt_graph`, `rosbag2` record/play,
  `foxglove_bridge`.

**What it's good for**
- Many devices, each at its own rate, each in its own process. A device crash doesn't take down
  the run (**measured:** bridge killed mid-run, bag recovered automatically).
- One recorder sees every stream on one clock.
- Language-neutral: Python and C++ nodes, plus MATLAB's ROS Toolbox (**verify**: version and
  MCAP support).
- The same graph spans several machines (2P PC + stimulus PC).

**What it's not for**
- Hard real-time: display timing stays on the G6 controller.
- Browsers: Studio talks to `bridge_node` over `ws://localhost:8765` and stays unmodified.
- Small installs: 1.0–1.7 GB environment, but `pixi install` takes 25 s on the Mac (**measured**).

**In our rigs (diagram, built from `rig/` and `docs/img/rqt_graph_live.png`)**
```
FicTrac ──UDP──▶ fictrac_udp_adapter ─┐
Kinefly ──UDP──▶ kinefly_udp_adapter ─┤
BIAS ◀──HTTP──▶ bias_node ────────────┼──▶ bridge_node ◀──WebSocket──▶ Arena Studio (unmodified)
ScanImage ◀─JSON/ZMQ─▶ scanimage_node ┤        │
SiPM controller ──▶ sipm node (#266) ─┘        ├──▶ recorder ──▶ <run>.bag/ (MCAP)
                                               └──▶ viz_node / stimulus_node ──▶ foxglove_bridge :8766
```

**Micro-demo (30 s):** `pixi run rig -- --sim --bias --bias-sim`, then `pixi run graph`
(or `rqt_graph`) and `ros2 topic hz /fictrac/raw`.

---

## Slide 2: How fast? Zenoh, and when shared memory matters

**Why Zenoh (`rmw_zenoh`) and not the default DDS:** no multicast discovery, which is fragile on
lab and Windows networks. Instead there is one small router per host, used only for discovery.
**Measured:** killing the router mid-run caused no data gap, because peers keep their direct links.

**A ladder of transports (fastest first)**

| level | how | latency / cost | use it for |
|---|---|---|---|
| L0 in-process | composable nodes in one process; true zero-copy in C++ only | µs (**verify**) | not needed today |
| L1 same host, Zenoh shared memory | payload written once into a shared 48 MiB pool that both processes map | **measured** about half the median latency of L2 for MB frames on Mac and Windows; on Windows it also cuts p99 from 26–67 ms to 3–14 ms (table below) | MB-sized frames at video rates |
| L2 same host, Zenoh over TCP loopback (**our default today**) | serialize, then copy through the kernel | **measured** adapter→bridge p50 0.9 ms / p99 1.4 ms (Mac), 1.7 / 3.8 ms (Linux container), flat over a 60-min soak | everything we send now: FicTrac about 100 Hz, arena commands, status, 128² previews |
| L3 across hosts | Zenoh peers/router over the LAN | + network hop (**unmeasured**) | Bergamo 2P PC ↔ stimulus PC |
| L4 not ROS at all | the device writes its own file (BIAS `.ufmf`, ScanImage TIFF) | none on the graph | full-resolution pixels (see slide 4) |

**What the data rates actually are**
- FicTrac: about 100 Hz × 25 columns. Tiny.
- ScanImage: 512×512×2 ch int16 = 1 MB per frame. At an assumed 30 Hz that is about 30 MB/s,
  about 108 GB/h.
- BIAS: 2 MP mono at 135 fps (ww18 Atlas10 rate; **verify** resolution) is about 280 MB/s raw.

**Shared memory in practice**
- Our environment already supports it: zenoh-c 1.9.0 and rmw_zenoh 0.2.10 are both built with it.
  It is switched off only in our config (`transport.shared_memory.enabled: false` in
  `config/zenoh-session.json5`, commented by ROS as "disabled until fully tested").
- To turn it on, set `ZENOH_CONFIG_OVERRIDE=transport/shared_memory/enabled=true` for both the
  publisher and the subscriber. It works on the same host only.
- Defaults: a 48 MiB pool (`ZENOH_SHM_ALLOC_SIZE`). Messages ≥ 512 B use shared memory
  (`ZENOH_SHM_MESSAGE_SIZE_THRESHOLD`; Zenoh's own default is 3 kB).
- With Python (`rclpy`) the message is still converted and serialized into the pool, and the
  subscriber still copies it out. Shared memory removes the transport copies, not those, which is
  why the latency halves rather than going flat.

**Measured on the Mac and on a rig PC (2026-10-21)**

Setup:
- Benchmark: `shm_bench.py`. One publisher process and one subscriber process exchanging
  `sensor_msgs/Image` over rmw_zenoh, reliable, depth 10, 8 s per cell. Both are Python
  (`rclpy`), like our nodes.
- Machines:
  - Mac: MacBook Pro M5 Max on battery.
  - ww18: Core Ultra 9 285K, 64 GB, Windows 11 25H2, Balanced power plan.
- Proof that shared memory was used: with it on, each process maps about 49 MB more (Mac
  48K → 49.3M; ww18 8.7M → 58.0M), which is the Zenoh pool.

Median latency (p99 in brackets for ww18), shared memory off → on. Where two values are given,
they are two runs.

| message | rate | Mac | ww18 | lost on ww18, off → on |
|---|---|---|---|---|
| 1 kB (FicTrac row) | 100 Hz | 0.40 → 0.38 ms | 0.34 → 0.35 ms (0.7 → 0.7) | 0 → 0 |
| 64 kB (preview) | 100 Hz | 0.47 → 0.39 ms | 0.45 → 0.42 ms (0.8 → 0.9) | 0 → 0 |
| 1 MB (2P frame) | 30 Hz | 1.5–1.7 → 0.9–1.0 ms | 3.6 → 1.6–1.9 ms (**26–27 → 3–4**) | 0 → 0 |
| 2 MB (2 MP camera) | 30 Hz | 3.1 → 2.1 ms | 5.9 → 3.5 ms (**32 → 6**) | 0 → 0 |
| 8 MB | 30 Hz | 6.3–6.7 → 3.9–4.0 ms | 20–23 → 11–12 ms (**64–67 → 14**) | 4 of 240 → 0 |
| 2 MB at BIAS rate | 135 Hz | 2.1–2.2 → 1.4 ms | 5.1–5.8 → 3.0–3.6 ms (**30–31 → 6–7**) ¹ | 6 of 1080 → 0 |
| 8 MB (stress) | 100 Hz | n/a | 21 → 11.5 ms (62 → 19) ¹ | 39 of 500 → 0 |
| 8 MB (stress) | 200 Hz | 3.7 → 1.9 ms, no loss | saturated both ways ¹ | 53 → 74 of 1000 |

¹ On ww18 the publisher was paced with the 15.6 ms Windows tick (since fixed in the script), so
rows above about 60 Hz bunch publishes and may read high. The 30 Hz rows are clean.

Takeaways:
- **Small messages** (FicTrac, commands, status, previews): 0.35–0.45 ms on both machines, and
  shared memory makes no difference. Leave it off for them.
- **Camera-sized frames:** shared memory halves the median on both machines.
- **On Windows the bigger win is the tail.** With shared memory off, 1 in 20 MB-sized messages
  takes over 20 ms, p99 is 26–67 ms, and a few frames are lost at camera rates. With it on, p99 is
  3–14 ms and nothing is lost.
- **The ceiling is the Python subscriber, not the transport.** With shared memory on, ww18 still
  spends about 8–10 ms of subscriber CPU per 8 MB message (Mac about 2.3 ms). At 8 MB × 200 Hz one
  Python subscriber saturates.
- **For the hybrid question:** if full-rate camera frames ever cross the graph on a rig PC, shared
  memory is required, and probably a C++ subscriber as well. Otherwise the frames stay in BIAS's
  own file (slide 4).
- **C++ recorder on ww18 (rosbag2 writing MCAP, 2026-10-22), shared memory off → on:**
  - 2 MB at 135 Hz: 1.3 → 0.12 ms median, p99 25 → 0.2 ms, lost 4–31 → 0.
  - 8 MB at 30 Hz: 5.4 → 0.19 ms median.
  - The recorder spends about 1.1 ms of CPU per MB.
  - The 2–3× gap to the Mac came from the Python subscriber, not from Windows or Zenoh.

**In practice (the slide's callout)**
- Through ROS: about 1 ms or less. Events, FicTrac rows, status and previews take 0.35–0.45 ms.
- Large data stays in its native format (TIFF, .ufmf). The graph carries timestamps, losses and a
  preview.
- If frames must cross the graph: shared memory and a C++ subscriber.
- Without shared memory, Windows drops frames and has a 25–67 ms tail.

**Bergamo 2P PC (i5-14600K, 2026-10-22)**
- The same pattern as ww18, about 1.8× faster on the Python path.
- The C++ recorder handled 2 MB at 135 Hz in 0.99 → 0.12 ms, lost 13 → 0, using about 0.67 ms of
  CPU per MB.
- The ScanImage frame path against real ScanImage on a simulated vDAQ:
  - 1745 of 1745 frames reached the node, at 2–4 % of a core;
  - a 10 s stall cost MATLAB 265 MB, recovered in 1 s, and lost nothing;
  - a subscriber that joins late misses the frames already sent, so start the node before Grab.

**Micro-demo:** `pixi run python shm_bench.py run --sizes 2097152 --rates 135` runs live in about
25 s and prints the off and on rows next to each other.

---

## Slide 3: MCAP to record, Foxglove to look (live and offline)

**MCAP: what**
- An open, self-describing log container.
- Every channel carries its schema (ROS 2 `.msg`, JSON Schema, Protobuf…).
- Chunked, zstd-compressed and indexed for seeking.
- Libraries in Python, C++, TypeScript, Go and Rust, so no ROS is needed to read it.
- rosbag2's default storage format since ROS 2 Iron.

**MCAP: why for us**
- One file per run with every stream on one PC clock: what devices said, and when we heard it.
- Crash-safe while open, indexed when closed.
  - **Measured:** our crash-safe profile loses about one record when killed, while rosbag2's
    defaults lose the whole run.
  - Reindexing at close took the bench bag from 6.76 to 2.33 MB in 0.18 s.
- A migration path without breaking readers. A pure-Python converter turns the bag into today's
  `behavior_v2` JSONL, byte-identical to the live writer. The JSONL is derived and transitional,
  and retires 2026-12-31 (LAB-309).
- Size: the 10-column FicTrac record is about 2× the gzipped JSONL (**measured**; it was 10–30×
  before the column work).

**Foxglove: what**
- One viewer for live data (`foxglove_bridge`, WebSocket :8766) and recorded data (open the
  `.mcap`).
- **The same layout works for both.**
- Layouts are JSON files in the repo.
- Panels we use: Plot, Image, 3D (arena cylinder `SceneUpdate`), State transitions, Indicators,
  Diagnostics, Raw messages.

**Foxglove: lessons learned**
- JSON-in-String topics can't be plotted. `pixi run fox-json` rewrites them with JSON schemas
  (the `.foxglove.mcap`).
- Derived topics (`/viz/*`, expected/observed display) come from `viz_node` / `stimulus_node`,
  live or rebuilt offline (the `.viz.mcap`).
- Several MCAPs open together: run + viz + camera sidecar.
- Licensing: we have used the free desktop app so far (**verify** the terms for lab-wide use).
  PlotJuggler and Rerun are the alternatives.

**Micro-demo:** `mcap info <run>.mcap` (channels, counts, schemas), then drag the same file into
Foxglove.

---

## Slide 4: Hybrid architecture. What goes on the graph, into the MCAP, and onto the dashboard?

**Proposal (current practice in `rig/`, open for discussion)**

| stream | rate × size | on the ROS graph | in the MCAP | on the dashboard |
|---|---|---|---|---|
| Arena commands + echoes, runner status, connector command/reply (BIAS, ScanImage) | events, < 1 kB | yes | yes, verbatim | condition / state strip, events |
| FicTrac | about 100 Hz | yes (`/fictrac/raw`) | 10 columns in one `/arena/frame` record (decided) | heading, idx, turning |
| Controller telemetry (`cc`/`cf`/`cs`) | about 10 Hz batches | yes | yes | observed display, lag, display rate |
| Device health (BIAS status, ScanImage `frame_stats`, SiPM) | 1–5 Hz | yes | yes | indicators, diagnostics |
| 2P frames (ScanImage) | about 30 MB/s | per-frame metadata + a bounded 128² preview (≤ 5 Hz) | metadata + loss accounting + preview; **pixels stay in the TIFF** | live preview; full replay via `tiff2mcap` |
| Camera frames (BIAS) | about 280 MB/s | no (frame timestamps at stop) | timestamps; **movie stays `.ufmf`** | replay sidecar (uFMF → 10 Hz JPEG); live needs a BIAS preview patch |
| Derived views (`/viz/*`, expected display, 3D scene) | n/a | live only | **no**: rebuilt offline by the same code | yes |

**Principles**
1. Record what the devices said and when the PC heard it. Don't record what you can recompute.
2. Large pixel data stays in the device's native file. The graph carries metadata, loss
   accounting and a bounded preview, and the two are joined offline by frame number and
   timestamp.
3. Every stream states its losses (ScanImage: gap / segment / `dropped_by_queue`).
4. One pure core runs both live and offline (`stimulus_core.py`, `viz_node`), so a dashboard
   looks the same on replay.
5. One clock story: the PC clock in the bag, the controller clock mapped by a fit, and the
   ScanImage `epoch` not trusted (**measured** 0.53–0.67 s ahead).

**Questions for the room**
- Is live analysis (online ROI ΔF/F, closed loop on imaging) worth bringing full-rate frames onto
  the graph over shared memory?
- Should previews be recorded, or rebuilt?
- Multi-host graph for Bergamo: one router per PC, or a shared one?
- Typed messages beyond `/arena/frame`?

---

## Demos: three dashboards

Interpretation: three dashboards, each arena + one device. Dashboard 2 uses a run that also has
FicTrac, so it can show all three together if we want the cumulative version.

| # | dashboard | recorded data (ready) | layout | live option | status / gap |
|---|---|---|---|---|---|
| D1 | **Arena + FicTrac** | ww18 run `arena-log-20261015-152501-050`: real FicTrac about 96 Hz, G6 2×10, two closed-loop epochs (no bias, then constant 90°), 103 s. Files `.foxglove.mcap` + `.viz.mcap` | `layouts/arena-fictrac.json` | `pixi run rig -- --sim --foxglove` + Studio on localhost (sim FicTrac) | Recorded data: **ready**, every layout topic is present in the MCAPs. Live: rehearse on the Mac |
| D2 | **Arena + BIAS** | same run, BIAS Atlas10 at 135 fps: rate, drops, rtt, writer queue | `layouts/arena-bias.json` | `pixi run rig -- --no-fictrac --bias-sim --bias --foxglove` (sim BIAS, no images) | Health dashboard: **ready**. The **camera image is a gap**: the okey-cokey layout (`foxglove/arena-okey-cokey.json`, camera + expected/observed arena) needs one bag + `.ufmf` pair through `pixi run fox-json -- <bag> <out> --stimulus`. None is on this Mac (the ww18 movies stayed on ww18), and that layout has never been opened in Foxglove |
| D3 | **Arena + ScanImage** | Oct 16 Bergamo 2P color sweep: `oct16_color_sweep.mcap` (82 MB, 121 s): ch2/ch3 previews, arena display, 3D arena, qc trace, events, provenance | `foxglove-oct16.json` | frames node against the ZMQ mock publisher (PR [#261](https://github.com/reiserlab/webDisplayTools/pull/261)): live preview + loss stats | Recorded data: **ready**. The stimulus track is RECONSTRUCTED (no run log on the Mac); with the Bergamo run log it becomes COMMANDED. Live: mock only |

**Where the files are** (Dropbox `ClaudeCoworkProject/`)
- D1/D2: `arena-bags/ros2-poc-ww18-2026-10-15/{mcap,layouts}/`
- D3: `Bergamo_testing/Oct16/` (run 2 is in `foxglove/`)

**Opening a recording:** in Foxglove.app (installed), Open local file → select the MCAP(s) →
Layout → Import from file.

**Prep checklist**
1. D1/D2: open both MCAPs for run 152501 with each layout and screenshot each one for the deck.
2. D2 camera: get one bag + uFMF pair and build the replay MCAP. Candidates: today's okey-cokey
   run on the G6 rig, or ww18 run `160327-867` (BIAS only, 1,087 frames, movie on ww18). Then
   open `arena-okey-cokey.json` in Foxglove for the first time.
3. D3 (optional): pull the Bergamo run log and rebuild with `--runlog`, so the stimulus track is
   commanded rather than reconstructed.
4. Slide 2: the shared-memory benchmark has run on the Mac and on ww18 (results above; the ww18
   JSON files are untracked in its `rig` folder). Optional: re-run the 135 Hz and stress
   rows on ww18 with the fixed pacing.
5. Live fallback: if the live rig misbehaves, every demo has a recorded version.
