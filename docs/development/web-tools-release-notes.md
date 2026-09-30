# Web tools — release notes

Newest first. Each entry is one Production release (see `releases/` for the exact
candidate manifest: main commit + the PRs and their head SHAs).

## G6 Panel Flash Programmer v0.4 (2026-09-30) · LAB-158 ports (Protocol ▾, ⚙ Settings, two-column Console) + visibility themes · Multi-color G6 panels V1 — Panel LEDs layout, ON color, per-bank preview (LAB-228) · Flasher + Studio picker: one production build from the published catalog; legacy images hashed, never default (panel-fw-v1.3.1)

<!-- #242 -->
- **The flasher now offers the panel firmware repo's published production build by default — one build, pre-selected.** Old development builds that used to sit at the top of the list (one of them installed a known frame-drop bug on new panels) are gone. A "Legacy" entry remains only for a replacement panel joining an arena that has not been reflashed yet, and is never pre-selected.
- **Each build shows its fingerprint**, the same number Arena Studio's panel inventory reports per panel, so you can tell at a glance whether an arena runs the build you are about to flash. If the catalog cannot be reached, the page asks you to choose explicitly instead of guessing.

## Arena Console v10 (2026-09-28) · Release tiers on the page; SD purge timeout

<!-- #228 -->
- **Same 2-minute wait for Purge;** the refresh-rate hint shows the current firmware defaults (GS16 400 Hz, GS2 1200 Hz).

