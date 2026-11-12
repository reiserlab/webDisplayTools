Patterns for protocols/g6_optomotor_open_loop_oscillation.yaml (GS2; built by
scripts/make-optomotor-oscillation-patterns.js — regenerate rather than edit).
Upload the whole folder from Arena Studio (Console → Patterns → Add ▾ → this folder). The Studio resolves
patterns by NAME; the pattern_IDs in the YAML are only the fallback when the SD listing is unavailable.

Arena G6_2x10: 2×10 panels, 200×40 px, 1.8° per pixel. Vertical square-wave grating, period 20 px = 36°, 10 px on / 10 px off, every pixel row, every pixel of the on bars lit.
Rotation: frame_rate ±F plays F px/s = F/20 Hz temporal frequency = 1.8·F °/s.
Positive frame_rate and positive shift = toward increasing column index.

G6_2x10_grat20.pat — 20 frames, 1 px (1.8°) per frame toward increasing column index; 21338 bytes  OK
G6_2x10_grat20_osc1hz.pat — 200 frames = one cycle at frame_rate 200 (1 Hz); amplitude ±20 px (±36.0°); 213218 bytes  OK
    decoded shift sequence: fundamental 20.088 px at 0.000° phase, largest harmonic (2..5) 0.029 px, RMS error to the ideal sinusoid 0.279 px, largest step 1 px/frame
    peak speed 125.7 px/s = 226.2°/s (peak temporal frequency 6.28 Hz)
