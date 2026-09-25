# Per-trial closed-loop start position (`start_frame`) and the epoch gate

Branch `feat/start-frame-sbd` — Shubham Rathore (rig03-sr) with Claude, 2026-09-21 → 2026-09-24.
This note is the "why" for the branch; the "what" is in the commit messages and the release notes.

## The experiment that needs it

The SBD visual place-learning protocol (`cshl-2026-course/protocols/rig03-sr/p3-sbd-placelearning-led5.yaml`,
pattern `p3_sbd_placelearning`, SD ID 46) is a port of the G4.1 MATLAB protocol `p058.m`
(Ofstad / Florence place learning): a bars | stripes | diagonal panorama, a 90° safe zone on the
bars/stripes seam where the heat LED is off, 15° intensity ramps outside both zone edges, and — the
part this branch is about — **every closed-loop trial starts with the fly a fixed 90° outside the
nearest zone edge, alternating sides** (p058 `START_OFFSET_DEG = 90`, `altSign` = + − + − …). The
start position is part of the design: every trial begins at full heat with the same escape distance,
so the time-to-zone and the side of approach are comparable across bouts and across flies.

## Why `frame_index` alone cannot do it since bridge 3.3

Bridge 3.3 (Studio v0.85, PR #211) re-tares the heading at every `startClosedLoop` (`epoch: true`):
the fly's turn since the tare is zero, so the epoch opens on

    idx = round((coupling · 0 + offset + bias) / deg_per_frame) mod n_frames = round(offset / pitch)

which, with the plugin config's `offset: 0`, is **frame 0** — whatever the Mode-3 `trialParams`
`frame_index` said. The display shows `frame_index` only until the first FicTrac frame arrives.

Evidence — run `2zo017ag` (2026-09-23, SBD protocol from the Pages Studio v0.86): all 22 epochs
opened on idx 0; frame 0 is *inside* the SBD safe zone, so every trial began in the cool region with
the LED off, the opposite of the design. The first LED-on of every bout came at index 9, when the
fly walked out. (`docs/development/sbd-place-learning-handoff-2026-09-23.md` has the log excerpts.)

Before 3.3 the same protocol would have opened wherever the fly's absolute heading happened to map,
i.e. randomly — also not what p058 does. So a per-trial start position never existed on the web
path; the tare just made the absence deterministic.

## What the branch adds

### 1. `startClosedLoop params.start_frame` → bridge `offset` (commit 41efa9d)

The tare gives us a clean anchor: after it, `offset` alone decides the opening frame. So the smallest
correct change is to let the protocol set `offset` per epoch, in frame units:

| layer | change |
|---|---|
| YAML | `startClosedLoop` → `params: { coupling: -1, start_frame: 57 }` (0-based; the trial's `frame_index` is set to the same anchor so the display shows it before the first frame) |
| runner (`js/arena-runner-g6.js`) | IR `startFrame` (integer ≥ 0, else the step fails with a message); pushed as `cfg.start_frame` in the SAME config message as coupling / frames / epoch |
| client (`js/fictrac-bridge-client.js`) | `setConfig` treats `start_frame` as a ONE-SHOT: sent with that push only, never stored, so a later plain `sendConfig()` cannot re-open a running epoch |
| bridge (`bridge.py`) | `config.start_frame` → `Pipeline.start_frame_to_offset()`: `offset = (start_frame mod n_frames) × deg_per_frame`, applied after `deg_per_frame`/`frames` from the same message |

Coupling sign does not matter (offset is outside the coupling). An older bridge ignores the key
and behaves as before (opens on frame 0). Nothing changes for protocols that don't use it.

Alternatives considered: shifted pattern copies (the Heisenberg phase-0/phase-90 trick) swap the
panorama but cannot place the fly; a bridge-side "tare to index" needs the heading first and is the
same thing under another name; setting `offset` in degrees from the YAML would make authors do the
pitch arithmetic. Frames are what every other field (`frame_index`, `on_ranges`, zones) already use.

### 2. Epoch-stamped frames + client gate (commit 00022b0, bridge 3.4)

Verification runs (`knqkkyi3`, `ueykyxxz`) showed the start frame working in 41 of 44 epochs. The
misses were a race that predates this branch: the runner pushes `{epoch:true}` and turns apply on; a
frame the bridge computed *just before* it processed that config can arrive afterwards and was
applied — a stale index for one frame period at closed-loop start (`ueykyxxz` bouts 14 and 21:
frames 25 and 10 applied 5–9 ms before the tare). With a per-trial start position this became
visible; before, the opening frame was arbitrary anyway.

Fix: the bridge stamps every frame message with `epoch` (+1 each time a tare fires, also on the
`heading_tare` log event); after requesting an epoch the client withholds frames still carrying the
previous id until the first post-tare frame (or 1 s), counted in `stats.stale` and shown in the Run
view bridge row as `stale N`. Frames without the stamp (older bridge) are never gated.

### 3. Also on the branch

- `feat/led-activation` events for lit-baseline / lit-teardown trials went to **main** directly
  (e2d3783, Studio v0.87, Michael's OK on Slack 2026-09-23) — not part of this branch.
- `docs/development/sbd-place-learning-handoff-2026-09-23.md`: rig-side state and evidence.
- Release notes: the v0.89 entry; the protocol-yaml skill and the bridge README document the
  YAML shape and the wire schema (`start_frame`, `epoch`).

## Tests

- `tests/test-arena-runner-g6.js`: IR (`start_frame` int / string / non-integer / negative), config
  push carries `start_frame` with `epoch`, stopClosedLoop carries none.
- `tests/test-fictrac-bridge-client.js`: one-shot semantics; epoch gate (withhold / open / old bridge).
- `tests/test-bridge-behavior.py`: `start_frame_to_offset` (coupling ±1, wrap), epoch counter + stamp.
- Whole suite green except the pre-existing Windows CRLF fixture failure (N9 rollback) that reproduces on
  a clean checkout.

## Bench evidence (rig03-sr, fw #56 781efe2, bridge 3.4)

| run | Studio | start frames | notes |
|---|---|---|---|
| `2zo017ag` 09-23 | Pages v0.86 (no start_frame) | all 22 epochs on **0** | motivates the feature |
| `knqkkyi3` 09-23 | local v0.87 + branch | 21/22 on 57/108 | 1 stale-frame race → epoch gate |
| `ueykyxxz` 09-24 | local, bridge 3.4, **cached old client** | 20/22 on 57/108 | 2 stale frames applied — the page had not been hard-refreshed, gate code not loaded |
| next run | local, refreshed | expected 22/22, `stale ≥ 0` shown | |

Behaviour in both full runs: training-bout occupancy of the LED-off zone 71–79 % (chance 25 %);
LED ramps 1 → 5 % over frames 8–16 and 150–158 as designed.

## Open questions for review

1. Version numbering: rebased onto main at v0.88 on 2026-09-24; this PR is labelled **Studio v0.89 /
   bridge 3.4** (footer, release notes, skill). Renumber freely if something else lands first.
2. Should `stopClosedLoop` reset `offset` to 0 so a following trial *without* `start_frame` opens on
   frame 0 rather than on the previous trial's start? Today it keeps the last value (the Studio
   re-pushes the plugin-config offset at run start, so runs never inherit from each other).
3. `deg_per_frame` on the bridge is the rig pitch (1.8°); `start_frame` assumes one frame = one pixel
   column, like every other frame-unit field.
