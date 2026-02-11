/**
 * Image to Pattern Converter Module
 * Converts raster images to LED pattern frames with arena region extraction
 *
 * @module pattern-editor/tools/image-converter
 */

/**
 * State for the image converter
 */
const ImageConverterState = {
    sourceImage: null, // HTMLImageElement (loaded image)
    sourceCanvas: null, // Canvas with grayscale source
    sourceWidth: 0, // Original image width
    sourceHeight: 0, // Original image height

    // Transform state
    scale: 1.0, // Scale factor (0.1 to 5.0)
    rotation: 0, // Rotation in degrees
    panX: 0, // Pan offset X (in source image pixels)
    panY: 0, // Pan offset Y (in source image pixels)

    // Arena dimensions (set from arena config)
    arenaWidth: 200, // Arena pixel columns
    arenaHeight: 40, // Arena pixel rows

    // Interaction state
    isDragging: false,
    dragStartX: 0,
    dragStartY: 0,
    dragStartPanX: 0,
    dragStartPanY: 0
};

/**
 * Load an image file and convert to grayscale
 * @param {File} file - Image file (PNG, JPEG)
 * @returns {Promise<{width: number, height: number, name: string}>} Image dimensions and name
 */
export async function loadImage(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            const img = new Image();
            img.onload = () => {
                ImageConverterState.sourceImage = img;
                ImageConverterState.sourceImage.name = file.name;
                ImageConverterState.sourceWidth = img.width;
                ImageConverterState.sourceHeight = img.height;

                // Convert to grayscale on canvas
                createGrayscaleSource(img);

                // Reset transform
                resetTransform();

                resolve({ width: img.width, height: img.height, name: file.name });
            };
            img.onerror = () => reject(new Error('Failed to load image'));
            img.src = e.target.result;
        };
        reader.onerror = () => reject(new Error('Failed to read file'));
        reader.readAsDataURL(file);
    });
}

/**
 * Create grayscale version of source image
 * @param {HTMLImageElement} img - Source image
 */
function createGrayscaleSource(img) {
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;

    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);

    // Convert to grayscale using luminance formula
    const imageData = ctx.getImageData(0, 0, img.width, img.height);
    const data = imageData.data;

    for (let i = 0; i < data.length; i += 4) {
        // Luminance: 0.299*R + 0.587*G + 0.114*B
        const gray = Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
        data[i] = gray;
        data[i + 1] = gray;
        data[i + 2] = gray;
        // Alpha unchanged
    }

    ctx.putImageData(imageData, 0, 0);
    ImageConverterState.sourceCanvas = canvas;
}

/**
 * Reset transform to default (centered, 100% scale, no rotation)
 */
export function resetTransform() {
    ImageConverterState.scale = 1.0;
    ImageConverterState.rotation = 0;
    ImageConverterState.panX = 0;
    ImageConverterState.panY = 0;
}

/**
 * Set arena dimensions from arena config
 * @param {number} pixelCols - Arena pixel columns
 * @param {number} pixelRows - Arena pixel rows
 */
export function setArenaDimensions(pixelCols, pixelRows) {
    ImageConverterState.arenaWidth = pixelCols;
    ImageConverterState.arenaHeight = pixelRows;
}

/**
 * Set transform parameters
 * @param {Object} transform - Transform parameters
 * @param {number} [transform.scale] - Scale factor
 * @param {number} [transform.rotation] - Rotation in degrees
 * @param {number} [transform.panX] - Pan X offset
 * @param {number} [transform.panY] - Pan Y offset
 */
export function setTransform(transform) {
    if (transform.scale !== undefined) {
        ImageConverterState.scale = Math.max(0.1, Math.min(5.0, transform.scale));
    }
    if (transform.rotation !== undefined) {
        ImageConverterState.rotation = transform.rotation;
    }
    if (transform.panX !== undefined) {
        ImageConverterState.panX = transform.panX;
    }
    if (transform.panY !== undefined) {
        ImageConverterState.panY = transform.panY;
    }
}

/**
 * Get current transform state
 * @returns {Object} Current transform parameters
 */
export function getTransform() {
    return {
        scale: ImageConverterState.scale,
        rotation: ImageConverterState.rotation,
        panX: ImageConverterState.panX,
        panY: ImageConverterState.panY
    };
}

/**
 * Calculate fit transform to fill image with arena rectangle
 * @returns {Object} Transform to fit arena in image
 */
export function calculateFitTransform() {
    if (!ImageConverterState.sourceCanvas) return { scale: 1.0, panX: 0, panY: 0, rotation: 0 };

    const { sourceWidth, sourceHeight, arenaWidth, arenaHeight } = ImageConverterState;

    // Calculate scale to fit arena in image (with some margin)
    const scaleX = sourceWidth / arenaWidth;
    const scaleY = sourceHeight / arenaHeight;
    const fitScale = Math.min(scaleX, scaleY) * 0.9; // 90% to leave margin

    return {
        scale: fitScale,
        rotation: 0,
        panX: 0,
        panY: 0
    };
}

