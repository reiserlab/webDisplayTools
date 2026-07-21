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

> <span class="flies-are-cheap">"Flies are cheap."</span><br>
> — Michael Dickinson<br><br>
> **Don't hold back.**

## Plan and schedule

| Time | Focus |
| --- | --- |
| **10:30-noon** | Meet at the rigs for a brief setup orientation and tethering demonstration, then work hands-on: tether, mount one fly, and run P0. P0 is a calibration protocol: it asks which stimulation levels are most effective for that genotype on that rig. |
| **After lunch-5:30** | Bootstrap P1 and P2 across genotypes: different groups begin with different flies, run short protocols first, and collect high-quality data. At roughly hourly check-ins, we will compare results, troubleshoot, and decide together which genotypes or effects deserve more runs. |
| **Late afternoon** | Review promising results in the dashboard. Once core P1/P2 data are in hand, teams may try an instructor-approved variation or a new pattern. |
| **After evening lecture** | P3 closed-loop conditioning: an exploratory, instructor-led experiment. |

## Goals for the day

### Morning — learn the rig, tether, and run P0

Everyone should tether at least one fly and become comfortable with the rig
before lunch:

1. Open **Arena Studio** and connect to the rig.
2. In the Editor, open **[P0](protocols/p0-opto-intensity.md)** first and trace
   its sequence so you understand what the protocol will do.
3. Explore the **Console**: browse patterns, display several patterns at
   different speeds and directions (including a negative speed), try modes 2
   and 3, and drive the optogenetic LED.
4. On a fly-on-ball rig, start **FicTrac** and connect Arena Studio to it through
   the bridge.
5. Switch to the **Run** tab and inspect the live oscilloscope: identify the
   forward and turning signals and watch how they change with commands.
6. Run **P0** before lunch.

### Afternoon — collect useful behavioral data

Keep tethering and running flies. The immediate goal is `n=2` good flies in a
selected protocol; `n=4-5` is a realistic target for analyzable data. Work with
one or both of **P1** and **P2**, collecting multiple flies in each condition.

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
*Updated 2026-07-10 08:48 ET.*
