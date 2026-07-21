# Making a protocol + patterns from scratch (the GitHub workflow)

*For Arena Studio v0.7 + Pattern Designer v0.10. This is the end-to-end path from
"blank screen" to "recorded run on the arena", with everything stored in the course
repo on GitHub.*

---

## The one idea to hold onto

A protocol and its patterns are associated in exactly **two** ways — and both are
just names:

1. **Inside the protocol**, each condition names its pattern:
   `pattern: "G6_2x10_dark_bar_8pix_GS2"` — the pattern's **filename without
   `.pat`** (a leading `001_`-style index prefix is also ignored, so SD copies
   match too).
2. **In the repo**, a protocol's patterns live in a folder named after it, right
   next to the YAML:

   ```
   protocols/bench03/looming_v1.yaml
   protocols/bench03/looming_v1_patterns/
       G6_2x10_dark_bar_8pix_GS2.pat
       G6_2x10_grating_20px.pat
   ```

There is **no registration step and no required order**. The `_patterns/` folder
can exist before the YAML, or after it — the tools only match names. So the
chicken-and-egg worry dissolves: **you never need a protocol (or a placeholder)
to start making patterns.** You only need to have *picked the protocol's name*
if you want the patterns filed next to it from the start.

## Two homes for patterns — pick per pattern

| | **Shared library** (`patterns/`) | **Protocol folder** (`protocols/<bench>/<name>_patterns/`) |
|---|---|---|
| Best for | Reusable patterns — gratings, loomings, anything several protocols will share | Patterns specific to one protocol |
| Needs | Nothing — no protocol name, no bench id | The protocol's *name* (the YAML itself can come later) |
| Visible to | Every bench, every protocol | Travels with that protocol (Promote copies it; repo checks key off it) |

Both are first-class sources everywhere: the Designer's **Open from Repo…**, the
Console's **Add ▾ → From course repo…**, and the Studio's pattern checks all see
both. Start in the library; colocate when a protocol stabilizes (see Flow A).

---

## One-time bench setup (instructor)

1. Open **Arena Studio** → **File ▾**.
2. Click the 🔒 to unlock the GitHub settings, then **Sign in…** with the course
   token.
3. **Repo** is pre-filled with the course repo (`reiserlab/cshl-2026-course`);
   set the **Bench id** (e.g. `bench03`).
4. Tick **Commit directly to default branch** and re-lock 🔒.
5. Check the **rig** selector in the top bar matches this bench's arena.

Everything below works on any bench set up this way. The Pattern Designer reuses
these settings automatically — no separate sign-in.

---

## Flow A (start here): patterns into the library, then a protocol

The natural order — make patterns first, assemble later. No protocol needs to
exist, or even be named, while you design.

### Step 1 — make the patterns (Pattern Designer)

1. In the Studio's top bar, click **Patterns ↗**. The Pattern Designer opens in a
   new tab already set to your bench's arena and the course repo, with your
   GitHub sign-in carried over.
