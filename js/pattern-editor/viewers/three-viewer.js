/**
 * Three.js 3D Viewer Module for Pattern Editor
 *
 * Extracted from arena_3d_viewer.html for integration into the Pattern Editor.
 * Renders LED arena patterns in 3D using Three.js.
 *
 * Usage:
 *   const viewer = new ThreeViewer(containerElement);
 *   viewer.init(arenaConfig);
 *   viewer.setPattern(patternData);
 *   viewer.setFrame(frameIndex);
 *   viewer.destroy();
 */

import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.182.0/build/three.module.js';
import { OrbitControls } from 'https://cdn.jsdelivr.net/npm/three@0.182.0/examples/jsm/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'https://cdn.jsdelivr.net/npm/three@0.182.0/examples/jsm/renderers/CSS2DRenderer.js';

const GRAYSCALE_LEVELS = 16;
const BASE_OFFSET_RAD = -Math.PI / 2;

class ThreeViewer {
    constructor(container) {
        this.container = container;
        this.scene = null;
        this.camera = null;
        this.renderer = null;
        this.labelRenderer = null;
        this.controls = null;
        this.arenaGroup = null;
        this.ledMeshes = [];
        this.labelObjects = [];
        this.poleGroup = null;      // Group for pole geometry visualization

        this.state = {
            pattern: null,          // Pattern data from editor
            currentFrame: 0,
            phaseOffset: 0,
            showPanelBoundaries: true,
            showPanelNumbers: false,
            showColumnLabels: false,
            showPoleGeometry: false,  // Show pole axis line
            poleCoord: [0, -Math.PI / 2],  // [phi, theta] in radians - default south pole
            isPlaying: false,
            fps: 10,
            playbackIntervalId: null
        };

        this.arenaConfig = null;
        this.panelSpecs = null;

        this._animationId = null;
        this._resizeHandler = null;
    }

    /**
     * Initialize the 3D viewer
     * @param {Object} arenaConfig - Arena configuration from arena-configs.js
     * @param {Object} panelSpecs - Panel specifications from arena-configs.js
     */
    init(arenaConfig, panelSpecs) {
        // Prevent double initialization
        if (this.scene) {
            return;
        }

        this.arenaConfig = arenaConfig;
        this.panelSpecs = panelSpecs;

        // Scene
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x0f1419);

        // Camera
        const width = this.container.clientWidth;
        const height = this.container.clientHeight;
        this.camera = new THREE.PerspectiveCamera(60, width / height, 0.1, 1000);
        this.camera.position.set(0, 5, 10);

        // Renderer
        this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
        this.renderer.setSize(width, height);
        this.renderer.setPixelRatio(window.devicePixelRatio);
        this.container.appendChild(this.renderer.domElement);

        // CSS2D Renderer for labels
        this.labelRenderer = new CSS2DRenderer();
        this.labelRenderer.setSize(width, height);
        this.labelRenderer.domElement.style.position = 'absolute';
        this.labelRenderer.domElement.style.top = '0px';
        this.labelRenderer.domElement.style.left = '0px';
        this.labelRenderer.domElement.style.pointerEvents = 'none';
        this.container.appendChild(this.labelRenderer.domElement);

        // Ensure container has relative positioning for absolute label renderer
        if (getComputedStyle(this.container).position === 'static') {
            this.container.style.position = 'relative';
        }

        // Controls
        this.controls = new OrbitControls(this.camera, this.renderer.domElement);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.05;
        this.controls.minDistance = 0.1;
        this.controls.maxDistance = 50;

        // Lighting
        const ambientLight = new THREE.AmbientLight(0x404040, 0.5);
        this.scene.add(ambientLight);

        const directionalLight = new THREE.DirectionalLight(0xffffff, 0.3);
        directionalLight.position.set(5, 10, 5);
        this.scene.add(directionalLight);

        // Grid helper
        const gridHelper = new THREE.GridHelper(20, 20, 0x2d3640, 0x1a1f26);
        gridHelper.position.y = -5;
        this.scene.add(gridHelper);

