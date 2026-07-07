/**
 * plugin-registry.js — Plugin definitions and command schemas
 *
 * Provides:
 *   - BUILTIN_PLUGINS: definitions for LEDControllerPlugin, BiasPlugin
 *   - CONTROLLER_COMMANDS: controller command definitions
 *   - G6_ONLY_COMMANDS / isG6OnlyCommand(name): controller commands valid only
 *     on the G6 controller board (setAnalogOut, setDigitalOut)
 *   - getPluginCommands(pluginName): get available commands for a plugin
 *   - getCommandParams(pluginName, commandName): get parameter schema
 *   - getAllCommandOptions(enabledPlugins): get all available commands for dropdowns
 *
 * Dual-export pattern:
 *   - Browser <script> tag: window.PluginRegistry
 *   - ES6 module import: import { BUILTIN_PLUGINS, ... } from './plugin-registry.js'
 */

'use strict';

// ════════════════════════════════════════════════════
// Controller Commands
// ════════════════════════════════════════════════════

/**
 * Built-in controller commands for the G4/G6 display system.
 * These are always available regardless of plugins.
 */
var CONTROLLER_COMMANDS = {
    trialParams: {
        label: 'Trial Params',
        description: 'Display a pattern on the arena',
        params: {
            pattern: { type: 'string', required: true, label: 'Pattern file' },
            pattern_ID: {
                type: 'number',
                required: true,
                default: 1,
                min: 1,
                max: 65535,
                integer: true,
                label: 'Pattern ID'
            },
            duration: {
                type: 'number',
                required: true,
                default: 5,
                min: 0,
                step: 0.1,
                label: 'Duration (s)'
            },
            mode: {
                type: 'select',
                required: true,
                default: 2,
                options: [
                    { value: 2, label: 'Mode 2 - Constant Rate' },
                    { value: 3, label: 'Mode 3 - Host-stepped (FicTrac / frame jump)' },
                    { value: 4, label: 'Mode 4 - Closed Loop (analog)' }
                ],
                label: 'Mode'
            },
            frame_index: {
                type: 'number',
                required: true,
                default: 1,
                min: 0,
                max: 65535,
                integer: true,
                label: 'Frame index'
            },
            // int16 on the wire (fw ee74c33+, fw issue #4): negative plays
            // Mode 2 in REVERSE (G4-style count-down); sign ignored in Modes
            // 3/4. Max is 32767, NOT 65535 — since the firmware went signed,
            // larger unsigned values would silently alias to reverse rates.
            frame_rate: {
                type: 'number',
                required: true,
                default: 60,
                min: -32768,
                max: 32767,
                integer: true,
                label: 'Frame rate (Hz, − = reverse)'
            },
            gain: {
                type: 'number',
                required: true,
                default: 0,
                min: -128,
                max: 127,
                integer: true,
                label: 'Gain (int8)'
            }
        }
    },
    allOn: {
        label: 'All On',
        description: 'Turn all arena panels on'
    },
    allOff: {
        label: 'All Off',
        description: 'Turn all arena panels off'
    },
    stopDisplay: {
        label: 'Stop Display',
        description: 'Stop displaying the current pattern'
    },
    // setPositionX is the Mode-3 FRAME JUMP: it maps to SET_FRAME_POSITION (0x70),
    // and its `posX` param is a 0-based frame index (NOT a pixel/position offset).
    // The historical key `posX` is kept for YAML compatibility — only the labels
    // describe the real behaviour. (setColorDepth was dropped: it mapped to
    // SWITCH_GRAYSCALE 0x06, which is dropped on G6 — color depth is a property of
    // the .pat/SD-card header, not a runtime command. A YAML carrying setColorDepth
    // now has no schema here and is flagged as unsupported by the editor + runner.)
    setPositionX: {
        label: 'Set Frame (Mode 3)',
        description:
            'Mode-3 frame jump — show a specific 0-based frame (SET_FRAME_POSITION 0x70). ' +
            'Load the pattern first with a trialParams command (frame_rate 0). ' +
            'Full Mode-3 closed-loop streaming is out of scope.',
        params: {
            posX: {
                type: 'number',
                required: true,
                default: 0,
                min: 0,
                max: 65535,
                integer: true,
                label: 'Frame index (0-based)'
            }
        }
    },
    // ── G6-only I/O commands (see G6_ONLY_COMMANDS below) ─────────────────────
    // These drive hardware on the G6 controller board itself (not a plugin
    // device), so they are controller commands. They are instantaneous — they
    // send one wire frame and do NOT advance the sequence clock.
    setAnalogOut: {
        label: 'Set Analog Out (G6)',
        description:
            'Drive the "Analog Out (0-5V)" BNC (J27, MCP4725 DAC) to a DC level. ' +
            'G6 controller only (SET_AO_VOLTAGE 0xA0).',
        params: {
            mv: {
                type: 'number',
                required: true,
                default: 0,
                min: 0,
                max: 5000,
                integer: true,
                label: 'Voltage (mV)'
            }
        }
    },
    ledDrive: {
        label: 'LED drive (% intensity)',
        description:
            'Drive an LED through a BuckPuck current driver on the "Analog Out ' +
            '(0-5V)" BNC as a percentage of full brightness (0 = off, 100 = max). ' +
            'The runner maps % to the control voltage via the BuckPuck datasheet ' +
            'curve, so students calibrate in % instead of raw millivolts. G6 ' +
            'controller only (SET_AO_VOLTAGE 0xA0).',
        params: {
            percent: {
                type: 'number',
                required: true,
                default: 0,
                min: 0,
                max: 100,
                step: 0.1,
                label: 'Brightness (%)'
            }
        }
    },
    setDigitalOut: {
        label: 'Set Digital Out (G6)',
        description:
            'Drive the "Digital IO 1 (5V)" or "Digital IO 2 (5V)" BNC (board ' +
            'silkscreen names; J3/J4) HIGH/LOW as a TTL output. G6 controller ' +
            'only (SET_DIGITAL_OUT 0xAA; channel number == BNC label number).',
        params: {
            channel: {
                type: 'select',
                required: true,
                default: 1,
                options: [
                    { value: 1, label: 'Digital IO 1 (5V)' },
                    { value: 2, label: 'Digital IO 2 (5V)' }
                ],
                label: 'Channel'
            },
            state: {
                type: 'select',
                required: true,
                default: 0,
                options: [
                    { value: 0, label: 'LOW' },
                    { value: 1, label: 'HIGH' }
                ],
                label: 'State'
            }
        }
    }
};

