# Visual Behavior in Flies — Course Guide

Welcome! These pages are your reference for running fly-on-ball experiments on
the G6 LED-arena rigs. Read them in roughly this order; each page is short and
practical.

> **Draft.** Anything marked **TBD** still needs instructor review or a missing
> image/reference before the final student handout.

> **Feedback welcome.** This equipment is brand new: the rigs are less than a
> month old, and much of the course software, including Arena Studio, is only
> about 10 days old. If you see something confusing, broken, missing, or worth
> improving in the course, experiments, rigs, or software, please tell us. You
> can send feedback directly to the instructors or [open a course feedback
> issue](https://github.com/reiserlab/cshl-2026-course/issues/new?title=Course%20feedback%3A%20).

## Course team

- **Instructors:** Michael Reiser and Frank Loesche.
- **Rig assembly and testing:** many people in the Reiser Lab helped assemble,
  test, and troubleshoot these rigs, especially Hannah Marie Santos and Isabel
  Lehenbauer.
- **Fly work and genotypes:** Ed Rogers.

## Start here

1. **[Tethering basics](tethering.md)** — gluing a fly to a pin and getting it on the ball.
2. **[Rig 101](rig-101.md)** — what's on the bench and what each part does.
3. **[FicTrac basics & config](fictrac.md)** — the ball tracker: what it does and how to set it up.
4. **[Arena Studio](arena-studio.md)** — the web app you run experiments from (getting started + links).
5. **[Pattern Editor](pattern-editor.md)** — make and preview LED-arena patterns.
6. **[GitHub for the course](github-overview.md)** — where protocols and data live, and how they get there.

## The experiments

- **[Protocol overview](protocols/README.md)** — the p0–p3 series at a glance.
  - [p0 — Optogenetic intensity](protocols/p0-opto-intensity.md)
  - [p1 — Visual motion (optomotor + looming)](protocols/p1-motion.md)
  - [p2 — Object responses (bar, choice)](protocols/p2-object.md)
  - [p3 — Conditioning / bonus experiment](protocols/p3.md) *(coming soon)*

## Course strategy

1. **Learn the rig with P0.** Run the short intro/calibration protocol so your
   team sees how the arena, optogenetic LED, FicTrac traces, metadata, and
   GitHub run logging fit together.
2. **Collect core data with P1 and P2.** For each assigned fly, run the short
   version first. If the fly is walking and the setup looks healthy, continue
   with the matching full version.
3. **Then make or modify a pattern.** After the core runs, use the
   [Pattern Editor](pattern-editor.md) to build at least one stimulus and, if
   time allows, test it in Arena Studio.

## Reference

- **[Genotype shorthand](genotypes.md)** — the line shorthand names used in Arena Studio metadata.
- **[References and links](references.md)** — panel-system, FicTrac, Arena Studio, and reading links.

> **TBD: add images.** Useful first images: tethering station, fly on the ball,
> Arena Studio Run view, Pattern Editor, FicTrac config GUI, and example pattern
> animations for p0-p2.

---
*Last updated 2026-07-09.*
