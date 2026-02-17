/**
 * Base class for map projection viewers (Mercator, Mollweide).
 *
 * Uses forward-projection of each arena pixel onto a 2D canvas,
 * matching the approach used in the companion MATLAB PatternPreviewerApp.
 *
 * Subclasses implement:
 *   _forwardProject(lonDeg, latDeg) => { x, y } in map units
 *   _inverseProject(x, y) => { lonDeg, latDeg } or null
 *   _isInsideProjection(x, y) => boolean
 *   _getMapBounds() => { xMin, xMax, yMin, yMax }
 *   _drawDecorations(ctx, mapToCanvas)
 *
 * @module projection-viewer
 */

class ProjectionViewer {
    constructor(container, projectionType) {
        this.container = container;
        this.projectionType = projectionType;
        this.canvas = null;
        this.ctx = null;

        this.arenaConfig = null;
        this.panelSpecs = null;

        this.state = {
            pattern: null,
            currentFrame: 0,
            showPanelBoundaries: true,
            showPanelNumbers: false
        };

        // Viewport (FOV half-widths in degrees, matching MATLAB)
        this.lonFOV = 180; // ±180° longitude
        this.latFOV = 90; // ±90° latitude
        this.lonCenter = 0;
        this.latCenter = 0;

        // Precomputed arena pixel data
        this.pixelData = null; // Array of { lonDeg, latDeg, row, col }
        this.totalPixelRows = 0;
        this.totalPixelCols = 0;
        this.panelSize = 0;

        this._resizeHandler = null;
        this._initialized = false;
    }

    // ========================================
    // Public API (mirrors ThreeViewer)
    // ========================================

    /**
     * Initialize the projection viewer
     * @param {Object} arenaConfig - Arena configuration from arena-configs.js
     * @param {Object} panelSpecs - Panel specifications from arena-configs.js
     */
    init(arenaConfig, panelSpecs) {
        if (this._initialized) return;

        this.arenaConfig = arenaConfig;
        this.panelSpecs = panelSpecs;

        this._createCanvas();
        this._computeArenaCoordinates();
        this._setInitialFOV();
        this._render();

        this._resizeHandler = () => this._onResize();
        window.addEventListener('resize', this._resizeHandler);
        this._initialized = true;
    }

    /**
     * Reinitialize with a new arena configuration.
     * Rebuilds coordinate data but preserves zoom state if reasonable.
     * @param {Object} arenaConfig - Arena configuration
     * @param {Object} panelSpecs - Panel specifications
     */
    reinit(arenaConfig, panelSpecs) {
        this.arenaConfig = arenaConfig;
        this.panelSpecs = panelSpecs;
        this._computeArenaCoordinates();
        this._setInitialFOV();
        this._render();
    }

    /**
     * Set the pattern data to display
     * @param {Object} patternData - Pattern with frames, pixelRows, pixelCols, gsMode
     */
    setPattern(patternData) {
        this.state.pattern = patternData;
        this.state.currentFrame = 0;
        this._render();
    }

    /**
     * Set the current frame to display
     * @param {number} frameIndex - 0-indexed frame number
     */
    setFrame(frameIndex) {
        if (!this.state.pattern) return;
        this.state.currentFrame = Math.max(
            0,
            Math.min(frameIndex, this.state.pattern.numFrames - 1)
        );
        this._render();
    }

    /**
     * Update display options
     * @param {Object} options - { showPanelBoundaries, showPanelNumbers }
     */
    setOptions(options) {
        if (options.showPanelBoundaries !== undefined) {
            this.state.showPanelBoundaries = options.showPanelBoundaries;
        }
        if (options.showPanelNumbers !== undefined) {
            this.state.showPanelNumbers = options.showPanelNumbers;
        }
        this._render();
    }

    /**
     * Take a screenshot of the current view
     * @returns {string} Data URL of the screenshot
     */
    screenshot() {
        return this.canvas.toDataURL('image/png');
    }

    /**
     * Zoom in: decrease FOV
     */
    zoomIn() {
        this.lonFOV = Math.max(10, this.lonFOV - 20);
        this.latFOV = Math.max(5, this.latFOV - 10);
        this._render();
    }

