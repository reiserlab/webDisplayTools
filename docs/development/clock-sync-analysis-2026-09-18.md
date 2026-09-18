# Host ↔ controller clock alignment — why the logs already do PTP's job (2026-09-18)

*For Frank and anyone joining the timing discussion. Question raised by Michael: the Teensy's clock will drift against
the PC — do we need something like PTP (Precision Time Protocol) on the arena link?* **Short answer: no.** The run logs
already contain a two-way time exchange for every command, the drift is a few ppm, and a per-run linear fit removes it
to within the link's own jitter. Implemented as the "Clock fit" line of `scripts/telemetry-report.py`.

## 1. The three clocks in a run log

| clock | where it lives | what stamps it | resolution / behaviour |
|---|---|---|---|
| host wall clock | `a` rows (`t_off`, `rx_off` relative to `frame_schema.t0`), FicTrac rows (`ms`), every `{type:"log"}` event | browser `Date.now()` / bridge `time.time()` | 1 ms; NTP-disciplined by the OS (can step) |
| controller clock | `cc` / `cf` / `cs` rows, field `t_us` | Teensy microsecond counter since boot | 1 µs; monotonic, never adjusted, crystal-driven |
| FicTrac clock | FicTrac rows, field `ft` | the tracker's own timestamp | ns in the raw stream; a third clock we do not discuss here |

Format authority: `telemetry-logging-reference.md` (rows, events, the three-clock model). Within a single clock all
intervals are exact. The question is only how to place controller events on the host timeline (or vice versa).

## 2. What PTP does, and what the logs already contain

PTP/NTP estimate the offset between two clocks from a *two-way exchange*: A sends at $t_1$, B receives at $t_2$,
B replies at $t_3$, A receives at $t_4$; with a symmetric path, $\text{offset} = \tfrac{(t_2 - t_1) + (t_3 - t_4)}{2}$
and the exchange is repeated to track drift.

Every accepted SET_FRAME_POSITION (0x70) in a Mode-3 run *is* that exchange:

| PTP quantity | in the run log |
|---|---|
| $t_1$ host send | `a` row: `t0 + t_off` (v2) or `arena_command.t` (v1) |
| $t_2$ controller receipt | matching `cc` row: `t_us` |
| $t_4 - t_1$ round trip | `a.dt` (the reply is immediate, so $t_3 \approx t_2$) |
| exchange rate | 100–200 per second, for the whole run |

So $\text{offset}(t) = t_{us}/1000 - (t_{send} + RTT/2)$ is available for every command, for free, without a single extra
byte on the wire or a line of firmware.

## 3. Measured drift

The controller's crystal runs at a slightly different rate than the PC's, so the offset is a **line**, not a constant.
Fit $t_{ctl} = \alpha + (1+\beta)\,t_{host}$ on the quarter of pairs with the lowest RTT (least host-side queueing — the
same idea as NTP's clock filter):

| host | run | drift $\beta$ | accumulated | residual after the fit |
|---|---|---|---|---|
| Mac bench (2026-09-12) | one soak iteration | −3 ppm | — | USB/CDC queueing |
| rig03 Windows PC (2026-09-16, Shubham, real flies) | 18 min, 109 k commands, 105 k pairs matched | **−4.2 ppm** (0.25 ms/min) | **4.4 ms** over the run | median 0.33 ms, p95 1.0 ms, max 6.9 ms |

For orientation: a Teensy 4.1 crystal is specified around ±20–50 ppm; ±50 ppm would be 3 ms per minute. What we see is
well inside that, and it is *stable* within a run (the fit residual has no trend).

## 4. Why a time protocol on the controller would not help

- **The residual is the link, not the clock.** After the fit, what is left (0.3 ms median, 1 ms p95) is USB-CDC queueing on
  the host side plus the controller's one-command-per-loop service. A firmware PTP would measure its offsets through the
  same USB path and inherit the same jitter; it cannot beat that floor.
- **A logging clock should never be adjusted.** The controller's `t_us` is monotonic and uniform; every controller-side
  interval (request age, read cost, stall duration, refresh period) is exact because of that. Disciplining it to the host
  would put PC clock steps and NTP corrections *into* the controller's own measurements. Correction belongs in analysis.
- **Per-trial the drift is negligible.** A 20–60 s trial accumulates 5–15 µs of drift at 4 ppm. A constant offset is
  already good to far better than a millisecond within a trial. Only run-scale comparisons (18 min → 4 ms) need the line.
- **Nothing to deploy.** Both lab controllers and every stored log already have what the fit needs; it works on the
  behavior_v1 archive too (`arena_command.t`/`dt`).

## 5. How to use it

```bash
pixi run python scripts/telemetry-report.py soak-logs/arena-log-*.jsonl*     # look for the "## Clock fit" line
pixi run python scripts/telemetry-report.py --json run.jsonl.gz               # clock_fit: {drift_ppm, residual_ms, …}
```

The line reads like: `Clock fit (host ↔ controller): drift +4.1 ppm (+0.246 ms/min, +4.33 ms over 1055 s) · controller
clock at first send 40 123.4 ms · residual median 1.96 ms, p95 5.25, max 21.2 · 34 436 low-RTT pairs (RTT ≤ 1 ms) of
106 453 matched (0.976 of host sends)`. To place a controller event on the host timeline:
`t_host = t_first_send + (t_us/1000 − controller_ms_at_first_send) / (1 + drift_ppm·1e-6)`.

Warnings the fit raises, and what they mean:

| warning | likely cause |
|---|---|
| drift beyond ±100 ppm | the host clock stepped during the run (NTP), the controller rebooted mid-run (its clock restarted), or the pairing is wrong |
| residual p95 > 20 ms | the host was in a slow state (see the 2026-09-15 Run-log-dock finding) or the link dropped |
| matched share < 80 % | a second run in the same file, or a large pre-run ring backlog |

Pairing detail: host sends are matched to the *nearest* controller receipt after a coarse offset taken from the drain
envelope (`rx − t_us` is the offset plus at most one poll interval), so a ring backlog from before the run cannot
mis-pair the two lists (pairing purely by order does — measured: a 500 000 ppm nonsense slope).

## 6. When we would revisit

- A use case that needs **sub-millisecond** host↔controller alignment across a whole run (today's science needs
  per-trial alignment, where a constant offset is already ~10 µs good).
- A host whose clock **steps** during runs (the fit's drift warning will tell us).
- If a hardware trigger line between PC and controller ever exists, an edge on both clocks gives an exact offset without
  any protocol — that would beat both PTP and this fit.

*Written 2026-09-18 15:32 ET from the rig03 run of 2026-09-16 20:09 ET and the Mac bench measurement of 2026-09-12.*
