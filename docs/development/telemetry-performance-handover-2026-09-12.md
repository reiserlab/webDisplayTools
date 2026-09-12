# Handover — parallel session: what else to log, how useful the current logging is, and how to remove SD-read jitter and other slop

**Written:** 2026-09-12 14:30 ET by the fw #50 soak session (Claude + Michael). **For:** a parallel
planning session working in a git worktree. **Do not touch the bench:** a 10-hour soak (T4) is running
on the only controller until ~23:40 ET; the Studio that drives it is served from the MAIN checkout at
`http://localhost:8091` (Python `http.server`, pid 27488) and the bridge/simulator are live. Work in a
**worktree on a new branch** (`git worktree add ../webDisplayTools-perf claude/telemetry-perf-plan`),
never open a serial port, never flash, never restart the bridge or the server. Read-only access to the
soak logs is fine (they are append-only NDJSON).

## 1. What this session is asked to do

1. **Assess the current logging plan.** Given what the ring + host now record (§4), what questions
   can be answered from a night of logs, what cannot, and what is missing. Produce a metrics
   specification: every performance quantity we care about, which rows it comes from, how it is
   computed, and its expected healthy range.
2. **What else could be logged**, at what cost (bytes/s, controller loop time, link occupancy), and
   whether it belongs in the ring (controller side) or the host log. Candidates already discussed:
   per-op SD timing beyond frame loads (`sd_open`, directory reads, `TRIAL_PARAMS` load), USB TX
   timeouts, refresh-ISR overruns / dropped refreshes, loop period histogram, analog TICK yoking
   (T3, needs analog firmware), FicTrac → bridge → browser hop times (bridge-side timestamps exist),
   Chrome timer throttling markers, controller-side reply-send timestamp (to split RTT).
3. **Performance metrics via logging.** Define the comparison protocol for telemetry-on vs -off
   (alternating iterations; what is measurable in both arms — host RTT p50/p99, delivered 0x70 rate,
   GET_HEALTH loop-max/sd-max at boundaries — vs only in the on arm — `sd_load_us`, `spi_us`), and
   the Mode 2 (open loop) variant.
