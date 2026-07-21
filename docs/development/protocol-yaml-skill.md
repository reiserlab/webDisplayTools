# The `protocol-yaml` skill — what it is, and how we validated it

*A short writeup for colleagues: what the skill captures, how we stress-tested it, what the
test found (including a real bug), and how we fixed it. Suitable as a basis for a slide.*

---

## TL;DR

We froze the hard-won knowledge of authoring **v3 protocol YAML** (for the G6/G4 LED
arenas) into a Claude Code **skill** — a short reference document plus a validator script.
To check it was actually good, we had **five copies of a smaller model (Claude Sonnet)**
each write a different, demanding G6 protocol using *only* the skill. **All five produced
valid protocols on the first try.** The exercise also surfaced **one real latent bug** in
the shared validation code and several documentation gaps, all of which we fixed and
locked with a regression test.

**The headline:** a cheaper model, handed the skill, now authors correct arena protocols
first-shot — and the act of testing the skill found a production bug that had been hiding
behind the test fixtures.

---

## 1. What the skill is

A "skill" in Claude Code is a small folder that teaches the assistant a specific,
stable body of knowledge — it loads automatically for anyone working in this repo. Ours
lives at `.claude/skills/protocol-yaml/` and has two parts:

**`SKILL.md`** — the reference. It captures the things that are *true but not obvious from
looking at a protocol file*, the kind of knowledge that otherwise gets re-learned painfully
each time:

- **The waits rule** (the big one): `trialParams` is fire-and-forget — it arms the
  controller and returns immediately; it does **not** advance the protocol clock. Only
  `wait` commands do. So every timed `trialParams` needs a companion `wait`, and a
  condition's real duration is `max(trialParams.duration, Σ waits)`. Editing only one of
  the pair is silently masked by the other — the classic "the timeline won't update" trap.
- **Trial mode semantics** — mode 2 (constant rate; negative frame_rate = reverse), mode 3
  (host-stepped / FicTrac closed loop), mode 4 (analog closed loop) — and which fields are
  live vs fixed in each.
- **Pattern naming and sizing** — reference by filename; `.pat` size math; direction
  correctness; the fresh-vs-legacy caveat.
- **Anchors / variables**, plugins (which the web runner executes vs skips), the FicTrac
  closed-loop command shape, the G6-only analog/digital I/O command shapes, `frame_index`
  conventions (including the stripe-fixation start-position rule), and duration granularity.

**`bin/validate-protocol.mjs`** — the checker. It runs the repo's own parser and
error/warning collectors *plus* a custom lint for the waits rule and the mode/field
sanity checks, and prints a plain-language report with an exit code. Anyone can run it on a
protocol before it ever touches a browser or the arena:

```
pixi run node --import ./tests/vendor-yaml.register.mjs \
    .claude/skills/protocol-yaml/bin/validate-protocol.mjs path/to/protocol.yaml
```

**Why bother:** protocol mistakes (a missing wait, a wrong mode field, a mistyped pattern
name) are invisible in the YAML and only bite at run time on the bench. The skill moves
that knowledge to where it's authored and makes the check one command.

---

## 2. How we validated it

We treated the skill as a product and ran an honest experiment: **can a *smaller, cheaper*
model author correct protocols with nothing but the skill?** If yes, the skill is doing its
job; if not, the gaps tell us what to add.

**Setup:** five Claude Sonnet agents in parallel, each given a different G6 (2×10 arena)
stress specification, instructed to (1) read `SKILL.md` first and use no outside format
knowledge, (2) author the protocol, and (3) run the skill's validator and report its
**first-run** output *verbatim* — before any self-correction. Then **we independently
re-ran the validator on every file ourselves** rather than trusting the agents' self-reports.

The five specs were chosen to hit the corners a real course will use:

| # | Stress spec | Result (first run) |
|---|---|---|
| A | Open-loop only, many short trials (0.25–2 s), reverse motion, a block | ✓ clean (14 conditions) |
| B | FicTrac: mixed closed-loop (Mode 3) + open-loop (Mode 2) | ✓ clean (8 conditions, plugin detected) |
| C | Long trials (60–300 s), heavy use of variables/anchors | ✓ clean (9 conditions) — *surfaced the bug* |
| D | Analog/digital I/O heavy (`setAnalogOut` / `setDigitalOut`) | ✓ clean (9 conditions) |
| E | Large realistic protocol: 22 conditions, 3 blocks, everything mixed | ✓ clean (22 conditions) |

