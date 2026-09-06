# Run-log format `behavior_v2` + large-file commit path — PLAN (not started)

Owner: Michael. Drafted 2026-09-06 from the analysis of rig03-sr run `rydc2tql`
(40 s trials, 51.4 MB, failed to auto-commit). Status: **approved direction, no code
yet**. Implementation lands as three PRs (bridge, Studio, dashboard) in that order.

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
   for v1 and v2 of the same run (same PI values, same bundle counts).
5. Also update `js/runlog-replay*.js` / kinematics readers if they open run logs
   (grep `parseJsonl|frame_schema` at implementation time).

## Migration of existing files

- Nothing is re-written in place. Old `.jsonl` (v1) stay readable forever.
- Optional one-shot: convert + gzip the existing 27 rig03-sr / bench files with the
  Part 1 CLI and commit as `.jsonl.gz` alongside (or instead — Michael's call), which
  also shrinks the course repo by ~250 MB.

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
