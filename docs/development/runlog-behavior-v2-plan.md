# Run-log format `behavior_v2` + large-file commit path — PLAN (PRs 1–3 implemented 2026-09-06)

Owner: Michael. Drafted 2026-09-06 from the analysis of rig03-sr run `rydc2tql`
(40 s trials, 51.4 MB, failed to auto-commit). Status: **all three PRs implemented
2026-09-06** (bridge #183 → Studio → readers, stacked) — see the implementation notes
at the end. None bench-tested yet. **Merge order:** PR 3 (readers) must be live before
or together with PR 2 (Studio): once PR 2 is live, new course runs commit as
`.jsonl.gz`, which only PR 3's readers open.

## Problem

The Studio commits run logs through GitHub's Contents API, which rejects files over
~35 MiB (measured: 35 OK, 40 → HTTP 422). A 20 s-trial P3 full run is ~26 MB; a 40 s
run is ~51 MB; an hour-long run would be ~85 MB. Composition of the 51 MB file:

| Line type | Lines | Bytes | Share |
|---|---|---|---|
| `arena_command` echo (one per 0x70 closed-loop frame command, ~100 Hz) | 217,204 | 41.1 MB | 76% |
| behavior frame `[ms,fc,idx,ft,x,y,hd]` (behavior_v1) | 218,708 | 12.7 MB | 24% |
| runner events + session/metadata lines | 860 | 0.1 MB | <1% |

Each `arena_command` line is a 189-byte object whose payload is four numbers; the rest is
constant strings and derivable fields. gzip compresses the whole file 8.0× (6.7 MB).

## Goals / non-goals

- **Lossless.** Every value recoverable from a v1 file must be recoverable from v2:
  bit-identical numbers (no rounding), every event, every field. Verified by a
  round-trip test (v1 → v2 → v1 canonical JSON equality).
- Hour-long runs commit from the browser with headroom; the dashboard and the replay
  viewer read v1 and v2 transparently.
- Non-goals: changing what is measured; changing the behavior frame array (already
  58 B/line, would need lossy rounding to shrink); Git LFS (Contents API returns the
  pointer, breaking every reader; bandwidth quotas).

## Part 1 — `behavior_v2` line format (bridge `fictrac-bridge/bridge.py`)

The level name in `frame_schema` / `log_control` becomes `behavior_v2`. Frame arrays
are **unchanged** (`[ms,fc,idx,ft,x,y,hd]`, same columns, same precision). What
changes is the *other* line types:

1. **Schema line gains the arena-echo layout**:
   `{"type":"frame_schema","level":"behavior_v2","cols":[...],"arena_cols":["t_off","dt","hex","status","rx_off"],"t0":<epoch ms>}`
   `t0` = the session's `logging_started.ms`; all `*_off` values are ms offsets from
   it (small ints), which is what makes the arrays short.
2. **`arena_command` → `"a"` array line**: `["a", t_off, dt, "03702e00", status, rx_off]`
   - `t_off = t − t0`, `rx_off = rx_ms − t0` (both kept — rx_ms is the bridge receive
     time, not derivable from t+dt exactly).
   - `hex` = the `head` bytes without spaces (v1 `head` is reconstructed by inserting
     spaces; `len` = hex length / 2; `echo` = second byte; `ok` = status === 0).
   - `status` = integer, or `null` when the command timed out (v1 `status: null`).
   - `error` is `null` in every v1 line observed; when non-null it is appended as a
     7th element so nothing is dropped: `["a", …, rx_off, "error text"]`.
   - Constant v1 fields `type:"log"`, `event:"arena_command"`, `dir:"browser→bridge"`
     are implied by the `"a"` tag and restored on export.
   - Size: 217k lines × ~24 B ≈ 5.3 MB (measured on the real file) vs 41.1 MB.
3. **Runner / session / metadata / config lines stay verbatim JSON objects** (0.1 MB;
   readability matters more than bytes there). `run_metadata` gains
   `"log_format":"behavior_v2"` for readers that skip the schema line.
4. **Lossless proof**: `tests/test-bridge-behavior.py` gets `v1→v2→v1` round-trip
   cases built from real line samples (ok, status-1 reject, timeout/null status,
   non-null error, unknown extra key → must raise, not drop). Add a CLI
   `bridge.py --convert in.jsonl out.jsonl` (both directions) so existing course
   files can be re-encoded for the migration and so the dashboard can be tested on
   real data before a rig produces v2.
   **Corpus test (gate for every PR in this series):** `scripts/runlog-v2-corpus.py`
   runs against the local course-repo clone (`/Users/reiserm/Documents/GitHub/
   cshl-2026-course`, 165 run logs / 1.2 GB, all v1) and, for EVERY file: converts
   v1→v2→v1 and asserts canonical-JSON identity line by line; records v1 / v2 / v2.gz
   sizes; fails on any line whose keys are not in the known v1 set (older July logs,
   legacy `_a`/`_b` protocols and `full`-level logs are exactly the variants the five
   hand-picked samples would miss). Output = one table committed to the PR
   description. Not part of `pixi run test` (needs the clone), like the dashboard's
   `test-analysis.js`.
5. **Runtime log level — four places must change, bridge first.** Today the level is a
   Studio setting (File ▾ → Run logging `#fmLogLevel`, localStorage `studio_log_level`,
   advanced-only) that the runner ASSERTS at run start via `log_control`. The chain:
   - `fictrac-bridge/bridge.py` `set_level()` + the `log_control` handler (line ~515)
     accept only `behavior_v1 | full` and **silently ignore anything else** — so a new
     Studio asking an old bridge for `behavior_v2` would get a v1 file with no error.
     Bridge change: accept `behavior_v2` (new default for a fresh bridge), write the
     compact lines, and **acknowledge the level actually in force** — reply to
     `log_control` with `{"type":"log_control_ack","level":…}` and advertise
     `"levels":[…]` in the hello reply so the browser can tell.
   - `js/fictrac-bridge-client.js` `setLogLevel()` whitelist (line ~274) gains
     `behavior_v2`; it records the acked level and emits a warning event on mismatch.
   - `arena_studio.html`: `#fmLogLevel` gains `behavior_v2 (compact — default)`; the
     stored-value default becomes `behavior_v2` when nothing is stored; an explicitly
     stored `behavior_v1` is honored for one release (then dropped); the run-start banner
     names the level the bridge acknowledged, and warns "bridge too old for behavior_v2 —
     logging behavior_v1" when the ack disagrees. `full` (25-col FicTrac) unchanged.
   - Console `#cFtLogLevel` read-only mirror shows the acked level.
   Ship order: bridge PR first (backwards compatible — old Studios never send v2), then
   the Studio PR. Benches must `git pull` + restart `pixi run bridge` (the existing
   stale-bridge lesson) — the ack makes a stale bridge visible instead of silent.

Expected: 40 s full run 51 MB → ~18 MB; 1 h run → ~30 MB. Still tight vs 35 MiB for
hour-long runs — hence Part 2.

## Part 2 — Studio commit path (`arena_studio.html` classic shell + `js/studio-github.js`)

1. **gzip on commit.** After `bridge.exportLog()`, compress in the browser with the
   native `CompressionStream('gzip')` (Chrome ≥ 80) and commit `<name>.jsonl.gz` via
   the existing `contentBytes` path (already used for `.pat`). Lossless by
   definition; 8× (v1) to ~6× (v2, already denser). The uncompressed JSONL is never
   committed for recorded runs any more; `.jsonl.gz` is the archival format.
   Filename stays colon-free.
   Expected sizes: 40 s run ≈ 2.5 MB; 1 h ≈ 4 MB.
2. **Size-based fallback to the Git Database API** for any payload > 30 MiB after
   compression (defensive; only multi-hour runs or `full`-level logs get there):
   `POST /git/blobs` (base64) → `GET /git/trees/<head>` → `POST /git/trees` (base_tree
   + one entry) → `POST /git/commits` → `PATCH /git/refs/heads/<default>`. Same token,
   same `WRITABLE_PREFIXES` allowlist, one new orchestration `directCommitLarge` in
   `studio-github.js` with pure request builders + tests (mocked fetch, like
   `directCommit`). GitHub hard limit is 100 MiB per file.
3. **Manual "⇪ Push log" and the run-summary line** report the compressed size and
   which path was used. The existing 401 → `Studio.dropInvalidToken` handling applies.
4. **Docs**: `cshl-pipeline-test-plan.md` size-limits table (35 MiB row → "raw; gz
   ≈ 6–8× smaller; >30 MiB gz uses the Git Database path"), `data-repo-setup.md`,
   release notes, CLAUDE.md gotcha ("run logs are `.jsonl.gz`; readers must inflate").

## Part 3 — Readers (dashboard `dashboard/data-browser/`, replay viewer, kinematics)

1. **Inflate on read**: `github-repo.js` / `app.js` detect `.gz` (name or magic bytes
   `1f 8b`) and pipe through `DecompressionStream('gzip')` before `parseJsonl`.
   Local-file and same-origin-URL loaders too. Contents API raw reads of ≤100 MB are
   supported, so a 4 MB `.gz` is trivial.
2. **Parse v2**: `analysis-core.js parseJsonl` reads `frame_schema` (or
   `run_metadata.log_format`); `"a"` arrays are expanded to the v1 `arena_command`
   object shape *once at parse time*, so `p3LedEpochs`, stall forensics and every
   existing consumer keep working unchanged. Frames are identical in v1/v2.
3. **Catalog**: filename parser accepts `.jsonl.gz`; size column shows compressed
   size with the raw size in hover.
4. Tests: `tests/test-analysis.js` gets a v2 + gz fixture (generated by the Part 1
   converter from the existing short-P3 fixture) and asserts identical page output
   for v1 and v2 of the same run (same PI values, same bundle counts). The corpus
   script additionally builds every P3 page for the v1 and v2 version of EVERY P3
   run in the clone and diffs the CSV rows (parity across the whole corpus).
5. **Other readers (inventory 2026-09-06, `grep arena_command|frame_schema`):**
   `js/runlog-replay.js` (replay viewer) and the Studio's run-log adapter
   (`js/studio-runlog-adapter.js` / Alt replay) read log FILES and need the same
   inflate + v2→v1 expansion helper — put it in ONE shared classic dual-export module
   (`js/runlog-format.js`: `inflateIfGzip(bytes)`, `expandV2Line(arr, schema)`,
   `detectFormat(firstLines)`) used by the dashboard, the replay viewer and the
   adapter, with its own Node test. `js/kinematics.js` and the live scope consume
   frame arrays / websocket events only — unchanged. `js/arena-session.js` PRODUCES
   the arena_command objects over the websocket — unchanged (compaction is at the
   bridge's write step).

## Migration of existing files

- Nothing is re-written in place. Old `.jsonl` (v1) stay readable forever.
- Optional one-shot: convert + gzip the existing 27 rig03-sr / bench files with the
  Part 1 CLI and commit as `.jsonl.gz` alongside (or instead — Michael's call), which
  also shrinks the course repo by ~250 MB.

## Test matrix (what "done" means)

| Layer | Test | Where it runs |
|---|---|---|
| Format | v1→v2→v1 round trip on curated samples incl. null status, non-null error, unknown key → raise | `tests/test-bridge-behavior.py` (pixi + CI) |
| Format | Round trip + size table + parity over all 165 existing logs | `scripts/runlog-v2-corpus.py` (local clone) |
| Bridge | `log_control` ack + hello `levels`; v2 default; v1 still selectable | `tests/test-bridge-behavior.py` |
| Bridge client | whitelist accepts v2; mismatch warning event | `tests/test-fictrac-bridge-client.js` |
| Studio | gzip bytes committed via `contentBytes`; `.jsonl.gz` name; size threshold picks `directCommitLarge`; 401 drops token | `tests/test-studio-github.js` (mocked fetch) + browser with mocked api.github.com |
| Shared reader | gzip magic detection, `expandV2Line` exact v1 shape, `detectFormat` | new `tests/test-runlog-format.js` |
| Dashboard | v1 vs v2.gz identical pages/PI/bundles; catalog accepts `.jsonl.gz` | `dashboard/data-browser/tests/test-analysis.js` |
| Replay / adapter | opens v2.gz, same event stream as v1 | existing replay tests + fixture |
| Bench | real runs on a rig (below) | manual |

## Verification (end-to-end, on a rig)

1. Bridge on `behavior_v2`: run a short P3; log shows `"a"` lines; `--convert` round
   trip of that file is byte-identical in canonical JSON.
2. Studio: recorded 20 s run → `.jsonl.gz` committed (size shown); 40 s run → same,
   ~2.5 MB; force the Git Database path with a size threshold override and confirm the
   blob/tree/commit/ref sequence lands one file.
3. Dashboard: open the `.gz` from the repo and from a local file; P3 pages identical to
   the v1 run of the same protocol; Heisenberg bundles identical.
4. Old v1 `.jsonl` still open everywhere.

## Open decisions for Michael

- Keep committing an uncompressed copy for very small runs (readability on GitHub) or
  always `.gz`? (Recommend always `.gz`; GitHub can't render 20 MB JSONL anyway.)
- Convert the existing course-repo logs to v2+gz, or leave history as is?
- Default log level after the release: `behavior_v2` everywhere, including course
  benches (recommend yes; readers handle both).

## PR 1 implementation notes (bridge, 2026-09-06)

What shipped in `fictrac-bridge/bridge.py` (BRIDGE_VERSION 3.0), and the facts the
Studio (PR 2) and reader (PR 3) work must build on:

- **The compact line is exactly** `["a", t_off, dt, hex, status, rx_off]` with a 7th
  element only when v1 `error` is non-null. `t0` is the `ms` of the session line the
  file opened with (`_open` emits session + schema together). The v1 object is
  restored in the original key order `type, event, t, dt, len, head, status, echo,
  ok, error, dir, rx_ms`.
- **Correction to the plan's derivation rule:** on a timeout the real v1 lines have
  `status: null, echo: null, ok: null` (js/arena-session.js `_logCommand` sets all
  three from the decoded reply or leaves all three null). So `expandV2Line` must
  emit `echo = ok = null` when `status` is null, and `echo = command byte`
  (`head` byte 1), `ok = (status === 0)` otherwise — NOT `ok: false` on timeout.
  The corpus has 33 such lines (rig2 `spzae5dn`), all with a non-null `error`.
- **Lossless by construction, not by assumption:** `compact_arena_command` verifies
  every invariant it later relies on (fixed 12-key set, `dir`, int `t`/`rx_ms`,
  spaced lowercase hex `head` with `len` = byte count, `echo`/`ok` consistency).
  A line that does not fit is written **verbatim** by the live bridge (stderr
  warning) and **raises** under `--convert`/the corpus gate. Readers must therefore
  accept a v1-shaped `arena_command` object inside a v2 file (e.g. a bulk command
  whose `head` carries the ` …` truncation marker).
- **Files without a v1 schema line** (pre-#140 logs, `full` level) convert to v2 with
  a schema line inserted after the first session line carrying `"cols": null`
  (no positional frame rows in this file); the reverse drops it. Readers: `cols`
  may be null.
- **Level negotiation:** `hello` → `hello_ack {bridge, levels:[behavior_v2,
  behavior_v1, full], level, logging}`; `log_control` → `log_control_ack {enabled,
  level, requested, file}` where `level` is the one actually in force (an unknown
  `requested` is ignored, not applied). Old Studios ignore unknown message types
  (`fictrac-bridge-client.js` dispatches only `frame`/`log_export_result`). Old
  bridges never reply to `hello` — the Studio should treat "no hello_ack" as
  "behavior_v1-only bridge".
- **`run_metadata.log_format`** (Part 1 §3) is a Studio-side field (the Studio
  composes that line and now knows the acked level); the bridge does not inject it,
  so the v1↔v2 round trip stays exact.
- **Corpus result (164 logs, 1.28 GB, origin/main of cshl-2026-course):** all pass;
  totals in PR 1's description (1281.6 MB v1 → 655.6 MB v2 → 211.3 MB v2.gz at gzip
  level 6). The 51 MB `rydc2tql` run → 20.4 MB v2 → 6.2 MB v2.gz.

## PR 2 implementation notes (Studio, 2026-09-06)

- **`js/fictrac-bridge-client.js`:** `LOG_LEVELS = ['behavior_v2','behavior_v1','full']`
  (default v2); handles `hello_ack` (→ `bridgeInfo`, `bridgeSupportsLevel(level)`) and
  `log_control_ack` (→ `ackedLogLevel`, cleared by every `setLogging()` and on close);
  new `'loglevel'` event `{source, requested, level, ok, levels, enabled, file}` plus an
  `'err'` log line on mismatch; `waitForLogLevelAck(ms)` resolves the acked level or
  null (old bridge / not connected / timeout).
- **`js/studio-github.js`:** `gzipBytes(input)` (CompressionStream; rejects where
  unavailable), `isGzip(bytes)`, Git Database builders (`reqCreateBlob`, `reqGetCommit`,
  `reqCreateTree` — allowlisted path, `reqCreateCommit`, `reqUpdateRef` fast-forward
  only), `directCommitLarge` (7-call sequence, per-step error reporting),
  `commitFile` (routes by size; `LARGE_FILE_BYTES` = 30 MiB; `thresholdBytes` test hook;
  result carries `via` + `bytes`).
- **`arena_studio.html` v0.72:** `#fmLogLevel` v2/v1/full (v2 default; a stored v1 is
  honored); Console `#cFtLogLevel` follows the `'loglevel'` event (⚠ + tooltip on
  mismatch); run start awaits the ack ≤ 800 ms and names the level in the banner +
  transcript (`WARN` level when it disagrees or is unconfirmed); `run_metadata` gets
  `log_format` = acked level, or the inferred one for a non-acking bridge (`behavior_v1`
  when v2 was requested, else the request itself); `commitRunLog` gzips → `<name>.jsonl.gz`
  via `GH.commitFile`, falls back to raw `.jsonl` without CompressionStream, and reports
  raw → gz size + the path used in the log line, the modal and the run-summary line.
- **Not done here (PR 3):** readers. Until PR 3, `.jsonl.gz` files from a v0.72 Studio are
  opened with `gunzip` / `bridge.py --convert`.
- **Bench check when hardware is back:** recorded 20 s run → `.jsonl.gz` committed with the
  size shown; banner names `behavior_v2`; then run against a deliberately old bridge
  checkout and confirm the "bridge too old" warning + `log_format: behavior_v1`.

## PR 3 implementation notes (readers, 2026-09-06)

- **`js/runlog-format.js`** (classic dual-export; vendored byte-identical at
  `dashboard/data-browser/vendor/runlog-format.js`, enforced by `tests/test-runlog-format.js`):
  `isGzip`, `isRunlogName` (`.jsonl|.ndjson|.json` with optional `.gz`), `stripGz`,
  `inflateIfGzip`, `readRunlogText(string|bytes|ArrayBuffer|Blob)`, `readRunlogPrefixText`
  (truncation-tolerant gunzip for the catalog's 64 KB metadata reads), `isArenaArray`,
  `expandV2Line` (exact v1 object; timeout ⇒ status/echo/ok all null), `compactV1Line`,
  `detectFormat`, `createNormalizer()` (per-file state machine every reader feeds each
  parsed line through), `convertV1ToV2Text` / `convertV2ToV1Text` (JS mirror of the bridge
  converter — tests + parity).
- **Dashboard:** `analysis-core.js parseJsonl` normalizes every line (v2 echoes reach
  `p3LedEpochs`, stall forensics etc. as v1 objects); `run.logFormat` + `run.rawBytes`;
  `parseFilename` strips `.gz`. `github-repo.js fetchRaw` reads BYTES and inflates on the
  magic (prefix mode inflates a truncated gz). `app.js` loaders (repo / URL / local server /
  dropped file) go through `readRunlogText`; catalog filters accept `.jsonl.gz`; new size
  column (compressed, with inflated size + format in the hover). Cache-busting `?v=` bumped.
- **Replay:** `js/runlog-replay.js parseRunLog` normalizes records (needs
  `js/runlog-format.js` loaded first — `arena_studio.html` does; a stale cache degrades to
  "v2 echoes skipped" with a console warning, frames + runner events still replay);
  `js/arena-studio-alt.js` replay picker lists `.jsonl.gz` and inflates the picked file.
  `arena_replay_viewer.html` receives data over its protocol module — unchanged.
  `js/studio-runlog-adapter.js` does not read files — unchanged.
- **Tests:** `tests/test-runlog-format.js` (new, in `pixi run test`); `tests/test-runlog-replay.js`
  v2 case asserting identical samples/arenaFrames/events vs the equivalent v1;
  `dashboard/data-browser/tests/test-analysis.js` re-reads the P3 fixture as v2 + gz and
  asserts identical frames, arena_command objects, preference indices, LED epochs and page
  CSV rows, plus metadata from a gz prefix; `dashboard/data-browser/tests/corpus-v2-parity.js`
  runs that comparison over a whole clone (result in PR 3's description).