4. **SD-card read jitter and other slop.** A ranked proposal, with firmware evidence (file:line), for
   reducing the SD tail and the other latency/jitter sources in the Mode-3 chain (§6). Include what
   each change would do to the wedge investigation (fw #50): a change to the SD access pattern must
   not be flashed on the soak controller until a baseline wedge is captured on the ring firmware
   (Michael's standing decision).
5. Prototype **analysis scripts** in the worktree (`scripts/telemetry-report.py` or similar) that
   turn a night of logs into the metrics in (1). Test against the files in §4. Standalone tests like
   `tests/test-wedge-scan.py` (no pytest). The ad-hoc analyses in §5 are the seed.

Deliverables: a plan doc under `docs/development/` (run it through the `codex-plan-review` skill with
`CODEX_REVIEW_MODEL=gpt-6-astra`, independent analysis first, report back to Michael before revising),
the metrics spec, the SD-jitter proposal, the script(s). Do not open PRs against `main` for the
analysis code without Michael; the campaign branch (`claude/mode3-wedge-soak`, PR #198) is where the
telemetry host code lives and is still moving.

## 2. Repos, branches, worktrees

| What | Where |
|---|---|
| Web tools (Studio, bridge, analyzer) | `/Users/reiserm/Documents/GitHub/webDisplayTools`, branch `claude/mode3-wedge-soak` (PR #198, tip `793cf15`). `main` is behind by the whole campaign. |
| Firmware, running on the bench | worktree `/Users/reiserm/Documents/GitHub/LED-Display_G6_Firmware_Arena-ring`, branch `feat/telemetry-ring-2x10` (tip `64167f8`; flashed build `c47ee684`). Base chain: `arena-2x10-local` (2×10 geometry) → `feat/controller-health-2x10` (GET_HEALTH 0xCA, GET_FIRMWARE_VERSION 0xCB) → ring. **Firmware `main` is compiled for 4×10** and rejects every 2×10 pattern — branch off `arena-2x10-local`/the ring branch for anything meant for this bench. |
| Other firmware worktrees | `…-health` (`feat/controller-health`, off `main`, PR #53), `…-health-2x10`. |
| Rules | `webDisplayTools/CLAUDE.md` (Studio architecture, the fault lifecycle, telemetry ring rules, behavior_v2 readers, Prettier scope). Firmware README "Telemetry ring" section. |

## 3. What has been built and why (compressed history)

- **The bug:** fw #50 — during Mode-3 host-stepped streaming (SET_FRAME_POSITION 0x70 at 100–286 Hz)
  the controller goes silent until power cycle, ~1 in 10 experiments. Reproduced once on this bench
  (2026-09-12 00:19 ET, course firmware, iteration 4, after 18k clean commands): total silence to any
  host, 0x01 unanswered, display frozen. Hypotheses: H1 SDIO polled busy-wait latch, H2 USB/loop
  stall; H3 host/Chrome narrowed (not needed to observe; not excluded as trigger); H4 instrumented
  firmware changed the odds (needs a stock control night). Details: `mode3-wedge-soak-plan.md`
  (§1–11, bench log §10), `mode3-wedge-status-2026-09-12.md`, fw #50 comments.
- **Host (Studio v0.76, PR #198):** fail-closed fault detection (≥3 failed applies in 10 →
  `CONTROLLER_FAULT`), post-mortem probes, `ArenaLink.reconnect()` from granted ports, soak driver
  (`Studio.startSoak`, `?soak=1`), `scripts/wedge-scan.py` analyzer, controller-telemetry drainer
  (`js/arena-telemetry.js`, 10 Hz, ack-cursor, "ack means stored"), build identity in every log
  (`run_metadata.firmware`). Two Codex (gpt-6-astra) reviews reconciled: `codex-review-2026-09-12-mode3-wedge.md`.
- **Firmware:** GET_HEALTH 0xCA (66 B: uptime, loop max, sd reads/max, frames, isr, cmd70 count,
  state, reset cause, **reset-surviving breadcrumb** at OCRAM 0x2027FF40 + previous boot's slowest op);
  GET_FIRMWARE_VERSION 0xCB (46 B, flags bit 2 = telemetry ring present); **telemetry ring** 64 KiB at
  OCRAM 0x2026F000, survives SYSTEM_RESET and the bootloader reboot (verified today, both routes),
  records CMD / FRAME / STATE, 0xA8 SET_TELEMETRY (bit 7 synthetic producer), 0xA9 GET_TELEMETRY_BLOCK
  (18 B header + ≤178 B whole records, ack cursor). Review + deferred hardening:
  `LED-Display_G6_Firmware_Arena-ring/docs/development/codex-review-2026-09-12-telemetry-ring.md`,
  issue fw #54.
- **Recovery route validated today:** 134-baud open → HalfKay → `teensy_loader_cli --mcu=TEENSY41 -b`
  → CDC back in ~1 s, ring intact. 0x01 cannot recover a stuck `loop()`; the bootloader can (unless
  USB interrupts are dead too). Self-healing runner = issues web #197 / LAB-212 (not built).

## 4. The data: where, what, how to read it

**Location:** `/Users/reiserm/Documents/GitHub/webDisplayTools/soak-logs/` (gitignored, ~450 MB,
growing ~60 MB/h tonight). One file per soak iteration (`arena-log-YYYYMMDD-HHMMSS-mmm.jsonl`,
bridge rotates on `log_control`). Also `bridge-stdout.log`, `sim-stdout.log`. Night-1 wedge file:
`arena-log-20260912-001625-545.jsonl` (course firmware, no ring). Health-firmware clean iterations:
files from 07:05–13:36 today (`22b756dd`, no ring rows). **Ring firmware (T4):** files from
`arena-log-20260912-133850-123.jsonl` onward (~20 MB per 21-min iteration).

**Format:** bridge `behavior_v2` NDJSON. Line types:

| Line | Meaning |
|---|---|
| `{"type":"frame_schema","level":"behavior_v2","cols":[...],"t0":<ms>}` | first line; `t0` = wall-clock origin for `a` rows |
| `[ms, fc, idx, ft, x, y, hd]` (numbers first) | FicTrac sample (simulator here; 100 Hz, `--seed 1`, random-walk heading) |
| `["a", t_off, dt, hex, status, rx_off(, error)]` | host command echo: `t_off` ms since t0 at SEND, `dt` host-observed round trip incl. queue (monotonic clock), `hex` = request bytes (0x70 = `03 70 lo hi`), `status` reply status or null on timeout, `rx_off` bridge receipt. **Not** logged: the drainer's own 0xA9 requests (since 13:36). |
| `["cc", rx, t_us, seq, cmd, status, req_hex]` | controller CMD record: `t_us` = controller `micros()` at dispatch entry (u32, wraps 71.6 min), `seq` global ring sequence, `req_hex` first ≤8 request bytes |
| `["cf", rx, t_us, seq, idx, pattern, sd_load_us, spi_us]` | displayed-frame change: `t_us` = SPI transfer START (not display), `sd_load_us` = `SdManager::readFrame` duration (u32), `spi_us` = panel transfer |
| `["cs", rx, t_us, seq, kind, code, arg]` | state: kinds 1 boot (code = reset cause & 0xFF, arg = prev breadcrumb op<<8 \| valid), 2 state_change (code = ArenaState, arg = pattern), 3 error_glyph (code = CE), 4 sd_slow (arg = µs/100, >20 ms), 5 ring_overrun (0 evicted / 0xFF heap collision), 6 telemetry (code = flags, arg = synthetic rate), 7 sd_open (code = CE, arg = pattern) |
| `{"event":"run_metadata", ..., "firmware":"c47ee684 2x10 …", "telemetry":"ring-10hz"|"off", "soak":{...}}` | per run |
| `{"event":"stream_schema","streams":{cc,cf,cs}}` | column names for the tagged rows |
| `{"event":"runner","phase":...}` / `{"event":"soak","phase":"iteration-start|iteration-end|start|end", ...}` | run/soak lifecycle; `iteration-end` carries `applied_0x70`, `duration_s`, `telemetry` drainer stats |
| `{"event":"probe"...}`, `{"event":"telemetry_dump", "summary", "raw_blocks":[hex]}` | post-mortem / reboot-test evidence |
| `{"type":"log","event":"arena_command",...}` (207 B objects) | echoes that did not fit the compact form (request > 8 bytes, e.g. TRIAL_PARAMS) — verbatim v1 shape |

**Readers:** `js/runlog-format.js` (`createNormalizer().normalize(rec)` turns `a` rows back into the
v1 `arena_command` object; readers must skip string-tagged arrays other than `"a"`),
`scripts/wedge-scan.py` (per-run table, `--json`, `--verbose` prints controller tails; `ctl recs`,
`sd max us`, `ctl states`, `ctl rejects`, `fault-declared` outcome), firmware
`tests/telemetry_codec.py` (byte-level decoder for `raw_blocks`). `rx` on tagged rows is the bridge
receipt of the DRAIN, not of the event — order by `seq`, never by `rx` or `t_us` (a CMD's `t_us` is
dispatch entry but it is appended after its handler's STATE records).

**Clocks:** host `t0 + t_off` (ms, wall), bridge `rx` (ms, wall, same machine), controller `t_us`
(µs since boot). Measured drift host↔controller −3 ppm; align by pairing `a` 0x70 rows with `cc` 0x70
records **by request index in order** (counts differ by the in-flight ones; the pre-run backlog of
~120 controller records has old `t_us`).

## 5. Findings so far (numbers to reproduce, then extend)

From T4 iteration 1 (`arena-log-20260912-131346-381.jsonl`, 1,238 s, 104,895 0x70s, 100 Hz):

| Quantity | Value |
|---|---|
| Host RTT of 0x70 (`a.dt`) | median 2 ms, p99 7 ms, max 77 ms |
| Controller dispatch → frame on SPI (`cc.t_us` → next `cf.t_us`) | median 4.7 ms, p99 5.8 ms, max 22.9 ms — the display lags the reply by ~2.7 ms (waits for a transfer slot) |
| `sd_load_us` | median 1.21 ms, p99 2.3 ms, p99.9 3.4 ms, **max 19.4 ms** |
| `spi_us` | 766 µs, flat (2×10) |
| GET_HEALTH slowest op of that boot | op 1, **70.6 ms** — NOT a frame load (cf max 19 ms) ⇒ another SD op (pattern open at trial start? `sd_open` records) — first thing to pin down |
| Health build (22b756dd), earlier today | worst SD read 129 ms during clean runs |
| Ring production | ~2.9 KB/s at 100 Hz Mode 3 (CMD 16 B + FRAME 20 B per frame); drain ~2 chunks per 100 ms poll; 0 dropped, 0 gaps over 178k records |
| File | 19.8 KiB/s before the silent-0xA9 fix (73 MB/h), ~14 KiB/s after; gzip 4.5×; ring rows ≈ 38 % of bytes; FicTrac rows 27 %; host echoes 15 % |
| CMD 0x70 count controller vs host | equal (±2 in flight); FRAME idx == last request 16,562/16,564 |

Ad-hoc analysis code used today lives only in this session's transcript; re-derive: (a) pair `a`
0x70 rows with `cc` 0x70 records by order after dropping the pre-run backlog (records whose
`rx − t_us/1000` offset differs from the run's by > 2 s); (b) fit `t_host = a + b·t_us` (slope → drift,
residual → jitter); (c) `cc→cf` when `cf.seq == cc.seq + 1`; (d) file composition by first element.

## 6. SD-read jitter and other slop — what is known, where to look

Firmware facts (ring worktree; line numbers drift, grep):
- `CommandProcessor::handleSetFramePosition` (~:1073): `disarmRefreshTimer()` → `loadFrame()` →
  `armRefreshTimer()` → `sendResponse`. **`loadFrame` = uncached SD seek + reads on every 0x70**, even
  a repeated index (`SdManager::readFrame` :316). The FRAME record wraps exactly this call.
- SD is `SD.begin(BUILTIN_SDCARD)` = SdFat `SdioConfig(FIFO_SDIO)`: **polled**, persistent CMD18
  multi-block read; every non-sequential sector does `syncDevice()` (CMD12) + `readStart()`, each gated
  by `BUSY_TIMEOUT_MICROS = 1 000 000` and an **unbounded** spin on `SDHC_PRSSTAT_BREN`. Mode-3
  random access hits this path every command; Mode-2 sequential playback stays on the fast path.
  Candidate H1 for the wedge; also the most likely source of the 3–20 ms `sd_load` tail and the 70–129
  ms "slowest op".
- `transferPanelSet` spins unbounded on `dmaComplete_` (`SpiManager.cpp` ~:117); `spi_us` is flat
  today, but any SD delay lengthens the loop and delays the transfer slot (the 2.7 ms cc→cf gap).
- **PSRAM playback already exists**: `buildPsramFrame()` (~:1410), `psram_play_offset_` (~:1446/1474)
  — a whole-pattern-in-RAM path. A 2×10 GS16 200-frame pattern is ~800 KB; PSRAM is 8–16 MB. Preloading
  the trial's pattern into PSRAM at TRIAL_PARAMS and serving 0x70 from RAM would remove SD from the
  Mode-3 hot path entirely. Check what the PSRAM path is for today and its frame identity gap (fw #54:
  FRAME records don't track PSRAM frames yet).
- Held candidate (Michael, until a baseline wedge is captured on ring firmware): frame cache / skip
  `loadFrame` + timer churn when the index is unchanged (`handleSetFramePosition`).
- Other Teensy-side slop: `usb_serial_write` sticky 120 ms `transmit_previous_timeout`
  (`SerialManager::flushResponses` ignores short writes — fw #51); IntervalTimer disarm/rearm per
  command (benign per earlier analysis, but measurable now); refresh ISR vs `loop()` contention.
- Host-side slop: single-flight link (a 0xA9 drain request can delay a 0x70 by one RTT — measure
  telemetry on vs off), coalescing in `FicTracBridgeClient._drain` (newest index wins; #199 wrap),
  bridge WebSocket hop (`rx` vs FicTrac `ms`), Chrome background-tab timer throttling (1 s-aligned
  timeouts seen on night 1), 500 ms link timeout.
- Instruments for later (Michael has none for several days): AD3 + Saleae on the framescan DIO for
  true frame-period jitter (T2), photodiode for glass-to-glass (L-series in
  `controller-telemetry-ring-buffer-proposal.md` §9).

## 7. Tracking

fw #50 (the bug), fw #53 (health PR), fw #54 (ring hardening before course), web #197 (self-healing),
#198 (campaign PR), #199 (index wrap), #200 (fault-lifecycle follow-ups), LAB-149 (ring/perf logging),
LAB-212 (self-healing), LAB-164 (Mode-3 latency). Memory notes for the soak session:
`~/.claude/projects/-Users-reiserm-Documents-GitHub-webDisplayTools/memory/mode3-wedge-fw50.md`.

## 8. Coordination with the running soak session

The soak session owns the bench, the Studio tab, the bridge and the monitor, and will post the
morning analysis. If this session needs a bench experiment (e.g. a telemetry-off iteration, a PSRAM
preload prototype, the synthetic-producer T1 drain test at 5/12.6/50 KB/s), write it up as a bench
request with exact steps and expected measurements; do not run it. Files under `soak-logs/` may be
read at any time; copy, don't move.