/**
 * Is `name` a known/supported G6 controller command? Used by the editor to flag
 * unsupported controller commands (e.g. a legacy `setColorDepth`) on the command
 * card. The arena runner keeps its OWN copy of this set (it must stay import-free),
 * so this is the authoring-side mirror of the runner's emit list.
 */
function isKnownControllerCommand(name) {
    return Object.prototype.hasOwnProperty.call(CONTROLLER_COMMANDS, name);
}

/**
 * Controller commands that are ONLY valid on the G6 controller board (they drive
 * G6-specific hardware). Absence from this set means the command is supported on
 * all generations — so existing commands need no annotation. Used by the editor
 * to hide/flag these on a non-G6 rig, and to soft-warn on export.
 */
var G6_ONLY_COMMANDS = new Set(['setAnalogOut', 'setDigitalOut', 'ledDrive']);

/** Is `name` a controller command restricted to the G6 controller board? */
function isG6OnlyCommand(name) {
    return G6_ONLY_COMMANDS.has(name);
}

/**
 * Coerce a numeric value to a param schema's constraints (integer / min / max).
 * Pure — the designer calls this on commit to make out-of-range values
 * impossible to enter (clamp-to-legal). Non-numeric input or a schema without
 * numeric bounds is returned unchanged.
 *
 * @param {number|string} value  the raw entered value
 * @param {object} schema        a param schema ({ type, min, max, integer, ... })
 * @returns {{ value:*, changed:boolean, reason:(string|null) }}
 *   `value` is the corrected value; `changed` is true if it differs from the
 *   input; `reason` is a short human note (e.g. 'clamped to max 5000') or null.
 */
function clampToSchema(value, schema) {
    const n = Number(value);
    if (!schema || schema.type !== 'number' || !Number.isFinite(n)) {
        return { value: value, changed: false, reason: null };
    }
    let out = n;
    let reason = null;
    if (schema.integer && !Number.isInteger(out)) {
        out = Math.round(out);
        reason = 'rounded to integer';
    }
    if (typeof schema.min === 'number' && out < schema.min) {
        out = schema.min;
        reason = 'raised to minimum ' + schema.min;
    }
    if (typeof schema.max === 'number' && out > schema.max) {
        out = schema.max;
        reason = 'clamped to maximum ' + schema.max;
    }
    return { value: out, changed: out !== n, reason: reason };
}

// ════════════════════════════════════════════════════
// Built-in Plugin Definitions
// ════════════════════════════════════════════════════

