# Closed-loop bias analysis — handoff

**Audience:** whoever (or whatever) analyses `arena-log-*.jsonl` / `*.runlog.json`
recordings from FicTrac closed-loop bias experiments.

**Why this exists:** bridge **2.2** (2026-08-20) changed how the displayed frame index
is derived. Analysis code written against earlier logs will silently produce a wrong
displayed-stimulus trace. This document is the complete spec for reconstructing the
stimulus, plus what to do with the logs already on disk.

Authoritative feature spec: `docs/development/closed-loop-bias.md`. This file is the
analysis-facing subset.

---

## 1. What changed, in one line

Bridge ≥ 2.2 zeroes ("tares") the fly's heading at the start of every closed-loop
epoch, so the mapping is now **relative to trial onset** instead of absolute.

| | Bridge ≤ 2.1 | Bridge ≥ 2.2 |
| --- | --- | --- |
| Heading used | absolute (FicTrac col 17) | `wrap180(heading − hd0)` |
| Display at trial start | `round(heading/gain)` — arbitrary | index 0 (where `frame_index` put it) |
| New log event | — | `heading_tare` |

**If you apply the ≤2.1 formula to a ≥2.2 log** every reconstructed index is wrong by
`round(hd0/gain)` frames — up to 189 of 200 (340° of arena) in practice.

**If you apply the ≥2.2 formula to a ≤2.1 log** you get the same error in reverse.

You must therefore **detect the regime per log**, not assume one.

---

## 2. Regime detection

```python
# with the loader from section 5:
tared = bool(load(path)['tares'])
```

Presence of at least one `heading_tare` event ⟹ bridge ≥ 2.2. Absence ⟹ legacy, and
`hd0 = 0` reproduces what the bridge actually did.

Do **not** key off a version string; older logs don't record one reliably.

---

## 3. Log format (unchanged parts)

One JSON value per line. Dispatch on `Array.isArray`:

- **Array** → a `behavior_v1` frame row, columns given by the one-time
  `{"type":"frame_schema","cols":[...]}` header. Currently
  `["ms","fc","idx","ft","x","y","hd"]`. **This did not change** — no new column was
  added, so row parsing needs no update.
  - `ms` — ms since logging started. The master clock for everything below.
  - `idx` — **the frame the arena actually displayed.** Already includes the bias and
    the tare. If all you need is "what did the fly see", use this directly; no
    reconstruction required.
  - `hd` — FicTrac integrated heading, **radians, wrapped 0..2π**.
- **Object** → an event. The ones that matter here:

```json
{"type":"bias_config","dir":"bridge","ms":45024,"bias":{"type":"sine","amplitude":90.0,"frequency":0.5}}
{"type":"heading_tare","dir":"bridge","ms":45031,"hd0_deg":137.25}
{"type":"log","event":"runner","phase":"step-start","condition":"cl_bias_sine","rx_ms":...}
```

`bias_config.ms` and `heading_tare.ms` are in the **same relative timebase as the frame
rows**. Runner events carry `rx_ms` (absolute wall clock) — rebase them if you need to
align conditions by name; the two bridge events are easier to segment on.

An epoch is `bias_config` with `type != "none"`, terminated by the next
`bias_config` with `type == "none"`. Every condition emits both, so an 8-condition
sweep yields 16 `bias_config` events.

---

## 4. Reconstruction

```
b(t)  = bias_angle_deg(spec, t)        t = (ms − bias_config.ms) / 1000
rel   = wrap180(heading_deg − hd0_deg)      # hd0 = 0 for legacy logs
idx   = round((rel + offset + b) / gain) mod n_frames
```

`gain` and `n_frames` are **not in the log** — take them from the protocol
(`startClosedLoop.params.gain`, typically 1.8) and the pattern (200 for a full-azimuth
`frame2_h_ccw_200f`, 20 for a tiled grating). `offset` is 0 unless the protocol sets it.

### Bias waveforms

`amplitude` (A) is a **peak angular velocity in deg/s**; what the loop consumes is its
integral, an angle. `ω = 2πf`.

| `type` | `b(t)` | position range |
| --- | --- | --- |
| `none` | 0 | — |
| `constant` | `A·t` | unbounded drift |
| `sine` | `(A/ω)·sin(ωt)` | `±A/(2πf)` |
| `square` | symmetric triangle, `A·sign(cos ωt)` integrated | `±A/(4f)` |

All satisfy `b(0)=0`. The periodic two are zero-mean in position **over a whole
cycle** — if trial duration isn't an integer number of cycles there's a small DC
residual (a 15 s trial at 0.5 Hz is 7.5 cycles → ≈4% of peak).

**For frequency-response work, normalise by the position amplitude `A/ω`, not by `A`.**
A fixed `A` gives a smaller positional disturbance as `f` rises.

### The ±180 wrap

