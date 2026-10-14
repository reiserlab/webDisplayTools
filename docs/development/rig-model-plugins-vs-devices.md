# Rig model: controller hardware, devices, and plugins

**Status:** design, not yet implemented (2026-10-14). This is the authority for *where a thing
lives* in the rig and protocol YAML. It will be completed in the PR that adds the `devices:` parser
(LAB-214) and must be finished before that PR is considered done. The bridge and its connectors are
covered separately in `bridge-connectors-design.md` (to be written, LAB-303); the web-vs-MATLAB
runtime differences belong in the compatibility table in `v3-spec.md`.

## The rule

A rig has exactly two kinds of things, decided by one question:

> **Can the arena controller reach it over its own wires?**
> Yes → it is **controller hardware**, executed by the browser over Web Serial.
> No → it is a **plugin**, executed through the bridge by a connector.

"Its own wires" means the controller board's BNC digital I/O, the analog input and output, and the
Qwiic I2C chain. "No" covers a separate program (FicTrac, BIAS, ScanImage, a ROS robot) and hardware
attached to the PC rather than to the controller (the backlight LED board on a COM port, an NI DAQ).
There is no third kind.

Corollary for users: plugins are the only things that need the bridge for *control*; everything uses
the bridge for *logging*.

## Controller hardware: primitives and devices

Controller hardware is described in the rig YAML at two levels.

**Primitives** are the raw capabilities of the controller, one block each:

| Block | What it configures | Executed by |
|---|---|---|
| `io:` | the fixed board connectors: two digital BNCs with a firmware ROLE and power-on default each (`off`, `in_trigger`, `out_programmable`, `out_debug_framescan`, and the planned `in_event`), the analog input role, the analog output role and default | browser → serial at connect; protocol `type: controller` commands `setAnalogOut`, `setDigitalOut`, `ledDrive` |
| `peripherals:` | an open list of Qwiic I2C devices: `name`, `kind` (driver), `address`, `poll`, `config`, `channels` | browser → serial (I2C_TRANSFER 0xB1); bus scan vs YAML check in the Studio |

A primitive used plainly stays a primitive. A protocol may call `setAnalogOut` with millivolts; a
Qwiic environment sensor may simply be polled and logged.

**Devices** are named bundles of primitives with meaning attached. Promote a primitive (or a set of
them) to a device when it needs any of these five things:

1. a **name** experimenters use ("FlyRis", "opto LED"), rather than a wire;
2. **units** and a **calibration** (level → measured light, pulse width → position);
3. **more than one primitive** acting together;
4. a **safety rule** (a limit switch that stops an actuator);
5. **state** (homed, calibrated on a date, stale).

Proposed block (design; field names may change in LAB-214):

```yaml
devices:
  - name: flyris                      # FlyRis controller: couples a device to the arena
    kind: flyris_controller
    actuator: {peripheral: servo, channel: servo0}   # RC servo on a Qwiic PCA9685
    limit:    {dio: 1, active: low, on_assert: stop} # limit switch on a spare digital input

  - name: opto_led                    # BuckPuck LED drive, calibrated against a light sensor
    kind: led_drive
    actuator:    {ao: 1, curve: buckpuck_inverted}
    sensor:      {peripheral: light, channel: 0}
    calibration: {file: calib/opto_led_2026-10-14.yaml, units: uW_cm2}
```

Protocols address devices by name with verbs that belong to the device kind (`deviceMove`,
`deviceHome`, `deviceStop`; `ledSet` in physical units). The runner translates them into the
primitives it already sends (I2C transfers, analog-out writes, digital reads). The Studio renders one
device panel from the YAML instead of a panel per gadget.

**Safety is never the host's job.** A limit switch that stops a servo only after a browser round
trip is not a safety device. The stop path is either hardware (the switch cuts the servo signal or
power) or a firmware interlock (input assert → I2C stop, configured from the device entry at
connect). The host orchestrates normal motion and logs it.

**Calibration** lives with the device: a dated file the device entry points at, produced by the
Studio's calibration mode (step the actuator, read the sensor, fit, save). The Studio shows
"calibrated on …" or "stale".

## Plugins

Plugins are external programs or PC-attached hardware. The protocol declares them under `plugins:`
with `{name, type, matlab: {class}, config}` and uses them with `{type: plugin, plugin_name,
command_name, params}`; the rig YAML provides connection defaults under the same instance name, and
the protocol's `config:` overrides them. The plugin name is the INSTANCE (`camera`, `camera2`); the
connector or MATLAB class is the TYPE. Plugin semantics (`config.critical`, `timeout_s`, `on_loss`),
the bridge contract and the ROS 2 question are in LAB-303 and the bridge design doc.

## Examples

| Thing | Home | Why |
|---|---|---|
| FlyRis controller (servo on Qwiic + limit switch on DIO) | device | two primitives, a safety rule, state |
| Opto LED (BuckPuck on analog out) | device | units and calibration |
| Framescan pulse to the vDAQ (2P sync) | primitive, `io:` DIO role | one wire, no semantics beyond the role |
| Qwiic environment sensor, polled and logged | primitive, `peripherals:` | until a rule needs it |
| Wingbeat on the G6 analog input | primitive now; a device once calibrated | same logic as the LED |
| Backlight LED board on a PC COM port | plugin | PC-attached, not on the controller |
| FicTrac, BIAS camera, ScanImage, Kinefly, NI DAQ, robot | plugin | separate program or PC-attached |

## What is logged where

| Source | Log form | Clock |
|---|---|---|
| every controller command the browser sends (I2C transfers, AO writes, DIO writes) | `["a", …]` arena echo rows | bridge session ms |
| controller events (planned DIO `in_event` edges, frame records, state records) | telemetry `cc/cf/cs` rows via the 0xA9 ring drain | controller µs + host epoch ms |
| device verbs as the protocol wrote them | `runner` event lines (phase `plugin`/`device`) | bridge session ms |
| plugin streams, commands, replies, artifacts | connector-tagged rows and JSON events | declared per stream in `stream_schema` |

## Firmware dependencies

- DIO role `in_event` with debounce, emitting telemetry edge records, plus a current-state read and
  an optional I2C interlock table (firmware ticket, G6 Arena Hardware & Firmware project).
- Capability gating of the new role following the `fwGated` convention so older firmware greys it.

## MATLAB

MATLAB runs the same protocol YAML but has no composition layer: it executes controller commands and
its own plugin classes directly. Protocols that address devices are web-only until MATLAB gains the
same translation. Record this in the compatibility table in `v3-spec.md`; do not engineer around it.

## Still to decide (LAB-214)

Field names and the device-kind registry; where device verbs live in the registry
(`CONTROLLER_COMMANDS` vs a `DEVICE_COMMANDS` table); the calibration file format; whether a device
may reference another device; how `led_activation` names a device instead of a raw level.

Related: LAB-214 (host-side devices layer), LAB-213 (light-sensor calibration), LAB-303 (bridge and
plugins), LAB-149 (telemetry ring), LAB-150 (capability discovery).