/**
 * Render preview to canvas with arena overlay
 * @param {HTMLCanvasElement} canvas - Preview canvas
 * @param {boolean} [showOverlay=true] - Whether to show arena rectangle overlay
 */
export function renderPreview(canvas, showOverlay = true) {
    const ctx = canvas.getContext('2d');

    if (!ImageConverterState.sourceCanvas) {
        // Clear canvas and show placeholder
        ctx.fillStyle = '#1a1f26';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#8b949e';
        ctx.font = '14px IBM Plex Mono';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('Load an image to begin', canvas.width / 2, canvas.height / 2);
        return;
    }

    const {
        sourceCanvas,
        sourceWidth,
        sourceHeight,
        scale,
        rotation,
        panX,
        panY,
        arenaWidth,
        arenaHeight
    } = ImageConverterState;

    // Calculate display scaling to fit image in canvas
    const displayScale = Math.min(canvas.width / sourceWidth, canvas.height / sourceHeight) * 0.95;

    // Clear canvas
    ctx.fillStyle = '#0f1419';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Draw grayscale source image centered
    ctx.save();
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.scale(displayScale, displayScale);
    ctx.drawImage(sourceCanvas, -sourceWidth / 2, -sourceHeight / 2);
    ctx.restore();

    if (showOverlay) {
        // Draw arena rectangle overlay
        ctx.save();
        ctx.translate(canvas.width / 2, canvas.height / 2);
        ctx.scale(displayScale, displayScale);
        ctx.translate(panX, panY);
        ctx.rotate((rotation * Math.PI) / 180);
        ctx.scale(scale, scale);

        // Arena rectangle dimensions (centered at origin)
        const rectW = arenaWidth;
        const rectH = arenaHeight;

        // Draw semi-transparent fill
        ctx.fillStyle = 'rgba(255, 0, 0, 0.1)';
        ctx.fillRect(-rectW / 2, -rectH / 2, rectW, rectH);

        // Draw red outline
        ctx.strokeStyle = 'rgba(255, 0, 0, 0.8)';
        ctx.lineWidth = 2 / (displayScale * scale);
        ctx.strokeRect(-rectW / 2, -rectH / 2, rectW, rectH);

        // Draw crosshair at center
        const crossSize = 10 / scale;
        ctx.beginPath();
        ctx.moveTo(-crossSize, 0);
        ctx.lineTo(crossSize, 0);
        ctx.moveTo(0, -crossSize);
        ctx.lineTo(0, crossSize);
        ctx.stroke();

        ctx.restore();
    }
}

/**
 * Start drag operation
 * @param {number} x - Mouse X position on canvas
 * @param {number} y - Mouse Y position on canvas
 * @param {HTMLCanvasElement} canvas - Preview canvas
 */
export function startDrag(x, y, canvas) {
    if (!ImageConverterState.sourceCanvas) return;

    ImageConverterState.isDragging = true;
    ImageConverterState.dragStartX = x;
    ImageConverterState.dragStartY = y;
    ImageConverterState.dragStartPanX = ImageConverterState.panX;
    ImageConverterState.dragStartPanY = ImageConverterState.panY;
}

/**
 * Update drag operation
 * @param {number} x - Mouse X position on canvas
 * @param {number} y - Mouse Y position on canvas
 * @param {HTMLCanvasElement} canvas - Preview canvas
 * @returns {boolean} Whether pan changed
 */
export function updateDrag(x, y, canvas) {
    if (!ImageConverterState.isDragging || !ImageConverterState.sourceCanvas) return false;

    const { sourceWidth, sourceHeight } = ImageConverterState;

    // Calculate display scaling (same as in renderPreview)
    const displayScale = Math.min(canvas.width / sourceWidth, canvas.height / sourceHeight) * 0.95;

    // Calculate pan delta in source image coordinates
    const dx = (x - ImageConverterState.dragStartX) / displayScale;
    const dy = (y - ImageConverterState.dragStartY) / displayScale;

    ImageConverterState.panX = ImageConverterState.dragStartPanX + dx;
    ImageConverterState.panY = ImageConverterState.dragStartPanY + dy;

    return true;
}

/**
 * End drag operation
 */
export function endDrag() {
    ImageConverterState.isDragging = false;
}

/**
 * Check if currently dragging
 * @returns {boolean} Whether drag is in progress
 */
export function isDragging() {
    return ImageConverterState.isDragging;
}

/**
 * Extract arena region and convert to pattern frame
 * @param {Object} options - Conversion options
 * @param {number} options.gsMode - Grayscale mode (2 or 16)
 * @param {boolean} [options.invert=false] - Invert grayscale values
 * @returns {Uint8Array} Pattern frame data
 */
