# Bench-testing the closed loop with a model fly (arena, no FicTrac)

**Purpose.** Exercise the FicTrac Mode-3 closed loop — heading tare, bias waveforms
(LAB-185), frame modulus, the coming `coupling` gain, position-gated LED zones — on a
real arena with **no camera, ball or fly**. `fictrac_sim.py` plays the fly: either a
**real fly's recorded trace** (`--replay`) or a **closed-loop model fly** (`--model fly`)
that watches the frame the arena shows and turns toward it / with it. Then
`scripts/closed-loop-report.py` turns the run log into a table + strip charts.
Tool reference: `fictrac-bridge/README.md` ("Replaying a REAL fly", "A model fly in the loop").

## What each mode can and cannot tell you

| mode | fly | tests | does NOT test |
|---|---|---|---|
| `--replay run.jsonl.gz` | real kinematics (saccades, bouts, pauses), non-reactive | wrap/tare/modulus/coupling math, link load and `req_age_us` under realistic index jumps, LED zone transitions | the fly's response (it cannot see the display) |
| `--model fly --kp 2` | fixates the feature | **loop sign** (feature settles frontal vs runs to ±180°), bias rejection, coupling k≠1 stability, LED zones firing as the feature crosses them | anything quantitative about real flies — kp/kv/noise are opinions |
| `--model fly --kv 1` | follows world motion (optomotor) — also stabilizing in closed loop | the velocity-loop sign (a mis-signed rig makes it run away), open-loop bias replay with `coupling: 0` | same |
| `--model fly` (kp = kv = 0) | noisy walker | soak-style load, the Console loop | semantics |

## Procedure (one bench session, ~20 min)

1. **Serve the branch locally** — Pages serves `main` only:
   `pixi run serve` from the checkout, open `http://127.0.0.1:8000/arena_studio.html?advanced=1`.
2. **Bridge ≥ 3.2:** `pixi run bridge` (the banner prints the version; the bias and the tare
   live there).
3. **Studio:** Connect the controller; File ▾ → Open from library → *FicTrac closed-loop
   bias/disturbance test* (`protocols/fictrac_bias_test.yaml`, 8 × 30 s). Check the Run view's
   bridge strip shows the bridge connected.
4. **Sim:** in another terminal
   `pixi run sim -- --model fly --kp 2 --seed 1` (fixating fly, reproducible), or
   `pixi run sim -- --replay <runlogs/rig03-sr/…jsonl.gz> --loop` for a real trace.
   The sim prints one status line per second: `idx`, feature azimuth, heading, ω, walk/pause.
5. **Run.** Watch the arena: with a `--kp` fly and the correctly signed rig the bar should sit
   roughly in front of the (virtual) fly; on the bias trials it should hold there while the
   sim's status shows the fly turning steadily (constant) or swinging (sine/square).
   If the bar runs to the back and stays there, the loop sign is wrong — that is a finding,
   not a sim bug (flip `--frame-dir -1` to confirm it was the sign).
6. **Report.** After the run is committed (or exported), run
   `pixi run python scripts/closed-loop-report.py <run.jsonl.gz> --svg cl.svg` and read:
   - `frontal` ≈ 100 % on `cl_bias_none` for a `--kp` fly (fixation works, sign right);
   - `rejection` ≈ +1 on the constant-bias trial for a `--kp` fly, ≈ +0.5 for a `--kv 1` fly
     (following the slip counter-rotates the display too), ≈ 0 for `--kp 0 --kv 0`, and
     **strongly negative only when the velocity loop is mis-signed** (runaway spin);
   - `idx mismatch` ≈ 0 % (the LAB-185 consistency check: logged frame vs
     `round((heading − tare + bias)/gain) mod frames`);
   - the SVG: blue = fly heading, orange = bias angle (mirror images when rejecting), green =
     feature azimuth (flat near 0 when fixating).

## Expected results by configuration (what "pass" looks like)

Measured 2026-09-19 in the **virtual loop** (real bridge 3.2 + model fly, no arena; 8 s epochs,
`--seed 11 --noise-dps 15 --saccade-rate 0.3`):

| configuration | frontal (`cl_bias_none`) | mean \|az\| on constant 90 °/s | rejection (constant) | rejection (sine 0.5 Hz) | notes |
|---|---|---|---|---|---|
| `--kp 2`, rig sign correct | **92 %** | 41° | **+0.99** | +0.15 | the 45° lag is kp's steady-state error (90/2); kp 2 is too slow for 0.5 Hz |
| `--kp 2`, `--frame-dir -1` (mis-signed rig) | 21 %, feature at 130° | 164° | +0.90 | +1.57 | anti-fixation: the feature is a stable attractor at the BACK |
| `--kv 1 --kp 0` | 99 % (barely turns) | 93° | +0.52 | +0.43 | an optomotor follower is stabilizing too |
| `--kv 1`, `--frame-dir -1` | 14 %, ω +610 °/s | 90° | **−61** | +15 | runaway spin (clamped at 1500 °/s) — the unmistakable sign of a mis-signed velocity loop |
| `--kp 0 --kv 0` | ≈ 1/6 | sweeps | ≈ 0 | ≈ 0 | the bias sweeps the display at exactly A/1.8 frames/s |
| after the coupling PR: `coupling: 0.75` with `--kp 2` | > 90 % | — | ≈ 1 | — | and no once-per-revolution jump in the green trace |

`idx mismatch` was **0.00 %** in every run — the logged frame equals `round((heading − tare + bias)/gain) mod 200`
on the merged bridge.

## Hardware-free variant (CI-style)

The bridge computes and broadcasts the frame index whether or not a browser applies it, so
`bridge + sim --model fly` alone closes a *virtual* loop: push a bias via a WebSocket
`config` message, log with `log_control`, and run the report on the bridge's file. That is
what `tests/test-fictrac-sim.py` cannot do (no sockets) but a one-off smoke can; see the
PR that added this doc for the script.

## Sign conventions, once more

FicTrac heading (col 17) is CCW-positive: turning LEFT increases it. Feature azimuth is
right-positive. `frame_dir = +1`: an index increase moves the feature right (display
clockwise — Isabel's confirmed on-arena sign for a positive bias at gain +1.8). So a fly
turning toward a feature on its right turns right = heading decreases = `ω = −kp·az`, the
bridge lowers the index, the feature moves left toward the front. If any one of those links
is flipped on a rig, the model fly exposes it within seconds.
