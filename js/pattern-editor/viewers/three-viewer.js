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

const GRAYSCALE_LEVELS = 16;
const BASE_OFFSET_RAD = -Math.PI / 2;

class ThreeViewer {
    constructor(container) {
        this.container = container;
        this.scene = null;
        this.camera = null;
        this.renderer = null;
        this.controls = null;
        this.arenaGroup = null;
        this.ledMeshes = [];

        this.state = {
            pattern: null,          // Pattern data from editor
            currentFrame: 0,
            phaseOffset: 0,
            showPanelBoundaries: true,
            showPanelNumbers: false,
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
     * @param {Object} options - { showPanelBoundaries, showPanelNumbers }
     */
    setOptions(options) {
        if (options.showPanelBoundaries !== undefined) {
            this.state.showPanelBoundaries = options.showPanelBoundaries;
        }
        if (options.showPanelNumbers !== undefined) {
            this.state.showPanelNumbers = options.showPanelNumbers;
        }
        // TODO: Update panel boundary and number visibility
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

        if (this.controls) {
            this.controls.dispose();
        }

        // Clear references
        this.ledMeshes = [];
        this.scene = null;
        this.camera = null;
        this.renderer = null;
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
    }

    _onResize() {
        const width = this.container.clientWidth;
        const height = this.container.clientHeight;

        this.camera.aspect = width / height;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(width, height);
    }

    _buildArena() {
        // Clear existing
        while (this.arenaGroup.children.length > 0) {
            this.arenaGroup.remove(this.arenaGroup.children[0]);
        }
        this.ledMeshes = [];

        const config = this.arenaConfig;
        const specs = this.panelSpecs;
        if (!config || !specs) return;

        const arena = config.arena;
        const numCols = arena.num_cols;
        const numRows = arena.num_rows;

        // Calculate arena geometry
        const panelWidthInches = specs.panel_width_mm / 25.4;
        const panelHeightInches = panelWidthInches; // Square panels
        const totalHeight = panelHeightInches * numRows;

        // Calculate radius using the formula from MATLAB
        const alpha = (2 * Math.PI) / numCols;
        const cRadius = panelWidthInches / (Math.tan(alpha / 2)) / 2;

        // Create columns (panels)
        for (let col = 0; col < numCols; col++) {
            const angle = BASE_OFFSET_RAD + (col + 0.5) * alpha;

            const columnGroup = this._createColumn(specs, panelWidthInches, totalHeight, col, numCols, numRows);

            // Position column on cylinder (centered at Y=0)
            columnGroup.position.x = cRadius * Math.cos(angle);
            columnGroup.position.z = -cRadius * Math.sin(angle);
            columnGroup.position.y = 0;

            // Rotate to face center
            columnGroup.rotation.y = -angle + Math.PI / 2;

            this.arenaGroup.add(columnGroup);
        }

        // Position camera to view arena (top-down view)
        const viewDistance = cRadius * 3;
        this.camera.position.set(0, viewDistance, 0.01);
        this.controls.target.set(0, 0, 0);
        this.controls.update();
    }

    _createColumn(specs, width, height, colIndex, numCols, numRows) {
        const group = new THREE.Group();

        // Column background
        const depth = 0.1;
        const columnGeom = new THREE.BoxGeometry(width, height, depth);
        const columnMat = new THREE.MeshLambertMaterial({ color: 0x111111 });
        const column = new THREE.Mesh(columnGeom, columnMat);
        group.add(column);

        // Create LEDs
        const pixelsPerPanel = specs.pixels_per_panel;
        const totalPixelsV = pixelsPerPanel * numRows;
        const totalPixelsH = pixelsPerPanel;

        const ledSpacingX = width / totalPixelsH;
        const ledSpacingY = height / totalPixelsV;
        const ledSize = Math.min(ledSpacingX, ledSpacingY) * 0.8;

        const isRectLED = specs.led_type === 'rect';

        for (let py = 0; py < totalPixelsV; py++) {
            for (let px = 0; px < totalPixelsH; px++) {
                let ledMesh;

                if (isRectLED) {
                    // Rotated rectangle LED (45 degrees)
                    const rectGeom = new THREE.PlaneGeometry(ledSize * 0.7, ledSize * 0.5);
                    const ledMat = new THREE.MeshBasicMaterial({ color: 0x00e676 });
                    ledMesh = new THREE.Mesh(rectGeom, ledMat);
                    ledMesh.rotation.z = Math.PI / 4;
                } else {
                    // Circle LED
                    const ledGeom = new THREE.CircleGeometry(ledSize / 2, 16);
                    const ledMat = new THREE.MeshBasicMaterial({ color: 0x00e676 });
                    ledMesh = new THREE.Mesh(ledGeom, ledMat);
                }

                // Position LED
                const x = (px - totalPixelsH / 2 + 0.5) * ledSpacingX;
                const y = (py - totalPixelsV / 2 + 0.5) * ledSpacingY;
                ledMesh.position.set(x, y, depth / 2 + 0.01);

                group.add(ledMesh);

                // Store reference for color updates
                this.ledMeshes.push({
                    mesh: ledMesh,
                    colIndex,
                    px,
                    py,
                    totalPixelsH,
                    numCols,
                    numRows
                });
            }
        }

        return group;
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
        const { px, py, colIndex, totalPixelsH, numRows } = ledRef;
        const pattern = this.state.pattern;

        if (!pattern || !pattern.frames || pattern.frames.length === 0) {
            return 1.0; // Default full brightness
        }

        const frame = pattern.frames[this.state.currentFrame];
        if (!frame) return 0.0;

        const pixelsPerPanel = totalPixelsH;

        // Calculate global coordinates
        const globalX = colIndex * pixelsPerPanel + px;
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
}

// Export for use
export default ThreeViewer;
export { ThreeViewer };
