Patterns for protocols/g6_2p_color_led_sweep.yaml (G6 2x10 four-color panels, GS16 — lit pixels 15, 20 frames each;
built by scripts/make-color-optomotor-patterns.js --gs16 — regenerate rather than edit). GS16 so the controller
re-streams at 300 Hz (its GS16 default), as in the 22 Sept 2026 2P duty-sweep runs; the GS2 set would default to 1000 Hz.
Upload the whole folder from Arena Studio (Console → Patterns → Add ▾ → this folder); the Studio resolves
patterns by NAME, so the pattern_IDs in the YAML only matter as the fallback when the SD listing is unavailable.

Each file: square-wave grating, period 20 px = 36°, 10 px on / 10 px off, one pixel of shift toward increasing
column index per frame (20 frames = one period; playback wraps), TOP panel row only (pixel rows 20..39), and only
the pixels of ONE LED color bank lit (2×2-cell bank map of js/panel-color.js, layout "four-color").
Frame_rate +80 in mode 2 = 4 Hz temporal frequency (80 px/s ÷ 20 px); negative reverses.

G6_2x10_toprow_grat20_violet_gs16.pat — bank 0 = violet 405 nm; frames 20, lit px/frame 500, stray px 0, 81338 bytes  OK
G6_2x10_toprow_grat20_blue_gs16.pat — bank 1 = blue 470 nm; frames 20, lit px/frame 500, stray px 0, 81338 bytes  OK
G6_2x10_toprow_grat20_green_gs16.pat — bank 2 = green 525 nm; frames 20, lit px/frame 500, stray px 0, 81338 bytes  OK
G6_2x10_toprow_grat20_yellow_gs16.pat — bank 3 = yellow-orange 590 nm; frames 20, lit px/frame 500, stray px 0, 81338 bytes  OK
