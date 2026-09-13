# Run-log format review — does `behavior_v2` + the controller streams make sense, and is it compact? (2026-09-13)

Measured on real files from this weekend (Studio + bridge iteration `arena-log-20260913-093316`, harness
`sdstall-…-arm3` at 200 Hz, harness `prod-286hz` at 286 Hz). Numbers are per hour of ACTIVE Mode-3 running.

## 1. Answer first

- **Does it make sense?** Yes. Every fact needed for round-trip latency is in the file, each row is positional and
  self-describing through one schema line per file, and readers already treat any string-tagged array as a stream.
  Two things are under-documented (fixed below in §4): `rx` on controller rows is the *drain* time of the whole
  block, not the command's time; and the host `a` row and the controller `cc` row are joined by order, not by a key.
- **Is it compact?** Raw, no: **≈ 135 MB per active hour at 200 Hz** in the Studio path (≈ 110 MB in the harness),
  ≈ 160 MB at 286 Hz. Gzipped, yes: 3.3–4.4× → **30–40 MB/h**, and the Studio already commits `.jsonl.gz`. The bridge
  writes the raw file during the run, so a night is ~1.5 GB on disk before commit.
- **Recommendation, in order of payoff:** (1) stream-gzip in the bridge (level 1, 2.9×, no reader change) → a night
  fits in ~500 MB on disk and ~35 MB/h; (2) a schema-v3 pass later (t0-relative `rx`, integer index instead of hex,
  a host command counter on `a`) for another ~25 % and an exact `a`↔`cc` join. Nothing needs to change for the
  hand-off; (1) is a 10-line bridge change worth doing before the overnight if time allows.

## 2. What is in the file (one example line per row type)

| row | source | example | fields | bytes/row |
|---|---|---|---|---|
| FicTrac frame | bridge, every FicTrac/simulator frame (200 Hz) | `[4,7167479,12,0.0,-16.1773,580.57226,4.14543]` | `ms` (t0-relative), `fc`, `idx` (applied frame), `ft` (FicTrac col-22, relative), `x`, `y`, `hd` | 55 |
| `a` | browser, one per command sent (0x70 at 200 Hz) | `["a",312.652,2.285,"03 70 02 00",0,314.953]` | `t_off` (t0-relative ms), `dt` (round-trip ms), `hex` (request bytes), `status`, `rx_off`(, `error`) | 34 (Studio) / 49 (harness, longer hex) |
| `cc` | controller ring via the drainer, one per dispatched command | `["cc",1789325242813.438,28600458,5203,112,0,"b800"]` | `rx` (host epoch ms **of the drain block**), `t_us` (controller µs at dispatch), `seq`, `cmd`, `status`, `req` (params hex) | 54 |
| `cf` | controller ring, one per displayed frame change | `["cf",1789325242917.999,73238920,5229,2,36,1956,776,3029,1,1]` | `rx`, `t_us` (SPI start), `seq`, `idx`, `pattern`, `sd_load_us`, `spi_us`(, `req_age_us`, `superseded`, `flags`) | 55–66 |
| `cs` | controller ring, state/error events | `["cs",1789325242813.438,28611677,5205,2,0,36]` | `rx`, `t_us`, `seq`, `kind`, `code`, `arg` | 48 |
| objects | bridge/browser events | `{"type":"log","event":"runner",…}` | `run_metadata`, `runner`, `config`, `log_control`, `stream_schema`, `frame_schema`, `trial_quality`, `display_gap`, `soak`, `arena_command` (non-0x70 commands, full object) | 100–1200, rare |

Schema lines: `frame_schema` names the FicTrac columns and `arena_cols` for `a`; `stream_schema` names the `cc`/`cf`/
`cs` columns and the `cs` kind table. Readers: `js/runlog-format.js` (normalizer, gzip-aware), `js/runlog-replay.js`,
dashboard `analysis-core.js` (vendored copy, test-enforced), `scripts/wedge-scan.py`, `scripts/telemetry-report.py`.

## 3. Where the bytes go (per active hour, Mode 3, 200 Hz, Studio + bridge path)

| stream | rows/h | B/row | MB/h | share |
|---|---|---|---|---|
| FicTrac frames (200 Hz) | 720k | 55 | 39 | 29 % |
| `cc` (one per command) | 720k | 54 | 39 | 29 % |
| `cf` (one per frame change, ~0.76 per command) | 550k | 55 | 30 | 22 % |
| `a` (one per command) | 720k | 34 | 25 | 18 % |
| `cs` + objects | ~100 | — | < 0.1 | 0 % |
| **total raw** | | | **≈ 133** | |
| gzip −6 (commit path) | | | ≈ 35–40 (3.3–3.8×) | |