2. Generate or draw a pattern. Check it in the 2D grid and the 3D view — turn on
   **Panel numbers** to see exactly which physical panel shows what (numbering
   matches the arena's own Panel map: 1–10 along the bottom row).
3. **⇪ SAVE TO REPO…** → **Shared pattern library**. The file is committed to
   `patterns/` — visible to every bench and every protocol.
4. Repeat for every pattern you need. Keep the suggested arena-prefix filenames
   (`G6_2x10_…`) — the arena config travels in the name and the file header.

> **Direction sanity:** a pattern that plays clockwise in the Designer plays
> clockwise on the arena (bench-verified 2026-07-05). If an old pattern seems
> reversed, suspect the pattern, not the pipeline — legacy `.pat` files predate
> the current conventions. Make course patterns fresh.

### Step 1b (when a protocol stabilizes) — colocate its patterns

Colocation makes the protocol a self-contained pair (Promote copies the folder;
the repo-side pattern checks key off it). To move library patterns next to a
protocol: in the Designer, **LOAD ▾ → Open from Repo… → 📚 Shared pattern
library** → open the pattern → **⇪ SAVE TO REPO… → A protocol's pattern folder**
→ type the protocol's name. Repeat per pattern. *(A one-click "collect this
protocol's patterns" helper is planned — see the issue tracker.)* Skipping this
is fine for running on course benches: the library is repo-global, so any bench
can upload from it.

## Flow B: protocol-specific patterns, colocated from the start

If the patterns belong to one experiment, skip the library: decide the
protocol's **name** first (e.g. `looming_v1` — nothing needs to exist yet), and
in Step 1.3 choose **A protocol's pattern folder** → type `looming_v1`. The
patterns commit to `protocols/<bench-id>/looming_v1_patterns/`, ready for the
YAML to join them. Everything else below is identical.

### Step 2 — build the protocol (Arena Studio → Edit)

1. Back in the Studio: **File ▾ → New protocol**. The new document is pre-filled
   with this bench's rig, the rig's plugins, and today's date.
2. Open **Settings ▾** and set the **name** to `looming_v1` and yourself as
   **experimenter** (roster names are suggested).
3. Build the experiment: **+ Add** conditions in the Library, set each
   condition's mode/duration, and type each **pattern** name exactly as saved
   (without `.pat`) — e.g. `G6_2x10_dark_bar_8pix_GS2`.
   - The **W/C chip** on each condition is your live check: **W** = this Studio
     can resolve the pattern (SD card, library, or the protocol's repo folder);
     **C** = it can't (typo, or the pattern runs from the MATLAB computer).
   - Turn on **?** (top bar) any time — every control explains itself on hover.
4. Arrange the **Experiment Sequence** (blocks, repetitions, intertrial).
5. **Ctrl+S** (or File ▾ → Save). With the bench signed in, this commits
   `protocols/<bench-id>/looming_v1.yaml` (in Flow B, right next to its
   `_patterns/` folder — a portable pair).

### Step 3 — put the patterns on the SD card (Arena Studio → Console)

The arena plays patterns from its SD card, so the repo copies must be written to
the card once:

1. **⛭ Console** → **Connect** (pick the arena's USB port).
2. In **Patterns**: **Add ▾ → From course repo…** and pick the source —
   **📚 Shared pattern library** (Flow A: grab single patterns, or the whole
   folder) or the protocol's own set (Flow B / after colocating: **looming_v1**
   uploads its whole `_patterns/` folder). Per-file confirmations appear in the
   bench log.
3. The listing refreshes; click a row to see its preview and frame count —
   confirm the uploads look right.

### Step 4 — verify and run (Arena Studio → Run)

1. **File ▾ → Open from Repo…** → `looming_v1.yaml`. It opens in the **Editor**
   — glance over it, then click **▶ Run**.
2. The run gate checks everything for you and says what's missing: connection,
   saved protocol, experimenter + genotype, bridge, and **that every pattern in
   the sequence resolves on the SD card** (a recorded run will not start with a
   missing pattern; a name that only matches by numeric fallback gets a loud
   warning instead of silently playing the wrong pattern).
3. **▶ Test experiment** for an unrecorded shakedown, then **▶ Run experiment**
   for the real thing — the run log commits to the repo automatically.

### Step 5 (optional) — share it

**File ▾ → Promote to shared (course)…** copies the saved protocol **and its
`_patterns/` folder** to `protocols/shared/`, where every bench can open it.

---

## Variation: protocol first

Also fine — build and save the YAML with pattern names you *intend* to make;
every condition shows **C** until the patterns exist. Then make the patterns
(Step 1) into the library or the protocol's folder, upload to the SD, and
re-open the protocol — the chips flip to **W**.

---

## Naming rules (worth pinning)

- **Reference = filename minus `.pat`** (and minus any `001_`-style index
  prefix). `pattern: "G6_2x10_grating_20px"` ↔ `G6_2x10_grating_20px.pat`.
- Web uploads keep the repo filename on the SD card, so repo name = card name.
- **Same name = assumed same pattern.** Never save a *different* pattern under
  an existing name (the tools warn on overwrite — take the warning seriously).
  When in doubt, bump the name (`…_v2`).
- One card can hold several protocols' sets side by side; names must stay
  unique across them.

## Troubleshooting

| Symptom | Meaning / fix |
|---|---|
| Condition shows **C**, expected **W** | Name typo, or the pattern isn't anywhere this Studio can see (SD, library, this protocol's repo folder). Fix the name or save/upload the pattern. |
| Run gate: *pattern … missing* | The name doesn't resolve on the **SD card**. Console → Patterns → Add ▾ and upload it. |
| Warning: *falls back to numeric pattern_ID* | The name isn't on the card but an index number would play *something* — almost always the wrong something. Upload the named pattern. |
| Rotation looks reversed | Almost certainly a legacy pattern with a baked-in direction. Regenerate it fresh in the Designer. |
| A `_patterns/` folder doesn't appear in the Console's repo picker | The Console lists protocols by their **YAML**; save the protocol (Step 2) and it appears. (The Designer's own repo picker shows the folder either way.) |
| "Repo not configured" in the Pattern Designer | Open it via the Studio's **Patterns ↗** link, or set up the bench in the Studio's File ▾ first. |
