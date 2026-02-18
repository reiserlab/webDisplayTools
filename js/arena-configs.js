/**
 * Arena Configurations
 * Auto-generated from maDisplayTools/configs/arenas/
 * Last updated: 2026-02-18T23:04:32.832Z
 *
 * DO NOT EDIT MANUALLY - regenerate with: node scripts/generate-arena-configs.js
 */

const STANDARD_CONFIGS = {
  "G6_2x10": {
    "label": "G6 (2×10) - 360°",
    "description": "Full G6 arena, 2 rows x 10 columns, 360 degree coverage",
    "arena": {
      "generation": "G6",
      "num_rows": 2,
      "num_cols": 10,
      "columns_installed": null,
      "orientation": "normal",
      "column_order": "cw",
      "angle_offset_deg": 0
    }
  },
  "G6_2x8of10": {
    "label": "G6 (2×10) - 288°",
    "description": "G6 walking arena, 2 rows, 8 of 10 columns installed (288 degree coverage)",
    "arena": {
      "generation": "G6",
      "num_rows": 2,
      "num_cols": 10,
      "columns_installed": [
        1,
        2,
        3,
        4,
        5,
        6,
        7,
        8
      ],
      "orientation": "normal",
      "column_order": "cw",
      "angle_offset_deg": 0
    }
  },
  "G6_3x12of18": {
    "label": "G6 (3×18) - 240°",
    "description": "G6 arena, 3 rows, 12 of 18 columns installed (240 degree coverage)",
    "arena": {
      "generation": "G6",
      "num_rows": 3,
      "num_cols": 18,
      "columns_installed": [
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
      "angle_offset_deg": -60
    }
  },
  "G6_3x16_full": {
    "label": "G6 (3×16) - 360°",
    "description": "G6 arena, 3 rows × 16 columns",
    "arena": {
      "generation": "G6",
      "num_rows": 3,
      "num_cols": 16,
      "columns_installed": null,
      "orientation": "normal",
      "column_order": "cw",
      "angle_offset_deg": 0
    }
  },
  "G41_2x12_cw": {
    "label": "G4.1 (2×12) - 360°",
    "description": "G4.1 arena, 2 rows x 12 columns, 360 degree, CW, c0 at south",
    "arena": {
      "generation": "G4.1",
      "num_rows": 2,
      "num_cols": 12,
      "columns_installed": null,
      "orientation": "normal",
      "column_order": "cw",
      "angle_offset_deg": 15
    }
  },
  "G4_3x12": {
    "label": "G4 (3×12) - 360°",
    "description": "G4 arena, 3 rows x 12 columns, 360 degree coverage",
    "arena": {
      "generation": "G4",
      "num_rows": 3,
      "num_cols": 12,
      "columns_installed": null,
      "orientation": "normal",
      "column_order": "cw",
      "angle_offset_deg": 0
    }
  },
  "G4_3x12of18": {
    "label": "G4 (3×18) - 240°",
    "description": "G4 arena, 3 rows, 12 of 18 columns installed (240 degree coverage)",
    "arena": {
      "generation": "G4",
      "num_rows": 3,
      "num_cols": 18,
      "columns_installed": [
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
      "angle_offset_deg": -60
    }
  },
  "G4_4x12": {
    "label": "G4 (4×12) - 360°",
    "description": "G4 arena, 4 rows x 12 columns, 360 degree coverage",
    "arena": {
      "generation": "G4",
      "num_rows": 4,
      "num_cols": 12,
      "columns_installed": null,
      "orientation": "normal",
      "column_order": "cw",
      "angle_offset_deg": 0
    }
  },
  "G3_3x24": {
    "label": "G3 (3×24) - 360°",
    "description": "Full G3 arena, 3 rows x 24 columns, 360 degree coverage",
    "arena": {
      "generation": "G3",
      "num_rows": 3,
      "num_cols": 24,
      "columns_installed": null,
      "orientation": "normal",
      "column_order": "cw",
      "angle_offset_deg": 0
    }
  },
  "G3_4x12": {
    "label": "G3 (4×12) - 360°",
    "description": "Legacy G3 arena, 4 rows x 12 columns, 360 degree coverage",
    "arena": {
      "generation": "G3",
      "num_rows": 4,
      "num_cols": 12,
      "columns_installed": null,
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
        led_type: 'round',
        led_diameter_mm: 3.0  // 3mm diameter round (4mm pitch)
    },
    'G4': {
        panel_width_mm: 40.45,
        panel_height_mm: 40.45,
        panel_depth_mm: 18,
        pixels_per_panel: 16,
        led_type: 'round',
        led_diameter_mm: 1.9  // 1.9mm diameter round
    },
    'G4.1': {
        panel_width_mm: 40,
        panel_height_mm: 40,
        panel_depth_mm: 6.35,
        pixels_per_panel: 16,
        led_type: 'rect',      // 0603 SMD at 45 degrees
        led_width_mm: 1.6,
        led_height_mm: 0.8
    },
    'G6': {
        panel_width_mm: 45.4,
        panel_height_mm: 45.4,
        panel_depth_mm: 3.45,
        pixels_per_panel: 20,
        led_type: 'rect',      // 0402 SMD at 45 degrees
        led_width_mm: 1.0,
        led_height_mm: 0.5
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
