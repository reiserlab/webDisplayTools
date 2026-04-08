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
// Exports
// ════════════════════════════════════════════════════

var PluginRegistry = {
    BUILTIN_PLUGINS: BUILTIN_PLUGINS,
    CONTROLLER_COMMANDS: CONTROLLER_COMMANDS,
    getPluginCommands: getPluginCommands,
    getCommandParams: getCommandParams,
    getAllCommandOptions: getAllCommandOptions,
    createPluginEntry: createPluginEntry
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
    getPluginCommands,
    getCommandParams,
    getAllCommandOptions,
    createPluginEntry
};
export default PluginRegistry;
