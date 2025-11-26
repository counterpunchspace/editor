// Glyph Canvas Editor
// Handles canvas-based glyph editing with pan/zoom and text rendering

class GlyphCanvas {
    constructor(containerId) {
        this.container = document.getElementById(containerId);
        if (!this.container) {
            console.error(`Container ${containerId} not found`);
            return;
        }

        // Canvas and context
        this.canvas = null;
        this.ctx = null;

        // Transformation state
        this.panX = 0;
        this.panY = 0;
        this.scale = 1.0;
        this.initialScale = 0.5; // Start zoomed out to see glyphs better

        // Text buffer and shaping
        this.textBuffer = localStorage.getItem('glyphCanvasTextBuffer') || "Hamburgevons";
        this.shapedGlyphs = [];
        this.currentFont = null;
        this.fontBlob = null;
        this.opentypeFont = null; // For glyph path extraction

        // HarfBuzz instance and objects
        this.hb = null;
        this.hbFont = null;
        this.hbFace = null;
        this.hbBlob = null;

        // Mouse interaction
        this.isDragging = false;
        this.lastMouseX = 0;
        this.lastMouseY = 0;

        // Resize observer
        this.resizeObserver = null;

        // HarfBuzz instance
        this.hb = null;
        this.hbFont = null;
        this.hbBlob = null;

        // Initialize
        this.init();
    }

    init() {
        // Create canvas element
        this.canvas = document.createElement('canvas');
        this.canvas.style.width = '100%';
        this.canvas.style.height = '100%';
        this.canvas.style.display = 'block';
        this.canvas.style.cursor = 'grab';
        this.container.appendChild(this.canvas);

        // Get context
        this.ctx = this.canvas.getContext('2d');

        // Set up HiDPI canvas
        this.setupHiDPI();

        // Set initial scale and position
        this.scale = this.initialScale;

        // Center the view
        const rect = this.canvas.getBoundingClientRect();
        this.panX = rect.width / 4;  // Start a bit to the left
        this.panY = rect.height / 2; // Center vertically

        // Set up event listeners
        this.setupEventListeners();

        // Initial render
        this.render();

        // Load HarfBuzz
        this.loadHarfBuzz();
    }

    setupHiDPI() {
        const dpr = window.devicePixelRatio || 1;
        
        // Get the container size (not the canvas bounding rect, which might be stale)
        const containerWidth = this.container.clientWidth;
        const containerHeight = this.container.clientHeight;

        // Set the canvas size in actual pixels (accounting for DPR)
        this.canvas.width = containerWidth * dpr;
        this.canvas.height = containerHeight * dpr;

        // Set CSS size to match container
        this.canvas.style.width = containerWidth + 'px';
        this.canvas.style.height = containerHeight + 'px';

        // Get context again and scale for DPR
        this.ctx = this.canvas.getContext('2d');
        this.ctx.scale(dpr, dpr);
    }

