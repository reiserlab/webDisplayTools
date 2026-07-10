# Visual Behavior in Flies — Course Guide

Welcome! These pages are your reference for running fly-on-ball experiments on
the G6 LED-arena rigs. Read them in roughly this order; each page is short and
practical.

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

## Plan and schedule

| Time | Focus |
| --- | --- |
| **10:30-noon** | Meet at the rigs for a brief setup orientation, tethering demonstration, and hands-on tethering. Before lunch, each group mounts one fly and runs P0. P0 is a calibration protocol: it asks which stimulation levels are most effective for that genotype on that rig. |
| **After lunch-5:30** | Bootstrap P1 and P2 across genotypes. Different groups begin with different flies, run short protocols first, and collect high-quality data. At roughly hourly check-ins, we will compare results, troubleshoot, and decide together which genotypes or effects deserve more runs. The immediate goal is `n=2` good flies; `n=4-5` is a realistic target for analyzable data. |
| **Late afternoon** | Review promising results in the dashboard. Once core P1/P2 data are in hand, teams may try an instructor-approved variation or a new pattern. |
| **After evening lecture** | P3 closed-loop conditioning: an exploratory, instructor-led experiment. |

## Goals for the day

### Morning — learn the rig and make a first fly

Everyone should tether at least one fly and become comfortable with the rig
before lunch:

1. Open **Arena Studio** and connect to the rig.
2. Browse the pattern library, then use the Console to display a pattern.
3. Open a protocol file in the Editor and follow its steps to understand what it
   will do.
4. Use the setup to ask concrete questions: for example, what does `gain` do,
   and how would changing it affect a closed-loop experiment?

### Afternoon — collect useful behavioral data

Keep tethering and running flies. The immediate goal is `n=2` good flies in a
selected protocol; `n=4-5` is a realistic target for analyzable data. Work with
one or both of **P1** and **P2**, collecting multiple flies in each condition.

> **"Flies are cheap." — Michael Dickinson** Do not hold back on trying another
> fly when a tether, walking behavior, or result is not good enough.

### Evening — explore conditioning

Use optogenetic and visual stimuli to explore closed-loop conditioning in
walking flies, adapting classic experiments from Martin Heisenberg and
colleagues. This is exploratory, but if something seems to work, lock it in and
collect enough data to ask whether it replicates.

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
  - [p3 — The Heisenberg experiment](protocols/p3.md)

## Reference

- **[Fly Stock Genotypes](genotypes.md)** — the stock names and full genotypes used in Arena Studio metadata.
- **[References and links](references.md)** — panel-system, FicTrac, Arena Studio, and reading links.

---
*Updated 2026-07-10 02:30 ET.*
