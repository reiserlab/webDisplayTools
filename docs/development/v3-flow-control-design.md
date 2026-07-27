# v3 flow control — design and Stage 1 scope

**Status:** Design agreed; ready for implementation
**Stage:** Stage 1 — *Retry & Repeat*
**Date:** 2026-07-26
**Supersedes:** `flow-control-counter-proposal.md` (the Slack discussion, Michael's
counter-proposal, and Lisa's response — retained as the reasoning archive)

---

## Executive summary

We are adding two constructs to v3 protocols: **`trial_check`** (run a trial, and if a
measurement says it was no good, take a recovery action and retry, up to a cap) and
**`repeat_until`** (repeat a block between a minimum and maximum count, stopping early when a
measurement says the animal's vigor has declined).

Both are driven by a **single shared criterion grammar**: one metric, one statistic, one
comparison. There are no user-written check scripts in Stage 1. That single decision removes
the check-plugin interface, the MATLAB-versus-browser portability problem, and the question of
whether a protocol is self-contained.

Neither construct changes the protocol. `trial_check` preserves it; `repeat_until` sizes it.
All structural change continues to go through a new YAML file (Extension 2), and all operator
parameter changes go through declared runtime controls (Extension 1). That is the boundary
that keeps the protocol format from becoming a programming language.

**Not in Stage 1:** early trial abort, `branch`, `compute`, N-way branching, multiple metrics,
user script checks, and within-trial control.

### Scope and intent

This stage was chosen by asking what we would actually use on the rig in the next few months,
not by what is architecturally interesting. Two consequences are worth stating plainly, because
they are departures from the earlier discussion:

- **`repeat_until` is in, not deferred.** Running a block as many times as the animal's vigor
  supports — with a floor and a ceiling — is a routine practical need for both flight and
  walking experiments, not a speculative one.
- **Technical faults are a first-class use of `trial_check`.** An arena glitch or a FicTrac
  tracking error-trap, caught and recovered from, saves an entire experiment from being thrown
  away. This was not in the original framing and is arguably the strongest single justification
  for the construct.

### A note on naming

"Stage 1" rather than "v1": `version: 1` and `version: 2` are real protocol formats that the
parser explicitly rejects, so an ordinal here would collide with the format version in a way
that invites the wrong reading. Feature milestones use stage names; the file format stays at
`version: 3`.

---

## 1. Why four mechanisms, and how they divide

Flow control is not one problem. It is four, at four granularities, and conflating them is what
makes protocol formats turn into programming languages.

| Mechanism | Granularity | Decided by | Changes the protocol? |
|---|---|---|---|
| `trial_check` | trial | measurement or device health | **No** — preserves it |
| `repeat_until` | block | measurement | **No** — sizes it |
| Runtime controls (Ext 1) | any trial boundary | operator | Parameter values only |
| YAML switch (Ext 2) | minutes / phase | measurement or operator | **Yes** — structurally |

The practical cadence matters here. Protocol change in real experiments happens on the scale of
**minutes**, not trials: run a batch of measurements, find the receptive field centre, recompute
the protocol, run many more minutes. That maps directly onto switching to a new immutable YAML,
and it is why the latency of validating and hashing a new segment is not a concern — these
transitions are infrequent by nature.

What genuinely cannot wait for a segment switch is not protocol change at all. It is *recovery*
(the fly stopped flying; the arena glitched) and *iteration* (how many times should this block
run). Those are what `trial_check` and `repeat_until` cover.

### The line for what we defer

**`trial_check` and `repeat_until` control iteration and recovery within a fixed program.
`branch` and `compute` change the program.** The first pair is not a programming language. The
second pair is. That is the boundary, and it is why the deferral list looks the way it does
rather than being an arbitrary cut for schedule reasons.

---

## 2. The criterion (one grammar, both constructs)

Every decision in Stage 1 reduces to: *take a metric over a window, reduce it to a statistic,
compare it against a threshold.*

```yaml
criterion:
  metric: walking_speed      # a metric the runner can supply on this rig
  statistic: mean            # `mean` | `fraction_below` | `fraction_above`
  stop_when: below           # `below` | `above`
  threshold: 5.0             # absolute…
  # …or relative to a session baseline:
  # baseline: {window: [2, 6], units: minutes}
  # fraction: 0.7
```

### Statistics

`mean` is the plain average over the window. The `fraction_*` statistics measure **how much of the
window** the metric spent past a level, and take a required `level:`:

```yaml
criterion:
  metric: wingbeat_frequency
  statistic: fraction_below
  level: 150                 # the per-sample line
  stop_when: above
  threshold: 0.30            # …reject if below 150 Hz for more than 30% of the trial
```

`level:` is the per-sample line; `threshold:` is what the resulting statistic is compared against.
Two words for two different things, each used consistently.

**For "did the animal actually perform?", prefer the fraction form.** A mean conflates *how hard*
with *how long*: a fly at 160 Hz for four seconds of a five-second trial that then quits has a mean
of 128, indistinguishable from a uniformly weak fly. `fraction_below` asks the question directly and
lets the protocol state how much of the trial must be good. `mean` remains the natural choice for
vigor decline against a baseline, where magnitude is the point.

**Median is not a separate statistic** — it is `fraction_below` at `threshold: 0.5`. The fraction
form generalizes it, so having both would be redundant.

Relative-to-baseline comparison is defined for `mean` only in Stage 1. The two forms serve the two
constructs' typical needs — fractions for trial rejection, baseline-relative means for vigor decline
— and the cross product is deferred until something needs it.

**The evaluation window is implied by the construct** and is not a field. A `trial_check`
criterion can only mean the trial that just ran; a `repeat_until` criterion can only mean the
repetition that just completed. There is no third possibility, so making it explicit would only
create the opportunity to express nonsense. (A sub-trial window — "the last two seconds", to
catch an animal that quit partway — is a genuine future refinement and can be added later as an
optional modifier without a format change.)

**Absolute or relative.** An absolute `threshold:` compares against a fixed value. A relative
criterion compares against a **session baseline** — the statistic computed over a wall-clock
window measured from the start of the run, e.g. minutes 2 through 6. The baseline is
deliberately a time interval rather than "the first repetition": it is independent of block
structure and repetition length, and starting at minute 2 rather than 0 skips settling time.

**The runner owns baseline state; criteria stay pure.** The runner computes the baseline once,
logs its value and window into the trace, and reuses it. Nothing stateful lives in the criterion
itself, so a run is reproducible from the YAML plus the trace.

**If the baseline window has not elapsed** when a block begins, the criterion is inactive and the
block runs on `min_repeats` alone. This is recorded in the trace. The authoring tools should warn
when the protocol structure makes this likely.

### Metrics

Stage 1 supports **one metric per criterion**, named explicitly, resolved by the runner against
what the current rig can supply:

- Flight rigs: wingbeat frequency (analog input, MATLAB).
- Ball rigs: mean forward walking speed (derived from the FicTrac bridge's `behavior_v1` stream
  via the shared kinematics module — available to both runners).
- Device health is exposed as an ordinary metric (link status, tracking quality), so apparatus
  faults use this same grammar rather than a second mechanism.

The metric is named explicitly rather than through an abstract `vigor` token. A token that
silently means wingbeat frequency on one rig and ball speed on another produces a wrong answer
where an explicit name produces an error. A rig-level role alias — the rig YAML declaring which
measurement plays the vigor role, as it already does for `io:` roles — is the natural way to make
one protocol portable across rig types, and is a deliberate later extension.

### Monitors

Monitors **buffer continuously** from the start of the run; the runner queries arbitrary time
windows against those buffers. This replaces bracketing a window around each trial.

**Continuous buffering is not continuous evaluation.** It is a storage-and-access contract, not a
decision cadence. In Stage 1 the runner evaluates each criterion exactly once — at the end of a
trial or a repetition — so statistics are computed over a complete, fixed window and nothing is
recomputed incrementally. Continuous buffering is what makes a session-spanning baseline possible;
it does not imply mid-trial decisions. (Those arrive with early abort, and bring their own minimum
evaluation interval with them — see §8.)

Two things follow. A session-spanning baseline becomes possible at all. And there is no ambiguity
about what interval a trial's criterion covers: the runner records trial start and end timestamps
and queries that exact span. This matters because v3 condition duration is
`max(trialParams.duration, Σwaits)` — the display runs autonomously on the controller, so "how
long the commands took" and "how long the trial lasted" are not the same interval, and an implicit
bracket would silently measure the wrong one.

The precedent already exists: `DAQThermometerPlugin` continuously logs temperature through
`ScansAvailableFcn`.

---

## 3. `trial_check`

Run a trial. Evaluate the criterion over that trial. If it fails, run a named recovery condition
and retry, up to a cap.

```yaml
- condition: "fixation trial"
  flow_control: trial_check
  criterion:
    metric: wingbeat_frequency
    statistic: mean
    stop_when: below
    threshold: 150
  on_fail:
    run: "puff and rest"      # a named condition from the library
  max_attempts: 5             # total attempts, including the first
  on_exhausted: advance       # `advance` | `abort` — required, no default
```

### Why not "guard"

The construct was called `guard` in the prototype. A guard implies gating *before* the fact,
which is the wrong mental model: this evaluates a trial **after** it has run and may repeat it.
`trial_check` names what the construct always does, rather than what it sometimes does — the
check happens every time, the retry only on failure.

### Two uses, one construct

*Biological rejection* — the fly stopped flying. The recovery action is an intervention (puff,
rest), and exhaustion means this animal is not cooperating: `advance`.

*Technical recovery* — an arena glitch, or a FicTrac tracking error-trap. The recovery action is
a device reset, and exhaustion means the rig is broken, so continuing would produce garbage:
`abort`. This case saves an entire experiment from being thrown away.

**`on_exhausted` is required and has no default.** The correct value flips between those two
uses, and getting it wrong is expensive in both directions — advancing through a broken rig
wastes a session, aborting on a tired fly throws away a good one.

**`max_attempts` counts total attempts including the first.** Stated explicitly because the
alternative reading is the more common off-by-one.

### Applying one check to many trials

Writing eight lines per trial is unusable for a forty-trial protocol. Three tiers, two of which
need no new machinery:

**Block level** — the common case. A check on a block applies to every trial in it:

```yaml
- name: "main block"
  trials: ["trial A", "trial B", "trial C"]
  repetitions: 10
  trial_check:
    criterion: {metric: wingbeat_frequency, statistic: mean, stop_when: below, threshold: 150}
    on_fail: {run: "puff and rest"}
    max_attempts: 3
    on_exhausted: advance
```

**Anchor and alias** — for the same check across several blocks or entries. This is free: v3
already supports and preserves YAML anchors, and the alias-preservation work in the SD-prep path
exists precisely so they survive. Define the check once under `variables:` and alias it wherever
it is needed.

**Entry level** — one-offs and overrides. An entry-level check overrides a block-level one.

A `trial_check` and a `repeat_until` on the same block compose without interaction: the check is
per-trial inside the block, the repeat is per-repetition of it.

### Retry timing

**A failed trial is retried immediately**, after the recovery condition runs.

This is unambiguously right for technical faults — the arena glitched, you reset it, you want
that trial's data under the same conditions, and deferring it would be worse. It is also the
canonical biological idiom: the point of the puff is to get the fly flying *so that this trial
can be captured now*.

Two consequences to be aware of:

- **A check is retrospective, not preventive.** The criterion spans the trial, so the animal runs
  the full trial before we learn it was no good. A failed attempt costs the trial duration plus
  the recovery action plus the retry. (Early abort — cutting a trial short the moment the
  criterion fails — is the fix for this, and is the leading Stage 2 candidate. See §8.)
- **With `randomize: true`, an immediate retry places the same condition twice in a row**, which
  is an order confound. The trace records this so it is visible in analysis rather than silent.

Requeuing a failed trial as "the next schedulable trial" is deliberately not built: it requires a
pending pool instead of a flattened list, a rule for trials that never come back up, and
interactions with repetition counting. It remains additive later as a `retry:` field defaulting to
immediate.

### Attempts are distinct trials sharing a parent

A retry after a puff or a device reset is not the same trial repeated — the animal's state and the
apparatus state have both changed. The trace records each attempt separately with a shared parent
step, rather than as one trial that happened more than once. Every attempt is written and carries a
validity mark; none are discarded (§5).

---

## 4. `repeat_until`

Repeat a block between a minimum and a maximum, stopping early when the criterion fires.

```yaml
- name: "training blocks"
  trials: ["training A", "training B"]
  flow_control: repeat_until
  min_repeats: 2              # run at least this many regardless
  max_repeats: 5              # hard cap
  criterion:
    metric: walking_speed
    statistic: mean
    stop_when: below
    baseline: {window: [2, 6], units: minutes}
    fraction: 0.7
```

The intent is: *as many repetitions as the animal's vigor supports, but never fewer than the
minimum and never more than the cap.*

**Polarity follows the construct name.** `repeat_until` stops when the criterion is met, so the
criterion always expresses the stop condition. There is no per-construct inversion flag.

**Evaluated only at complete repetition boundaries**, never partway through a repetition.
`randomize:` shuffles order within a repetition, so repetition-level aggregates remain comparable
across repetitions.

**`repetitions:` is the degenerate case.** A fixed `repetitions: 3` is exactly `min_repeats: 3,
max_repeats: 3`. A block therefore carries either the static key or the dynamic pair, and the
validator rejects a block that sets both.

**No `on_exhausted` here.** Both exits are normal outcomes: the criterion fires (the animal faded,
as expected) or the cap is reached (the animal stayed strong, which is the *good* result). Neither
is a failure, so there is nothing to decide — the trace simply records which exit occurred. An
optional `on_max_reached:` for protocols where hitting the cap *is* a failure (a training paradigm
where criterion was never reached) is deferred until someone needs it.

---

## 5. Provenance

**The trace is additive.** v3 writes a pre-expanded plan (`experiment_steps.mat`); flow control
adds a realized **executed trace** alongside it. The plan is not removed. Analysis needs to
distinguish "planned but not run" from "never part of this run", and only keeping both supports
that.

The trace records, per decision: the criterion's computed value, the threshold or baseline it was
compared against (with the baseline's own window and value), pass or fail, the attempt or
repetition index, the recovery condition run, and the exit taken. Retries are tagged with **why** —
biological versus technical — because they mean different things downstream. Retries that create
an adjacency in a randomized block are flagged.

Existing v3 provenance is unchanged: resolved YAML and SD manifest copied into each results folder,
protocol identity and hash in the run log.

### Failed attempts are written and marked invalid, never discarded

Every attempt — including the ones a `trial_check` rejects — is written to the data files.

Two reasons. Discarding is frequently not even possible: with continuously acquired streams (DAQ
channels, FicTrac, video), the data for a failed attempt is already in the record by the time the
criterion is evaluated. Validity can therefore only ever be a *marking* on top of a continuous
record, not a decision made at write time. And discarding measured data is not scientifically
defensible regardless of whether it happens to be technically possible.

Three consequences:

- **Every attempt consumes a trial index** and produces a record. A protocol's realized trial count
  varies from run to run, so analysis keyed on a fixed trial index will not survive contact with
  flow control.
- **Validity lives in the trace, not in the raw data.** Per attempt: `valid` (true/false),
  `invalid_reason` (biological or technical), the parent step it belongs to, and `attempt n of m`.
  The parent step is what lets analysis say "this trial was attempted three times — use the third."
- **Analysis must default to valid-only.** This is the same silent-wrongness hazard as §7's runner
  problem, one layer down: analysis code written before flow control reads every trial and will
  quietly include rejected ones. The validity convention has to reach the analysis tooling *before*
  any protocol starts producing invalid trials — the same "ship the awareness before the feature"
  rule that applies to the runners.

---

## 6. Failure policy

A criterion that cannot be evaluated is not the same as a criterion that failed, and must never be
silently treated as one.

- Metric unavailable on this rig → **authoring-time validation error**, not a runtime surprise.
- Monitor unavailable, buffer empty, window contains no samples, or the statistic is NaN → **fail
  closed: abort the run with a clear reason.** Silently advancing risks a session of meaningless
  data.
- Baseline window not yet elapsed → criterion inactive, `min_repeats` governs, recorded in the
  trace. This is a normal state, not an error.
- Abort requested during a recovery condition → the recovery condition completes or is interrupted
  according to the existing STOP semantics; the trace records the interruption.

Because every flow-control decision happens at a trial or repetition boundary, and runtime controls
also apply at trial boundaries, the two cannot interleave within a decision. No precedence matrix is
required.

---

## 7. Both runners

Flow control is going into the browser runner as well as MATLAB. **MATLAB implements first (Lisa);
the browser half is Michael's. The format is designed once, now, for both.**

This is affordable precisely because Stage 1 has no script checks. A declarative criterion is
evaluable by either runner. The metric sources differ by rig — walking speed is available to the
browser today through the FicTrac bridge; wingbeat frequency needs analog input and so begins
MATLAB-only — but that is a rig capability question, not a format question.

**Capability declaration, not a version bump.** A protocol using flow control declares:

```yaml
version: 3
requires: [flow_control]
```

`version:` stays `3`. It is typed as an integer and the parser hard-rejects anything else
(`js/protocol-yaml-v3.js:163`), so a `3.1` file would fail to open even for *editing* in the Studio.
More fundamentally, a version is a total order answering "can you read this at all", while a
capability set answers "which features does this need" — and during the MATLAB-first window, that
second question is the one being asked.

The capability token is **unversioned by design**. Capabilities compose as a set, so a later stage
adds a token (`requires: [flow_control, branching]`) rather than incrementing one. Nothing in this
scheme ever needs a version number.

**Ship the refusal before the feature.** Until a runner implements flow control it must refuse these
protocols loudly, and that gate has to land in both runners *before* any flow-control protocol
exists in the wild — an older runner has no idea to look for a new key. Current behaviour makes this
urgent and asymmetric:

- A `trial_check` entry is a mapping with `condition:` and no `trials:`, which the web parser
  hard-throws on (`js/protocol-yaml-v3.js:370`). Loud, but it also prevents *editing*.
- A `repeat_until` block parses cleanly today — it is a block with unknown keys, which land in
  `_unknownKeys` — and the web runner would flatten and run it as a plain block with the criterion
  **silently ignored**. This is the dangerous one.

**Web parser work required:** accept `condition:` entries in `extractSequenceEntry`; preserve
flow-control fields through `docReplaceSequenceEntry` (today it rebuilds entries from known keys
only, so editing an entry in the designer would silently drop them); honour `requires:` by refusing
to run rather than running wrong; and teach D4 import (`js/v3-import.js`) that a check's
`on_fail.run` is a dependency to pull.

**Recommended first increment:** ship the `requires:` refusal on its own, ahead of any other web
work. It is small, it is the only part that is time-critical, and it removes the silent-divergence
risk before a flow-control protocol can exist.

---

## 8. Deferred, and what would change our mind

| Deferred | Why | What would revisit it |
|---|---|---|
| **Early trial abort** | Within-trial action, excluded from Stage 1 | Leading Stage 2 candidate — see below |
| Minimum evaluation interval | Stage 1 evaluates once per complete trial, so trial length already supplies it | Arrives with early abort, where mid-trial decisions make it necessary |
| Sub-trial criterion windows | The whole-trial window covers the known cases | Catching an animal that quits partway through a trial |
| Baseline-relative fraction statistics | `mean` covers vigor decline; fractions cover trial rejection | A criterion needing both at once |
| `branch` | Changes the program, not just its iteration | A real experiment needing a genuine two-way path choice at trial cadence |
| `compute` / N-way | Parameterizing later conditions from earlier measurements is closed-loop control | Eyal's closed-loop frame-selection case, if it becomes concrete |
| Multiple metrics per criterion | One metric covers the known cases | A criterion that genuinely needs two measurements |
| User script checks | Not portable across runners; breaks self-containment | A criterion the declarative grammar cannot express |
| Requeued retries | Needs a pending pool and repetition-count interactions | Order confounds from immediate retry proving material |
| `on_max_reached` | Both `repeat_until` exits are normal today | A training paradigm where hitting the cap is a failure |

**Early abort is the strongest Stage 2 candidate — ahead of `branch`.** Cutting a trial short the
moment its criterion fails, rather than burning the remaining four seconds of a five-second trial,
saves real time on *every* failed trial. It is also not program change: it is the same recovery
concept acting sooner, so it sits on the correct side of the line drawn in §1. `branch`, by
contrast, buys expressiveness we have no concrete use for yet.

**A standing tripwire:** if `branch` and `compute` both land, the qualifier-on-an-entry approach was
the wrong foundation, and the right move is a proper control graph — which can validate
reachability, terminal states, and loop bounds directly — not one more keyword. That is a decision
to make deliberately, not to arrive at by accretion.

---

## 9. Open questions

1. **Which fields may default.** Fewer mandatory fields is a real authoring goal, but
   `on_exhausted` and `max_attempts` must stay explicit. The full default list should be settled
   before implementation rather than discovered during it.

*(Resolved and moved into the body: failed-attempt data handling → §5; ownership of the browser
half → §7.)*

---

## 10. Relationship to Lisa's prototype

Lisa's prototype (`FlowProtocolParser` + `FlowRunner`, tested against dummy hardware) already
implements `guard`, `branch`, and `repeat_until` and reuses the v3 execution classes unchanged.
What carries over, and what changes:

**Carries over:** the `condition:`-first entry syntax (deliberately chosen so the left edge of the
experiment list reads as names rather than keywords); the executed-trace concept; evaluation
strictly at trial and sequence boundaries; recovery targets as named conditions from the existing
library, executed through `CommandExecutor`; immediate retry after the recovery condition.

**Changes:**
- `guard` is renamed `trial_check` (§3), for the mental-model reason given there.
- Script-plugin checks are replaced by the declarative criterion — the single largest
  simplification, and what makes both-runner support affordable.
- `beginWindow`/`getWindow` bracketing becomes continuous buffering with runner-side time-window
  queries.
- The evaluation window is implied by the construct rather than being a field.
- The trace is additive rather than replacing `experiment_steps.mat`.
- `min_repeats` is added; `max_repeats` relates to `repetitions:` as described in §4.
- Block-level and aliased checks are added so one check can cover many trials (§3).
- `on_exhausted` becomes check-only and keyword-only, resolving the collision where the same key
  took an enum in one construct and a condition name in another.
- The `pass:` inversion flag is removed; polarity is fixed by each construct's semantics.
- `branch` is deferred, so `on_pass:`/`on_fail:`-as-condition-names does not enter Stage 1. (Its
  example also referenced a "sequence", which v3 does not have as a concept.)
