# Telemetry & run-log reference — what is logged, how the clocks merge, how to compute round-trip latency

**Status:** authoritative for the current stack (2026-09-13). Describes **Arena Studio v0.79** (`claude/mode3-perf-sd`
@ `e64bb33`, PRs #198 + #202 → `main`), **fictrac-bridge 3.1**, and the firmware **merge candidate `488d5b9`**
(`feat/mode3-reliability`, fw PR #56; ring v2; 0xCB flags `0x7C`). Firmware citations use the bench-build history
`feat/sd-fastpath-2x10` @ `75405ee`, whose `src/` is byte-identical to `488d5b9` except the per-board variant headers.
Every row shape below was checked against the code AND against real logs (`soak-logs/arena-log-20260913-120611-713.jsonl`
— 5.06 M lines, fw `3c71953`, Studio v0.77 — plus `…-114448-137.jsonl`, `soak-logs/wedges/wedge6-*.jsonl.gz` and a
committed `.jsonl.gz` protocol run from rig05). Diagrams: [`telemetry-reference.html`](telemetry-reference.html).

Companion docs (do not duplicate them): [`mode3-reliability-handoff-2026-09-14.md`](mode3-reliability-handoff-2026-09-14.md)
(the narrative; §7.2 = the four parsing rules), [`runlog-format-review-2026-09-13.md`](runlog-format-review-2026-09-13.md)
(bytes per hour, compaction plan R1–R4), firmware `README.md` (byte tables: "Telemetry ring", "Health + breadcrumb",
"SD fast path", "Build identity"), [`runlog-behavior-v2-plan.md`](runlog-behavior-v2-plan.md) (why `behavior_v2` exists).

**Acceptance numbers (Michael):** display freeze **5 ms target, 10 ms worst case; ≥ 30 ms is a visible artifact.**
`js/trial-quality.js` defaults `target_us = 5000`, `threshold_us = 10000`; firmware `kSdSlowThresholdUs = 10000`.

---

## 0. What is where (one paragraph)

FicTrac (or `fictrac_sim.py`) → UDP → **bridge** (`fictrac-bridge/bridge.py`, Python, same PC as the browser) → WebSocket
→ **Studio** (browser; owns the Web Serial port) → USB CDC → **controller** (Teensy 4.1) → SPI → panels. The bridge
writes ONE NDJSON file per logging session. It originates the FicTrac rows and the session/schema lines; **everything
else in the file is sent by the browser** over the WebSocket — protocol events as `{type:"log", event:…}` objects, and
the controller's telemetry ring as pre-decoded array rows (`{type:"rows"}`). The controller never talks to the bridge.

On `main` today (Studio v0.74) none of the controller streams exist; a `main` reader that meets a `cc`/`cf`/`cs` row
must skip it (rule 2 in the hand-off §7.2). After #198 merges, all readers below are on `main`.

## 1. File anatomy

| line | who writes | shape | source |
|---|---|---|---|
| 1 | bridge | `{"type":"session","event":"logging_started","file":"<name>","ms":<epoch ms>}` | `bridge.py:603` `_open` |
| 2 | bridge | `{"type":"frame_schema","level":"behavior_v2","cols":["ms","fc","idx","ft","x","y","hd"],"arena_cols":["t_off","dt","hex","status","rx_off"],"t0":<epoch ms>}` — **`t0` = line 1's `ms`**, the origin of every `_off` field | `bridge.py:204` |
| 3 | browser (echoed) | `{"type":"log_control","enabled":true,"level":"behavior_v2","dir":"browser→bridge","rx_ms":…}` | `bridge.py:935` |
| … | interleaved | numeric FicTrac rows · `["a",…]` · `["cc"\|"cf"\|"cs",…]` · `{type:"log",…}` events · `{type:"config"}` / `{type:"hello"}` echoes | §2, §3 |
| last | bridge | `{"type":"session","event":"logging_stopped","ms":…}` | `bridge.py:714` |

- **Event envelope.** Every browser `{type:"log", event:X, …}` passes through `write_inbound` (`bridge.py:673`), which
  adds `dir:"browser→bridge"` and `rx_ms` (bridge wall clock at receipt). Browser control messages (`hello`, `config`,
  `log_control`) are echoed the same way. **`{type:"rows"}` batches are NOT enveloped** — `write_rows` (`bridge.py:655`)
  writes each array verbatim after a shape check (`ROW_MIN_LEN = {cc:7, cf:8, cs:7}`, `bridge.py:550`).
- **Levels.** `behavior_v2` (default, this document) · `behavior_v1` (same rows, `arena_command` as objects, no
  `frame_schema.t0`) · `full` (25-column FicTrac objects). Advertised in `hello_ack {bridge, levels, level, logging}`
  (`bridge.py:912`).
- **Rotation + ack.** `log_control{enabled:true, level}` → `set_level`, `reset_base()` (re-zeroes the FicTrac `ms`
  origin and `ft0`, `bridge.py:738`), `start_new_log()` → a fresh `arena-log-YYYYmmdd-HHMMSS-mmm.jsonl` in `--log-dir`
  (default: the bridge's CWD; `--log <file>` appends instead). `enabled:false` closes the file. The bridge replies
  `log_control_ack {enabled, level, requested, file}` (`bridge.py:952`) **to the asking client only — it is a socket
  message, never a log line.** Studio waits ≤ 800 ms for it (`arena_studio.html:8687`); with no ack it assumes
  `behavior_v1` and writes that into `run_metadata.log_format`.
- **Commit path.** At run end Studio gzips the bridge's export and commits `runlogs/<bench>/<name>.jsonl.gz`
  (`GH.commitFile`; > 30 MiB via the Git Database API). Readers inflate on the `1f 8b` magic (`js/runlog-format.js`
  `readRunlogText`). **v0.78 guarantee:** the final ring drain and the `trial_quality` event are written **before** the
  export, on normal and on fault runs (v0.77 files can have controller rows after `trial_quality` — see §7).

## 2. Row catalogue (arrays)

All examples are verbatim lines from `arena-log-20260913-120611-713.jsonl` unless noted. "Clock" names the owner of the
stamp — see §5.

### 2.1 FicTrac behaviour sample — `[ms, fc, idx, ft, x, y, hd]` (7 fields, first element numeric)

`[3,9002558,6,0.0,38.98338,405.69664,0.82451]`

| field | type | clock | meaning | source |
|---|---|---|---|---|
| `ms` | int ms | bridge wall (`time.time()`) | receipt of the FicTrac packet, relative to the last `log_control{enabled:true}` (re-zeroed per activation, so it restarts at 0 on every run/soak iteration) | `bridge.py:775`, `:738` |
| `fc` | int | FicTrac | frame counter (FicTrac col 1) | `behavior_v1_row`, `bridge.py:147` |
| `idx` | int | derived | frame index the bridge computed from heading: `round((deg(hd)+offset)/gain) mod frames`; `gain`/`offset`/`frames` come from the browser's `{type:"config"}` message (pushed per trial by the runner); `0` when gain is unset | `bridge.py:465` |
| `ft` | float ms or `null` | **FicTrac camera clock** | FicTrac col 22 minus its value on the first frame after activation, **÷ 1 000 000 (ns → ms)**; `null` if the record has < 22 fields | `bridge.py:140,147` |
| `x`, `y`, `hd` | float (5 dp) | — | FicTrac cols 15, 16, 17 (integrated x/y, heading rad) | `bridge.py:147` |

**Caveat — simulator `ft` in logs before 2026-09-13 evening.** `fictrac_sim.py` used to fill col 22 in
**milliseconds** while the bridge divides by 1e6 expecting ns, so every simulator-driven log up to and including the
2026-09-13 soaks has `ft` ≈ 1000× too small (the 1280 s run above ends at `ft = 21.962`; the first ~100 frames read
`0.0`). Fixed on `claude/mode3-perf-sd` @ `f16e67e` (col 22 written in ns; sim restarted before the overnight run).
For older sim logs use `ms`, not `ft`. Real-FicTrac `ft` (ns) has not yet been checked on a rig.

### 2.2 Host arena-command echo — `["a", t_off, dt, hex, status, rx_off(, error)]` (6 or 7 fields)

Studio path: `["a",20,2,"03700100",0,22]` · harness path (`sd_stall_test.py`): `["a",312.652,2.285,"03 70 02 00",0,314.953]`

| field | type | clock | meaning | source |
|---|---|---|---|---|
| `t_off` | int ms | browser `Date.now()` − bridge `t0` | time the command entered the host send queue (before the single-flight link wait) | `js/arena-session.js:363`; subtraction `bridge.py:259` |
| `dt` | int ms | browser `performance.now()` | send-queue entry → reply decoded, **including queue wait** behind the previous command | `js/arena-session.js:408` |
| `hex` | string | — | request bytes `len cmd …` (≤ 8 B); Studio logs are unspaced (the bridge strips spaces), the firmware harness writes spaced | `bridge.py:259` |
| `status` | int or `null` | — | reply status byte; `null` = no decodable reply (host timeout ≈ 500 ms — a `dt` near 500 with `null` is the timeout, not a measured RTT) | `js/arena-session.js:391` |
| `rx_off` | int ms | bridge wall − `t0` | when the bridge received the echo (after the reply) | `bridge.py:673` |
| `error` | string | — | 7th element only on failure | `bridge.py:259` |

- One `a` row per non-silent `session.send` — the 0x70 stream, TRIAL_PARAMS, STOP, etc. Silent sends (the 0xA9 ring
  drain, the analog-in poller, GET_HEALTH probes) are not echoed.
- **Requests longer than 8 bytes** (TRIAL_PARAMS 0x08 = 14 B) cannot be compacted (`head` ends in `…`) and are written
  as the v1 object: `{"type":"log","event":"arena_command","t":<epoch>,"dt":6,"len":14,"head":"0d 08 03 24 00 00 00 00 …","status":0,"echo":8,"ok":true,"error":null,"dir":…,"rx_ms":…}`
  (`bridge.py:217,259`). `expandV2Line` / `compactV1Line` in `js/runlog-format.js` are the exact inverses.
- **No field links an `a` row to the FicTrac frame that caused it** (the `fc` → 0x70 gap, §6).

### 2.3 Controller command record — `["cc", rx, t_us, seq, cmd, status, req]` (7 fields)

`["cc",1789315572700,1860411193,427767,8,0,"0324000000000000"]`

| field | type | clock | meaning | source |
|---|---|---|---|---|
| `rx` | float epoch ms | **browser `Date.now()`** | when the 0xA9 block containing this record was parsed — **one value for every record of the block**, up to ~100 ms after the event (10 Hz poll); NOT the command's time, NOT a bridge stamp | `js/arena-telemetry.js:341`, `:222` |
| `t_us` | u32 µs | controller `micros()` | **receipt of the command, before dispatch** (`t_rx_us`); wraps every 71.6 min | fw `CommandProcessor.cpp:142`, `:984` |
| `seq` | u32 | controller | ring append order; contiguous unless records were evicted | fw `Telemetry.cpp` `append` |
| `cmd` | int | — | opcode (8 = TRIAL_PARAMS, 112 = 0x70 SET_FRAME_POSITION, …) | |
| `status` | int | — | the reply's status byte | fw `CommandProcessor.cpp:984` |
| `req` | hex string | — | first ≤ 8 request bytes **after** `len cmd` (so a 0x70 for index 45 is `"2d00"` while the `a` row has `"03702d00"`) | fw README "Telemetry ring" |

Not recorded by the firmware: 0xA9 itself, 0x32 stream frames, 0x85/0xE0 bulk headers, 0x01 SYSTEM_RESET.

### 2.4 Displayed frame change — `["cf", rx, t_us, seq, idx, pattern, sd_load_us, spi_us, req_age_us, superseded, flags]` (11 fields; **8 on ring-v1 firmware**)

`["cf",1789315572700,1860419028,427768,0,36,1340,776,4833,0,3]`

| field | type | clock | meaning | source |
|---|---|---|---|---|
| `rx`, `seq` | | | as `cc` | |
| `t_us` | u32 µs | controller | **start of the SPI transfer** that put this frame on the panels | fw `CommandProcessor.cpp:1763` |
| `idx`, `pattern` | u16 | — | frame index and SD pattern id now displayed | |
| `sd_load_us` | u32 µs | controller | duration of the SD read that produced the buffer (`last_sd_read_us`) | |
| `spi_us` | u16 µs (sat.) | controller | transfer duration (~776 µs on a 2×10) | |
| `req_age_us` | u32 µs | controller | dispatch of the 0x70 that requested this frame (Mode 2/4: the `loadFrame` decision) → SPI start. **The request→presentation latency, measured on one clock.** | fw `CommandProcessor.h:104` |
| `superseded` | u8 | — | SD frames loaded into the buffer but replaced before any transfer since the previous FRAME record | |
| `flags` | u8 | — | bit0 buffer came from an SD read · bit1 the open pattern file is contiguous (O(1) seek path). `3` = both | fw `Telemetry.h` `kFrameFlag*` |

- Only **changes** are recorded (`cur_frame_index_ != tel_last_frame_ || pattern != …`); a held frame produces nothing.
- Ring v1 (fw before `3c71953`): 8 fields, no `req_age_us`; **consumers gate on length**, never assume 11.
- Trial verdicts use `sd_load_us` from FRAME records too (v0.78), so a slow read counts even when no `sd_slow` STATE
  was emitted (ring v1 flagged only > 20 ms).

### 2.5 Controller state / error / boot — `["cs", rx, t_us, seq, kind, code, arg]` (7 fields)

`["cs",1789315572700,1860414194,427764,7,0,36]` · `["cs",…,11,1,8]` · `["cs",…,13,0,9173]` · `["cs",…,4,0,327]` (ring v1: 32.7 ms read)

| kind | name | `code` | `arg` | when |
|---|---|---|---|---|
| 1 | `boot` | reset-cause bits (bit 7 = watchdog, as decoded by `wedge-scan.py`) | previous breadcrumb op | first record after a reset (ring contents survive a soft reset; `boot_count` in the block header) |
| 2 | `state_change` | controller state id | context (pattern id in the samples) | display state machine transitions (STOP, SHOW_FRAME, …) |
| 3 | `error_glyph` | error | — | an error glyph was shown on the arena |
| 4 | `sd_slow` | bits 0–1 slowest phase: 1 seek · 2 body · 3 CRC trailer; bit 7 = read error | read µs **/ 100**, saturating | a `readFrame` > **10 ms** (ring v2; 20 ms on v1) |
| 5 | `ring_overrun` | `0x00` evicted · `0xFF` heap collision (ring disabled for the session) | records evicted since the last marker | overflow episode (≥ 1 s apart); the durable signal is the header `dropped` counter + `seq` gaps |
| 6 | `telemetry` | opcode that changed settings (`0xCE` for SD diag) | new flags | SET_TELEMETRY / SET_SD_DIAG; also `[…,6,1,0]` right after boot |
| 7 | `sd_open` | 0 = ok, else error | pattern id | pattern opened → **trial boundary** for `trial-quality` (`code === 0`) |
| 8 | `wdog_context` | watchdog handler's EXC_RETURN low byte (`0xF9` thread, `0xF1` handler) | IPSR bits 0–8 \| `isr_last << 9` | first boot after a watchdog reset |
| 9 | `prev_isr_count` | ISR id (4 usb · 5 sdhc · 6 lpspi · 7 pit) | `min(65535, count >> 12)` | after a watchdog reset, one per ISR with a count |
| 10 | `timer_fail` | 0 | requested refresh Hz | `IntervalTimer::begin()` failed |
| 11 | `sd_layout` | bit0 contiguous · bit1 exFAT · bit2 legacy seek forced (diag) · bit3 same-index skip off (diag) | sectors per cluster (8 = 4 KiB) | after each `sd_open` |
| 12 | `sd_slow_ctx` | SdFat sticky `errorCode()` | USDHC `IRQSTAT` bits 16–31 | immediately after every `sd_slow` |
| 13 | `sd_reads` | shift | reads for that open = `arg << code` | pattern close / re-open |
| 14 | `sd_reads_ckpt` | shift | cumulative so far = `arg << code` (lower bound if the run dies) | every 30 k reads while open (fw flag bit 6) |

Source: fw `src/Telemetry.h:169–214` (`StateKind`, `kSdSlow*`, `kFrameFlag*`, `kSdSlowThresholdUs`),
`CommandProcessor.cpp:2151–2178`; names mirrored in `js/arena-telemetry.js:45` `STATE_KINDS` and written into every
file's `stream_schema` (a log from fw `3c71953` lists kinds 1–13; `488d5b9` lists 1–14).

**Ordering inside one dispatch:** STATE records are appended *during* a handler, the CMD record *after* it — so a
trial's `sd_open`/`sd_layout` (`seq` 427764/765) precede the TRIAL_PARAMS `cc` (427767) while carrying a **later**
`t_us`. Rows are in ring order in the file; **never sort controller rows by `rx` or `t_us`, order by `seq`.**

## 3. Event catalogue (objects)

All are `{"type":"log","event":<name>,…,"dir":"browser→bridge","rx_ms":<bridge epoch ms>}` unless marked. Emitters are
Studio v0.79 (`arena_studio.html`) or the named module; the bridge only adds the envelope.

| event | emitter | when | fields |
|---|---|---|---|
| `run_metadata` | `arena_studio.html:8719` (meta half built by `js/run-log.js:184`) | run start, after the level ack | `rig_id`, `log_format` (acked level), `run_id`, `experimenter`, `genotype`, `age`, `sex`, `fly_number`, `notes`, `protocol_filename`, `protocol_sha256` (`null` for test intent), `arena_config`, `rig`, **`firmware`** (0xCB label, e.g. `"3c719534 2x10 2026-09-13 feat/sd-fastpath-2x10 freerun sdfast"`), `controller_id` (MAC), `tool_version`, `timestamp_start` (ISO), **`telemetry`** (`"ring-10hz"` \| `"off"`), **`sd_card`** (0xCD identity `{label, manufacturer, pnm, prv, psn_hex, mdt, capacity_gb, card_type, fat, bytes_per_cluster, cid_hex, sd_diag}` or `null`), **`gap_threshold_ms`** (10), `soak` `{iteration, policy, first_fault}` (soak runs only) |
| `stream_schema` | `arena_studio.html:8740` | right after `run_metadata`, when the ring is on | `streams: {cc:{cols,desc}, cf:{cols,desc}, cs:{cols,desc,kinds}}` = `ArenaTelemetry.STREAM_SCHEMA`. **`cols` omit the tag: `cols[i]` ↔ `row[i+1]`** (whereas `frame_schema.cols[0]` ↔ `row[0]`) |
| `runner` | `js/arena-session.js:513` | every runner status | `phase` (`sequence-start`, `trial_start`, `condition-start`, …), `index`, `total`, `op`, `value`, `reason`, `message`, `level`, `durationSec`, `conditionName`, `params`, `condition`, `status`/`ok` (allow-listed by `_sanitizeRunStatus`, `:522`) |
| `log` | `js/arena-runner-g6.js:1454` | runner INFO/WARN lines | `message`, `level` |
| `config` (`type:"config"`, no `event`) | `js/fictrac-bridge-client.js` per trial | closed-loop trial start | `fictrac_port`, `gain`, `offset`, `frames` — the bridge's `idx` parameters |
| `arena_command` | `js/arena-session.js:391` | > 8-byte requests (TRIAL_PARAMS) | v1 object, see §2.2 |
| `trial_quality` | `arena_studio.html:8264` ← `js/trial-quality.js:246` `summary()` | **once, at run end, before export** (v0.78) | `threshold_us`, `target_us`, `trials[]`, `counts {pass, fail, unknown, open}`, `worst_gap_us`, `flagged_trials[]`, `unknown_trials[]`, `duplicates_dropped`, `records`. Per trial: `trial`, `pattern`, `status` (`pass`\|`fail`\|`unknown`), `duration_s`, `cmds70`, `index_changes`, `reads`, `frames`, `slow_reads`, `stalls`, `max_read_ms`, `age_gaps`, `max_age_ms`, `over_target`, `superseded`, `coverage[]` |
| `display_gap` | `js/trial-quality.js:101` `gapEvent` → `arena_studio.html:8479` | one per gap > threshold, as it happens | `trial`, `pattern`, `seq`, `t_us`, `ms`, `kind` ∈ `sd_slow` (+ `phase`, `read_error`) · `frame_read` (+ `idx`; a slow read seen only in the FRAME record) · `frame_age` (+ `idx`; `req_age_us` > threshold). Absent from a clean run |
| `soak` | `arena_studio.html:8317` `logSoak` | soak driver phases | `phase` ∈ `start` · `iteration-start` · `iteration-end` · `paused` · `end`; `iteration-end` carries `iteration`, `outcome`, `fault`, `stop_acked`, `postmortem`, `applied_0x70`, `duration_s`, `telemetry` (drainer stats: `ackSeq`, `lastSeq`, `records`, `blocks`, `bytes`, `gaps`, `dropped`, `errors`, `notStored`, …). **`dropped` is the controller's lifetime evicted-record counter from the block header** (1157 with `gaps: 0` in the sample = eviction before the drainer started, not in-run loss) |
| `sd_diag` | `arena_studio.html:8543` | `Studio.setSdDiag()` and the v0.79 connect banner | `flags`, `in_force` (GET_SD_INFO byte 29), `label` |
| `probe` | `js/studio-postmortem.js:112` | post-mortem after a controller fault | `name`, `phase`, `cmd`, `req`, `sd`, then `dt`, `resp`, `status`, `ok`, `decoded` — or `error`, or `skipped: "capability X absent"`. The health read appears here as `name:"health"` with `decoded` |
| `telemetry_dump` | `arena_studio.html:8580` | post-mortem | `summary {tag, records, blocks, survivedReboot, bootCount, dropped, gaps, heapCollision, tail[]}`, `raw_blocks[]` (hex) |
| `crash_report` | `arena_studio.html:8554` | post-mortem, fw flag bit 3 | `present`, `fault`, `ret_addr`, `cfsr`, `hfsr`, `bfar`, `mmfar`, `raw_hex` (junk after a HalfKay reflash — known) |
| `health` | `arena_studio.html:5587` | **Console `chealth` only** | `source:"console"`, `health` (decoded 0xCA) |
| `analog_loopback_sweep` | `arena_studio.html:5303` | Console Analog In panel | `channel`, `rows`, `fit`, `verdict` |

Not log lines: `hello_ack`, `log_control_ack` (socket replies). Not implemented: `soak_note` (an operator can type
`bridge.log({event:'soak_note', …})` in the console; no code emits it).

## 4. Controller reads (pointer table — byte layouts live in the firmware README)

| opcode | name | gate | reply | README § | Studio decoder |
|---|---|---|---|---|---|
| 0xA8 | `SET_TELEMETRY` `[04 A8 flags rate_lo rate_hi]` | 0xCB bit 2 | echo | Telemetry ring | `js/arena-wire-g6.js:74` |
| 0xA9 | `GET_TELEMETRY_BLOCK` `[08 A9 ack_seq(u32) max_bytes(u16) flags]` — frees `seq ≤ ack_seq`, returns **18-B header** `{t_now_us u32, first_seq u32, n_records u16, dropped u32, more u8, flags u8, boot_count u16}` + whole records (`len, type, seq u32, t_us u32, payload`; CMD 13–21 B · FRAME 26 B · STATE 14 B, little-endian) | bit 2 | ≤ 196 B | Telemetry ring | `js/arena-telemetry.js:103` `parseBlock`; drain loop `createDrainer` `:272` (ack = stored by the bridge; loop on `more`; 200 chunks/poll; 10 Hz poller `:445`) |
| 0xCA | `GET_HEALTH` | 0xC2 capability bit 7 | **ver 5, 114 B** | Health + breadcrumb | `decodeHealth` `:744` |
| 0xCB | `GET_FIRMWARE_VERSION` | cap bit 7 | 46 B `{ver, rows, cols, flags, sha[8], date[10], branch[24]}`; flags: bit0 dirty · 1 debug · **2 telemetry ring · 3 crash report · 4 free-running refresh · 5 SD fast path (0xCD, FRAME v2, kinds 11–13) · 6 SD diag (0xCE, kind 14)** | Build identity | `decodeFirmwareVersion` `:942` → `run_metadata.firmware` |
| 0xCC | `GET_CRASHREPORT` | bit 3 | 128 B raw | Watchdog | `decodeCrashReport` `:881` |
| 0xCD | `GET_SD_INFO` | bit 5 | 30 B (CID, FAT type, cluster size, `sd_status_maint`, byte 29 = diag readback) | SD card identity | `decodeSdInfo` `:1026` → `run_metadata.sd_card` |
| 0xCE | `SET_SD_DIAG` `[02 CE flags]` | bit 6 | echo | A/B switches | `Studio.setSdDiag` |

**Gating rule:** every ring-era feature is gated on a **0xCB flag bit, never on the 0xC2 capability byte** (it is full;
its bit 7 is `health`). An ungated opcode gets `CE_UNKNOWN_CMD` and an error glyph on the arena.

## 5. Timestamp merging — the clocks and how to align them

### 5.1 Every stamp in the file

| stamp | in | clock | absolute / relative | notes |
|---|---|---|---|---|
| `t0` | `frame_schema` | bridge wall (`time.time()`) | epoch ms | origin of `t_off`, `rx_off`; equals line 1's `ms` |
| `ms` | FicTrac row | bridge wall | relative to the last `log_control{enabled}` (`t0_ms`, a *different* variable set µs after `t0`; treat as `t0`) | UDP receipt |
| `ft` | FicTrac row | **FicTrac camera** (col 22, ns) | relative to the first frame after activation | the only stamp from the tracker's clock; sim value broken (§2.1) |
| `t_off` | `a` | **browser** `Date.now()` | − `t0` | send-queue entry |
| `dt` | `a` | browser `performance.now()` | duration | includes host queue wait |
| `rx_off` | `a`, `rx_ms` on events | bridge wall | − `t0` / epoch | bridge receipt of the browser message |
| `rx` | `cc`/`cf`/`cs` | **browser** `Date.now()` | epoch ms (float) | 0xA9 block parse time; shared by the block; ≤ 100 ms late |
| `t_us` | `cc`/`cf`/`cs` | **controller** `micros()` | u32, wraps 71.6 min | CMD = receipt-before-dispatch; FRAME = SPI start; STATE = at the event |
| `t_now_us` | 0xA9 header (not in the file today) | controller | u32 | reply time; the natural host↔controller pair point (`rx`, `t_now_us`) — not logged, see §8 |

Three clocks, then: **FicTrac** (`ft`), **host** (bridge and browser are the same PC — `t0`, `ms`, `t_off`, `rx_off`,
`rx` are all host epoch ms; the browser and bridge processes read the same OS clock, so treat them as one clock with
sub-ms process latency), **controller** (`t_us`). The file mixes bridge-stamped (`rx_off`) and browser-stamped (`rx`)
host times without a marker; both are host epoch, so the mix is harmless for alignment but confusing to read
(format review R2 proposes `drain_ms`, t0-relative).

### 5.2 Rules

1. **Order controller rows by `seq`** (= file order). `rx` is quantised to the drain (13 rows share one `rx` in the
   sample), and `t_us` runs backwards across a STATE→CMD boundary (41 such steps in the 20-trial log = one per
   `sd_open`+TRIAL_PARAMS). `seq` gaps = evicted records (`dropped` in the header grows).
2. **Unwrap `t_us`** with `seq`: consecutive records are ≤ seconds apart, so a decrease of ~2³² µs is a wrap.
   Discard a **pre-run backlog** (ring contents from before connect) by its offset: `rx − t_us/1000` differs from the
   run's offset by seconds.
3. **`a` ↔ `cc` join is by order**, not by key: both are complete sequences of the same commands (host echo vs
   controller record); counts differ by the commands in flight at the end (and, on v0.77 files, by the tail written
   after `trial_quality` — `runlog-check.py` reports both). A host command counter on `a` is R2 in the format review.
4. **Host↔controller offset is a fit, not a constant.** Pair 0x70 `a` rows with 0x70 `cc` rows by order, take
   `t_host = t0 + a.t_off` vs `cc.t_us` (unwrapped), fit `t_host = α + β·t_us`. Measured 2026-09-12 on one run: slope
   **−3 ppm**; residuals = USB/CDC queueing + `serviceUsb` (one command per `loop()`). **Not implemented in any
   script** — `telemetry-report.py` and `wedge-scan.py` never fit clocks; it is a recipe. A cleaner pair point is
   (`rx`, `t_now_us`) once the block header time is logged (§8).
5. **FicTrac ↔ host:** `ms − ft` is constant plus camera→UDP latency, only on a real rig (sim `ft` is unusable).
   Never measured.

### 5.3 Per-edge evidence

| edge | what the file gives | status |
|---|---|---|
| camera → FicTrac → bridge | `ms − ft` (real FicTrac only) | **unmeasured** on a rig |
| bridge → browser → `apply` → send | nothing: the `a` row carries no `fc`; the client coalesces frames (newest index wins, `js/fictrac-bridge-client.js:584`) with no counter | **not derivable** |
| host send → controller dispatch | `cc.t_us` (via the §5.2.4 fit) − (`t0 + a.t_off`) | derivable; measured once (−3 ppm, residual = USB) |
| dispatch → SD read → SPI start | **`cf.req_age_us`** (ring v2) or `cf.t_us − cc.t_us` by `seq` (v1); split: `sd_load_us` + tick wait (0–3.3 ms at 300 Hz) + loop | **measured per frame**: p50 1.72 ms, p99 2.56, max 4.8 ms (20 trials, 2026-09-13, fw `3c71953`) |
| SPI transfer | `cf.spi_us` ≈ 776 µs | measured |
| SPI end → LEDs lit | — | **unmeasured** (needs a light sensor, §8) |
| controller reply → host | `a.dt` − in-controller time (≈ `req_age_us` when the frame changed, else ~0.1 ms) | derivable; `a.dt` median 2 ms, includes queue wait |
| event → log line | `rx − t_us` (after the fit) | ≤ 100 ms drain lag; seconds when the bridge refuses rows |

## 6. Round-trip timing recipe (one closed-loop step)

Chain: FicTrac frame *k* → bridge (`ms_k`, `ft_k`) → browser apply → 0x70 sent (`a.t_off`) → controller receipt
(`cc.t_us`) → SD read (`cf.sd_load_us`) → wait for tick → SPI start (`cf.t_us`; `cf.req_age_us` covers receipt→SPI)
→ LEDs (unmeasured) ; reply → browser (`a.t_off + a.dt`).

| step | compute | clock(s) | today |
|---|---|---|---|
| 1. tracker → bridge | `ms_k − ft_k` (constant offset + jitter) | FicTrac vs host | real rig only |
| 2. bridge → 0x70 sent | needs `fc` on the `a` row | host | **not derivable** — bound it: ≤ one FicTrac period + coalescing |
| 3. sent → controller receipt | `fit(cc.t_us) − (t0 + a.t_off)` for the paired rows | host→controller (fit) | median ≈ 1–2 ms, tail = USB |
| 4. receipt → SPI start | `cf.req_age_us`; `sd_load_us` is the SD part, the rest is the refresh-tick wait | controller only (no fit) | 1.7 ms p50 / 4.8 max; +1 step reads 0.62 ms, any other step 1.19–1.46 ms |
| 5. SPI | `cf.spi_us` | controller | 0.78 ms |
| 6. LED latch + update | — | — | unmeasured (§8 #3) |
| 7. reply → host | `a.dt − step 4` | host | ≈ 2 ms − 1.7 ms |

**Glass-to-glass today** = step 1 + [step 2 unknown] + step 3 + `req_age_us` + `spi_us` + [step 6 unknown]. The two
unknowns are the reason for §8 items 3 and 5. **Superseded frames** (`cf.superseded`, 0.5 % of frames in the sample) are
requests that never reached the panels because a newer one arrived first — the controller-side coalescing; the
host-side coalescing (bridge client) is uncounted.

## 7. Readers and tools

| tool | reads | does |
|---|---|---|
| `js/runlog-format.js` (+ byte-identical copy `dashboard/data-browser/vendor/runlog-format.js`, divergence test) | any level, gzip | `readRunlogText` inflates; `createNormalizer().normalize(rec)` expands **only `"a"` arrays** to v1 objects and passes every other array through unchanged — **callers skip string-tagged rows** (`dashboard/data-browser/analysis-core.js`, `js/runlog-replay.js`; both guards ship with #198) |
| `scripts/telemetry-report.py` | `cc`/`cf`/`cs` + `run_metadata` (skips `a` and FicTrac) | reads per pattern, SD cost by index-step class, stall clusters (with spacing in commands / index changes / s), `req_age_us` percentiles, per-trial verdicts — same rule as `trial-quality.js` (`fail` if any stall or age gap; `unknown` if coverage gaps) |
| `scripts/runlog-check.py` | whole file | completeness: metadata, `stream_schema`, `trial_quality` present and after the last controller row, `cc` 0x70 vs `a` counts, drainer stats, FicTrac rows per trial-second, `display_gap` ↔ `trial_quality` provenance; exit 1 on a problem |
| `scripts/wedge-scan.py` | `a` (+ v1 objects), `cc`/`cf`/`cs`, events | wedge onset/outcome, host RTT median/p99/max (from `a.dt`), controller-order and host-order tails around a `boot` |
| firmware `scripts/sd_stall_test.py` | writes the same row shapes (browser-free) | card comparisons; exact worst/cluster stats (Codex rounds 1–4 applied on `75405ee`) |
| `tests/telemetry_codec.py` (fw), `tests/test-arena-telemetry.js`, `tests/test-trial-quality.js`, `tests/test-telemetry-report.py`, `tests/test-wedge-scan.py` (web) | — | the shape oracles: change a column → these fail |

Sample, `arena-log-20260913-120611-713.jsonl` (v0.77, fw `3c71953`, 2 soak iterations, 20 trials, 1280 s):

```
telemetry-report:  pattern 36: 121 001 accepted 0x70 · 91 874 index changes · 91 884 fw reads · 0.759 reads/cmd · contiguous, 8 spc
                   SD read cost (µs): +1 step p50 621 · other steps p50 1460 (pat 36) / 1190 (pat 5) · max 1798
                   stalls > 10 ms: 0 · req_age p50 1716 · p90 2555 · p99 2556 · max 4835 · superseded 0.5 % · trials {'pass': 20}
runlog-check:      firmware 3c719534 … freerun sdfast · verdicts {'pass': 20} · cc_0x70_ok 242178 vs a_ok 242200
                   ! trial_quality at line 923845 BEFORE the last controller row at 924204   ← v0.77 export ordering (fixed v0.78)
```

## 8. Gaps → instrumentation (ranked; Teensy-only first, no AD3 / Saleae)

| # | gap | smallest fix | where |
|---|---|---|---|
| 1 | CMD `t_us` is dispatch-side; USB queue time invisible | stamp `micros()` in `SerialManager::parseIncoming` when `cmd_ready_`, carry on `ParsedCommand`, add to CMD (or a STATE) | fw |
| 2 | no host↔controller pair point without the order-join | log the 0xA9 header `t_now_us` with the block `rx` (one `["ct", rx, t_now_us, first_seq]` row per block, or in `soak`/drainer stats) → direct fit, ~10 pairs/s | `js/arena-telemetry.js` `toRows` |
| 3 | SPI start → light unmeasured | photodiode/phototransistor on **Analog In 1**; arm the i.MX RT ADC compare interrupt after each transfer, record `light_us − cf.t_us` as a FRAME field or STATE (bench build: poll ≤ 5 ms after `transferFrame`); alternate dark/lit frames at the sensor | fw (analog-in path exists: 0xA4–0xA7) |
| 4 | framescan envelope not cross-checked | loop `out_debug_framescan` (Digital IO 1) into Digital IO 2 as an edge-interrupt input; timestamp both edges → validates `spi_us` and tick phase | fw + one wire |
| 5 | FicTrac frame → 0x70 not linkable | add `fc` to the `arena_command` object / `a` row (one int; R2 in the format review); optionally echo 2 bytes in the 0x70 payload the firmware ignores so it lands in `cc.req` | `js/arena-session.js`, `bridge.py` (+ readers) |
| 6 | host coalescing uncounted | counter at the `_pending` overwrite (`js/fictrac-bridge-client.js:584`) → drainer/`soak` stats and run end | web |
| 7 | refresh-tick phase unknown | record `micros()` (or a 16-bit counter) in `refreshISR`; log tick→transfer per FRAME → separates "waited for the tick" from "loop busy" | fw |
| 8 | `rx` semantics confuse readers | schema v3: `drain_ms` t0-relative (format review R2); until then, this document | web |
| 9 | sim `ft` unit bug (§2.1) | **fixed** `claude/mode3-perf-sd` @ `f16e67e` (col 22 in ns); logs before the overnight of 2026-09-13 keep the wrong `ft` | bridge |
| 10 | LEDs / camera with instruments | proposal §9 L1–L4 (AD3-toggled IR LED in the camera view, Saleae on framescan + photodiode, motorised ball) — when instruments are back | bench |

## 9. Next experiments (state as of 2026-09-13 evening) and document lineage

**Done:** control iterations on the fast-path build (482 k commands, 0 stalls, 40/40 pass) · 4-arm causal test (FAT
access is the cause; same-index skip irrelevant) · 1 h at 286 Hz (1.04 M commands, 0 reads > 1.8 ms) · 13 × 10-min
286 Hz campaign (one 19.4 ms body-phase read on the 8 MB sine — the watch item). **Running:** overnight benchmark on
`488d5b9` per [`overnight-soak-test-plan-2026-09-13.md`](overnight-soak-test-plan-2026-09-13.md) (its §4 lists what the
night does NOT test).

**Open, in the order they pay off:**
1. Photodiode on Analog In (§8 #3) — the only way to turn `req_age_us` into latency-to-light.
2. `t_now_us` pair rows + `fc` on `a` (§8 #2, #5) — makes the whole chain derivable from one file; then run it on a
   real FicTrac rig (camera clock).
3. Working-set test on the same file (`sd_stall_test.py --window 50/100/200`) — card read-cache vs placement.
4. `0x32` host streaming at 100/200/286 Hz — removes SD entirely; tests USB against the deadline.
5. Telemetry on vs off control iteration — the instrumentation's own cost.
6. Card screening when cards arrive (protocol: archive `sd-read-jitter-2026-09-13.md` §5); never reformat the bench card.
7. Resident decode (compressed per-frame RAM cache) — only if a read-free path is still wanted after the benchmark.

**Lineage — which document owns what now:**

| document | status | owns |
|---|---|---|
| this file | living | row/event catalogue, clocks, latency recipe, gaps |
| `mode3-reliability-handoff-2026-09-14.md` | living | the narrative, firmware layers, test history, ship plan, parsing rules §7.2 |
| `runlog-format-review-2026-09-13.md` | living | bytes per hour, compaction R1–R4 |
| `runlog-behavior-v2-plan.md` | living | why `behavior_v2` / `.jsonl.gz`; the level negotiation design |
| `controller-telemetry-ring-buffer-proposal.md` | design record | the ring's rationale, T1–T6, instrument plan L1–L4 (§9); as-built layouts differ — see §2, §4 here |
| `telemetry-review-handoff-2026-09-13.md` | **delivered by this file** — suggested header for the clean-up: *"Deliverables (1)–(4) landed in `telemetry-logging-reference.md`; kept for the experiment rationale in §5."* | Teensy-only measurement rationale |
| `archive/mode3-2026-09/*` | history | see its README |
