# Flow control: Slack discussion and Michael's counter-proposal

**Status:** Discussion draft for Lisa and the experiment-control team  
**Date:** 2026-07-12

## What we discussed in Slack

The discussion focused on flow control at trial, sequence, and block boundaries,
rather than changes within a running trial.

Lisa first proposed two levels of control:

- a simple `wait_for` command that pauses until a plugin-reported condition is
  met; and
- branching that can select another condition, repeat an earlier condition, or
  end the experiment.

We identified three representative use cases:

1. **Trial check and retry:** test a measurement; if the check fails, puff air,
   wait, and repeat the trial.
2. **Sequence branching:** choose sequence X or Y from measured data.
3. **Block repeat or stop:** decide whether to repeat a block or end the
   experiment.

The measurements might include wingbeat frequency or walking speed, with
filtering and thresholding before a decision is made.

Lisa has written code for these cases and was testing it when she left, but has
not integrated it into version 3. She also raised two possible generalizations:
setting values in later conditions from earlier outputs, and choosing among more
than two branches. Her main question is how far we want to take this before
integration.

The existing version 3 design already provides useful provenance: conditions
are defined once and referenced by the experiment sequence, variables use YAML
anchors and aliases, and a resolved YAML plus the SD-card manifest are copied
into each run's results. Any flow-control extension should preserve that basic
principle: after the experiment, we must be able to determine exactly what ran.

## Michael's counter-proposal: more functionality, less complexity

Michael's counter-proposal is to support a broader set of practical experimental
changes while minimizing new complexity in the YAML and runtime executor. Rather
than building a general-purpose branching and value-setting language into an
active protocol, use two simpler mechanisms: constrained runtime variables for
small changes, and a switch to a new YAML for larger ones.

This division is intended to preserve flexibility without turning the YAML into
an open-ended programming language. It also makes the boundary explicit: small
parameter changes and large structural changes use different mechanisms.

### Extension 1: limited dynamic variables

**Motivation.** During an otherwise unchanged experiment, an operator may need
to adjust one parameter. The immediate example is changing optogenetic LED
intensity without stopping the run and rewriting the YAML.

**Strategy.** A YAML may explicitly expose a small set of existing variables as
runtime controls. Each control must provide a default value, type, and allowed
range or set of values; numeric controls should also specify units when useful.
Undeclared variables remain fixed.

```yaml
variables:
  led_percent: &led_percent 25

runtime_controls:
  led_percent:
    type: number
    units: percent
    minimum: 0
    maximum: 100
```

For the first implementation:

- controls are changed only by the operator;
- the interface has one explicit **Apply** action;
- a change takes effect at the next trial boundary;
- the new value persists until changed again; and
- a reason may be entered, but is optional.

The source YAML is not rewritten. Each apply event records the session, YAML
identity and hash, variable, old and new values, operator, request and effective
times, and first affected trial. Each trial also records the complete resolved
parameters it actually used. The per-trial record is the final authority.

This first version should support only numeric, integer, Boolean, and enumerated
controls. Pattern switching and pattern caching should be handled later as a
separate design problem.

### Extension 2: switch YAML files for larger changes

**Motivation.** A different sequence, block structure, set of conditions, or
control policy is a different protocol segment—not merely a parameter override.
Representing such changes as a growing list of runtime mutations would make the
experiment harder to inspect and reproduce.

**Strategy.** Keep one session ID for the biological experiment, but represent
each larger phase as a separate, immutable YAML segment. Each segment has its own
run or segment ID and identifies the exact saved, validated YAML by content hash.
A transition record connects the segments.

```text
session S
  segment A — protocol_A.yaml — hash A
  transition — operator or process selected protocol B
  segment B — protocol_B.yaml — hash B
```

The next YAML must be saved, validated, and hashed before it runs. The transition
record should say when the switch occurred and why. If an online process selects
or generates the next YAML, it should also record the process version, inputs,
and decision output.

Predefined YAML variants and operator-controlled switching are the simplest
first use. Measurement-driven generation or selection can be considered later.
Many experiments already have a natural block structure, so we should first ask
whether a proposed automatic behavior is clearer as a new YAML segment than as
dynamic logic inside one file.

## Proposed next step

Michael's counter-proposal is therefore:

1. implement narrowly scoped, operator-controlled dynamic variables; and
2. use linked immutable YAML segments for larger changes.

Lisa: please edit or comment on this document to describe how your current
implementation maps onto this proposal. In particular, it would be helpful to
record how decisions are represented and evaluated, what measurements are
available, how later values or branches are selected, what is logged, and what
has been tested.

The questions to resolve together are:

- Does your current implementation fit cleanly within either mechanism?
- Which of the three flow-control cases should be integrated now?
- Do we need value-setting or multi-way branching now, or should those wait for
  concrete experimental use cases?
- Is any important experiment impossible to express through constrained dynamic
  variables plus linked YAML segments?