    /**
     * Zoom out: increase FOV
     */
    zoomOut() {
        this.lonFOV = Math.min(180, this.lonFOV + 20);
        this.latFOV = Math.min(90, this.latFOV + 10);
        this._render();
    }

    /**
     * Reset FOV to full sphere view
     */
    resetFOV() {
        this.lonFOV = 180;
        this.latFOV = 90;
        this.lonCenter = 0;
        this.latCenter = 0;
        this._render();
    }

    /**
     * Get current FOV description
     * @returns {string} FOV label like "±180° × ±90°"
     */
    getFOVLabel() {
        return `\u00b1${this.lonFOV}\u00b0 \u00d7 \u00b1${this.latFOV}\u00b0`;
    }

    /**
     * Clean up and destroy the viewer
     */
    destroy() {
        if (this._resizeHandler) {
            window.removeEventListener('resize', this._resizeHandler);
        }
        if (this.canvas && this.canvas.parentNode) {
            this.canvas.parentNode.removeChild(this.canvas);
        }
        this.canvas = null;
        this.ctx = null;
        this.pixelData = null;
        this._initialized = false;
    }

    // ========================================
    // Abstract methods (override in subclass)
    // ========================================

    /**
     * Forward project geographic coordinates to map coordinates.
     * @param {number} lonDeg - Longitude in degrees
     * @param {number} latDeg - Latitude in degrees
     * @returns {{x: number, y: number}} Map coordinates
     */
    _forwardProject(lonDeg, latDeg) {
        throw new Error('_forwardProject not implemented');
    }

    /**
     * Get the map coordinate bounds for the current FOV.
     * @returns {{xMin: number, xMax: number, yMin: number, yMax: number}}
     */
    _getMapBounds() {
        throw new Error('_getMapBounds not implemented');
    }

    /**
     * Check if a point in map coordinates is inside the projection boundary.
     * @param {number} x - Map x coordinate
     * @param {number} y - Map y coordinate
     * @returns {boolean}
     */
    _isInsideProjection(x, y) {
        return true;
    }

    /**
     * Draw projection-specific decorations (ellipse outline, etc.)
     * @param {CanvasRenderingContext2D} ctx
     * @param {Function} mapToCanvas - Convert (mapX, mapY) => { cx, cy }
     */
    _drawDecorations(ctx, mapToCanvas) {
        // Override in subclass
    }

    // ========================================
    // Shared implementation
    // ========================================

    _createCanvas() {
        // Remove any existing content (coming-soon overlay)
        this.container.innerHTML = '';

        // Create wrapper for centering
        const wrapper = document.createElement('div');
        wrapper.style.cssText =
            'width:100%;height:100%;display:flex;align-items:center;justify-content:center;flex-direction:column;';

        // Create controls bar
        const controls = document.createElement('div');
        controls.className = 'projection-controls';
        controls.innerHTML = `
            <div class="ctrl-group">
                <label>Zoom:</label>
                <button class="ctrl-btn proj-zoom-in" title="Zoom in (decrease field of view)">+</button>
                <button class="ctrl-btn proj-zoom-out" title="Zoom out (increase field of view)">\u2212</button>
                <button class="ctrl-btn proj-reset-fov" title="Reset to full sphere view">\u21ba Reset</button>
                <span class="proj-fov-label">\u00b1180\u00b0 \u00d7 \u00b190\u00b0</span>
            </div>
            <div class="separator"></div>
            <div class="ctrl-group">
                <button class="ctrl-btn proj-screenshot" title="Download screenshot of projection view">\ud83d\udcf7 Screenshot</button>
            </div>
        `;
        wrapper.appendChild(controls);

        // Wire up controls
        controls.querySelector('.proj-zoom-in').addEventListener('click', () => {
            this.zoomIn();
            this._updateFOVLabel(controls);
        });
        controls.querySelector('.proj-zoom-out').addEventListener('click', () => {
            this.zoomOut();
            this._updateFOVLabel(controls);
        });
        controls.querySelector('.proj-reset-fov').addEventListener('click', () => {
            this.resetFOV();
            this._updateFOVLabel(controls);
        });
        controls.querySelector('.proj-screenshot').addEventListener('click', () => {
            this._downloadScreenshot();
        });

        this._controlsEl = controls;

        // Create canvas
        this.canvas = document.createElement('canvas');
        this.canvas.style.cssText =
            'max-width:100%;max-height:calc(100% - 40px);image-rendering:auto;';
        wrapper.appendChild(this.canvas);

        this.container.appendChild(wrapper);
        this._sizeCanvas();
    }

