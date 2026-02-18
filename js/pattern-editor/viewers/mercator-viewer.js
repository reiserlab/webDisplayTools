/**
 * Mercator (equirectangular) projection viewer.
 *
 * Plots arena pixels on a longitude × latitude grid, matching
 * the MATLAB PatternPreviewerApp Mercator view.
 *
 * In this projection:
 *   x = longitude (degrees)
 *   y = latitude (degrees)
 * which is technically an equirectangular (Plate Carrée) projection.
 * This matches the companion MATLAB implementation.
 *
 * @module mercator-viewer
 */

import { ProjectionViewer } from './projection-viewer.js';

class MercatorViewer extends ProjectionViewer {
    constructor(container) {
        super(container, 'mercator');
    }

    /**
     * Forward project: longitude/latitude directly map to x/y.
     * @param {number} lonDeg - Longitude in degrees
     * @param {number} latDeg - Latitude in degrees
     * @returns {{x: number, y: number}}
     */
    _forwardProject(lonDeg, latDeg) {
        return { x: lonDeg, y: latDeg };
    }

    /**
     * Get map bounds for current FOV.
     * @returns {{xMin: number, xMax: number, yMin: number, yMax: number}}
     */
    _getMapBounds() {
        return {
            xMin: this.lonCenter - this.lonFOV,
            xMax: this.lonCenter + this.lonFOV,
            yMin: this.latCenter - this.latFOV,
            yMax: this.latCenter + this.latFOV
        };
    }

    /**
     * Draw Mercator-specific decorations.
     */
    _drawDecorations(ctx, mapToCanvas) {
        // Mercator has a simple rectangular boundary — no special decoration needed
        // Draw a thin border around the visible area
        const w = this.canvas.width;
        const h = this.canvas.height;
        ctx.strokeStyle = '#2d3640';
        ctx.lineWidth = 1;
        ctx.strokeRect(0.5, 0.5, w - 1, h - 1);
    }
}

export default MercatorViewer;
export { MercatorViewer };
