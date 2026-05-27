/**
 * plugin-registry.js — Plugin definitions and command schemas
 *
 * Provides:
 *   - BUILTIN_PLUGINS: definitions for LEDControllerPlugin, BiasPlugin
 *   - CONTROLLER_COMMANDS: controller command definitions
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
                label: 'Pattern ID'
            },
            duration: {
                type: 'number',
                required: true,
                default: 5,
                label: 'Duration (s)'
            },
            mode: {
                type: 'select',
                required: true,
                default: 2,
                options: [
                    { value: 2, label: 'Mode 2 - Constant Rate' },
                    { value: 4, label: 'Mode 4 - Closed Loop' }
                ],
                label: 'Mode'
            },
            frame_index: {
                type: 'number',
                required: true,
                default: 1,
                label: 'Frame index'
            },
            frame_rate: {
                type: 'number',
                required: true,
                default: 60,
                label: 'Frame rate (Hz)'
            },
            gain: {
                type: 'number',
                required: true,
                default: 0,
                label: 'Gain'
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
    setPositionX: {
        label: 'Set Position X',
        description: 'Set the starting frame for pattern display',
        params: {
            posX: {
                type: 'number',
                required: true,
                default: 1,
                label: 'Position X'
            }
        }
    },
    setColorDepth: {
        label: 'Set Color Depth',
        description: 'Change the arena grayscale value',
        params: {
            gs_val: {
                type: 'select',
                required: true,
                default: 2,
                options: [
                    { value: 2, label: 'GS2 (binary)' },
                    { value: 16, label: 'GS16 (4-bit)' }
                ],
                label: 'Grayscale'
            }
        }
    }
};

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
                        label: 'Power (0-100)'
                    },
                    panel_num: {
                        type: 'number',
                        required: false,
                        default: 0,
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
                        label: 'Power (0-100)'
                    },
                    panel_num: {
                        type: 'number',
                        required: false,
                        default: 0,
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
                        label: 'Power (0-100)'
                    },
                    panel_num: {
                        type: 'number',
                        required: false,
                        default: 0,
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

    thermometer: {
        name: 'thermometer',
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
                description: 'Begin background acquisition; logs to CSV at sample_rate Hz until stopped (recommended for long experiments).'
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
                description: 'Connect to BIAS camera (use when rig YAML is missing ip, port, or config_file)',
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
 * @param {string} pluginName - builtin plugin name
 * @returns {object} plugin definition suitable for experiment.plugins[]
 */
function createPluginEntry(pluginName) {
    var def = BUILTIN_PLUGINS[pluginName];
    if (!def) return null;

    var entry = {
        name: def.name,
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
// Exports
// ════════════════════════════════════════════════════

var PluginRegistry = {
    BUILTIN_PLUGINS: BUILTIN_PLUGINS,
    CONTROLLER_COMMANDS: CONTROLLER_COMMANDS,
    LOG_PLUGIN: LOG_PLUGIN,
    getPluginCommands: getPluginCommands,
    getCommandParams: getCommandParams,
    getAllCommandOptions: getAllCommandOptions,
    createPluginEntry: createPluginEntry,
    findPluginDefByClass: findPluginDefByClass,
    getCommandsForClass: getCommandsForClass,
    getV3PluginCommands: getV3PluginCommands,
    listV3PluginNames: listV3PluginNames,
    getV3CommandParams: getV3CommandParams
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
    getPluginCommands,
    getCommandParams,
    getAllCommandOptions,
    createPluginEntry,
    findPluginDefByClass,
    getCommandsForClass,
    getV3PluginCommands,
    listV3PluginNames,
    getV3CommandParams
};
export default PluginRegistry;
