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


## Lisa's implementation notes and response [LF]

### Current implementation status

I have a working prototype of trial/sequence-level flow control that runs end-to-end on my Mac without hardware. It reuses the existing v3 execution classes unchanged (CommandExecutor, PluginManager, ClassPlugin, ScriptPlugin, ExperimentLogger) and adds two new core components: a FlowProtocolParser that emits a program of control nodes instead of a flat command list, and a FlowRunner that interprets that program at runtime.

The prototype is tested against dummy hardware (simulated fly, simulated wingbeat monitor, simulated air puff) and exercises all three flow-control cases identified in our Slack discussion. It has not been integrated into the v3 codebase. To be used in a real experiment, plugins for these pieces of hardware will still need to be created.

### How flow control is currently laid out and executed

The experiment section of the YAML remains a list of condition and block names. Flow control is expressed as a qualifier on an entry. The condition or block name always appears first so that scanning the left edge of the experiment list reads as a sequence of descriptive names, not control keywords:

```yaml
experiment:
  - "start"

  - condition: "fixation trial"
    flow_control: guard
    monitor: "wingbeat"
    check: "wbf_ok"
    pass: true
    on_fail:
      run: "puff and rest"
      then: repeat
    max_attempts: 5
    on_exhausted: advance

  - condition: "direction choice"
    flow_control: branch
    monitor: "wingbeat"
    check: "fly_chose_left"
    on_pass: "left sequence"
    on_fail: "right sequence"

  - name: "training blocks"
    trials:
      - "training A"
      - "training B"
    flow_control: repeat_until
    monitor: "wingbeat"
    check: "criterion_met"
    pass: true
    max_repeats: 5
    on_exhausted: "shutdown"

  - "shutdown"
```

Entries without a `flow_control` field behave exactly as they do in v3 — plain condition references or static blocks. The three options for flow control are:

- **guard**: run a trial, check a monitored measurement window spanning that trial, and on failure run a side-effect condition (e.g. puff air, wait 1 second) then retry, up to a mandatory `max_attempts` cap.
- **branch**: check a measurement window and run one of two named conditions depending on the result.
- **repeat_until**: run a block of trials repeatedly, checking a criterion after each pass, until the criterion is met or a mandatory `max_repeats` cap is hit.

All decisions are evaluated at trial or sequence boundaries, never within a running trial. The trial's `wait` command runs to completion exactly as in v3; the flow-control layer acts in the gap between trials.

### How measurements are taken/checked

Measurements come from monitor plugins — ordinary class plugins that buffer data in the background during trials. The prototype uses a DummyWingbeatMonitor that fills a ring buffer from a timer reading a simulated fly. The real version would use the same buffer/window API backed by an NI-DAQ `ScansAvailableFcn` (the same mechanism DAQThermometerPlugin already uses for continuous temperature logging).

The runner brackets each guarded or checked trial with `beginWindow` and `getWindow` calls on the monitor plugin. The resulting data window (timestamps and values spanning the trial) is passed to a check function. These functions would be standard in all plugins for monitoring hardware. 

Checks are ordinary script plugins — standalone MATLAB functions that receive the data window and return a value. These could easily be written by the user to do different checks on the data collected by the monitoring hardware. For guard and repeat_until, the check's output will be turned into a logical, so any nonzero number resolves to true and zero resolves to false. The pass condition (whether the fly passes and the experiment continues like normal) is set in the yaml as Pass: True or Pass: False. We would give this and some other fields default values to reduce the number of mandatory fields the user must add to the yaml.

### How later values or branches are selected

Guard side-effects and branch targets are named conditions from the conditions library. The runner looks them up in the conditions map and executes their commands through the existing CommandExecutor. No new command types or plugin interfaces are needed.

I was considering a `compute` flow_control type for N-way decisions, where a check returns a numeric value that parameterizes the next condition's commands at runtime via placeholder substitution. This would cover the closed-loop frame-selection case that Eyal brought up, but I haven't coded it. 