    _sizeCanvas() {
        const maxW = this.container.clientWidth - 20;
        const maxH = this.container.clientHeight - 60; // leave room for controls

        // 2:1 aspect ratio for both Mercator and Mollweide
        const aspect = 2;
        let canvasW, canvasH;
        if (maxW / maxH > aspect) {
            canvasH = maxH;
            canvasW = Math.floor(canvasH * aspect);
        } else {
            canvasW = maxW;
            canvasH = Math.floor(canvasW / aspect);
        }

        // Cap internal resolution for performance
        const maxRes = 900;
        const scale = Math.min(1, maxRes / canvasW);
        this.canvas.width = Math.max(200, Math.floor(canvasW * scale));
        this.canvas.height = Math.max(100, Math.floor(canvasH * scale));
        this.canvas.style.width = Math.max(200, canvasW) + 'px';
        this.canvas.style.height = Math.max(100, canvasH) + 'px';

        this.ctx = this.canvas.getContext('2d');
    }

    _updateFOVLabel(controls) {
        const label = controls.querySelector('.proj-fov-label');
        if (label) {
            label.textContent = this.getFOVLabel();
        }
    }

    _downloadScreenshot() {
        const dataURL = this.screenshot();
        const link = document.createElement('a');
        const gen = this.arenaConfig?.arena?.generation || 'arena';
        const cols = this.arenaConfig?.arena?.num_cols || '';
        const rows = this.arenaConfig?.arena?.num_rows || '';
        const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        link.download = `${this.projectionType}_${gen}_${cols}c${rows}r_${ts}.png`;
        link.href = dataURL;
        link.click();
    }

    /**
     * Compute spherical coordinates for every arena pixel.
     * Stores results as an array of { lonDeg, latDeg, row, col } objects.
     */
    _computeArenaCoordinates() {
        if (!this.arenaConfig || !this.panelSpecs) return;

        const arena = this.arenaConfig.arena;
        const specs = this.panelSpecs;
        this.panelSize = specs.pixels_per_panel;
        const numCols = arena.num_cols;
        const numRows = arena.num_rows;

        // Determine installed columns
        const columnsInstalled = arena.columns_installed;
        const installedCols = columnsInstalled ? columnsInstalled.length : numCols;

        this.totalPixelRows = numRows * this.panelSize;
        this.totalPixelCols = installedCols * this.panelSize;

        // Generate 3D coordinates using ArenaGeometry (loaded as browser global)
        const AG = window.ArenaGeometry;
        if (!AG) {
            console.error('ProjectionViewer: ArenaGeometry not available');
            return;
        }

        const coords = AG.arenaCoordinates({
            panelSize: this.panelSize,
            numCols: installedCols,
            numRows: numRows,
            numCircle: numCols,
            model: 'smooth'
        });

        // Convert to spherical coordinates
        const spherical = AG.cart2sphere(coords.x, coords.y, coords.z);

        // Build pixel data array
        this.pixelData = [];
        for (let r = 0; r < this.totalPixelRows; r++) {
            for (let c = 0; c < this.totalPixelCols; c++) {
                const phi = spherical.phi[r][c]; // azimuth [-PI, PI]
                const theta = spherical.theta[r][c]; // polar from north [0, PI]
                const latDeg = ((Math.PI / 2 - theta) * 180) / Math.PI;
                const lonDeg = (phi * 180) / Math.PI;

                this.pixelData.push({
                    lonDeg,
                    latDeg,
                    row: r,
                    col: c,
                    patternIndex: r * this.totalPixelCols + c
                });
            }
        }
    }