var BUILTIN_PLUGINS = {
    backlight: {
        name: 'backlight',
        label: 'LED Backlight',
        type: 'class',
        matlab: { class: 'LEDControllerPlugin' },
        color: '#ff6b6b', // red-ish for UI
        configFields: {
            port: {
                type: 'string',
                label: 'Serial Port',
                default: '',
                placeholder: 'Set in rig YAML (e.g. COM6)',
                rigDefined: true
            },
            critical: {
                type: 'boolean',
                label: 'Critical (abort on failure)',
                default: '',
                placeholder: 'Default: true (set in code)'
            }
        },
        commands: {
            setIRLEDPower: {
                label: 'Set IR LED Power',
                description: 'Set infrared LED power level',
                params: {
                    power: {
                        type: 'number',
                        required: true,
                        default: 50,
                        min: 0,
                        max: 100,
                        integer: true,
                        label: 'Power (0-100)'
                    }
                }
            },
            setRedLEDPower: {
                label: 'Set Red LED Power',
                description: 'Set red visible LED power',
                params: {
                    power: {
                        type: 'number',
                        required: true,
                        default: 5,
                        min: 0,
                        max: 100,
                        integer: true,
                        label: 'Power (0-100)'
                    },
                    panel_num: {
                        type: 'number',
                        required: false,
                        default: 0,
                        min: 0,
                        integer: true,
                        label: 'Panel # (0=all)'
                    },
                    pattern: {
                        type: 'string',
                        required: false,
                        default: '',
                        label: 'LED pattern',
                        placeholder: '1010'
                    }
                }
            },
            setGreenLEDPower: {
                label: 'Set Green LED Power',
                description: 'Set green visible LED power',
                params: {
                    power: {
                        type: 'number',
                        required: true,
                        default: 5,
                        min: 0,
                        max: 100,
                        integer: true,
                        label: 'Power (0-100)'
                    },
                    panel_num: {
                        type: 'number',
                        required: false,
                        default: 0,
                        min: 0,
                        integer: true,
                        label: 'Panel # (0=all)'
                    },
                    pattern: {
                        type: 'string',
                        required: false,
                        default: '',
                        label: 'LED pattern',
                        placeholder: '1010'
                    }
                }
            },
            setBlueLEDPower: {
                label: 'Set Blue LED Power',
                description: 'Set blue visible LED power',
                params: {
                    power: {
                        type: 'number',
                        required: true,
                        default: 5,
                        min: 0,
                        max: 100,
                        integer: true,
                        label: 'Power (0-100)'
                    },
                    panel_num: {
                        type: 'number',
                        required: false,
                        default: 0,
                        min: 0,
                        integer: true,
                        label: 'Panel # (0=all)'
                    },
                    pattern: {
                        type: 'string',
                        required: false,
                        default: '',
                        label: 'LED pattern',
                        placeholder: '1010'
                    }
                }
            },
            turnOnLED: {
                label: 'Turn On LED',
                description: 'Turn on the configured LEDs'
            },
            turnOffLED: {
                label: 'Turn Off LED',
                description: 'Turn off all LEDs'
            },
            setVisibleBacklightsOff: {
                label: 'Visible Backlights Off',
                description: 'Turn off all visible (RGB) backlights, keep IR on'
            }
        }
    },

    // Keyed `temperature` to match the canonical rig plugin name (per Lisa F.,
    // 2026-06-10): rig YAMLs declare this plugin as `temperature`, so the experiment
    // YAML must use the same name or the rig's config won't carry over (the code
    // matches plugins by name). The MATLAB implementation class stays DAQThermometerPlugin.
    temperature: {
        name: 'temperature',
        label: 'DAQ Thermometer',
        type: 'class',
        matlab: { class: 'DAQThermometerPlugin' },
        color: '#ffa94d', // orange for UI
        // Config per Lisa's yaml_protocol_documentation_v3.md (2026-05-26).
        configFields: {
            device_id: {
                type: 'string',
                label: 'NI DAQ device',
                default: '',
                placeholder: 'e.g. cDAQ1Mod4'
            },
            channels: {
                type: 'string',
                label: 'Channels (comma-separated)',
                default: '',
                placeholder: 'ai0, ai2'
            },
            thermocouple_type: {
                type: 'string',
                label: 'Thermocouple type',
                default: 'K',
                placeholder: 'K'
            },
            sample_rate: {
                type: 'number',
                label: 'Sample rate (Hz)',
                default: 7,
                placeholder: '7'
            },
            sample_duration: {
                type: 'number',
                label: 'Sample duration (s)',
                default: 1.0,
                placeholder: '1.0'
            },
            generate_plots: {
                type: 'boolean',
                label: 'Generate PNG on log',
                default: true
            }
        },
        commands: {
            startContinuousLogging: {
                label: 'Start Continuous Logging',
                description:
                    'Begin background acquisition; logs to CSV at sample_rate Hz until stopped (recommended for long experiments).'
            },
            stopContinuousLogging: {
                label: 'Stop Continuous Logging',
                description: 'Stop background acquisition and close the CSV file.'
            },
            get_temperature: {
                label: 'Get Temperature',
                description: 'Read a single sample (blocks for sample_duration seconds).'
            },
            log_temperature: {
                label: 'Log Temperature',
                description: 'Read and log one sample (with optional PNG plot per generate_plots).'
            }
        }
    },

    camera: {
        name: 'camera',
        label: 'BIAS Camera',
        type: 'class',
        matlab: { class: 'BiasPlugin' },
        color: '#4dabf7', // blue for UI
        configFields: {
            executable: {
                type: 'string',
                label: 'BIAS Executable',
                default: '',
                placeholder: 'Path to BIAS executable'
            },
            ip: {
                type: 'string',
                label: 'IP Address',
                default: '',
                placeholder: 'Set in rig YAML (e.g. 127.0.0.1)',
                rigDefined: true
            },
            port: {
                type: 'number',
                label: 'Port',
                default: '',
                placeholder: 'Set in rig YAML (e.g. 5010)',
                rigDefined: true
            },
            video_format: {
                type: 'select',
                label: 'Video Format',
                default: '',
                placeholder: 'Default: ufmf',
                options: [
                    { value: '', label: '(use default)' },
                    { value: 'ufmf', label: 'UFMF' },
                    { value: 'avi', label: 'AVI' }
                ]
            },
            frame_rate: {
                type: 'number',
                label: 'Frame Rate',
                default: '',
                placeholder: 'Default: 100 (10-200)',
                min: 10,
                max: 200
            }
        },
        commands: {
            connect: {
                label: 'Connect',
                description:
                    'Connect to BIAS camera (use when rig YAML is missing ip, port, or config_file)',
                params: {
                    ip: {
                        type: 'string',
                        required: false,
                        default: '',
                        label: 'IP Address',
                        placeholder: '127.0.0.1'
                    },
                    port: {
                        type: 'number',
                        required: false,
                        default: '',
                        label: 'Port',
                        placeholder: '5010'
                    },
                    config_file: {
                        type: 'string',
                        required: false,
                        default: '',
                        label: 'Config file',
                        placeholder: 'path/to/camera_config.json'
                    }
                }
            },
            startRecording: {
                label: 'Start Recording',
                description: 'Start video recording',
                params: {
                    filename: {
                        type: 'string',
                        required: false,
                        default: '',
                        label: 'Filename',
                        placeholder: 'recording_name'
                    }
                }
            },
            stopRecording: {
                label: 'Stop Recording',
                description: 'Stop video recording'
            },
            startPreview: {
                label: 'Start Preview',
                description: 'Start camera preview'
            },
            stopCapture: {
                label: 'Stop Capture',
                description: 'Stop camera capture'
            },
            getTimestamp: {
                label: 'Get Timestamp',
                description: 'Record a timestamp marker'
            },
            disconnect: {
                label: 'Disconnect',
                description: 'Disconnect from BIAS camera'
            }
        }
    },

    // FicTrac closed-loop (fly-on-ball). WEB-FIRST: executed by the web runner via
    // the local Python bridge (fictrac-bridge/bridge.py) + Mode-3 host-stepping.
    // matlab.class is forward-looking — MATLAB has no FicTracPlugin yet (its only
    // closed-loop is analog Mode 4), so this YAML runs on the web runner today.
    // Driving the arena is the plugin's only real command: closed-loop applies
    // FicTrac frames via startClosedLoop/stopClosedLoop. Recording is NOT a command
    // — the bridge logs every FicTrac frame it receives continuously once connected,
    // so an open-loop trial just runs the arena's own commands with no fictrac call.
    fictrac: {
        name: 'fictrac',
        label: 'FicTrac closed-loop',
        type: 'class',
        matlab: { class: 'FicTracPlugin' },
        color: '#7c5cff', // violet for UI
        configFields: {
            bridge_url: {
                type: 'string',
                label: 'Bridge WebSocket URL',
                default: 'ws://localhost:8765',
                placeholder: 'ws://localhost:8765'
            },
            fictrac_port: {
                type: 'number',
                label: 'FicTrac port',
                default: 60000,
                placeholder: '60000'
            },
            proto: {
                type: 'select',
                label: 'FicTrac transport',
                default: 'udp',
                options: [
                    { value: 'udp', label: 'UDP' },
                    { value: 'tcp', label: 'TCP' }
                ]
            },
            gain: {
                type: 'number',
                label: 'Gain (deg heading / frame index)',
                default: 1.8,
                placeholder: '1.8'
            },
            offset: {
                type: 'number',
                label: 'Heading offset (deg)',
                default: 0
            }
        },
        commands: {
            connect: {
                label: 'Connect bridge',
                description:
                    'Open the FicTrac bridge WebSocket and push config. Idempotent; the runner also auto-connects at run start.'
            },
            disconnect: {
                label: 'Disconnect bridge',
                description: 'Close the FicTrac bridge WebSocket.'
            },
            startClosedLoop: {
                label: 'Start closed-loop',
                description:
                    'Drive the arena from FicTrac (Mode-3 host-stepping). Requires a Mode-3 pattern displayed (a preceding trialParams mode 3).',
                params: {
                    gain: {
                        type: 'number',
                        required: false,
                        default: 1.8,
                        label: 'Gain override (deg/index)',
                        placeholder: 'default: plugin config gain'
                    }
                }
            },
            stopClosedLoop: {
                label: 'Stop closed-loop',
                description: 'Stop driving the arena from FicTrac (FicTrac keeps being logged).'
            }
        }
    }
};