    setupEventListeners() {
        // Mouse events for panning
        this.canvas.addEventListener('mousedown', (e) => this.onMouseDown(e));
        this.canvas.addEventListener('mousemove', (e) => this.onMouseMove(e));
        this.canvas.addEventListener('mouseup', (e) => this.onMouseUp(e));
        this.canvas.addEventListener('mouseleave', (e) => this.onMouseUp(e));

        // Wheel event for zooming
        this.canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });

        // Window resize
        window.addEventListener('resize', () => this.onResize());

        // Container resize (for when view dividers are moved)
        this.resizeObserver = new ResizeObserver(() => this.onResize());
        this.resizeObserver.observe(this.container);
    }

    onMouseDown(e) {
        this.isDragging = true;
        this.lastMouseX = e.clientX;
        this.lastMouseY = e.clientY;
        this.canvas.style.cursor = 'grabbing';
    }

    onMouseMove(e) {
        if (!this.isDragging) return;

        const dx = e.clientX - this.lastMouseX;
        const dy = e.clientY - this.lastMouseY;

        this.panX += dx;
        this.panY += dy;

        this.lastMouseX = e.clientX;
        this.lastMouseY = e.clientY;

        this.render();
    }

    onMouseUp(e) {
        this.isDragging = false;
        this.canvas.style.cursor = 'grab';
    }

    onWheel(e) {
        e.preventDefault();

        const rect = this.canvas.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        // Calculate zoom
        const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
        const newScale = this.scale * zoomFactor;

        // Limit zoom range
        if (newScale < 0.01 || newScale > 100) return;

        // Adjust pan to zoom toward mouse position
        this.panX = mouseX - (mouseX - this.panX) * zoomFactor;
        this.panY = mouseY - (mouseY - this.panY) * zoomFactor;

        this.scale = newScale;
        this.render();
    }

    onResize() {
        this.setupHiDPI();
        this.render();
    }

    getTransformMatrix() {
        // Return a transformation matrix for converting font coordinates to canvas coordinates
        return {
            a: this.scale,
            b: 0,
            c: 0,
            d: -this.scale, // Flip Y axis (font coordinates have Y going up)
            e: this.panX,
            f: this.panY
        };
    }

    async loadHarfBuzz() {
        try {
            // Wait for createHarfBuzz to be available
            if (typeof createHarfBuzz === 'undefined') {
                console.log('Waiting for HarfBuzz to load...');
                await new Promise((resolve, reject) => {
                    let attempts = 0;
                    const check = () => {
                        if (typeof createHarfBuzz !== 'undefined') {
                            resolve();
                        } else if (attempts < 100) {
                            attempts++;
                            setTimeout(check, 100);
                        } else {
                            reject(new Error('HarfBuzz did not load'));
                        }
                    };
                    check();
                });
            }

            // Initialize HarfBuzz
            console.log('Initializing HarfBuzz WASM...');
            const hbModule = await createHarfBuzz();
            this.hb = hbjs(hbModule);
            console.log('HarfBuzz initialized successfully');

            // If we have a font loaded, shape it
            if (this.fontBlob) {
                this.shapeText();
            }
        } catch (error) {
            console.error('Error loading HarfBuzz:', error);
            console.log('Text shaping will not be available. Glyphs will be displayed as placeholder boxes.');
        }
    }

    setFont(fontArrayBuffer) {
        if (!fontArrayBuffer) {
            console.error('No font data provided');
            return;
        }

        try {
            // Store font blob
            this.fontBlob = fontArrayBuffer;

            // Parse with opentype.js for glyph path extraction
            if (window.opentype) {
                this.opentypeFont = opentype.parse(fontArrayBuffer);
                console.log('Font parsed with opentype.js:', this.opentypeFont.names.fontFamily.en);
            }

            // Clean up old HarfBuzz font
            if (this.hbFont) {
                this.hbFont.destroy();
                this.hbFont = null;
            }
            if (this.hbFace) {
                this.hbFace.destroy();
                this.hbFace = null;
            }
            if (this.hbBlob) {
                this.hbBlob.destroy();
                this.hbBlob = null;
            }

            // Create HarfBuzz blob, face, and font if HarfBuzz is loaded
            if (this.hb) {
                const uint8Array = new Uint8Array(fontArrayBuffer);
                this.hbBlob = this.hb.createBlob(uint8Array);
                this.hbFace = this.hb.createFace(this.hbBlob, 0); // 0 = first face
                this.hbFont = this.hb.createFont(this.hbFace);

                console.log('Font loaded into HarfBuzz');

                // Shape text with new font
                this.shapeText();
            }
        } catch (error) {
            console.error('Error setting font:', error);
        }
    }

    setTextBuffer(text) {
        this.textBuffer = text || "";
        
        // Save to localStorage
        try {
            localStorage.setItem('glyphCanvasTextBuffer', this.textBuffer);
        } catch (e) {
            console.warn('Failed to save text buffer to localStorage:', e);
        }
        
        this.shapeText();
    }

    shapeText() {
        if (!this.hb || !this.hbFont || !this.textBuffer) {
            this.shapedGlyphs = [];
            this.render();
            return;
        }

        try {
            // Create HarfBuzz buffer
            const buffer = this.hb.createBuffer();
            buffer.addText(this.textBuffer);
            buffer.guessSegmentProperties();

            // Shape the text
            this.hb.shape(this.hbFont, buffer);

            // Get glyph information
            const result = buffer.json();

            // Clean up
            buffer.destroy();

            // Store shaped glyphs
            this.shapedGlyphs = result;

            console.log('Shaped glyphs:', this.shapedGlyphs);

            // Render the result
            this.render();
        } catch (error) {
            console.error('Error shaping text:', error);
            this.shapedGlyphs = [];
            this.render();
        }
    }

    render() {
        if (!this.ctx || !this.canvas) return;

        const rect = this.canvas.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;

        // Clear canvas
        this.ctx.save();
        this.ctx.setTransform(1, 0, 0, 1, 0, 0);
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

        // Fill background (white or dark based on theme)
        const isDarkTheme = document.documentElement.getAttribute('data-theme') !== 'light';
        this.ctx.fillStyle = isDarkTheme ? '#1e1e1e' : '#ffffff';
        this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
        this.ctx.restore();

        // Apply transformation
        const transform = this.getTransformMatrix();
        this.ctx.save();
        this.ctx.transform(transform.a, transform.b, transform.c, transform.d, transform.e, transform.f);

        // Draw coordinate system (optional, for debugging)
        this.drawCoordinateSystem();

        // Draw baseline
        this.drawBaseline();

        // Draw shaped glyphs
        this.drawShapedGlyphs();

        this.ctx.restore();

        // Draw UI overlay (zoom level, etc.)
        this.drawUIOverlay();
    }

    drawCoordinateSystem() {
        const rect = this.canvas.getBoundingClientRect();
        const invScale = 1 / this.scale;

        this.ctx.strokeStyle = 'rgba(255, 255, 0, 0.3)';
        this.ctx.lineWidth = 1 * invScale;

        // Draw X axis
        this.ctx.beginPath();
        this.ctx.moveTo(-10000, 0);
        this.ctx.lineTo(10000, 0);
        this.ctx.stroke();

        // Draw Y axis
        this.ctx.beginPath();
        this.ctx.moveTo(0, -10000);
        this.ctx.lineTo(0, 10000);
        this.ctx.stroke();
    }

    drawBaseline() {
        if (!this.shapedGlyphs || this.shapedGlyphs.length === 0) return;

        const invScale = 1 / this.scale;

        // Calculate total advance width
        let totalAdvance = 0;
        for (const glyph of this.shapedGlyphs) {
            totalAdvance += (glyph.ax || 0);
        }

        this.ctx.strokeStyle = 'rgba(0, 255, 255, 0.5)';
        this.ctx.lineWidth = 1 * invScale;

        this.ctx.beginPath();
        this.ctx.moveTo(0, 0);
        this.ctx.lineTo(totalAdvance, 0);
        this.ctx.stroke();
    }

    drawShapedGlyphs() {
        if (!this.shapedGlyphs || this.shapedGlyphs.length === 0) {
            return;
        }

        if (!this.opentypeFont) {
            return;
        }

        const invScale = 1 / this.scale;
        let xPosition = 0;

        // Set font size for path extraction (in font units)
        const fontSize = 1000; // Use font units directly

        // Use black on white or white on black based on theme
        const isDarkTheme = document.documentElement.getAttribute('data-theme') !== 'light';
        this.ctx.fillStyle = isDarkTheme ? '#ffffff' : '#000000';

        for (const glyph of this.shapedGlyphs) {
            const glyphId = glyph.g;
            const xOffset = glyph.dx || 0;
            const yOffset = glyph.dy || 0;
            const xAdvance = glyph.ax || 0;
            const yAdvance = glyph.ay || 0;

            const x = xPosition + xOffset;
            const y = yOffset;

            // Get glyph from opentype.js
            const otGlyph = this.opentypeFont.glyphs.get(glyphId);

            if (otGlyph) {
                this.ctx.save();
                this.ctx.translate(x, y);

                // Get the glyph path
                const path = otGlyph.getPath(0, 0, fontSize);

                // Draw the path
                this.ctx.beginPath();

                // Convert opentype.js path commands to canvas commands
                for (const cmd of path.commands) {
                    switch (cmd.type) {
                        case 'M': // moveTo
                            this.ctx.moveTo(cmd.x, -cmd.y); // Flip Y
                            break;
                        case 'L': // lineTo
                            this.ctx.lineTo(cmd.x, -cmd.y);
                            break;
                        case 'Q': // quadratic curve
                            this.ctx.quadraticCurveTo(cmd.x1, -cmd.y1, cmd.x, -cmd.y);
                            break;
                        case 'C': // cubic curve
                            this.ctx.bezierCurveTo(cmd.x1, -cmd.y1, cmd.x2, -cmd.y2, cmd.x, -cmd.y);
                            break;
                        case 'Z': // closePath
                            this.ctx.closePath();
                            break;
                    }
                }

                this.ctx.fill();

                this.ctx.restore();
            } else {
                // Fallback: draw a placeholder box if glyph not found
                this.ctx.save();
                this.ctx.translate(x, y);

                const glyphWidth = xAdvance * 0.8;
                const glyphHeight = 700;

                const isDarkTheme = document.documentElement.getAttribute('data-theme') !== 'light';
                this.ctx.fillStyle = isDarkTheme ? 'rgba(255, 255, 255, 0.3)' : 'rgba(0, 0, 0, 0.3)';
                this.ctx.beginPath();
                this.ctx.rect(0, -glyphHeight, glyphWidth, glyphHeight);
                this.ctx.fill();

                this.ctx.restore();
            }

            xPosition += xAdvance;
        }
    }

    drawUIOverlay() {
        this.ctx.save();
        this.ctx.setTransform(1, 0, 0, 1, 0, 0);

        const rect = this.canvas.getBoundingClientRect();

        // Use contrasting color based on theme
        const isDarkTheme = document.documentElement.getAttribute('data-theme') !== 'light';
        this.ctx.fillStyle = isDarkTheme ? 'rgba(255, 255, 255, 0.7)' : 'rgba(0, 0, 0, 0.7)';
        this.ctx.font = '12px monospace';
        
        // Draw zoom level
        const zoomText = `Zoom: ${(this.scale * 100).toFixed(1)}%`;
        this.ctx.fillText(zoomText, 10, rect.height - 10);

        // Draw pan position
        const panText = `Pan: (${Math.round(this.panX)}, ${Math.round(this.panY)})`;
        this.ctx.fillText(panText, 10, rect.height - 25);

        // Draw text buffer info
        if (this.textBuffer) {
            const textInfo = `Text: "${this.textBuffer}" (${this.shapedGlyphs.length} glyphs)`;
            this.ctx.fillText(textInfo, 10, 20);
        }

        this.ctx.restore();
    }

    destroy() {
        // Disconnect resize observer
        if (this.resizeObserver) {
            this.resizeObserver.disconnect();
            this.resizeObserver = null;
        }

        // Clean up HarfBuzz resources
        if (this.hbFont) {
            this.hbFont.destroy();
            this.hbFont = null;
        }
        if (this.hbFace) {
            this.hbFace.destroy();
            this.hbFace = null;
        }
        if (this.hbBlob) {
            this.hbBlob.destroy();
            this.hbBlob = null;
        }

        // Remove canvas
        if (this.canvas && this.canvas.parentNode) {
            this.canvas.parentNode.removeChild(this.canvas);
        }
    }
}

