/**
 * Mollweide (equal-area) projection viewer.
 *
 * Plots arena pixels using the Mollweide pseudocylindrical projection,
 * matching the MATLAB PatternPreviewerApp Mollweide view.
 *
 * The Mollweide projection:
 *   1. Solve iteratively: 2θ + sin(2θ) = π·sin(latitude)
 *   2. x = (2√2/π) · longitude · cos(θ)
 *   3. y = √2 · sin(θ)
 *
 * Output coordinates are converted to degrees for consistent axis labeling.
 * The projection boundary is an ellipse.
 *
 * Supports optional eye FOV overlay from CSV data files containing
 * Mollweide-projected boundary coordinates (in radians).
 *
 * @module mollweide-viewer
 */

import { ProjectionViewer } from './projection-viewer.js';

const SQRT2 = Math.SQRT2;
const PI = Math.PI;

class MollweideViewer extends ProjectionViewer {
    constructor(container) {
        super(container, 'mollweide');

        // Eye FOV overlay state
        this.showEyeFOV = false;
        this.eyeFOVLeft = null;
        this.eyeFOVRight = null;
        this._eyeFOVLoading = false;
    }

    /**
     * Compute the Mollweide auxiliary angle θ for a given latitude.
     * Solves 2θ + sin(2θ) = π·sin(lat) using Newton-Raphson.
     * Matches MATLAB computeMollweideTheta exactly.
     *
     * @param {number} latRad - Latitude in radians
     * @returns {number} Auxiliary angle θ in radians
     */
    _computeTheta(latRad) {
        // Special cases at poles
        if (Math.abs(latRad) >= PI / 2 - 1e-10) {
            return latRad > 0 ? PI / 2 : -PI / 2;
        }

        let theta = latRad; // initial guess
        const target = PI * Math.sin(latRad);
        for (let i = 0; i < 10; i++) {
            const delta =
                -(2 * theta + Math.sin(2 * theta) - target) / (2 + 2 * Math.cos(2 * theta));
            theta = theta + delta;
            if (Math.abs(delta) < 1e-6) break;
        }
        return theta;
    }

    /**
     * Forward project longitude/latitude to Mollweide map coordinates.
     * Returns coordinates in degrees for consistent labeling with Mercator.
     *
     * @param {number} lonDeg - Longitude in degrees
     * @param {number} latDeg - Latitude in degrees
     * @returns {{x: number, y: number}} Map coordinates in degrees
     */
    _forwardProject(lonDeg, latDeg) {
        const lonRad = (lonDeg * PI) / 180;
        const latRad = (latDeg * PI) / 180;

        const theta = this._computeTheta(latRad);

        // Mollweide formulas (in radians)
        const xRad = ((2 * SQRT2) / PI) * lonRad * Math.cos(theta);
        const yRad = SQRT2 * Math.sin(theta);

        // Convert to degrees for axis labeling
        return {
            x: (xRad * 180) / PI,
            y: (yRad * 180) / PI
        };
    }

    /**
     * Get map bounds for current FOV.
     * Applies the Mollweide transform to the FOV limits.
     */
    _getMapBounds() {
        // Transform FOV limits through Mollweide
        const xScale = (2 * SQRT2) / PI;
        const yScale = SQRT2;

        // X limit from longitude FOV
        const lonRad = (this.lonFOV * PI) / 180;
        const xLimRad = xScale * lonRad; // at equator, cos(theta)=1
        let xLimDeg = (xLimRad * 180) / PI;

        // Y limit from latitude FOV
        const latRad = (this.latFOV * PI) / 180;
        const thetaLim = this._computeTheta(latRad);
        const yLimRad = yScale * Math.sin(thetaLim);
        let yLimDeg = (yLimRad * 180) / PI;

        // Safety bounds
        if (xLimDeg <= 0 || !isFinite(xLimDeg)) xLimDeg = 180;
        if (yLimDeg <= 0 || !isFinite(yLimDeg)) yLimDeg = 90;

        return {
            xMin: -xLimDeg,
            xMax: xLimDeg,
            yMin: -yLimDeg,
            yMax: yLimDeg
        };
    }

    // ========================================
    // Eye FOV overlay
    // ========================================

    /**
     * Toggle eye FOV overlay visibility.
     * Loads CSV data lazily on first enable.
     * @param {boolean} show - Whether to show the eye FOV overlay
     */
    setShowEyeFOV(show) {
        this.showEyeFOV = show;
        if (show && !this.eyeFOVLeft && !this._eyeFOVLoading) {
            this._loadEyeFOV().then(() => this._render());
        } else {
            this._render();
        }
    }