    /**
     * Set initial FOV based on arena coverage.
     * Matches MATLAB: lat FOV = max lat extent + 5°, lon FOV from coverage.
     */
    _setInitialFOV() {
        if (!this.pixelData || this.pixelData.length === 0) return;

        // Find lat/lon extent of arena pixels
        let maxAbsLat = 0;
        for (const px of this.pixelData) {
            const absLat = Math.abs(px.latDeg);
            if (absLat > maxAbsLat) maxAbsLat = absLat;
        }

        // Check for partial azimuth coverage
        const arena = this.arenaConfig.arena;
        const columnsInstalled = arena.columns_installed;
        if (columnsInstalled && columnsInstalled.length < arena.num_cols) {
            // Partial arena: tighten lon FOV
            const azCoverage = (columnsInstalled.length / arena.num_cols) * 360;
            this.lonFOV = azCoverage / 2 + 10;
        } else {
            this.lonFOV = 180;
        }

        this.latFOV = Math.min(90, maxAbsLat + 5);
        this.lonCenter = 0;
        this.latCenter = 0;
    }

    /**
     * Main render function. Clears canvas and draws everything.
     */
    _render() {
        if (!this.canvas || !this.ctx) return;

        const ctx = this.ctx;
        const w = this.canvas.width;
        const h = this.canvas.height;

        // Clear with background color
        ctx.fillStyle = '#0f1419';
        ctx.fillRect(0, 0, w, h);

        if (!this.pixelData || this.pixelData.length === 0) {
            this._drawPlaceholder(ctx, w, h);
            return;
        }

        // Get map bounds for current FOV
        const bounds = this._getMapBounds();
        const mapW = bounds.xMax - bounds.xMin;
        const mapH = bounds.yMax - bounds.yMin;

        // Map coordinate to canvas pixel
        const mapToCanvas = (mx, my) => ({
            cx: ((mx - bounds.xMin) / mapW) * w,
            cy: ((bounds.yMax - my) / mapH) * h // y-axis inverted (top = max lat)
        });

        // Canvas pixel to map coordinate (for background fill)
        const canvasToMap = (cx, cy) => ({
            mx: bounds.xMin + (cx / w) * mapW,
            my: bounds.yMax - (cy / h) * mapH
        });

        // Draw sphere background (areas inside projection but outside arena)
        this._drawBackground(ctx, w, h, canvasToMap);

        // Draw gridlines
        this._drawGridlines(ctx, w, h, bounds, mapToCanvas);

        // Draw arena pixels
        this._drawArenaPixels(ctx, w, h, bounds, mapToCanvas);

        // Draw panel boundaries
        if (this.state.showPanelBoundaries) {
            this._drawPanelBoundaries(ctx, w, h, mapToCanvas);
        }

        // Draw projection-specific decorations
        this._drawDecorations(ctx, mapToCanvas);
    }

    _drawPlaceholder(ctx, w, h) {
        ctx.fillStyle = '#8b949e';
        ctx.font = '14px "IBM Plex Mono", monospace';
        ctx.textAlign = 'center';
        ctx.fillText('No Pattern Loaded', w / 2, h / 2 - 10);
        ctx.font = '12px "IBM Plex Mono", monospace';
        ctx.fillText('Load a .pat file or generate a pattern to view.', w / 2, h / 2 + 10);
    }

    /**
     * Draw background: sphere-but-no-arena region in surface dark color.
     */
    _drawBackground(ctx, w, h, canvasToMap) {
        // For Mollweide, fill the ellipse interior with sphere color
        // For Mercator, fill the entire canvas with sphere color
        ctx.fillStyle = '#1a1f26';

        // Simple fill — subclass decorations will handle ellipse clipping if needed
        ctx.fillRect(0, 0, w, h);
    }