**Every protocol validated clean on the first attempt.** That is the core result: the skill
was sufficient for a smaller model to get demanding G6 protocols right first-shot, with no
outside knowledge and no iteration.

---

## 3. What the test surfaced

A clean pass doesn't mean nothing was learned. The exercise found one bug and several gaps.

### A real, latent bug in the validation code

Agent C's protocol (heavy anchors) produced a bogus warning:

```
⚠ Anchor "&function anchor() { [native code] }" is declared in variables: but never referenced.
```

That garbage name — `function anchor() { [native code] }` — is the fingerprint of
JavaScript's deprecated `String.prototype.anchor` method. The unused-anchor check in the
shared parser (`js/protocol-yaml-v3.js`) read `pair.value.anchor`, which is correct only for
*mapping-style* variables (`name: &anchor 5`). But the **documented** shape — and the one
every fixture and the skill use — is *sequence-style* (`- &anchor 5`), where the anchor sits
on the item node directly. For a **string-valued** sequence anchor, `.value` was the string
itself, so `.anchor` returned that deprecated method and the code emitted a false "unused"
warning for an anchor that was, in fact, used.

**Why it had hidden:** the bug only triggers on a *string-valued sequence anchor*. The
existing fixtures use numeric anchors, so the test suite never exercised the failing path.
It took a model improvising a realistic protocol (a pattern name stored as an anchor) to
walk into it.

### Documentation gaps the agents hit

- **Analog/digital I/O had no field shapes.** The skill named `setAnalogOut` /
  `setDigitalOut` but didn't give their fields, so agent D had to open a fixture to learn
  `mv` (millivolts), `channel` (1-based), `state` (0/1).
- **`frame_index` indexing wasn't stated** (0- vs 1-based), so agent B had to guess.
- **No fully worked block example** — only a skeleton line, so the block/`trials:` shape
  was inferred.
- **The FicTrac closed-loop command pattern** (`startClosedLoop` / `stopClosedLoop` around
  the wait) wasn't shown explicitly.
- **Duration granularity was described loosely** ("seconds"), which understated that
  fractional/sub-second values are fully supported.

---

## 4. How we corrected them

**The bug** — the unused-anchor scan now handles both variable shapes and guards against the
primitive-`.value` footgun (a string's `.anchor` is no longer mistaken for an anchor name).
We added a **regression test** using the exact triggering shape (a sequence-style,
string-valued anchor) so it can't silently return. The full suite passes (710/710).

**The skill** was expanded to close every gap the agents hit:

- Exact `setAnalogOut` (`mv`, millivolts) / `setDigitalOut` (`channel` 1-based, `state`
  0/1) shapes, so I/O no longer needs a fixture dive.
- A worked FicTrac Mode-3 closed-loop example (`startClosedLoop` / `stopClosedLoop` around
  the wait).
- A full block / repetitions / intertrial / `trials:` example.
- `frame_index` is 0-based; `duration` is a float in seconds — sub-second is fine and
  preserved exactly through save (verified empirically), with an honest note that the web
  runner is host-timed (soft real-time) and that a MATLAB/G4 executor may quantize to 0.1 s.

We then **verified the skill's own new examples validate clean**, so the reference can't be
teaching wrong shapes.

Two further domain notes were added from expert review while the skill was fresh: the
**stripe-fixation start position** (these trials start with the object in front of the fly,
≈ frame 100 of 200, not frame 0) and the **reason** for the pattern alignment (frame 0/1 is
aligned to the center of the column directly behind the fly so recorded position data maps
straight to azimuth — histograms need no unwrapping in analysis).

**Commits:** `d707eab` (skill created) · `aba87b7` (bug fix + I/O & closed-loop docs) ·
`1807487` (duration clarified) · `43e1ae2` (fixation start position) · `2bd9d5c` (alignment
rationale).

---

## 5. Takeaways (slide-ready)

1. **Freezing tacit knowledge pays off.** The rules that cost real bench time — the waits
   trap, mode fields, I/O shapes — now live in one place and load automatically.
2. **A smaller model + a good skill = correct first-shot output.** Five demanding G6
   protocols, five clean passes, no iteration. That's a strong signal the reference is
   complete enough to hand to students or collaborators.
3. **Testing the skill tested the tools.** The exercise found a production bug in shared
   parsing code that the fixtures had masked for months — and it's now fixed with a
   regression guard. Stress-testing documentation with an independent author is a cheap way
   to shake out latent defects.
4. **The validator makes it self-checking.** Anyone can run one command to confirm a
   protocol is sound before it reaches the arena.