FicTrac's col 17 wraps, so `wrap180` is what the bridge uses and what you must use to
reproduce `idx`. Note the consequence: `rel` is bounded to ±180°, so it is **not** the
fly's cumulative turn. For behavioural measures (turning velocity, total rotation)
unwrap the heading yourself from frame-to-frame differences — see §6.

---

## 5. Reference implementation

Tested against three logs; results in §7.

```python
import json, math

def wrap180(d):
    return ((d + 180.0) % 360.0) - 180.0

def bias_angle_deg(kind, A, f, t):
    """Bias ANGLE (deg) t seconds into an epoch. Mirrors bridge.py exactly."""
    if kind == 'constant':
        return A * t
    if kind == 'sine':
        w = 2 * math.pi * f
        return 0.0 if w == 0 else (A / w) * math.sin(w * t)
    if kind == 'square':
        if f == 0:
            return 0.0
        period = 1.0 / abs(f); q = period / 4.0; peak = A * q; ph = t % period
        if ph <= q:
            return A * ph
        if ph <= 3 * q:
            return peak - A * (ph - q)
        return -peak + A * (ph - 3 * q)
    return 0.0

def load(path):
    cols = None; rows = []; bias = []; tares = []; steps = []
    for line in open(path):
        line = line.strip()
        if not line:
            continue
        try:
            o = json.loads(line)
        except json.JSONDecodeError:
            continue                      # tolerate a torn final line
        if isinstance(o, list):
            if cols:
                rows.append(dict(zip(cols, o)))
            continue
        t = o.get('type')
        if t == 'frame_schema':
            cols = list(o['cols'])
        elif t == 'bias_config':
            bias.append((o['ms'], o['bias']))
        elif t == 'heading_tare':
            tares.append((o['ms'], o['hd0_deg']))
        elif o.get('event') == 'runner' and o.get('phase') == 'step-start':
            steps.append((o.get('rx_ms'), o.get('condition')))
    return dict(cols=cols, rows=rows, bias=bias, tares=tares, steps=steps,
                tared=bool(tares))

def _latest(seq, ms):
    cur = None
    for m, v in seq:
        if m <= ms:
            cur = v
        else:
            break
    return cur

def reconstruct(log, gain, n_frames, offset=0.0):
    """Per-row bias angle, tared turn, and predicted index. Rows before the first
    bias_config are skipped — the bridge's state there is not fully described."""
    if not log['bias']:
        return []
    t_first = log['bias'][0][0]
    out = []
    for r in log['rows']:
        ms = r['ms']
        if ms < t_first:
            continue
        spec = _latest(log['bias'], ms) or {'type': 'none', 'amplitude': 0., 'frequency': 0.}
        b_ms = max(m for m, _ in log['bias'] if m <= ms)
        b = bias_angle_deg(spec['type'], spec['amplitude'], spec['frequency'],
                           (ms - b_ms) / 1000.0)
        hd0 = _latest(log['tares'], ms)
        if hd0 is None:
            hd0 = 0.0                     # LEGACY (bridge <= 2.1): absolute heading
        rel = wrap180(math.degrees(r['hd']) - hd0)
        out.append(dict(ms=ms, hd_deg=math.degrees(r['hd']), hd0=hd0, rel=rel,
                        bias=b, epoch_ms=b_ms, bias_type=spec['type'],
                        idx_pred=round((rel + offset + b) / gain) % n_frames,
                        idx_log=r['idx']))
    return out
```

**Always validate before trusting an analysis:** compare `idx_pred` against `idx_log`.
A mismatch rate above ~0.05% means the assumed `gain`, `n_frames`, `offset`, or regime
is wrong.

---

## 6. Deriving the science quantities

With the tare, the mapping has a clean control-theoretic reading. Let `disp` be the
displayed pattern position in degrees relative to where it started:

```
disp = idx * gain            (unwrap the idx series first — see below)
disp ≈ rel + offset + b
```

- **`b(t)` is the disturbance input** — known exactly, noise-free.
- **`rel(t)` is the fly's response** (its turn since trial onset).
- **`disp(t)` is the residual / retinal position error** the fly is trying to null.

Perfect disturbance rejection means the fly holds the display still: `rel = −b`, so
`disp = const`. **A fly that counter-turns correctly produces `rel` opposite in sign to
`b`.** Getting this backwards inverts the conclusion, so sanity-check it on a
`constant` condition first: the fly should turn *against* the drift.

On-arena sign convention (confirmed by eye, positive `gain`): **positive
`bias_amplitude` turns the display clockwise viewed from above**, equivalently the
pattern sweeps rightward across the fly's visual field.

### Two unwrapping jobs — don't confuse them

1. **`idx` → continuous `disp`.** `idx` is mod `n_frames`, so a `constant` bias wraps
   repeatedly. Unwrap by frame-to-frame differences before integrating or plotting.
