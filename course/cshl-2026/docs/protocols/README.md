# Protocols — the p0–p3 series

The course experiments are numbered **p0 → p3**. Each one is a self-contained
Arena Studio protocol; most come in a **short** and a **full** version.

Each protocol asks a different behavioral question. P0 is mainly for learning
the system and checking optogenetic intensity. P1 asks how visual motion and
looming stimuli drive behavior. P2 asks how flies control or choose visual
objects, especially during optogenetic activation. P3 is reserved for a bonus or
conditioning experiment.

**Workflow:** run the **short** version first to check that the fly, tracking,
visual display, and optogenetic timing make sense. If it looks good, run the
matching **full** version. If short and full were run on the same fly, the
analysis can pool them.

P0 is the intro/calibration protocol and is worth running once per line when
possible. P1 and P2 are the core student protocols. P3 is the Heisenberg
flight-simulator tribute: five named short/full protocol pairs use phase-paired
visual stimuli and fixed −1.8 closed-loop coupling.

## Design principle: internal comparisons

These protocols are built around comparisons that can be made **within the same
fly and the same run**. Genetic controls matter, but stimulus controls matter
too: we want to know whether a response depends on a specific feature of the
stimulus, not just on "something changed on the display."

Examples:

- P0 compares the same visual trials across sham, low-light, and high-light
  optogenetic blocks.
- P1 pairs opposite grating directions, matched temporal frequencies, loom
  speeds, loom positions, and looming control stimuli.
- P2 balances object-choice stimuli across left/right positions and compares
  no-opto versus opto phases within the same behavioral structure.

The analysis will keep these matched comparisons visible instead of treating
each trial type as an isolated condition.

| # | Name | What it probes | Closed-loop / FicTrac? | Short | Full |
| --- | --- | --- | --- | --- | --- |
| **[p0](p0-opto-intensity.md)** | Optogenetic intensity | Which LED level drives the fly | No (open-loop) | about 2.6 min | about 10.3 min |
| **[p1](p1-motion.md)** | Visual motion | Optomotor turning + looming response | No (open-loop) | about 2.7 min | about 7.9 min |
| **[p2](p2-object.md)** | Object responses | Bar fixation + A/B choice | **Yes** (needs FicTrac) | about 4.3-4.5 min | about 9.8-10.2 min |
| **[p3](p3.md)** | Heisenberg conditioning | Closed-loop cue-preference learning | **Yes** (needs FicTrac) | ≈8:04 min | ≈18:04 min |

Animated pattern previews are embedded on all four protocol pages.

## Also on the rigs

- **`p100_rig_test`** — a 60-second, controller-only checkout (no fly, no
  FicTrac): full-field brightness, panel map, a moving bar, and LED levels
  2/5/10/20/40%. Use it to confirm a rig works after setup.
- **`fictrac_direction_test`** — open-loop motion then a closed-loop block, to
  confirm the [FicTrac](../fictrac.md) bridge is working.
- **`optomotor_led_test`** — a slow grating with the LED switched on for the
  last few seconds; the reference example of "fire a command partway through a
  trial."

## How to read a protocol page

Each page tells you: **what the fly sees**, **what the LED does**, **how the
trials are organized**, and **roughly how long it takes**. The authoritative
source is always the protocol's YAML file (in `protocols/shared/`), whose header
comment describes it in full detail.

> **TBD:** add which genotypes pair with which protocol and the intended order
> for the course sessions.

## Analysis preview

These analysis pages are still being built. The first plots will likely include:

- P0: LED dose-response curves and time-aligned velocity/turning around LED onset.
- P1: optomotor matrices by spatial/temporal frequency and looming matrices by
  stimulus class/speed/position.
- P2: closed-loop fixation traces, open-loop sweep responses, and side-balanced
  object-choice preference plots.
- P3: arena-index occupancy, baseline-corrected preference, quadrant dwell
  times, LED transitions, and walking/immobility QC.

---
*Updated 2026-07-10 01:47 ET.*
