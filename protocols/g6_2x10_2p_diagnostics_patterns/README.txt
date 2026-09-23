Patterns for protocols/g6_2x10_2p_diagnostics.yaml (G6 2x10, GS16, built by scripts/make-2p-diagnostic-patterns.js).
Upload the whole folder from Arena Studio (Console → Patterns → Add ▾ → this protocol's folder); the Studio resolves patterns by NAME.

G6_2x10_ff_ramp16.pat — full field, grey level = frame index 0..15 (ascending ramp). mode 2, frame_rate 2 → 8 s per pass
    G6_2x10_ff_ramp16.pat  frames 16  mean/full per frame [0.00 0.07 0.13 0.20 0.27 0.33 0.40 0.47 0.53 0.60 0.67 0.73 0.80 0.87 0.93 1.00]  lit fraction [0.00 1.00]  OK
G6_2x10_ff_steps_pr16.pat — full field, the 16 grey levels in pseudo-random order 8,12,14,15,7,3,1,0,9,4,2,10,5,11,13,6. mode 2, frame_rate 2 → 8 s per pass
    G6_2x10_ff_steps_pr16.pat  frames 16  mean/full per frame [0.53 0.80 0.93 1.00 0.47 0.20 0.07 0.00 0.60 0.27 0.13 0.67 0.33 0.73 0.87 0.40]  lit fraction [1.00 0.00]  OK
G6_2x10_ff_flash_0_15.pat — full field off/on square wave. mode 2, frame_rate 2 → 1 Hz flash (0.5 s dark, 0.5 s full)
    G6_2x10_ff_flash_0_15.pat  frames 2  mean/full per frame [0.00 1.00]  lit fraction [0.00 1.00]  OK
G6_2x10_sparse10.pat — 10 % of pixels at level 15, rest dark, static (frame_rate 0). Compare with ff_ramp16 held at level 1–2
    G6_2x10_sparse10.pat  frames 1  mean/full per frame [0.10]  lit fraction [0.10]  OK
