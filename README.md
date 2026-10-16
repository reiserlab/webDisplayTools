# ROS 2 PoC run data — reiserlab-ww18, 2026-10-15 (for Foxglove dashboard testing)

**Data-only branch.** It has no code history and must never be merged. Every fresh `git clone`
downloads it, so delete it when the dashboard testing is done:

```bash
git push origin --delete data/ros2-poc-ww18-2026-10-15
```

Five hardware runs from the LAB-303 Plan B Windows test on reiserlab-ww18:

- the CSHL G6 2×10 ball rig, with real FicTrac at about 96 Hz and the Atlas10 camera (BIAS) at 135 fps;
- run 5c on the four-color arena.

Every number and finding is in `ros2-poc/windows-results-ww18-2026-10-15.md` on branch
`claude/ros-studio-plan-b-c44942` (PR #254). The original bags, the converted `.jsonl` logs and
the videos stay on ww18.

| run (`mcap/<run>.*`) | step | what happened | length |
|---|---|---|---|
| `arena-log-20261015-152501-050` | 5.2 | Studio run `bias_camera_closed_loop_poc_ww18`: two closed-loop epochs (no bias, then a constant 90° bias), BIAS recording | 103 s |
| `arena-log-20261015-153548-287` | 5.7 | crash test: the bridge was hard-killed 10.4 s into the first loop, so the bag ends mid-record; everything up to the kill is here (1,162 frames) | 12 s |
| `arena-log-20261015-154452-578` | soak | `bias_camera_closed_loop_poc_ww18_soak10`: 2 × 300 s closed loop | 611 s |
| `arena-log-20261015-155617-614` | 5c | `g6_color_optomotor_smoke` on the four-color arena (open loop, 8 trials, each color CW then CCW) | 127 s |
| `arena-log-20261015-160327-867` | B2 | BIAS only: one 8 s recording; `/bias/frames` carries the timestamps of all 1,087 camera frames | 24 s |

There was no Kinefly on any of these runs.

## Two files per run

**`<run>.foxglove.mcap`: the run itself, made plottable.** The rig recorded every topic as
`std_msgs/String` holding JSON text, which Foxglove can't plot. This file carries the same
messages on the same topics with the same log and publish times, stored as MCAP JSON messages
with a JSON Schema per topic. So `/arena/frame.idx`, `/bias/status.framesPerSec` and similar paths
plot directly. It also adds a few fields:

- `/arena/frame` gets `bias_deg`, `turning_dps` and `forward_mms`. They are computed the way the
  typed `ArenaFrame` message computes them: the `bridge_node.FrameDeriver` math on a 9 mm ball,
  `null` where the typed message would have NaN. These are the only fields the recording doesn't have.
- `/fictrac/raw` gets `cols`, FicTrac's 25 output columns by name (`heading`, `speed`, `forward`,
  `side`, `r_lab_x`…, `timestamp`), in place of the raw CSV text.
- `/arena/browser` gets `msg`, the parsed browser message, in place of the raw text.

Checked against each source bag: same message count per topic, same times, every recorded field equal.
Each schema field has exactly one `type`, because Foxglove rejects type unions. A field seen with
several types gets the widest one (string over number over boolean), and a field that was always
null is left out of the schema. The messages themselves are unchanged.

**`<run>.viz.mcap`: what PR #252's `viz_node` shows for that run.** This file holds the `/viz/*`
topics (std_msgs), `/diagnostics` and `/viz/markers` (the 3D scene) that the two new dashboards
read. `viz_node` is `ros2-poc/nodes/viz_node.py` at commit `2783662`, run with default arguments:
1.8° per frame, frame direction +1, feature azimuth 0 at index 0.

To make it, each bag was played back at 1× into `viz_node` and its outputs were recorded. Then
every output was moved back onto the run's own timeline:

- Each message that one input produces (FicTrac, arena index/azimuth/bias, BIAS state/frame count)
  carries the original receive time of that input. Checked: the index and heading values and times
  match the run exactly, with |Δt| = 0.
- The 3D markers (20 Hz), diagnostics and FicTrac rate are timer-driven. They carry the nearest
  frame's offset, which is within the playback's ±7 ms jitter.
