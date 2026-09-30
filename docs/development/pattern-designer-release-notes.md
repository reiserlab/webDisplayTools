# Pattern Designer — release notes

Newest first. Each entry is one Production release (see `releases/` for the exact
candidate manifest: main commit + the PRs and their head SHAs).

## v0.12 (2026-09-30) · LAB-158 ports (Protocol ▾, ⚙ Settings, two-column Console) + visibility themes · Multi-color G6 panels V1 — Panel LEDs layout, ON color, per-bank preview (LAB-228) · Flasher + Studio picker: one production build from the published catalog; legacy images hashed, never default (panel-fw-v1.3.1)

<!-- #238 -->
- **Sign-in and repo hints now point to the Studio's ⚙ Settings menu** (they used to say File ▾).

<!-- #240 -->
- **Choose which LEDs your G6 panels have.** A new **Panel LEDs** selector next to the arena picker (standard green, four-color violet/blue/green/yellow-orange, or red + IR) recolors every view — grid, 3D, Mercator/Mollweide and thumbnails — so a color pattern previews as it will look, with each color on its own 10×10 lattice per panel. Standard green panels look and save exactly as before.
- **Say what ON means on a color panel.** Generate → Output gains an **ON color** control: light all colors, one pure color, or a custom per-color level. Generated patterns keep only the chosen LEDs; the `.pat` format is unchanged and the filename gets a `_4c` / `_rir` tag.
- **Choose the background color too.** A second **OFF color** row (Dark by default) sets what OFF pixels show. A square grating in blue-on-green lights blue LEDs in the stripes and green LEDs between them; a sine grating becomes a smooth blue↔green modulation.
- **Combine gains "Add (saturate)".** Two color patterns stack at full intensity (their lit LEDs never overlap); Blend (50%) halved them.
- **Flip H / Flip V keep colors.** On color panels the 2×2 color cells are mirrored, so a violet LED stays violet after a flip.
- **Paint whole color cells.** In Edit, a new **2×2 cell** brush fills the four LEDs under the cursor with the ON-color mix; the single-LED brush works as before.
- The selector is remembered in the URL (`?panel=…`) so links open with the right panels.
- **Color filenames stay tagged.** The `_4c` / `_rir` suffix is added when you save, so patterns that went through Combine, the tray or an image import carry it too.
- **Mercator and Mollweide views are no longer upside down.** The top row of the arena now appears at the top of the map (positive elevation); it had been drawn at the bottom since the projection views were added, which full-height gratings hid.
- **Painting uses the ON color.** With a single color selected, the LED brush and the row/column fills light only that color's LEDs, the same replace behaviour as Generate and the 2×2 cell brush. With "All" nothing changes.
- **Saving twice no longer eats part of the name.** Re-saving `G6_2x10_combo_test.pat` used to produce `G6_2x10_test.pat`; the arena prefix is now recognised exactly.

## v0.11 (2026-09-28) · Release tiers on the page; SD purge timeout

<!-- #227 -->
- **Shows the same beta / NEXT badge**, and its links to the Studio stay on the same build.