export function extractArenaRegion(options) {
    if (!ImageConverterState.sourceCanvas) {
        throw new Error('No image loaded');
    }

    const { gsMode, invert = false } = options;
    const {
        sourceCanvas,
        sourceWidth,
        sourceHeight,
        scale,
        rotation,
        panX,
        panY,
        arenaWidth,
        arenaHeight
    } = ImageConverterState;

    // Create temporary canvas for transformed extraction
    const extractCanvas = document.createElement('canvas');
    extractCanvas.width = arenaWidth;
    extractCanvas.height = arenaHeight;
    const ctx = extractCanvas.getContext('2d');

    // Fill with black (in case arena extends outside image)
    ctx.fillStyle = 'black';
    ctx.fillRect(0, 0, arenaWidth, arenaHeight);

    // Set up transform: we need to map arena pixels to source pixels
    // The arena rectangle is centered at (sourceWidth/2 + panX, sourceHeight/2 + panY),
    // rotated by rotation, scaled by scale
    // We need the inverse transform to sample the source

    ctx.save();

    // Transform to sample source at correct location
    // First translate to center of arena output
    ctx.translate(arenaWidth / 2, arenaHeight / 2);
    // Apply inverse scale
    ctx.scale(1 / scale, 1 / scale);
    // Apply inverse rotation
    ctx.rotate((-rotation * Math.PI) / 180);
    // Translate to source center with pan offset
    ctx.translate(-sourceWidth / 2 - panX, -sourceHeight / 2 - panY);

    // Draw source (this samples using our inverse transform)
    ctx.drawImage(sourceCanvas, 0, 0);

    ctx.restore();

    // Extract pixel data and quantize
    const imageData = ctx.getImageData(0, 0, arenaWidth, arenaHeight);
    const data = imageData.data;

    // Create pattern frame (arena rows * cols)
    const frame = new Uint8Array(arenaWidth * arenaHeight);

    // Note: Canvas Y=0 is top, but arena row 0 is bottom
    // So we flip vertically during extraction
    for (let row = 0; row < arenaHeight; row++) {
        for (let col = 0; col < arenaWidth; col++) {
            // Flip Y: arena row 0 = canvas row (arenaHeight - 1)
            const canvasRow = arenaHeight - 1 - row;
            const pixelIndex = (canvasRow * arenaWidth + col) * 4;
            let gray = data[pixelIndex]; // R channel (already grayscale)

            // Invert if requested
            if (invert) {
                gray = 255 - gray;
            }

            // Quantize based on gsMode
            let value;
            if (gsMode === 2) {
                // Binary: threshold at 128
                value = gray >= 128 ? 1 : 0;
            } else {
                // GS16: Map 0-255 to 0-15
                value = Math.round((gray * 15) / 255);
            }

            frame[row * arenaWidth + col] = value;
        }
    }

    return frame;
}

/**
 * Generate a pattern from the loaded image
 * @param {Object} options - Generation options
 * @param {number} options.gsMode - Grayscale mode (2 or 16)
 * @param {boolean} [options.invert=false] - Invert grayscale values
 * @param {Object} arena - Arena configuration
 * @returns {Object} Pattern data compatible with state.pattern format
 */
export function generatePattern(options, arena) {
    const frame = extractArenaRegion(options);

    const generation = arena.generation || arena.arena?.generation;

    return {
        generation,
        gsMode: options.gsMode,
        numFrames: 1,
        pixelRows: ImageConverterState.arenaHeight,
        pixelCols: ImageConverterState.arenaWidth,
        frames: [frame],
        stretchValues: [1]
    };
}

/**
 * Check if an image is loaded
 * @returns {boolean} Whether an image is loaded
 */
export function hasImage() {
    return ImageConverterState.sourceCanvas !== null;
}

/**
 * Get source image info
 * @returns {Object|null} Image info or null if no image
 */
export function getImageInfo() {
    if (!ImageConverterState.sourceImage) return null;
    return {
        width: ImageConverterState.sourceWidth,
        height: ImageConverterState.sourceHeight,
        name: ImageConverterState.sourceImage.name || 'image'
    };
}

/**
 * Clear loaded image
 */
export function clearImage() {
    ImageConverterState.sourceImage = null;
    ImageConverterState.sourceCanvas = null;
    ImageConverterState.sourceWidth = 0;
    ImageConverterState.sourceHeight = 0;
    resetTransform();
}

export default {
    loadImage,
    resetTransform,
    setArenaDimensions,
    setTransform,
    getTransform,
    calculateFitTransform,
    renderPreview,
    startDrag,
    updateDrag,
    endDrag,
    isDragging,
    extractArenaRegion,
    generatePattern,
    hasImage,
    getImageInfo,
    clearImage
};