// Initialize when document is ready
document.addEventListener('DOMContentLoaded', () => {
    // Wait for the editor view to be ready
    const initCanvas = () => {
        const editorContent = document.querySelector('#view-editor .view-content');
        if (editorContent) {
            // Create canvas container
            const canvasContainer = document.createElement('div');
            canvasContainer.id = 'glyph-canvas-container';
            canvasContainer.style.width = '100%';
            canvasContainer.style.height = '100%';
            canvasContainer.style.position = 'relative';
            editorContent.appendChild(canvasContainer);

            // Create text input
            const textInputContainer = document.createElement('div');
            textInputContainer.style.position = 'absolute';
            textInputContainer.style.top = '10px';
            textInputContainer.style.right = '10px';
            textInputContainer.style.zIndex = '100';
            textInputContainer.style.backgroundColor = 'var(--bg-secondary)';
            textInputContainer.style.border = '1px solid var(--border-primary)';
            textInputContainer.style.borderRadius = '4px';
            textInputContainer.style.padding = '8px';

            const textInput = document.createElement('input');
            textInput.type = 'text';
            textInput.id = 'glyph-text-input';
            textInput.placeholder = 'Enter text to render...';
            textInput.style.width = '300px';
            textInput.style.padding = '6px';
            textInput.style.border = '1px solid var(--border-secondary)';
            textInput.style.borderRadius = '3px';
            textInput.style.backgroundColor = 'var(--input-bg)';
            textInput.style.color = 'var(--text-primary)';
            textInput.style.fontFamily = 'var(--font-mono)';
            textInput.style.fontSize = '14px';

            textInputContainer.appendChild(textInput);
            editorContent.appendChild(textInputContainer);

            // Initialize canvas
            window.glyphCanvas = new GlyphCanvas('glyph-canvas-container');
            
            // Set input value from canvas's textBuffer (which loads from localStorage)
            textInput.value = window.glyphCanvas.textBuffer;

            // Connect text input to canvas
            textInput.addEventListener('input', (e) => {
                if (window.glyphCanvas) {
                    window.glyphCanvas.setTextBuffer(e.target.value);
                }
            });

            // Listen for font compilation events
            setupFontLoadingListener();

            console.log('Glyph canvas initialized');
        } else {
            setTimeout(initCanvas, 100);
        }
    };

    initCanvas();
});