Harness (`sd_stall_test.py`, no FicTrac rows, longer `a` hex): 110 MB/h at 200 Hz, 157 MB/h at 286 Hz; gzip 4.3× →
25–36 MB/h. At 100 Hz (the course rate for most rigs) everything halves except the FicTrac rows.

So the controller telemetry costs about as much as the behaviour stream it explains (2.5× the FicTrac rows), and
half of the controller bytes are the `rx` epoch stamps and the hex strings, which is where the compaction is.

## 4. Does the design make sense — the review

**Three clocks, all present.** FicTrac time (`ft`, from the tracker), host time (`ms`/`t_off`/`rx`, browser or
bridge epoch), controller time (`t_us`, free-running µs, wraps every 71.6 min, `seq` disambiguates). Round trip of one
frame command = `a.t_off` (host send) → `cc.t_us` (controller dispatch) → `cf.t_us` (SPI start; `req_age_us` = the
difference measured on the controller, so no clock fit needed for the part that matters) → `a.rx_off` (host reply).
The host↔controller offset comes from pairing `a` and `cc` (drift-free within a run; a linear fit over the run is the
analysis step the telemetry review session owns).

**Verdicts are derivable offline** (`telemetry-report.py` reproduces the Studio's per-trial pass/flagged/unknown from
the same rows), which is the property that matters for a data pipeline: the log is the truth, the banner is a view.

**Weak points, honestly:**
1. `rx` on `cc`/`cf`/`cs` is the host time the *block* was drained, so it is up to 100 ms late and identical for all
   records of a block. It is documented in the module header but readers keep mistaking it for the command's time;
   `t_us` is the controller-side time. → Rename in the schema-v3 pass (`drain_ms`) and make it t0-relative.
2. The `a` row has no key to its `cc` row; the join is by command order (both are complete sequences, and
   `telemetry-report.py` reconciles the counts). A host command counter on `a` (one small int) would make it exact and
   robust to a lost reply. → schema v3.
3. Hex strings: `"03 70 02 00"` (13 B) on every `a` and `"b800"` (6 B) on every `cc` when the value is a u16 frame
   index. → integer `idx` for 0x70 rows in schema v3 (keep hex for other opcodes).
4. Duplication by design: `a` (host view) and `cc` (controller view) both exist per command; that is the point (the
   two clocks), not waste — but with schema v3 the pair costs ~55 B instead of ~90 B.
5. The FicTrac stream is logged whenever logging is on, including between runs (the 131-min file above held 21 min of
   trials). Cheap (39 MB/h) but worth a `log_control` pause outside runs in the soak driver.

## 5. Recommendations

| # | change | where | saving | reader impact | when |
|---|---|---|---|---|---|
| R1 | **stream-gzip the live file** (`gzip.open(…, 'wt', compresslevel=1)`, flush per drain), name it `.jsonl.gz` from the start | `fictrac-bridge/bridge.py` `_open`/`write` | 2.9× on disk during the run; commit path unchanged | none (all readers inflate on the magic) | before the overnight if the review window allows; else next |
| R2 | schema v3: `rx` → t0-relative ms with 1 decimal (`drain_ms`), `a` gets a host command counter, 0x70 `hex`/`req` → integer index | `js/arena-telemetry.js` `toRows`, `js/arena-session.js` `a` row, `stream_schema`/`frame_schema` version, readers | ≈ 25 % of the controller bytes; exact `a`↔`cc` join | all readers (normalizer, dashboard copy, wedge-scan, telemetry-report) + tests | after the hand-off, one PR |
| R3 | pause the FicTrac stream between runs in the soak driver | `Studio.startSoak` (`bridge.setLogging`) | ~39 MB per idle hour | none | with R2 |
| R4 | document `rx` semantics and the order-join in the header comment of `js/arena-telemetry.js` and in `runlog-behavior-v2-plan.md` | docs | — | — | now (done in this doc; header comment in R2) |

Target after R1+R2: **≈ 25 MB per active hour gzipped at 200 Hz, ≈ 100 MB raw** — "1 h well under 100 MB" holds for the
committed artefact today (35–40 MB) and for the on-disk file after R1.