- During playback `viz_node` missed a few frames, because its `/arena/frame` subscription keeps
  only 10: 15 of 9,969 in run 5.2, 17 of 58,918 in the soak and 8 of 12,226 in run 5c. The index
  points it did draw are matched to their frames by order and value. 3, 3 and 4 of them couldn't be
  matched and sit on a neighbouring frame.
- `turn_deg` starts at 0 at the start of each run.

## Opening a run in Foxglove

1. Download both files for a run, using the links below or a checkout of this branch.
2. In Foxglove, choose **Open local file(s)…** and select both files. Foxglove shows them on one timeline.
3. Use **Layout → Import from file…** with one of these:

| layout | from | reads |
|---|---|---|
| `layouts/arena-fictrac.json` | PR #252 | `.viz.mcap`: 3D arena (ball, fly, feature bar), "Closed loop: fly vs display", FicTrac kinematics, displayed index, diagnostics |
| `layouts/arena-bias.json` | PR #252 | `.viz.mcap` for the BIAS state and the frame count vs index; `.foxglove.mcap` for the BIAS replies (`/bias/reply`) |
| `layouts/foxglove-arena-layout.json` | PR #254 | `.foxglove.mcap` only: index, heading, turning and forward motion, bias, epochs, raw browser, event and BIAS views |

The layout files are byte-identical copies of the ones on their branches.

**Opening by URL instead of downloading.** Foxglove's web app can open a file straight from a URL:
`https://app.foxglove.dev/<workspace>/view?ds=remote-file&ds.url=<url>`. Repeat `ds.url` to open
several files. It needs a server that lets the browser see `Accept-Ranges`:

- `raw.githubusercontent.com` doesn't, so Foxglove reports that range requests aren't supported.
- jsDelivr does: `https://cdn.jsdelivr.net/gh/reiserlab/webDisplayTools@<commit>/mcap/<file>`. Use a
  commit hash rather than the branch name, because jsDelivr caches branch names for hours. But it
  sends browsers brotli-compressed bytes, so Foxglove sees the wrong file size and can't jump to the
  index. It falls back to reading the whole file in order ("This file is unindexed"). That works,
  just more slowly.
- jsDelivr serves files up to 20 MB only. That rules out the soak's `.foxglove.mcap`.

Downloading the files and opening them locally avoids both problems. The files are fully indexed:
chunk indexes, message indexes and summary offsets.

Each array field has an item type. An array that was always empty gets string items, because
Foxglove fails on an array schema without `items`.

**What the layouts show on this data.** `tools/check_layouts.py` resolves every panel's message
paths against a run's two files. On the four FicTrac runs every data panel resolves and has data.
These stay empty:

- **Last error** (`/viz/last_error`): `viz_node` only publishes it when something fails, and nothing did.
- **Log** (`RosOut`, `/rosout`): the rig's bags never recorded `/rosout`, so this panel only works live.
- **The B2 run**: it is a camera-only check with no FicTrac, so only the BIAS panels have data.

**Checked in Foxglove itself** (web app 3.4, 2026-10-16, runs 5.2 and the soak opened as local files):

- `arena-fictrac` draws everything:
  - the 3D arena: ball, fly, feature bar, and a readout of index, azimuth, heading and bias;
  - FicTrac "flowing" and a rate gauge at about 96 Hz;
  - the diagnostics: Kinefly never seen, arena and FicTrac at 96–97 Hz, BIAS idle or recording;
  - the closed-loop, kinematics and index plots.
- `arena-bias` draws the BIAS state band (recording, then idle), the frame-count plot, the
  reachable / capturing / logging indicators, the fps gauge and the `/bias/reply` view.
- `foxglove-arena-layout` draws the index, heading / bias / epoch, and the raw browser, event and BIAS views.
- The only warning is "Different profiles detected in data sources". The `.viz.mcap` has the
  `ros2` profile and the `.foxglove.mcap` has none. No panel was affected.

**Suggestions for PR #252's dashboards, from this data:**