// ════════════════════════════════════════════════════
// Built-in "log" plugin (v3) — always available, never declared.
// ════════════════════════════════════════════════════
// Per Lisa's yaml_protocol_documentation_v3.md (Special Plugin Command - Logging):
// `plugin_name: "log"`, `command_name: "log"`. Not listed in `plugins:`.

var LOG_PLUGIN = {
    name: 'log',
    label: 'Log (built-in)',
    builtIn: true,
    color: '#8b949e',
    commands: {
        log: {
            label: 'Log message',
            description: 'Append a line to the experiment log.',
            params: {
                message: {
                    type: 'string',
                    required: true,
                    default: '',
                    label: 'Message',
                    placeholder: 'free text, up to 2000 chars'
                },
                level: {
                    type: 'select',
                    required: false,
                    default: 'INFO',
                    label: 'Level',
                    options: [
                        { value: 'DEBUG', label: 'DEBUG' },
                        { value: 'INFO', label: 'INFO' },
                        { value: 'WARNING', label: 'WARNING' },
                        { value: 'ERROR', label: 'ERROR' }
                    ]
                }
            }
        }
    }
};

// ════════════════════════════════════════════════════
// Lookup Functions
// ════════════════════════════════════════════════════

/**
 * Get available commands for a plugin by name.
 * Returns the commands object or empty object if not found.
 */
