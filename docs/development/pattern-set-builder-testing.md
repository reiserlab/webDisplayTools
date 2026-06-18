# Pattern Set builder — quick test outline (LAB-91 + LAB-92)

Manual QA for the CSHL rig YAML + the Pattern Set / SD-bundle builder. Use
**Chrome or Edge**. Serve the repo (`python3 -m http.server` from the repo root, or
the deployed GitHub Pages URL) — don't open via `file://` (the built-in library is
fetched).

## 0. Automated (Node)
- [ ] `npm test` → all suites green (incl. `test-pattern-set` 39/39).
- [ ] `node tests/generate-default-pattern-set.js` → ends `Self-verify OK (duty 0x80 + geometry == G6_2x10)`.

## 1. Rig → arena (LAB-91)
- [ ] Open `experiment_designer_v3.html`. Click **New** (or **Import YAML**) so a protocol is loaded.
- [ ] **Settings ▾ → Rig** → pick a built-in rig (**CSHL G6 — 2×10**) from the dropdown, or **Browse…** `configs/rigs/cshl_g6_2x10.yaml`.
- [ ] Path fills in; an **`arena (from rig): G6 (2×10) - 360° · G6_2x10`** row appears (green).
- [ ] Plugins section shows **no spurious plugins / no mismatch warnings**.

## 2. Builder blocked without a rig
- [ ] Reload (no rig loaded) → click **Pattern Set…** → shows the **blocked** prompt
      ("Load your rig… the arena comes from the rig"); no panes.

## 3. Built-in library (rig loaded)
- [ ] With the rig loaded, click **Pattern Set…**.
- [ ] Header: **Arena: G6 (2×10) - 360° (locked, from rig)** — no arena picker.
- [ ] **Available** lists 4 patterns, each with GS/frames/dims + **✓**:
      `all_on` (GS2·1f), `grating_sq` (GS2·20f), `grating_sine` (GS16·20f),
      `frame2_h_ccw_200f` (GS16·200f).  ← your editor pattern, now **bright** (duty 128).

## 4. Select · order · export
- [ ] **+ Add** two patterns → they appear in **Selected** as `pat0001.pat`, `pat0002.pat`
      (index 1, 2); their Available rows flip to **✓ added**.
- [ ] **▲ / ▼** reorder → indices and `pat000N` filenames update live.
- [ ] Edit a Selected name → it's what the manifest mapping uses.
- [ ] Footer: **"N selected · all valid"**, **Export ZIP** enabled → click → downloads `<set_id>.zip`.
- [ ] Unzip: contains `MANIFEST.bin`, `MANIFEST.txt`, `README.txt`, `patterns/NNN_<name>.pat …`.
      `MANIFEST.txt` contains `Pattern Count`, `Pattern Set ID` (FNV-1a hash of SD filenames),
      and `Mapping: NNN_<name>.pat <- <name>`.

## 5. Validation (reject wrong arena)
- [ ] Source → **Local files** (confirm the clear) → **Choose .pat files…** → pick a
      non-2×10 pattern (e.g. `test_patterns/web_G6_3x16_full_gs16_sine_grating_G6.pat`).
- [ ] It shows **greyed ✗** with reason `3×16 panels — arena G6_2x10 is 2×10`; **+ Add disabled**.

## 6. Another repo (optional)
- [ ] Source → **Another repo** → enter a GitHub **raw** base URL of a webDisplayTools-style
      repo that has `patterns/g6_2x10/MANIFEST.txt` → **Load** → Available populates.
      (CORS: `raw.githubusercontent.com` works; arbitrary Pages sites may not.)

## 7. Grow the default set (the "add a pattern" workflow)
- [ ] Drop a new G6 2×10 `.pat` into `patterns/g6_2x10/_sources/`.
- [ ] `node tests/generate-default-pattern-set.js` → it's ingested (duty → 128),
      shipped as the next `NNN_<name>.pat`, listed in `MANIFEST.txt`.
- [ ] Reopen the builder → it's in **Available**.

## 8. Hardware SD round-trip (optional — needs a G6 controller)
- [ ] Copy `MANIFEST.bin`, `MANIFEST.txt` + the `patterns/` folder to the
      **SD card root** (from an exported ZIP, or `patterns/g6_2x10/`). **Seat the card before
      powering on** (firmware mounts SD only at boot).
- [ ] Connect via `arena_console.html` (or the v3 per-condition dry-run). Send trial-params
      with **pattern = the manifest index** (e.g. `frame2_h_ccw_200f` → `pat0004.pat` → index 4).
- [ ] Pattern displays, is the right one, and is **bright** (duty 128 — confirms the dim
      duty=1 export was fixed by the pipeline). (Name→index lookup is automated later in LAB-95/96.)