    /**
     * Fetch and parse eye FOV boundary CSV files.
     * CSV files contain Mollweide-projected coordinates in radians (x1, y1).
     * Converts to degrees to match the viewer's coordinate system.
     */
    async _loadEyeFOV() {
        this._eyeFOVLoading = true;
        try {
            const [leftResp, rightResp] = await Promise.all([
                fetch('data/fov_left_Mo.csv'),
                fetch('data/fov_right_Mo.csv')
            ]);

            if (!leftResp.ok || !rightResp.ok) {
                console.error('Eye FOV: Failed to load CSV files');
                this._eyeFOVLoading = false;
                return;
            }

            const [leftText, rightText] = await Promise.all([leftResp.text(), rightResp.text()]);

            this.eyeFOVLeft = this._parseEyeFOVCSV(leftText);
            this.eyeFOVRight = this._parseEyeFOVCSV(rightText);

            console.log(
                'Eye FOV loaded:',
                this.eyeFOVLeft.length,
                'left pts,',
                this.eyeFOVRight.length,
                'right pts'
            );
        } catch (err) {
            console.error('Eye FOV: Load error:', err.message);
        }
        this._eyeFOVLoading = false;
    }

    /**
     * Parse a CSV string of Mollweide coordinates (radians) into degree points.
     * @param {string} csvText - CSV with "x1","y1" header and radian values
     * @returns {Array<{x: number, y: number}>} Points in degrees (Mollweide map space)
     */
    _parseEyeFOVCSV(csvText) {
        const lines = csvText.trim().split('\n');
        const points = [];
        // Skip header row
        for (let i = 1; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;
            const parts = line.split(',');
            if (parts.length < 2) continue;
            const xRad = parseFloat(parts[0]);
            const yRad = parseFloat(parts[1]);
            if (isNaN(xRad) || isNaN(yRad)) continue;
            // Convert from Mollweide radians to degrees
            points.push({
                x: (xRad * 180) / PI,
                y: (yRad * 180) / PI
            });
        }
        return points;
    }

    /**
     * Draw eye FOV boundary polygons on the projection.
     * @param {CanvasRenderingContext2D} ctx
     * @param {Function} mapToCanvas - Convert (mapX, mapY) => { cx, cy }
     */
    _drawEyeFOV(ctx, mapToCanvas) {
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
        ctx.lineWidth = 2.5;

        for (const points of [this.eyeFOVLeft, this.eyeFOVRight]) {
            if (!points || points.length < 3) continue;

            ctx.beginPath();
            for (let i = 0; i < points.length; i++) {
                const { cx, cy } = mapToCanvas(points[i].x, points[i].y);
                if (i === 0) {
                    ctx.moveTo(cx, cy);
                } else {
                    ctx.lineTo(cx, cy);
                }
            }
            ctx.closePath();
            ctx.stroke();
        }
    }

    // ========================================
    // Decorations
    // ========================================

    /**
     * Draw Mollweide-specific decorations: elliptical boundary + optional eye FOV.
     */
    _drawDecorations(ctx, mapToCanvas) {
        // Draw the full-sphere ellipse outline
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
        ctx.lineWidth = 1;
        ctx.beginPath();

        const steps = 100;
        for (let s = 0; s <= steps; s++) {
            const latDeg = -90 + (180 / steps) * s;
            // Right boundary (lon = +180)
            const proj = this._forwardProject(180, latDeg);
            if (!proj) continue;
            const { cx, cy } = mapToCanvas(proj.x, proj.y);
            if (s === 0) {
                ctx.moveTo(cx, cy);
            } else {
                ctx.lineTo(cx, cy);
            }
        }
        // Continue with left boundary (lon = -180), going back down
        for (let s = steps; s >= 0; s--) {
            const latDeg = -90 + (180 / steps) * s;
            const proj = this._forwardProject(-180, latDeg);
            if (!proj) continue;
            const { cx, cy } = mapToCanvas(proj.x, proj.y);
            ctx.lineTo(cx, cy);
        }
        ctx.closePath();
        ctx.stroke();

        // Draw eye FOV overlay if enabled and loaded
        if (this.showEyeFOV && this.eyeFOVLeft && this.eyeFOVRight) {
            this._drawEyeFOV(ctx, mapToCanvas);
        }
    }
}

export default MollweideViewer;
export { MollweideViewer };