    /**
     * Draw latitude/longitude gridlines at 30° intervals.
     */
    _drawGridlines(ctx, w, h, bounds, mapToCanvas) {
        ctx.strokeStyle = 'rgba(45, 54, 64, 0.6)';
        ctx.lineWidth = 0.5;

        // Longitude lines (vertical)
        for (let lon = -180; lon <= 180; lon += 30) {
            if (lon < this.lonCenter - this.lonFOV - 5 || lon > this.lonCenter + this.lonFOV + 5)
                continue;

            ctx.beginPath();
            const steps = 60;
            let started = false;
            for (let s = 0; s <= steps; s++) {
                const lat = -this.latFOV + ((2 * this.latFOV) / steps) * s + this.latCenter;
                const proj = this._forwardProject(lon, lat);
                if (!proj) continue;
                const { cx, cy } = mapToCanvas(proj.x, proj.y);
                if (cx < -10 || cx > w + 10 || cy < -10 || cy > h + 10) continue;
                if (!started) {
                    ctx.moveTo(cx, cy);
                    started = true;
                } else {
                    ctx.lineTo(cx, cy);
                }
            }
            ctx.stroke();
        }

        // Latitude lines (horizontal)
        for (let lat = -90; lat <= 90; lat += 30) {
            if (lat < this.latCenter - this.latFOV - 5 || lat > this.latCenter + this.latFOV + 5)
                continue;

            ctx.beginPath();
            const steps = 120;
            let started = false;
            for (let s = 0; s <= steps; s++) {
                const lon = -this.lonFOV + ((2 * this.lonFOV) / steps) * s + this.lonCenter;
                const proj = this._forwardProject(lon, lat);
                if (!proj) continue;
                const { cx, cy } = mapToCanvas(proj.x, proj.y);
                if (cx < -10 || cx > w + 10 || cy < -10 || cy > h + 10) continue;
                if (!started) {
                    ctx.moveTo(cx, cy);
                    started = true;
                } else {
                    ctx.lineTo(cx, cy);
                }
            }
            ctx.stroke();
        }

        // Equator highlight
        ctx.strokeStyle = 'rgba(45, 54, 64, 0.9)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        let started = false;
        const steps = 120;
        for (let s = 0; s <= steps; s++) {
            const lon = -this.lonFOV + ((2 * this.lonFOV) / steps) * s + this.lonCenter;
            const proj = this._forwardProject(lon, 0);
            if (!proj) continue;
            const { cx, cy } = mapToCanvas(proj.x, proj.y);
            if (!started) {
                ctx.moveTo(cx, cy);
                started = true;
            } else {
                ctx.lineTo(cx, cy);
            }
        }
        ctx.stroke();

        // Axis labels
        ctx.fillStyle = '#4a5568';
        ctx.font = '10px "IBM Plex Mono", monospace';
        ctx.textAlign = 'center';

        // Longitude labels along bottom
        for (let lon = -180; lon <= 180; lon += 30) {
            if (lon < this.lonCenter - this.lonFOV || lon > this.lonCenter + this.lonFOV) continue;
            const proj = this._forwardProject(lon, this.latCenter - this.latFOV);
            if (!proj) continue;
            const { cx, cy } = mapToCanvas(proj.x, proj.y);
            if (cx > 20 && cx < w - 20 && cy > 0 && cy < h) {
                ctx.fillText(lon + '\u00b0', cx, Math.min(cy + 12, h - 2));
            }
        }

        // Latitude labels along left
        ctx.textAlign = 'right';
        for (let lat = -90; lat <= 90; lat += 30) {
            if (lat < this.latCenter - this.latFOV || lat > this.latCenter + this.latFOV) continue;
            const proj = this._forwardProject(this.lonCenter - this.lonFOV, lat);
            if (!proj) continue;
            const { cx, cy } = mapToCanvas(proj.x, proj.y);
            if (cy > 12 && cy < h - 5 && cx >= 0) {
                ctx.fillText(lat + '\u00b0', Math.max(cx - 4, 30), cy + 3);
            }
        }
    }

    /**
     * Draw arena pixels as colored rectangles.
     */
    _drawArenaPixels(ctx, w, h, bounds, mapToCanvas) {
        const frame = this.state.pattern?.frames?.[this.state.currentFrame] ?? null;
        const maxVal = this.state.pattern?.gsMode === 2 ? 1 : 15;
        const mapW = bounds.xMax - bounds.xMin;
        const mapH = bounds.yMax - bounds.yMin;

        // Compute dot size based on pixel angular spacing
        // Each pixel subtends approximately pRad radians
        const pRadDeg =
            this.pixelData.length > 1
                ? Math.abs(this.pixelData[1].lonDeg - this.pixelData[0].lonDeg) || 1
                : 1;

        for (const px of this.pixelData) {
            // Forward project this pixel
            const proj = this._forwardProject(px.lonDeg, px.latDeg);
            if (!proj) continue;

            // Check if within current map bounds
            if (
                proj.x < bounds.xMin ||
                proj.x > bounds.xMax ||
                proj.y < bounds.yMin ||
                proj.y > bounds.yMax
            )
                continue;

            // Get brightness
            let brightness;
            if (frame && px.patternIndex < frame.length) {
                brightness = frame[px.patternIndex] / maxVal;
            } else {
                brightness = 1.0; // Default full brightness when no pattern
            }

            // Green phosphor color (matching MATLAB: pure green channel)
            if (brightness > 0) {
                const g = Math.round(brightness * 255);
                ctx.fillStyle = `rgb(0,${g},0)`;
            } else {
                ctx.fillStyle = '#1e2328';
            }

            // Convert to canvas coordinates
            const { cx, cy } = mapToCanvas(proj.x, proj.y);

            // Dot size: scale pRad to canvas pixels
            const dotW = Math.max(1.5, (pRadDeg / mapW) * w * 0.95);
            const dotH = Math.max(1.5, (pRadDeg / mapH) * h * 0.95);

            ctx.fillRect(cx - dotW / 2, cy - dotH / 2, dotW, dotH);
        }
    }