function getPluginCommands(pluginName) {
    var plugin = BUILTIN_PLUGINS[pluginName];
    return plugin ? plugin.commands || {} : {};
}

/**
 * Get parameter schema for a specific command.
 *
 * @param {string} type - 'controller' or 'plugin'
 * @param {string} pluginName - plugin name (ignored for controller)
 * @param {string} commandName - command name
 * @returns {object|null} params schema or null
 */
function getCommandParams(type, pluginName, commandName) {
    if (type === 'controller') {
        var cmd = CONTROLLER_COMMANDS[commandName];
        return cmd ? cmd.params || null : null;
    }
    if (type === 'plugin') {
        var commands = getPluginCommands(pluginName);
        var pluginCmd = commands[commandName];
        return pluginCmd ? pluginCmd.params || null : null;
    }
    return null;
}

/**
 * Get all available command options for dropdown menus.
 *
 * @param {string[]} enabledPlugins - array of enabled plugin names
 * @returns {object} grouped commands: { controller: [...], wait: [...], plugins: { name: [...] } }
 */
function getAllCommandOptions(enabledPlugins) {
    var result = {
        controller: [],
        wait: [{ value: 'wait', label: 'Wait', description: 'Pause execution' }],
        plugins: {}
    };

    // Controller commands
    var ctrlKeys = Object.keys(CONTROLLER_COMMANDS);
    for (var i = 0; i < ctrlKeys.length; i++) {
        var key = ctrlKeys[i];
        var cmd = CONTROLLER_COMMANDS[key];
        result.controller.push({
            value: key,
            label: cmd.label,
            description: cmd.description
        });
    }

    // Plugin commands
    if (enabledPlugins) {
        for (var j = 0; j < enabledPlugins.length; j++) {
            var pName = enabledPlugins[j];
            var plugin = BUILTIN_PLUGINS[pName];
            if (!plugin || !plugin.commands) continue;

            result.plugins[pName] = [];
            var cmdKeys = Object.keys(plugin.commands);
            for (var k = 0; k < cmdKeys.length; k++) {
                var cKey = cmdKeys[k];
                var pCmd = plugin.commands[cKey];
                result.plugins[pName].push({
                    value: cKey,
                    label: pCmd.label,
                    description: pCmd.description
                });
            }
        }
    }

    return result;
}

/**
 * Create a default plugin config object from a builtin plugin definition.
 *
 * @param {string} pluginName - builtin plugin name (registry key)
 * @param {string} [overrideName] - optional name for the entry. Used when adding
 *        a plugin under a rig key that differs from the registry key. Defaults to def.name.
 * @returns {object} plugin definition suitable for experiment.plugins[]
 */
function createPluginEntry(pluginName, overrideName) {
    var def = BUILTIN_PLUGINS[pluginName];
    if (!def) return null;

    var entry = {
        name: overrideName != null && overrideName !== '' ? String(overrideName) : def.name,
        type: def.type
    };
    if (def.matlab) {
        entry.matlab = { class: def.matlab.class };
    }
    // Populate config with defaults
    if (def.configFields) {
        var config = {};
        var hasConfig = false;
        var fields = Object.keys(def.configFields);
        for (var i = 0; i < fields.length; i++) {
            var field = def.configFields[fields[i]];
            if (field.default !== undefined && field.default !== '') {
                config[fields[i]] = field.default;
                hasConfig = true;
            }
        }
        if (hasConfig) {
            entry.config = config;
        }
    }
    return entry;
}

// ════════════════════════════════════════════════════
// v3 Lookup — by matlab class, not by plugin name
// ════════════════════════════════════════════════════
// v2 keyed off plugin **name** (assuming canonical "camera", "backlight"
// names). v3 lets users pick any name for a plugin entry, so lookups go via
// matlab.class instead. The built-in `log` plugin is always available even
// when not declared in the experiment's `plugins:` section.

/**
 * Find a built-in plugin definition whose matlab.class matches `className`.
 * Returns the entry or null.
 */
function findPluginDefByClass(className) {
    if (!className) return null;
    var keys = Object.keys(BUILTIN_PLUGINS);
    for (var i = 0; i < keys.length; i++) {
        var def = BUILTIN_PLUGINS[keys[i]];
        if (def.matlab && def.matlab.class === className) return def;
    }
    return null;
}

/**
 * Return the command schema map for a given MATLAB plugin class.
 * Returns {} when no registry entry matches.
 */
function getCommandsForClass(className) {
    var def = findPluginDefByClass(className);
    return def ? def.commands || {} : {};
}

