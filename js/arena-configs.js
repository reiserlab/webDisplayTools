/**
 * Arena Configurations
 * Auto-generated from maDisplayTools/configs/arenas/
 * Last updated: 2026-01-24T15:01:28.810Z
 *
 * DO NOT EDIT MANUALLY - regenerate with: node scripts/generate-arena-configs.js
 */

const STANDARD_CONFIGS = {
  "G6_2x10_full": {
    "label": "G6 (2×10) - 360°",
    "description": "Full G6 arena, 2 rows × 10 columns, 360° coverage",
    "arena": {
      "generation": "G6",
      "num_rows": 2,
      "num_cols": 10,
      "panels_installed": null,
      "orientation": "normal",
      "column_order": "cw",
      "angle_offset_deg": 0
    }
  },
  "G6_2x8_walking": {
    "label": "G6 (2×10) - 288°",
    "description": "G6 walking arena, 2 rows × 10-column grid, 8 columns installed (288° coverage)",
    "arena": {
      "generation": "G6",
      "num_rows": 2,
      "num_cols": 10,
      "panels_installed": [
        1,
        2,
        3,
        4,
        5,
        6,
        7,
        8,
        11,
        12,
        13,
        14,
        15,
        16,
        17,
        18
      ],
      "orientation": "normal",
      "column_order": "cw",
      "angle_offset_deg": -72
    }
  },
  "G41_2x12_ccw": {
    "label": "G4.1 CCW (2×12) - 360°",
    "description": "Standard G4.1 arena, 2 rows × 12 columns, 360° coverage, CCW column order",
    "arena": {
      "generation": "G4.1",
      "num_rows": 2,
      "num_cols": 12,
      "panels_installed": null,
      "orientation": "normal",
      "column_order": "ccw",
      "angle_offset_deg": 0
    }
  },
  "G41_2x12_cw": {
    "label": "G4.1 (2×12) - 360°",
    "description": "G4.1 arena, 2 rows × 12 columns, 360° coverage, CW column order",
    "arena": {
      "generation": "G4.1",
      "num_rows": 2,
      "num_cols": 12,
      "panels_installed": null,
      "orientation": "normal",
      "column_order": "cw",
      "angle_offset_deg": 0
    }
  },
  "G4_3x12_full": {
    "label": "G4 (3×12) - 360°",
    "description": "G4 arena, 3 rows × 12 columns, 360° coverage",
    "arena": {
      "generation": "G4",
      "num_rows": 3,
      "num_cols": 12,
      "panels_installed": null,
      "orientation": "normal",
      "column_order": "cw",
      "angle_offset_deg": 0
    }
  },
  "G4_3x18_partial": {
    "label": "G4 (3×18) - 240°",
    "description": "G4 arena, 3 rows × 18-column grid, 12 columns installed (240° coverage)",
    "arena": {
      "generation": "G4",
      "num_rows": 3,
      "num_cols": 18,
      "panels_installed": [
        0,
        1,
        2,
        3,
        4,
        5,
        6,
        7,
        8,
        9,
        10,
        11
      ],
      "orientation": "normal",
      "column_order": "cw",
      "angle_offset_deg": -20
    }
  },
  "G4_4x12_full": {
    "label": "G4 (4×12) - 360°",
    "description": "G4 arena, 4 rows × 12 columns, 360° coverage",
    "arena": {
      "generation": "G4",
      "num_rows": 4,
      "num_cols": 12,
      "panels_installed": null,
      "orientation": "normal",
      "column_order": "cw",
      "angle_offset_deg": 0
    }
  },
  "G3_3x24_full": {
    "label": "G3 (3×24) - 360°",
    "description": "Full G3 arena, 3 rows x 24 columns, 360 degree coverage",
    "arena": {
      "generation": "G3",
      "num_rows": 3,
      "num_cols": 24,
      "panels_installed": null,
      "orientation": "normal",
      "column_order": "cw",
      "angle_offset_deg": 0
    }
  },
  "G3_4x12_full": {
    "label": "G3 (4×12) - 360°",
    "description": "Legacy G3 arena, 4 rows × 12 columns, 360° coverage",
    "arena": {
      "generation": "G3",
      "num_rows": 4,
      "num_cols": 12,
      "panels_installed": null,
      "orientation": "normal",
      "column_order": "cw",
      "angle_offset_deg": 0
    }
  }
};

// Panel specifications by generation
const PANEL_SPECS = {
    'G3': {
        panel_width_mm: 32,
        panel_height_mm: 32,
        panel_depth_mm: 18,
        pixels_per_panel: 8,
        // 4mm pitch, 3mm diameter round LEDs (~1mm gap)
        led_type: 'round',
        led_diameter_mm: 3.0,
        led_pitch_mm: 4.0
    },
    'G4': {
        panel_width_mm: 40.45,
        panel_height_mm: 40.45,
        panel_depth_mm: 18,
        pixels_per_panel: 16,
        // 1.9mm diameter round LEDs
        led_type: 'round',
        led_diameter_mm: 1.9,
        led_pitch_mm: 2.53  // 40.45mm / 16 pixels
    },
    'G4.1': {
        panel_width_mm: 40,
        panel_height_mm: 40,
        panel_depth_mm: 6.35,
        pixels_per_panel: 16,
        // 0603 SMD LEDs: 1.6mm x 0.8mm, mounted at 45°
        led_type: 'rect',
        led_width_mm: 1.6,
        led_height_mm: 0.8,
        led_pitch_mm: 2.5  // 40mm / 16 pixels
    },
    'G6': {
        panel_width_mm: 45.4,
        panel_height_mm: 45.4,
        panel_depth_mm: 3.45,
        pixels_per_panel: 20,
        // 0402 SMD LEDs: 1.0mm x 0.5mm, mounted at 45°
        led_type: 'rect',
        led_width_mm: 1.0,
        led_height_mm: 0.5,
        led_pitch_mm: 2.27  // 45.4mm / 20 pixels
    }
};

// Helper to get config by name
function getConfig(name) {
    return STANDARD_CONFIGS[name] || null;
}

// Helper to list all config names grouped by generation
function getConfigsByGeneration() {
    const groups = { 'G6': [], 'G4.1': [], 'G4': [], 'G3': [] };

    for (const [name, config] of Object.entries(STANDARD_CONFIGS)) {
        const gen = config.arena?.generation;
        if (gen && groups[gen]) {
            groups[gen].push({ name, ...config });
        }
    }

    return groups;
}

// Export for both browser and Node.js
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { STANDARD_CONFIGS, PANEL_SPECS, getConfig, getConfigsByGeneration };
}