### What is logged

The prototype logs through the existing ExperimentLogger (same timestamped log as v3) and additionally records an **executed trace** — the actual sequence of steps that ran, including retries, chosen branches, and loop iterations. This is saved as both `executed_trace.mat` and `executed_trace.txt` in the results folder.

The trace records:
- every condition that executed, in order
- guard outcomes (which attempt passed, or if max attempts was reached)
- branch decisions (which path was taken)
- repeat_until outcomes (how many repetitions before the criterion was met, or if the max was reached)

The source YAML is not modified. The trace replaces the pre-expanded `experiment_steps.mat` from v3 because with flow control, the pre-expanded plan does not describe what actually happened.

### What has been tested

The prototype runs a complete scenario: a guard that fails on the first attempt (simulated tired fly, WBF too low), triggers a puff (which revives the fly), retries and passes; a branch that takes a path based on the revived fly's state; and a repeat_until block that runs twice before its criterion is met. All three constructs execute correctly through the real CommandExecutor and PluginManager with dummy hardware. It has not been tested on a real rig.

### How the current implementation maps onto this proposal

**Extension 1 (dynamic variables):** My prototype does not address this at all. Operator-adjustable runtime variables with logged change events and trial-boundary application are orthogonal to measurement-driven flow control and would be a useful tool. I agree this should be implemented. It solves a different problem (operator flexibility during a run) and there is no overlap or conflict with the flow-control constructs I've created. This would allow a user to watch the experiment and make real time decisions regarding adjustments to the experiment and my flow control would allow them to create scripts to check experiment conditions so they don't have to watch the experiment. Two different methods, both useful. 

**Extension 2 (YAML switching):** This is a bit different than what my prototype is trying to do. Session-level switching between programmatically updated, hashed YAML segments that cannot change once they've started running, with transition records, is appropriate for big structural changes: switching between experimental phases, selecting a protocol variant after a calibration block, or moving to a different set of conditions entirely. I agree this is a good mechanism for those cases.

**The gap is at the trial level.** Given all the execution happening between switches (check measurements, update or generate the next yaml, save it, validate it, hash it, then run it), this would introduce a lot of wait time in between segments where the fly is sitting there not exposed to anything. The three scenarios we identified in Slack - re-run a trial if a fly didn't fly, branch based on a fly's behavior, and repeat a block until something happens - need to operate faster than this, right? If you are simply trying to re-run a trial because the fly didn't fly, this lag for all this extra execution would be unnecessary and might hurt the integrity of the experiment. Neither extension really covers these scenarios. 

- *Trial check and retry (guard)*: The fly stops flying during a 5-second trial. The system needs to detect this from the data check, puff air, wait 1 second, and redo that specific trial — potentially multiple times in a row, capped at a maximum. Under the current proposal, this would require an external process that checks the data returned from a plugin, detects the failure, generates a new YAML, and initiates a segment switch, all within seconds. The currently implemented guard handles this scenario in 8 lines of YAML with no external code, and not all 8 of those lines need always be included, some can have default values for the typical use case. 

- *Sequence branching (branch)*: Choose sequence X or Y based on a measurement. A YAML switch could handle this if the variants are pre-defined, but the switching overhead (validate, hash, transition record, re-initialize plugins) is heavy for a decision that might happen between every trial. Which mechanism we'd want to use depends on how often it's happening. If we are switching YAMLs every other trial, by the end of an experiment a signficant amount of lag could be introduced. 

- *Block repeat or stop (repeat_until)*: Let the experiment decide its own length. An external script could implement this by deciding after each block whether to start another segment. This is viable but moves the experimental logic outside the protocol definition, which means the YAML alone no longer describes the experiment's behavior. It needs to be paired with some external execution code.

### What each approach achieves and does not achieve