/**
 * Resolve commands available on the plugin named `pluginName` in `experiment`.
 *
 *   - "log" returns the built-in LOG_PLUGIN commands (always available).
 *   - Otherwise: find the plugin entry by name in experiment.plugins, read
 *     matlab.class, and look up the registry by class.
 *   - Returns {} when the plugin isn't declared or the class isn't recognized.
 */
function getV3PluginCommands(experiment, pluginName) {
    if (pluginName === 'log') return LOG_PLUGIN.commands;
    if (!experiment || !Array.isArray(experiment.plugins)) return {};
    for (var i = 0; i < experiment.plugins.length; i++) {
        var p = experiment.plugins[i];
        if (p.name === pluginName) {
            var cls = p.matlab && p.matlab.class;
            return getCommandsForClass(cls);
        }
    }
    return {};
}

/**
 * Ordered list of plugin names available to a v3 experiment for use as
 * `plugin_name:` on a command. Includes user-declared plugins (in declared
 * order) plus the always-available "log" plugin at the end.
 */
function listV3PluginNames(experiment) {
    var names = [];
    if (experiment && Array.isArray(experiment.plugins)) {
        for (var i = 0; i < experiment.plugins.length; i++) {
            names.push(experiment.plugins[i].name);
        }
    }
    names.push('log');
    return names;
}

/**
 * v3 equivalent of getCommandParams — takes an `experiment` context so plugin
 * lookups route through matlab.class instead of guessing by plugin name.
 */
function getV3CommandParams(experiment, type, pluginName, commandName) {
    if (type === 'controller') {
        var cmd = CONTROLLER_COMMANDS[commandName];
        return cmd ? cmd.params || null : null;
    }
    if (type === 'plugin') {
        var cmds = getV3PluginCommands(experiment, pluginName);
        var pluginCmd = cmds[commandName];
        return pluginCmd ? pluginCmd.params || null : null;
    }
    return null;
}

// ════════════════════════════════════════════════════
// Rig-aware plugin mapping (#91 / #89)
// ════════════════════════════════════════════════════
// Rig YAMLs declare the plugins a rig provides under a `plugins:` map, keyed by
// canonical names (`backlight`, `camera`, `temperature`). An experiment's
// `plugins:` MUST use those same names to inherit the rig's connection config —
// so these are also the names D4 import must never prefix. Rig schemas drift
// (`type: "LED Controller"` vs `com_port`; camera `"Bias"` vs `"BIAS"`), so the
// rig→class mapping is tolerant: match the well-known key first, fall back to a
// normalized `type`, and degrade gracefully ("unknown plugin type") when unmapped.

// Canonical rig plugin names — never namespaced on import (the #89 baseline).
// `fictrac` is a physical fly-on-ball capability (a ball + FicTrac tracker), so a
// rig declares it only when the tracker is present — distinct from the logging
// bridge, which every web-runner rig uses regardless. A rig that lacks `fictrac`
// therefore flags a fictrac-using experiment as unsupported (diffRigVsProtocol),
// so you can't author a closed-loop run you can't run on that setup.
var WELL_KNOWN_RIG_PLUGIN_NAMES = ['backlight', 'camera', 'temperature', 'fictrac'];

// Well-known rig KEY → built-in registry key. The DAQ thermometer is keyed
// `temperature` (matching the rig + experiment YAML); the legacy `thermometer`
// name is tolerated and still maps to the `temperature` built-in.
var RIG_PLUGIN_KEY_MAP = {
    backlight: 'backlight',
    camera: 'camera',
    temperature: 'temperature',
    thermometer: 'temperature',
    fictrac: 'fictrac'
};

// Normalized `type` string → built-in registry key (fallback when the rig key
// isn't well-known). Keys are lowercased + stripped of spaces/punctuation.
var RIG_PLUGIN_TYPE_MAP = {
    ledcontroller: 'backlight',
    bias: 'camera',
    daqthermometer: 'temperature',
    thermometer: 'temperature',
    temperature: 'temperature',
    fictrac: 'fictrac',
    balltracker: 'fictrac'
};

function _normalizeRigType(rigType) {
    if (rigType == null) return '';
    return String(rigType)
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '');
}

/**
 * Map a rig plugin (by its key and optional `type`) to a built-in registry
 * definition. Key match first, then normalized type. Returns
 * `{ builtinName, def }` or null when unmapped.
 */
function mapRigPluginToBuiltin(rigKey, rigType) {
    var key = (rigKey == null ? '' : String(rigKey)).toLowerCase();
    if (RIG_PLUGIN_KEY_MAP[key]) {
        var bn = RIG_PLUGIN_KEY_MAP[key];
        return { builtinName: bn, def: BUILTIN_PLUGINS[bn] };
    }
    var t = _normalizeRigType(rigType);
    if (t && RIG_PLUGIN_TYPE_MAP[t]) {
        var bn2 = RIG_PLUGIN_TYPE_MAP[t];
        return { builtinName: bn2, def: BUILTIN_PLUGINS[bn2] };
    }
    return null;
}