1. **`viz_node` drops frames.** Its `/arena/frame` subscription keeps only 10 messages, and it lost
   15, 17 and 8 frames during playback. Its other subscriptions keep 200 (`RELIABLE_QOS`); this one should too.
2. **"Closed loop: fly vs display" can't show the display following the fly.** These runs used a
   grating that repeats every 20 frames, so `azimuth_deg` only covers 0–36°. Meanwhile the fly's
   turn reaches thousands of degrees, and the constant bias reaches 27,000° in the soak.
   - Publish an unwrapped display angle: the sum of the wrapped index steps × degrees per frame,
     with the frame count taken from the run's config.
   - Plot it against the turn, or give the bias its own panel.
3. **The kinematics plot has the wrong scales.** Speed (°/s) shares one axis with FicTrac's running
   forward and side totals (2,500–6,400 rad since FicTrac started), so the speed line is flattened.
   Plot forward and side as rates, or reset them each trial, in their own panel.
4. **The BIAS frame-count plot hides the index.** The frame count (thousands) shares an axis with
   the display index (0–20), so the index looks flat. Give each its own plot, or plot fps.
5. **The indicator labels are clipped** at a window about 1,370 px wide ("AS reach", "ot captu").
   Shorter labels or wider panels would fix it.
6. **The log panel stays empty offline**, because the bags don't record `/rosout`. Record it, or
   leave the panel out of replay layouts.
7. **The 3D feature bar can mislead with a grating.** It shows the phase within one period, not
   where a single feature is. It's right for a single-stripe pattern.

**For anyone writing JSON-schema MCAP for Foxglove** (both were bugs here, now fixed):

- Give every schema field exactly one `type`.
- Give every array an item type.

| file | 5.2 | 5.7 | soak | 5c | B2 | total |
|---|---|---|---|---|---|---|
| `.foxglove.mcap` | 3.6 MB | 0.5 MB | 24.6 MB | 4.3 MB | 0.02 MB | 33.1 MB |
| `.viz.mcap` | 2.9 MB | 0.4 MB | 17.3 MB | 3.6 MB | 0.09 MB | 24.3 MB |

## Provenance

| run | source bag sha256 (on ww18, `ros2-poc/runlogs/<run>.bag/<run>.bag_0.mcap`) |
|---|---|
| `arena-log-20261015-152501-050` | `14a4d6459e0bc58a5d467956b187abe4c1e9b2108aaf0f9675adb75c4ebf29a5` |
| `arena-log-20261015-153548-287` | `725f5bf3bedb1c000731160cf2962ac4fba470ee71af32524c7a9953c2c19055` |
| `arena-log-20261015-154452-578` | `1aa63e6928966ff5bd6680a121c404d6d200df7a3dceefa59cf5a154dd683d23` |
| `arena-log-20261015-155617-614` | `5f956b1e353661098364c57f5148a87b87f6640fd54a4cf4ad7a03149f5a7714` |
| `arena-log-20261015-160327-867` | `46877aed498d3a4c0dc6c28b99c82d3281d5e99827ff8fa7e5cbd4834954bf2b` |

Each output file also records its source, the `viz_node` commit and how its times were set, in an
MCAP metadata record (`foxglove_json` or `viz_replay`; run `mcap info`).

`tools/` holds the scripts that made and checked the files. They run in the `ros2-poc` pixi
environment of PR #254.

| script | what it does |
|---|---|
| `foxglove_json.py` | bag → `.foxglove.mcap` |
| `verify_fox.py` | checks a `.foxglove.mcap` against its bag |
| `replay.ps1` | ww18 paths; plays bags back at 1× into `viz_node` and records with `viz_capture.py`. Put `viz_node.py` and `_common.py` from PR #252 (`2783662`) beside it |
| `viz_capture.py` | the recorder `replay.ps1` uses |
| `viz_shift.py` | moves a capture onto the run's timeline → `.viz.mcap` |
| `verify_viz.py` | checks a `.viz.mcap` against its bag |
| `check_layouts.py` | resolves every panel of a layout against a run's files |

The crash bag has no `metadata.yaml`, so it was played from a scratch copy rebuilt with
`ros2 bag reindex`. The original stays untouched.
