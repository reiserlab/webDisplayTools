/**
 * Arena Geometry Calculations
 * Shared between arena_editor.html and validation tests
 *
 * This module contains the core calculation logic for arena layouts.
 * It is designed to work in both browser and Node.js environments.
 */

// Panel specifications (from MATLAB design_arena.m)
const PANEL_SPECS = {
  G3: {
    panel_width_mm: 32,
    panel_depth_mm: 18,
    pixels_per_panel: 8,
    num_pins: 8,
    pin_dist_mm: 15.24,
    pin_config: "single",
  },
  G4: {
    panel_width_mm: 40.45,
    panel_depth_mm: 18,
    pixels_per_panel: 16,
    num_pins: 15,
    pin_dist_mm: 13,
    pin_config: "single",
  },
  "G4.1": {
    panel_width_mm: 40,
    panel_depth_mm: 6.35,
    pixels_per_panel: 16,
    num_pins: 15,
    pin_dist_mm: 4.57,
    pin_config: "single",
  },

  G6: {
    panel_width_mm: 45.4,
    panel_depth_mm: 3.45,
    pixels_per_panel: 20,
    num_pins: 10,
    pin_dist_mm: 4.57,
    pin_config: "dual",
    header_separation_mm: 30.8,
  },
};

/**
 * Calculate arena geometry for a given panel type and number of panels
 * @param {string} panelType - Panel generation (G3, G4, G4.1, G6)
 * @param {number} numPanels - Number of panels in the arena
 * @param {number[]} panelsInstalled - Array of installed panel indices (1-based)
 * @returns {object} Geometry calculations
 */
function calculateGeometry(panelType, numPanels, panelsInstalled = null) {
  const specs = PANEL_SPECS[panelType];
  if (!specs) {
    throw new Error(`Unknown panel type: ${panelType}`);
  }

  // Default to all panels installed
  if (!panelsInstalled) {
    panelsInstalled = Array.from({ length: numPanels }, (_, i) => i + 1);
  }

  // Convert to working units (inches internally, like MATLAB)
  const panelWidth = specs.panel_width_mm / 25.4;
  const panelDepth = specs.panel_depth_mm / 25.4;

  // Calculate geometry
  const alpha = (2 * Math.PI) / numPanels;
  const cRadius = panelWidth / Math.tan(alpha / 2) / 2;
  const backCRadius = cRadius + panelDepth;

  // Resolution
  const degsPerPixel = 360 / (numPanels * specs.pixels_per_panel);
  const azimuthalPixels = numPanels * specs.pixels_per_panel;

  // Coverage
  const azimuthCoverage = 360 * (panelsInstalled.length / numPanels);
  const azimuthGap = 360 - azimuthCoverage;

  return {
    panel_type: panelType,
    num_panels: numPanels,
    panels_installed: panelsInstalled,
    c_radius_inches: cRadius,
    c_radius_mm: cRadius * 25.4,
    back_c_radius_inches: backCRadius,
    back_c_radius_mm: backCRadius * 25.4,
    degs_per_pixel: degsPerPixel,
    azimuthal_pixels: azimuthalPixels,
    azimuth_coverage: azimuthCoverage,
    azimuth_gap: azimuthGap,
    panel_width_mm: specs.panel_width_mm,
    panel_depth_mm: specs.panel_depth_mm,
    pixels_per_panel: specs.pixels_per_panel,
  };
}

/**
 * Compare two geometry objects within tolerance
 * @param {object} computed - Computed geometry
 * @param {object} reference - Reference geometry from MATLAB
 * @param {number} tolerance - Comparison tolerance (default 0.0001)
 * @returns {object} Comparison results
 */
function compareGeometry(computed, reference, tolerance = 0.0001) {
  const results = {
    pass: true,
    details: [],
  };

  const comparisons = [
    { field: "c_radius_inches", label: "Inner Radius (in)" },
    {
      field: "back_c_radius_inches",
      label: "Outer Radius (in)",
      refField: "back_c_radius_inches",
    },
    { field: "degs_per_pixel", label: "Deg/Pixel" },
    { field: "azimuthal_pixels", label: "Azimuthal Pixels" },
  ];

  for (const comp of comparisons) {
    const refField = comp.refField || comp.field;
    const computedVal = computed[comp.field];
    const refVal = reference[refField];

    if (refVal === undefined) continue;

    const diff = Math.abs(computedVal - refVal);
    const pass = diff < tolerance;

    results.details.push({
      field: comp.label,
      computed: computedVal,
      reference: refVal,
      diff: diff,
      pass: pass,
    });

    if (!pass) {
      results.pass = false;
    }
  }

  return results;
}

// Export for Node.js
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    PANEL_SPECS,
    calculateGeometry,
    compareGeometry,
  };
}

// Export for browser (ES6 modules)
if (typeof window !== "undefined") {
  window.ArenaCalculations = {
    PANEL_SPECS,
    calculateGeometry,
    compareGeometry,
  };
}