    /**
     * Draw panel boundary lines on the projection.
     */
    _drawPanelBoundaries(ctx, w, h, mapToCanvas) {
        if (!this.pixelData || this.pixelData.length === 0) return;

        ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
        ctx.lineWidth = 0.5;

        // Collect unique panel boundary longitudes and latitudes
        // Panel boundaries are between every panelSize pixels in azimuth and elevation

        // Get longitude of each column boundary
        const colBoundaryLons = [];
        for (let c = this.panelSize; c < this.totalPixelCols; c += this.panelSize) {
            // Boundary is between pixel c-1 and pixel c
            // Average their longitudes
            const idx1 = c - 1; // last pixel in previous panel
            const idx2 = c; // first pixel in next panel
            // Use row 0 as reference
            const px1 = this.pixelData[idx1];
            const px2 = this.pixelData[idx2];
            if (px1 && px2) {
                colBoundaryLons.push((px1.lonDeg + px2.lonDeg) / 2);
            }
        }

        // Get latitude of each row boundary
        const rowBoundaryLats = [];
        for (let r = this.panelSize; r < this.totalPixelRows; r += this.panelSize) {
            // Boundary between row r-1 and row r
            const idx1 = (r - 1) * this.totalPixelCols;
            const idx2 = r * this.totalPixelCols;
            const px1 = this.pixelData[idx1];
            const px2 = this.pixelData[idx2];
            if (px1 && px2) {
                rowBoundaryLats.push((px1.latDeg + px2.latDeg) / 2);
            }
        }

        // Get arena lat/lon extents
        let minLat = Infinity;
        let maxLat = -Infinity;
        let minLon = Infinity;
        let maxLon = -Infinity;
        for (const px of this.pixelData) {
            if (px.latDeg < minLat) minLat = px.latDeg;
            if (px.latDeg > maxLat) maxLat = px.latDeg;
            if (px.lonDeg < minLon) minLon = px.lonDeg;
            if (px.lonDeg > maxLon) maxLon = px.lonDeg;
        }

        // Draw vertical boundaries (panel column separators)
        for (const lon of colBoundaryLons) {
            ctx.beginPath();
            const steps = 40;
            let started = false;
            for (let s = 0; s <= steps; s++) {
                const lat = minLat + ((maxLat - minLat) / steps) * s;
                const proj = this._forwardProject(lon, lat);
                if (!proj) continue;
                const { cx, cy } = mapToCanvas(proj.x, proj.y);
                if (!started) {
                    ctx.moveTo(cx, cy);
                    started = true;
                } else {
                    ctx.lineTo(cx, cy);
                }
            }
            ctx.stroke();
        }

        // Draw horizontal boundaries (panel row separators)
        for (const lat of rowBoundaryLats) {
            ctx.beginPath();
            const steps = 80;
            let started = false;
            for (let s = 0; s <= steps; s++) {
                const lon = minLon + ((maxLon - minLon) / steps) * s;
                const proj = this._forwardProject(lon, lat);
                if (!proj) continue;
                const { cx, cy } = mapToCanvas(proj.x, proj.y);
                if (!started) {
                    ctx.moveTo(cx, cy);
                    started = true;
                } else {
                    ctx.lineTo(cx, cy);
                }
            }
            ctx.stroke();
        }
    }

    _onResize() {
        if (!this.canvas) return;
        this._sizeCanvas();
        this._render();
    }
}

export default ProjectionViewer;
export { ProjectionViewer };