        // Arena group
        this.arenaGroup = new THREE.Group();
        this.scene.add(this.arenaGroup);

        // Build arena
        this._buildArena();

        // Resize handler
        this._resizeHandler = () => this._onResize();
        window.addEventListener('resize', this._resizeHandler);

        // Start animation loop
        this._animate();
    }

    /**
     * Set the pattern data to display
     * @param {Object} patternData - Pattern object with frames, pixelRows, pixelCols, gsMode
     */
    setPattern(patternData) {
        this.state.pattern = patternData;
        this.state.currentFrame = 0;
        this._updateLEDColors();
    }

    /**
     * Reinitialize the viewer with a new arena configuration
     * @param {Object} arenaConfig - Arena configuration from arena-configs.js
     * @param {Object} panelSpecs - Panel specifications from arena-configs.js
     */
    reinit(arenaConfig, panelSpecs) {
        this.arenaConfig = arenaConfig;
        this.panelSpecs = panelSpecs;
        this._buildArena();
        this._updateLEDColors();
    }

    /**
     * Set the current frame to display
     * @param {number} frameIndex - 0-indexed frame number
     */
    setFrame(frameIndex) {
        if (!this.state.pattern) return;
        this.state.currentFrame = Math.max(0, Math.min(frameIndex, this.state.pattern.numFrames - 1));
        this._updateLEDColors();
    }

    /**
     * Update display options
     * @param {Object} options - { showPanelBoundaries, showPanelNumbers, showPoleGeometry, poleCoord }
     */
    setOptions(options) {
        let needsRebuild = false;

        if (options.showPanelBoundaries !== undefined) {
            this.state.showPanelBoundaries = options.showPanelBoundaries;
        }
        if (options.showPanelNumbers !== undefined && options.showPanelNumbers !== this.state.showPanelNumbers) {
            this.state.showPanelNumbers = options.showPanelNumbers;
            needsRebuild = true;
        }
        if (options.showPoleGeometry !== undefined) {
            this.state.showPoleGeometry = options.showPoleGeometry;
            this._updatePoleGeometry();
        }
        if (options.poleCoord !== undefined) {
            this.state.poleCoord = options.poleCoord;
            if (this.state.showPoleGeometry) {
                this._updatePoleGeometry();
            }
        }

        // Rebuild arena if label visibility changed (labels are attached to columns)
        if (needsRebuild) {
            this._buildArena();
            this._updateLEDColors();
        }
    }

    /**
     * Update pole coordinate for visualization
     * @param {Array} poleCoord - [phi, theta] in radians
     */
    setPoleCoord(poleCoord) {
        this.state.poleCoord = poleCoord;
        if (this.state.showPoleGeometry) {
            this._updatePoleGeometry();
        }
    }

    /**
     * Start playback animation
     * @param {number} fps - Frames per second
     */
    startPlayback(fps = 10) {
        if (this.state.playbackIntervalId) return;
        if (!this.state.pattern || this.state.pattern.numFrames <= 1) return;

        this.state.isPlaying = true;
        this.state.fps = fps;

        const intervalMs = 1000 / fps;
        this.state.playbackIntervalId = setInterval(() => {
            this.state.currentFrame = (this.state.currentFrame + 1) % this.state.pattern.numFrames;
            this._updateLEDColors();
            this._onFrameChange?.(this.state.currentFrame);
        }, intervalMs);
    }

    /**
     * Stop playback animation
     */
    stopPlayback() {
        if (this.state.playbackIntervalId) {
            clearInterval(this.state.playbackIntervalId);
            this.state.playbackIntervalId = null;
        }
        this.state.isPlaying = false;
    }

    /**
     * Set callback for frame changes during playback
     * @param {Function} callback - Called with (frameIndex) when frame changes
     */
    onFrameChange(callback) {
        this._onFrameChange = callback;
    }

    /**
     * Take a screenshot of the current view
     * @returns {string} Data URL of the screenshot
     */
    screenshot() {
        this.renderer.render(this.scene, this.camera);
        return this.renderer.domElement.toDataURL('image/png');
    }

    /**
     * Clean up and destroy the viewer
     */
    destroy() {
        this.stopPlayback();

        if (this._animationId) {
            cancelAnimationFrame(this._animationId);
        }

        if (this._resizeHandler) {
            window.removeEventListener('resize', this._resizeHandler);
        }

        if (this.renderer) {
            this.renderer.dispose();
            if (this.renderer.domElement.parentNode) {
                this.renderer.domElement.parentNode.removeChild(this.renderer.domElement);
            }
        }

        if (this.labelRenderer) {
            if (this.labelRenderer.domElement.parentNode) {
                this.labelRenderer.domElement.parentNode.removeChild(this.labelRenderer.domElement);
            }
        }

        if (this.controls) {
            this.controls.dispose();
        }

        // Clean up label elements
        for (const label of this.labelObjects) {
            if (label.element && label.element.parentNode) {
                label.element.parentNode.removeChild(label.element);
            }
        }

        // Clear references
        this.ledMeshes = [];
        this.labelObjects = [];
        this.scene = null;
        this.camera = null;
        this.renderer = null;
        this.labelRenderer = null;
        this.controls = null;
        this.arenaGroup = null;
    }

    // ==========================================
    // Private methods
    // ==========================================

    _animate() {
        this._animationId = requestAnimationFrame(() => this._animate());
        this.controls.update();
        this.renderer.render(this.scene, this.camera);
        if (this.labelRenderer) {
            this.labelRenderer.render(this.scene, this.camera);
        }
    }

    _onResize() {
        const width = this.container.clientWidth;
        const height = this.container.clientHeight;

        this.camera.aspect = width / height;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(width, height);
        if (this.labelRenderer) {
            this.labelRenderer.setSize(width, height);
        }
    }

    _buildArena() {
        // Clean up existing label DOM elements FIRST (they're nested in column groups)
        // CSS2DRenderer appends label.element to its own domElement container
        for (const label of this.labelObjects) {
            if (label.element && label.element.parentNode) {
                label.element.parentNode.removeChild(label.element);
            }
        }
        this.labelObjects = [];

        // Also clear any orphaned labels from the labelRenderer's container
        if (this.labelRenderer && this.labelRenderer.domElement) {
            const labelContainer = this.labelRenderer.domElement;
            while (labelContainer.firstChild) {
                labelContainer.removeChild(labelContainer.firstChild);
            }
        }

        // Clear existing arena children
        while (this.arenaGroup.children.length > 0) {
            const child = this.arenaGroup.children[0];
            this.arenaGroup.remove(child);
        }
        this.ledMeshes = [];

        const config = this.arenaConfig;
        const specs = this.panelSpecs;
        if (!config || !specs) return;

        const arena = config.arena;
        const numCols = arena.num_cols;
        const numRows = arena.num_rows;
        const columnOrder = arena.column_order || 'cw';
        const angleOffsetDeg = arena.angle_offset_deg || 0;
        const angleOffsetRad = (angleOffsetDeg * Math.PI) / 180;

        // Convert mm to inches (working units)
        const panelWidth = specs.panel_width_mm / 25.4;
        const panelHeight = specs.panel_height_mm / 25.4;
        const panelDepth = specs.panel_depth_mm / 25.4;

        // Calculate radius using the formula from MATLAB
        const alpha = (2 * Math.PI) / numCols;
        const halfPanel = alpha / 2;  // Offset so c0 starts at boundary, not centered
        const cRadius = panelWidth / (Math.tan(alpha / 2)) / 2;

        const columnHeight = panelHeight * numRows;

        // Place columns with proper CW/CCW ordering
        // CW: c0 just LEFT of south (looking from above), columns increase counter-clockwise
        // CCW: c0 just RIGHT of south, columns increase clockwise (mirror)
        // Note: Three.js uses right-handed coords but top-down view has +Z toward viewer,
        // so we negate Z to match MATLAB's top-down appearance
        for (let col = 0; col < numCols; col++) {
            let angle;
            if (columnOrder === 'cw') {
                // CW: start left of south, go counter-clockwise
                angle = BASE_OFFSET_RAD - halfPanel - col * alpha + angleOffsetRad;
            } else {
                // CCW: start right of south, go clockwise
                angle = BASE_OFFSET_RAD + halfPanel + col * alpha + angleOffsetRad;
            }

            const x = cRadius * Math.cos(angle);
            const z = -cRadius * Math.sin(angle);  // Negate Z to match MATLAB top-down view

            const columnGroup = this._createColumn(specs, panelWidth, columnHeight, panelDepth, -angle, numRows, col, numCols, columnOrder);
            columnGroup.position.set(x, 0, z);

            this.arenaGroup.add(columnGroup);
        }

        // Position camera to view arena (top-down view)
        const viewDistance = cRadius * 3;
        this.camera.position.set(0, viewDistance, 0.01);
        this.controls.target.set(0, 0, 0);
        this.controls.update();
    }

    _createColumn(specs, width, height, depth, angle, numRows, colIndex, numCols, columnOrder) {
        const group = new THREE.Group();

        // Apply rotation to face center (matches standalone viewer exactly)
        group.rotation.y = -angle - Math.PI / 2;

        // Column background
        const columnGeom = new THREE.BoxGeometry(width, height, depth * 0.1);
        const columnMat = new THREE.MeshLambertMaterial({ color: 0x111111 });
        const column = new THREE.Mesh(columnGeom, columnMat);
        group.add(column);

        // Border
        const borderMat = new THREE.LineBasicMaterial({ color: 0xffffff, linewidth: 2 });
        const halfW = width / 2;
        const halfH = height / 2;
        const panelThickness = depth * 0.05;

        const borderOffsets = [panelThickness, -panelThickness];

        for (const borderZ of borderOffsets) {
            const borderGeom = new THREE.BufferGeometry();
            const borderVertices = new Float32Array([
                -halfW, -halfH, borderZ,
                 halfW, -halfH, borderZ,
                 halfW, -halfH, borderZ,
                 halfW,  halfH, borderZ,
                 halfW,  halfH, borderZ,
                -halfW,  halfH, borderZ,
                -halfW,  halfH, borderZ,
                -halfW, -halfH, borderZ
            ]);
            borderGeom.setAttribute('position', new THREE.Float32BufferAttribute(borderVertices, 3));
            const border = new THREE.LineSegments(borderGeom, borderMat);
            group.add(border);

            // Panel separators for multi-row columns
            if (numRows > 1) {
                const panelH = height / numRows;
                for (let r = 1; r < numRows; r++) {
                    const lineY = -halfH + r * panelH;
                    const lineGeom = new THREE.BufferGeometry();
                    const lineVerts = new Float32Array([
                        -halfW, lineY, borderZ,
                         halfW, lineY, borderZ
                    ]);
                    lineGeom.setAttribute('position', new THREE.Float32BufferAttribute(lineVerts, 3));
                    const line = new THREE.Line(lineGeom, borderMat);
                    group.add(line);
                }
            }
        }

        // LEDs - use accurate dimensions from specs
        const totalPixelsV = specs.pixels_per_panel * numRows;
        const totalPixelsH = specs.pixels_per_panel;

        const ledSpacingX = width / totalPixelsH;
        const ledSpacingY = height / totalPixelsV;

        // Use actual LED dimensions from specs (convert mm to inches)
        const isRectLED = specs.led_type === 'rect';
        let ledW, ledH, ledRadius;

        if (isRectLED) {
            // Rectangular SMD LEDs (G4.1, G6) - mounted at 45°
            ledW = (specs.led_width_mm || 1.0) / 25.4;
            ledH = (specs.led_height_mm || 0.5) / 25.4;
        } else {
            // Round LEDs (G3, G4)
            ledRadius = (specs.led_diameter_mm || 2.0) / 25.4 / 2;
        }

        for (let py = 0; py < totalPixelsV; py++) {
            for (let px = 0; px < totalPixelsH; px++) {
                const localX = -halfW + ledSpacingX / 2 + px * ledSpacingX;
                const localY = -halfH + ledSpacingY / 2 + py * ledSpacingY;
                const localZ = panelThickness + 0.001;

                if (isRectLED) {
                    // Rectangular LED rotated 45°
                    const rectW = ledW / 2;
                    const rectH = ledH / 2;

                    const cos45 = Math.SQRT1_2;
                    const sin45 = Math.SQRT1_2;

                    const c1x = (-rectW) * cos45 - (-rectH) * sin45;
                    const c1y = (-rectW) * sin45 + (-rectH) * cos45;
                    const c2x = (rectW) * cos45 - (-rectH) * sin45;
                    const c2y = (rectW) * sin45 + (-rectH) * cos45;
                    const c3x = (rectW) * cos45 - (rectH) * sin45;
                    const c3y = (rectW) * sin45 + (rectH) * cos45;
                    const c4x = (-rectW) * cos45 - (rectH) * sin45;
                    const c4y = (-rectW) * sin45 + (rectH) * cos45;

                    const rectShape = new THREE.Shape();
                    rectShape.moveTo(c1x, c1y);
                    rectShape.lineTo(c2x, c2y);
                    rectShape.lineTo(c3x, c3y);
                    rectShape.lineTo(c4x, c4y);
                    rectShape.lineTo(c1x, c1y);

                    const rectGeom = new THREE.ShapeGeometry(rectShape);
                    const rectMat = new THREE.MeshBasicMaterial({ color: 0x00e600 });
                    const rect = new THREE.Mesh(rectGeom, rectMat);
                    rect.position.set(localX, localY, localZ);
                    group.add(rect);

                    this.ledMeshes.push({
                        mesh: rect,
                        colIndex: colIndex,
                        px: px,
                        py: py,
                        totalPixelsH: totalPixelsH,
                        numCols: numCols,
                        numRows: numRows,
                        columnOrder: columnOrder
                    });

                    // LED outline
                    const outlineGeom = new THREE.BufferGeometry();
                    const outlineVerts = new Float32Array([
                        c1x, c1y, 0,
                        c2x, c2y, 0,
                        c2x, c2y, 0,
                        c3x, c3y, 0,
                        c3x, c3y, 0,
                        c4x, c4y, 0,
                        c4x, c4y, 0,
                        c1x, c1y, 0
                    ]);
                    outlineGeom.setAttribute('position', new THREE.Float32BufferAttribute(outlineVerts, 3));
                    const outlineMat = new THREE.LineBasicMaterial({ color: 0x333333 });
                    const outline = new THREE.LineSegments(outlineGeom, outlineMat);
                    outline.position.set(localX, localY, localZ + 0.0001);
                    group.add(outline);
                } else {
                    // Round LED
                    const ledGeom = new THREE.CircleGeometry(ledRadius, 16);
                    const ledMat = new THREE.MeshBasicMaterial({ color: 0x00e600 });
                    const led = new THREE.Mesh(ledGeom, ledMat);
                    led.position.set(localX, localY, localZ);
                    group.add(led);

                    this.ledMeshes.push({
                        mesh: led,
                        colIndex: colIndex,
                        px: px,
                        py: py,
                        totalPixelsH: totalPixelsH,
                        numCols: numCols,
                        numRows: numRows,
                        columnOrder: columnOrder
                    });

                    // LED outline circle
                    const circlePoints = [];
                    const segments = 16;
                    for (let i = 0; i <= segments; i++) {
                        const theta = (i / segments) * Math.PI * 2;
                        circlePoints.push(new THREE.Vector3(
                            Math.cos(theta) * ledRadius,
                            Math.sin(theta) * ledRadius,
                            0
                        ));
                    }
                    const circleGeom = new THREE.BufferGeometry().setFromPoints(circlePoints);
                    const circleMat = new THREE.LineBasicMaterial({ color: 0x333333 });
                    const circle = new THREE.Line(circleGeom, circleMat);
                    circle.position.set(localX, localY, localZ + 0.0001);
                    group.add(circle);
                }
            }
        }

        // Add panel number labels if enabled
        if (this.state.showPanelNumbers) {
            const panelH = height / numRows;
            for (let row = 0; row < numRows; row++) {
                const panelNumber = colIndex * numRows + row + 1; // 1-indexed
                const label = this._createLabel(panelNumber.toString(), '#ff3333', 'bold', '17px');
                // Position on back side of panel, centered
                label.position.set(0, -halfH + row * panelH + panelH / 2, -panelThickness - 0.02);
                group.add(label);
                this.labelObjects.push(label);
            }
        }

        return group;
    }

    /**
     * Create a CSS2D label
     */
    _createLabel(text, color, fontWeight = 'normal', fontSize = '14px') {
        const div = document.createElement('div');
        div.className = 'arena-label';
        div.textContent = text;
        div.style.color = color;
        div.style.fontFamily = "'JetBrains Mono', monospace";
        div.style.fontSize = fontSize;
        div.style.fontWeight = fontWeight;
        div.style.textShadow = '0 0 4px rgba(0,0,0,0.9), 0 0 8px rgba(0,0,0,0.7)';
        div.style.pointerEvents = 'none';

        const label = new CSS2DObject(div);
        return label;
    }

    _updateLEDColors() {
        const pattern = this.state.pattern;

        for (const ledRef of this.ledMeshes) {
            const brightness = this._getLEDBrightness(ledRef);
            const color = this._brightnessToColor(brightness);
            ledRef.mesh.material.color.setHex(color);
        }
    }

    _getLEDBrightness(ledRef) {
        const { px, py, colIndex, totalPixelsH, numCols, columnOrder } = ledRef;
        const pattern = this.state.pattern;

        if (!pattern || !pattern.frames || pattern.frames.length === 0) {
            return 1.0; // Default full brightness
        }

        const frame = pattern.frames[this.state.currentFrame];
        if (!frame) return 0.0;

        const pixelsPerPanel = totalPixelsH;
        const totalAzimuthPixels = numCols * totalPixelsH;

        // For CCW mode, mirror the pixel index within each panel
        // to ensure grating tiles correctly when columns are placed clockwise
        const effectivePx = (columnOrder === 'ccw')
            ? (totalPixelsH - 1 - px)
            : px;

        // Calculate global X with phase offset support
        const phaseOffset = this.state.phaseOffset || 0;
        const globalX = ((colIndex * pixelsPerPanel + effectivePx) + phaseOffset + totalAzimuthPixels) % totalAzimuthPixels;
        const globalY = py;

        // Row-major index: row * numCols + col
        const pixelIndex = globalY * pattern.pixelCols + globalX;

        if (pixelIndex < 0 || pixelIndex >= frame.length) {
            return 0.0;
        }

        const value = frame[pixelIndex];
        const maxValue = pattern.gsMode === 2 ? 1 : 15;

        return value / maxValue;
    }

    _brightnessToColor(brightness) {
        // Green phosphor color
        const r = Math.floor(brightness * 0.6 * 255);
        const g = Math.floor(brightness * 255);
        const b = Math.floor(brightness * 0.2 * 255);
        return (r << 16) | (g << 8) | b;
    }

    /**
     * Update pole geometry visualization
     * Shows a red line through the arena indicating the pole axis
     */
    _updatePoleGeometry() {
        // Remove existing pole group
        if (this.poleGroup) {
            this.scene.remove(this.poleGroup);
            this.poleGroup = null;
        }

        if (!this.state.showPoleGeometry) {
            return;
        }

        // Create pole group
        this.poleGroup = new THREE.Group();

        // Get arena radius for line length
        const config = this.arenaConfig;
        const specs = this.panelSpecs;
        if (!config || !specs) return;

        const arena = config.arena;
        const numCols = arena.num_cols;
        const panelWidth = specs.panel_width_mm / 25.4;
        const alpha = (2 * Math.PI) / numCols;
        const cRadius = panelWidth / (Math.tan(alpha / 2)) / 2;
        const numRows = arena.num_rows;
        const panelHeight = specs.panel_height_mm / 25.4;
        const columnHeight = panelHeight * numRows;

        // Line extends well beyond arena
        const lineLength = Math.max(cRadius, columnHeight) * 3;

        // Get pole coordinates [phi, theta] in radians
        // phi is azimuthal angle, theta is polar angle from north (0 = north pole, PI = south pole)
        const [phi, theta] = this.state.poleCoord;

        // Convert spherical to direction vector
        // theta is angle from north pole (zenith), phi is azimuth
        // Direction vector pointing in the pole direction
        const sinTheta = Math.sin(theta);
        const cosTheta = Math.cos(theta);
        const sinPhi = Math.sin(phi);
        const cosPhi = Math.cos(phi);

        // In Three.js: Y is up, X is right, Z is toward viewer (negated to match MATLAB)
        // Pole direction in 3D
        const dx = sinTheta * cosPhi;
        const dy = cosTheta;
        const dz = -sinTheta * sinPhi;  // Negate Z to match arena rendering

        // Create line geometry
        const lineGeom = new THREE.BufferGeometry();
        const lineVertices = new Float32Array([
            -dx * lineLength, -dy * lineLength, -dz * lineLength,
             dx * lineLength,  dy * lineLength,  dz * lineLength
        ]);
        lineGeom.setAttribute('position', new THREE.Float32BufferAttribute(lineVertices, 3));

        // Red line material - thick and prominent
        const lineMat = new THREE.LineBasicMaterial({
            color: 0xff0000,
            linewidth: 3  // Note: linewidth > 1 only works with LineBasicMaterial on some systems
        });
        const poleLine = new THREE.Line(lineGeom, lineMat);
        this.poleGroup.add(poleLine);

        // Add arrowhead to indicate positive direction (using right-hand rule)
        // Arrow points in the direction the pattern rotates around (thumb direction)
        const arrowLength = lineLength * 0.15;
        const arrowRadius = lineLength * 0.04;

        // Arrow cone at the positive end
        const arrowGeom = new THREE.ConeGeometry(arrowRadius, arrowLength, 8);
        const arrowMat = new THREE.MeshBasicMaterial({ color: 0xff0000 });
        const arrow = new THREE.Mesh(arrowGeom, arrowMat);

        // Position arrow at the positive end of the line
        arrow.position.set(dx * lineLength, dy * lineLength, dz * lineLength);

        // Orient arrow to point along the direction
        // Default cone points up (+Y), we need to rotate to match direction
        const targetDir = new THREE.Vector3(dx, dy, dz).normalize();
        const upDir = new THREE.Vector3(0, 1, 0);
        const quaternion = new THREE.Quaternion();
        quaternion.setFromUnitVectors(upDir, targetDir);
        arrow.setRotationFromQuaternion(quaternion);

        this.poleGroup.add(arrow);

        // Add a small sphere at the center for reference
        const sphereGeom = new THREE.SphereGeometry(arrowRadius * 0.8, 16, 12);
        const sphereMat = new THREE.MeshBasicMaterial({ color: 0xff4444 });
        const centerSphere = new THREE.Mesh(sphereGeom, sphereMat);
        centerSphere.position.set(0, 0, 0);
        this.poleGroup.add(centerSphere);

        this.scene.add(this.poleGroup);
    }
}

// Export for use
export default ThreeViewer;
export { ThreeViewer };