// Set up listener for compiled fonts
function setupFontLoadingListener() {
    // Custom event when font is compiled
    window.addEventListener('fontCompiled', async (e) => {
        console.log('Font compiled event received');
        if (window.glyphCanvas && e.detail && e.detail.ttfBytes) {
            const arrayBuffer = e.detail.ttfBytes.buffer.slice(
                e.detail.ttfBytes.byteOffset,
                e.detail.ttfBytes.byteOffset + e.detail.ttfBytes.byteLength
            );
            window.glyphCanvas.setFont(arrayBuffer);
        }
    });

    // Also check for fonts loaded from file system
    window.addEventListener('fontLoaded', async (e) => {
        console.log('Font loaded event received');
        if (window.glyphCanvas && window.pyodide) {
            try {
                // Try to find a compiled TTF in the file system
                const result = await window.pyodide.runPythonAsync(`
import os
import glob

# Look for TTF files in the current directory and subdirectories
ttf_files = []
for root, dirs, files in os.walk('.'):
    for file in files:
        if file.endswith('.ttf'):
            ttf_files.append(os.path.join(root, file))

# Use the most recently modified TTF
if ttf_files:
    ttf_files.sort(key=lambda x: os.path.getmtime(x), reverse=True)
    ttf_files[0]
else:
    None
                `);

                if (result) {
                    console.log('Found TTF file:', result);
                    const fontBytes = window.pyodide.FS.readFile(result);
                    const arrayBuffer = fontBytes.buffer.slice(
                        fontBytes.byteOffset,
                        fontBytes.byteOffset + fontBytes.byteLength
                    );
                    window.glyphCanvas.setFont(arrayBuffer);
                }
            } catch (error) {
                console.error('Error loading font from file system:', error);
            }
        }
    });
}


// Export for module use
if (typeof module !== 'undefined' && module.exports) {
    module.exports = GlyphCanvas;
}