/**
 * Derive the plugins a rig supports from a parsed rig YAML object.
 *
 * Tolerant by design — a null/partial `rigData`, or a missing/non-object
 * `plugins:` block, yields an empty result rather than throwing.
 *
 * @param {object} rigData - parsed rig YAML (e.g. from parseRigYAMLText)
 * @returns {{ plugins: Array, unmapped: string[] }} one entry per declared rig
 *   plugin: { key, enabled, type, builtinName, matlabClass, mapped }. `unmapped`
 *   lists keys with no recognized class.
 */
function deriveRigPlugins(rigData) {
    var result = { plugins: [], unmapped: [] };
    if (!rigData || typeof rigData !== 'object') return result;
    var pluginsObj = rigData.plugins;
    if (!pluginsObj || typeof pluginsObj !== 'object') return result;
    var keys = Object.keys(pluginsObj);
    for (var i = 0; i < keys.length; i++) {
        var key = keys[i];
        var cfg = pluginsObj[key] && typeof pluginsObj[key] === 'object' ? pluginsObj[key] : {};
        var type = cfg.type != null ? cfg.type : null;
        var mapped = mapRigPluginToBuiltin(key, type);
        result.plugins.push({
            key: key,
            enabled: cfg.enabled === true,
            type: type,
            builtinName: mapped ? mapped.builtinName : null,
            matlabClass: mapped && mapped.def.matlab ? mapped.def.matlab.class : null,
            mapped: !!mapped
        });
        if (!mapped) result.unmapped.push(key);
    }
    return result;
}

/**
 * Compare a rig's derived plugins against the protocol's declared plugins.
 * Name-based, because a plugin's declared name MUST equal the rig key to inherit
 * config (so a name mismatch is a real, actionable flag).
 *
 * @param {Array} derivedPlugins - deriveRigPlugins(...).plugins
 * @param {Array} experimentPlugins - experiment.plugins
 * @returns {{ unsupported: string[], unused: string[] }}
 *   unsupported = declared plugin names (excluding `log`) that aren't an ENABLED rig key;
 *   unused      = ENABLED rig keys the protocol never declares.
 */
function diffRigVsProtocol(derivedPlugins, experimentPlugins) {
    var derived = Array.isArray(derivedPlugins) ? derivedPlugins : [];
    var declared = Array.isArray(experimentPlugins) ? experimentPlugins : [];
    var enabledRigKeys = {};
    for (var i = 0; i < derived.length; i++) {
        if (derived[i] && derived[i].enabled) enabledRigKeys[derived[i].key] = true;
    }
    var declaredNames = {};
    for (var j = 0; j < declared.length; j++) {
        if (declared[j] && declared[j].name != null) declaredNames[declared[j].name] = true;
    }
    var unsupported = [];
    for (var k = 0; k < declared.length; k++) {
        var nm = declared[k] && declared[k].name;
        if (nm == null || nm === 'log') continue;
        if (!enabledRigKeys[nm]) unsupported.push(nm);
    }
    var unused = [];
    for (var m = 0; m < derived.length; m++) {
        var d = derived[m];
        if (d && d.enabled && !declaredNames[d.key]) unused.push(d.key);
    }
    return { unsupported: unsupported, unused: unused };
}

// ════════════════════════════════════════════════════
// Rig I/O config (#135 addendum): controller I/O roles + power-on defaults
// ════════════════════════════════════════════════════

// Role vocabularies for the rig YAML `io:` block. `fwGated` names the roles
// current controller firmware cannot do yet — the schema is authored now; the
// Studio greys these out with a tooltip naming the dependency, and never
// applies them at connect.
var RIG_IO_ROLES = {
    dio: ['off', 'in_trigger', 'out_programmable', 'out_debug_framescan'],
    ai: ['off', 'in'],
    ao: ['off', 'programmable', 'frame_number'],
    fwGated: {
        dio: ['in_trigger', 'out_debug_framescan'],
        ai: ['in'],
        ao: ['frame_number']
    }
};

function _rigIoRole(raw, allowed, label, warnings) {
    if (raw == null) return 'off';
    var role = String(raw).trim().toLowerCase();
    if (allowed.indexOf(role) !== -1) return role;
    warnings.push('unknown ' + label + ' role "' + raw + '" — treated as off');
    return 'off';
}

/**
 * Parse a rig YAML's `io:` block (G6 controller I/O roles + power-on defaults).
 *
 * Tolerant by design (same contract as deriveRigPlugins): a null/partial
 * `rigData` or missing `io:` block yields everything off/0; malformed entries
 * degrade to off with a warning string — never throws.
 *
 * Port numbering is 1-BASED, matching the controller board's BNC silkscreen
 * ("Digital IO 1 (5V)" / "Digital IO 2 (5V)") AND the SET_DIGITAL_OUT (0xAA)
 * wire channel — one number everywhere, no off-by-one to remember. (An early
 * #135 sketch used 0-based ports; adjusted 2026-07-03 against the physical
 * board before anything shipped.)
 *
 * @param {object} rigData - parsed rig YAML (e.g. from parseRigYAMLText)
 * @returns {{ dio: Array, ai: object, ao: object, warnings: string[] }}
 *   dio = exactly two entries (ports 1 and 2 == silkscreen == 0xAA channel):
 *   { port, role, default(0|1) }. ai = { role }. ao = { role, default } with
 *   `default` in VOLTS (nullable; wire 0xA0 takes mV) — some hardware expects
 *   a 5 V idle, so an authored default is applied at connect.
 */