| Capability | Dynamic variables (Ext 1) | YAML switching (Ext 2) | Lisa's Prototype |
|---|---|---|---|
| Operator adjusts a parameter mid-run | Yes | No | No |
| Change takes effect at trial boundary | Yes | Yes (new segment) | Yes |
| Switch to a different protocol structure | No | Yes | No |
| Automated trial-level check and retry | No (operator only in v1) | Heavy (full segment switch per retry) | Yes (guard) |
| Automated two-way branch | No | Yes (pre-defined variants) | Yes (branch) |
| Data-driven loop termination | No | Yes (external code decides) | Yes (repeat_until) |
| Protocol is self-contained | N/A | Across linked segments | Yes (single YAML) |
| Provenance after the run | Change log + per-trial params | Hashed segments + transition records | Executed trace + source YAML |
| YAML complexity added | Low (runtime_controls block) | Low (per YAML; complexity in orchestration) | Moderate (flow_control fields on entries) |
| External code required | No | Yes (for measurement-driven switching) | No |


### What the two-part approach would not cover 

The two extensions as described can cover everything but measurement-driven trial-level decisions must be handled by external orchestration code rather than declared in the YAML. There are some costs to this:

1. **The puff-and-retry loop needs external automation.** This the most common example of flow-control in experiments. In the current proposal's initial form (operator-controlled only), it requires a person to be watching every trial. In its measurement-driven extension, it requires an external process that runs alongside the experiment, monitors data, and triggers YAML switches at trial granularity. This can be done as part of the experiment runner, but if we implement code in the runner that receives the "fail" check, generates a new yaml, runs the retry, then continues the experiment, the user must then be able to configure this for their experiment. At a minimum they'll need to configure a maximum number of attempts. They'd likely also want to be able to configure what happens when the fail check is received (puff or something else?), what happens if the max number of attempts is reached (continue or end experiment?) - and that configuration must go either in a settings section of the yaml or a separate settings file of some kind. And at that point you've recreated the guard implementation in the prototype. Some of the simplicity gained from this method is lost by needing these configuration settings.

2. **Experimental logic splits across two artifacts.** The YAML defines what to run; external code defines when and whether to switch. Both are needed to understand or reproduce what the experiment did. Or if we implement the orchestration code in the software, an additional settings section or file is needed to understand and reproduce what the experiment did. 

3. **Segment switching is heavy for per-trial decisions.** Validating, hashing, and initializing a new YAML segment is appropriate for phase-level transitions but adds overhead and complexity for decisions that happen every few seconds.

None of these are blocking but they're tradeoffs we should consider carefully.

### A possible combined approach

The two extensions and the flow-control constructs solve problems at different granularities and actually combine pretty cleanly. I suggest a combined approach that keeps the best of both. 

- **Extension 1 (dynamic variables)**: implement as proposed. Useful regardless, no overlap with flow control.
- **Extension 2 (YAML switching)**: implement as proposed for coarse-grained structural changes (phase transitions, protocol variants, measurement-driven protocol generation at block boundaries or longer). I would suggest we implement as part of the software package and provide a way for users to configure any relevant YAML switching settings. Could be a settings section in the experiment yaml or rig yaml, or a separate configuration file. 
- **Guard**: retain as a third, narrowly scoped mechanism for automated trial-level check-and-retry. It does not turn the YAML into a general-purpose language — it is a declared rule with a capped retry count and a named side-effect, evaluated at trial boundaries. It sits inside one YAML segment and is compatible with both extensions. 

Branch and repeat_until could be deferred until there are concrete experimental use cases that cannot be handled by YAML switching. The guard is the one construct that addresses a gap neither extension covers well in its initial form.

Value-setting (the `compute` type for parameterizing later conditions from earlier measurements) and multi-way branching can wait until use cases become more clear and simpler flow control is settled. This makes true closed-loop experiments not possible for this software at the present, but could be developed later as an expansion to flow control.