2. **`hd` → cumulative heading.** `rel` from §4 is bounded to ±180° by construction.
   For turning velocity or total rotation, unwrap the raw `hd` series instead:

```python
def unwrap_deg(series_deg):
    out = []; acc = 0.0; prev = None
    for v in series_deg:
        acc = v if prev is None else acc + wrap180(v - prev)
        out.append(acc); prev = v
    return out
```

Use the unwrapped heading for behaviour, and `rel` (wrapped) only to reproduce `idx`.

### Timebase

Use `ms` for alignment against events. Prefer `ft` (FicTrac's own camera clock, already
normalised to relative ms) for **velocity** denominators — it is drop-safe, whereas
`ms` is bridge wall-clock. Frame rate is variable, so always compute `dt` per frame
rather than assuming a constant.

---

## 7. Validation results (what "correct" looks like)

The implementation in §5 was run against three logs:

| Log | Regime | Rows in epochs | Index mismatches |
| --- | --- | --- | --- |
| `arena-log-20260804-153127-085` (hardware validation) | legacy | 328,733 | 4 (0.0012%) |
| `bench03/…bias-disturbance-test__2026-08-13T14-25-19` (real fly) | legacy | 68,637 | 11 (0.0160%) |
| bridge-2.2 end-to-end capture | tared | 365 | 3 (0.82%) |

(The tared capture is a 365-row synthetic smoke test, so its percentage is dominated
by the small denominator — 3 rows, same absolute count as the others.)

All residual mismatches are **±1 frame**, from millisecond rounding between when the
bridge evaluates the bias and the `ms` it stamps on the row. Treat ±1 frame as noise;
do not chase it.

The real-fly log also had 3 rows *before* its first `bias_config`, mismatching by −60
frames. That is why `reconstruct()` skips pre-epoch rows: the bridge's configuration
there is not fully described by the log. **Analyse inside epochs only.**

---

## 8. The existing bench03 logs — a scientific caveat

All 12 `bench03/fictrac-closed-loop-bias-disturbance-*` logs currently on disk are
**legacy (no `heading_tare`)**. They reconstruct correctly with `hd0 = 0`, so the
recorded behaviour and stimulus are fully recoverable — nothing is lost.

But be aware of what the fly actually experienced in those runs: **each trial began
with the pattern at an essentially random azimuth.** Measured across those 12 files,
7 epochs each:

- 200-frame full-azimuth pattern: median start offset **55–156 frames**, max **189 of
  200 ≈ 340°**
- 20-frame tiled grating: up to **19 of 20 frames** — the whole pattern

So the stimulus onset azimuth is an uncontrolled, trial-varying nuisance variable in
that dataset, and it is often far outside the fly's frontal field. Options, in
increasing order of conviction:

1. Include the reconstructed start azimuth as a covariate / check that responses don't
   depend on it.
2. Restrict to trials whose start offset is small.
3. Re-record with bridge ≥ 2.2, where onset azimuth is 0 by construction.

For a disturbance-rejection measurement this matters most where the response depends
on where the pattern sits (any non-uniform stimulus, e.g. a single bar or object); for
a uniform grating it is closer to benign, since a tiled grating looks the same at every
phase — though the 20-frame case still starts at an arbitrary phase within the period.

---

## 9. JavaScript path (if the analysis is in the browser)

`js/runlog-replay.js` surfaces both events as status items, so they flow through
`buildTimeline` with everything else:

```js
const epochs = parsed.events
    .filter((e) => e.status && e.status.phase === 'bias_config')
    .map((e) => ({ ms: e.ms, bias: e.status.bias }));
const tares = parsed.events
    .filter((e) => e.status && e.status.phase === 'heading_tare')
    .map((e) => ({ ms: e.ms, hd0_deg: e.status.hd0_deg }));
```

Caveat: an epoch/tare `ms` is used verbatim only when the log carries its usual
epoch-stamped `logging_started` anchor. A hand-written fixture without it gets rebased
against its own first record.

The offline dashboard (`dashboard/data-browser/`) uses its **own vendored parser** in
`analysis-core.js`, which does *not* yet know about either event. Extend that
separately if the dashboard needs to annotate bias epochs.

---

## 10. Things that are deliberately not in the log

- **No per-frame bias column.** `BEHAVIOR_V1_COLS` was intentionally not widened —
  every positional reader would break. The `bias_config` + `ms` pair reconstructs it
  exactly, which is why the waveform is analytic.
- **The live WebSocket `bias` field is not logged.** It exists only to drive the
  Studio's on-screen readout.
- **`gain`, `n_frames`, `offset`** come from the protocol and pattern, not the log.
  Pair every log with its protocol YAML; canonical `*.runlog.json` exports carry
  `protocol_sha256` for exactly this.