function parseRigIo(rigData) {
    var result = {
        dio: [
            { port: 1, role: 'off', default: 0 },
            { port: 2, role: 'off', default: 0 }
        ],
        ai: { role: 'off' },
        ao: { role: 'off', default: null },
        warnings: []
    };
    if (!rigData || typeof rigData !== 'object') return result;
    var io = rigData.io;
    if (!io || typeof io !== 'object' || Array.isArray(io)) return result;

    var dioList = Array.isArray(io.dio) ? io.dio : [];
    for (var i = 0; i < dioList.length; i++) {
        var entry = dioList[i] && typeof dioList[i] === 'object' ? dioList[i] : null;
        if (!entry) continue;
        var port = Number(entry.port);
        if (port !== 1 && port !== 2) {
            result.warnings.push(
                'ignored dio entry with port "' +
                    entry.port +
                    '" (ports are 1 and 2, matching the board\'s "Digital IO 1/2 (5V)" BNC labels)'
            );
            continue;
        }
        var slot = result.dio[port - 1];
        slot.role = _rigIoRole(entry.role, RIG_IO_ROLES.dio, 'dio port ' + port, result.warnings);
        // default is outputs-only; clamp anything truthy-numeric/boolean to 0|1.
        if (entry.default != null)
            slot.default = entry.default === true || Number(entry.default) === 1 ? 1 : 0;
    }

    if (io.ai != null) {
        var ai = typeof io.ai === 'object' && !Array.isArray(io.ai) ? io.ai : { role: io.ai };
        result.ai.role = _rigIoRole(ai.role, RIG_IO_ROLES.ai, 'ai', result.warnings);
    }

    if (io.ao != null && typeof io.ao === 'object' && !Array.isArray(io.ao)) {
        result.ao.role = _rigIoRole(io.ao.role, RIG_IO_ROLES.ao, 'ao', result.warnings);
        if (io.ao.default != null) {
            var volts = Number(io.ao.default);
            if (!isFinite(volts)) {
                result.warnings.push('ignored non-numeric ao default "' + io.ao.default + '"');
            } else {
                if (volts < 0 || volts > 5) {
                    result.warnings.push(
                        'ao default ' + volts + ' V clamped to 0–5 V (0xA0 range)'
                    );
                    volts = Math.min(5, Math.max(0, volts));
                }
                result.ao.default = volts;
            }
        }
    }

    return result;
}

// ════════════════════════════════════════════════════
// Exports
// ════════════════════════════════════════════════════

var PluginRegistry = {
    BUILTIN_PLUGINS: BUILTIN_PLUGINS,
    CONTROLLER_COMMANDS: CONTROLLER_COMMANDS,
    LOG_PLUGIN: LOG_PLUGIN,
    WELL_KNOWN_RIG_PLUGIN_NAMES: WELL_KNOWN_RIG_PLUGIN_NAMES,
    getPluginCommands: getPluginCommands,
    getCommandParams: getCommandParams,
    isKnownControllerCommand: isKnownControllerCommand,
    G6_ONLY_COMMANDS: G6_ONLY_COMMANDS,
    isG6OnlyCommand: isG6OnlyCommand,
    clampToSchema: clampToSchema,
    getAllCommandOptions: getAllCommandOptions,
    createPluginEntry: createPluginEntry,
    findPluginDefByClass: findPluginDefByClass,
    getCommandsForClass: getCommandsForClass,
    getV3PluginCommands: getV3PluginCommands,
    listV3PluginNames: listV3PluginNames,
    getV3CommandParams: getV3CommandParams,
    mapRigPluginToBuiltin: mapRigPluginToBuiltin,
    deriveRigPlugins: deriveRigPlugins,
    diffRigVsProtocol: diffRigVsProtocol,
    RIG_IO_ROLES: RIG_IO_ROLES,
    parseRigIo: parseRigIo
};

// Browser global
if (typeof window !== 'undefined') {
    window.PluginRegistry = PluginRegistry;
}

// Node.js / CommonJS
if (typeof module !== 'undefined' && module.exports) {
    module.exports = PluginRegistry;
}

// ES module export
export {
    BUILTIN_PLUGINS,
    CONTROLLER_COMMANDS,
    LOG_PLUGIN,
    WELL_KNOWN_RIG_PLUGIN_NAMES,
    getPluginCommands,
    getCommandParams,
    isKnownControllerCommand,
    G6_ONLY_COMMANDS,
    isG6OnlyCommand,
    clampToSchema,
    getAllCommandOptions,
    createPluginEntry,
    findPluginDefByClass,
    getCommandsForClass,
    getV3PluginCommands,
    listV3PluginNames,
    getV3CommandParams,
    mapRigPluginToBuiltin,
    deriveRigPlugins,
    diffRigVsProtocol,
    RIG_IO_ROLES,
    parseRigIo
};
export default PluginRegistry;
