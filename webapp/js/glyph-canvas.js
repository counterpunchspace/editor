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
        this.variationSettings = {}; // Store variable axis values
        this.sourceGlyphNames = {}; // Map of GID to glyph names from source font

        // Bidirectional text support
        this.bidi = null; // Will be initialized with UnicodeBidi instance
        this.bidiRuns = []; // Store bidirectional runs for rendering

        // Cursor state
        this.cursorPosition = 0; // Logical position in textBuffer (0 = before first char)
        this.cursorVisible = true;
        this.cursorBlinkInterval = null;
        this.cursorX = 0; // Visual X position for rendering
        this.clusterMap = []; // Maps logical char positions to visual glyph info
        this.embeddingLevels = null; // BiDi embedding levels for cursor logic

        // Selection state
        this.selectionStart = null; // Start of selection (null = no selection)
        this.selectionEnd = null;   // End of selection

        // Animation state
        this.animationFrames = parseInt(localStorage.getItem('animationFrames') || '10', 10);
        this.isAnimating = false;
        this.animationStartValues = {};
        this.animationTargetValues = {};
        this.animationCurrentFrame = 0;

        // Focus state for background color
        this.isFocused = false;

        // Mouse interaction
        this.mouseX = 0;
        this.mouseY = 0;
        this.hoveredGlyphIndex = -1; // Index of glyph being hovered
        this.glyphBounds = []; // Store bounding boxes for hit testing

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
        this.canvas.style.cursor = 'default';
        this.canvas.style.outline = 'none'; // Remove focus outline
        this.canvas.tabIndex = 0; // Make canvas focusable
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

        // Initialize BiDi support
        if (typeof bidi_js !== 'undefined') {
            this.bidi = bidi_js(); // It's a factory function
            console.log('bidi-js support initialized', this.bidi);
        } else {
            console.warn('bidi-js not loaded - bidirectional text may not render correctly');
        }

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

        // Mouse move for hover detection
        this.canvas.addEventListener('mousemove', (e) => this.onMouseMoveHover(e));

        // Keyboard events for cursor and text input
        this.canvas.addEventListener('keydown', (e) => this.onKeyDown(e));

        // Focus/blur for cursor blinking
        this.canvas.addEventListener('focus', () => this.onFocus());
        this.canvas.addEventListener('blur', () => this.onBlur());

        // Window resize
        window.addEventListener('resize', () => this.onResize());

        // Container resize (for when view dividers are moved)
        this.resizeObserver = new ResizeObserver(() => this.onResize());
        this.resizeObserver.observe(this.container);
    }

    onMouseDown(e) {
        // Focus the canvas when clicked
        this.canvas.focus();

        // Check if clicking on text to position cursor
        if (!e.shiftKey && !e.ctrlKey && !e.metaKey) {
            const clickedPos = this.getClickedCursorPosition(e);
            if (clickedPos !== null) {
                this.clearSelection();
                this.cursorPosition = clickedPos;
                this.updateCursorVisualPosition();
                this.render();
                // Keep text cursor
                this.canvas.style.cursor = 'text';
                return; // Don't start dragging if clicking on text
            }
        }

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
        // Update cursor based on current mouse position
        this.updateCursorStyle(e);
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

    onMouseMoveHover(e) {
        if (this.isDragging) return; // Don't detect hover while dragging

        const rect = this.canvas.getBoundingClientRect();
        // Store both canvas and client coordinates
        this.mouseX = e.clientX - rect.left;
        this.mouseY = e.clientY - rect.top;
        // Scale for HiDPI
        this.mouseCanvasX = this.mouseX * this.canvas.width / rect.width;
        this.mouseCanvasY = this.mouseY * this.canvas.height / rect.height;

        // Update cursor style based on position
        this.updateCursorStyle(e);

        // Check which glyph is being hovered
        this.updateHoveredGlyph();
    }

    updateCursorStyle(e) {
        // Update cursor style based on mouse position
        const rect = this.canvas.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        // Transform mouse coordinates to glyph space to check if over text area
        const transform = this.getTransformMatrix();
        const det = transform.a * transform.d - transform.b * transform.c;
        const glyphX = (transform.d * (mouseX - transform.e) - transform.c * (mouseY - transform.f)) / det;
        const glyphY = (transform.a * (mouseY - transform.f) - transform.b * (mouseX - transform.e)) / det;

        // Check if hovering within cursor height range (same as click detection)
        if (glyphY <= 1000 && glyphY >= -300) {
            this.canvas.style.cursor = 'text';
        } else {
            this.canvas.style.cursor = 'grab';
        }
    }

    updateHoveredGlyph() {
        // Use HiDPI-scaled mouse coordinates for hit testing
        const mouseX = this.mouseCanvasX || this.mouseX;
        const mouseY = this.mouseCanvasY || this.mouseY;

        // Transform mouse coordinates to glyph space
        const transform = this.getTransformMatrix();

        // Inverse transform to get glyph-space coordinates
        const det = transform.a * transform.d - transform.b * transform.c;
        const glyphX = (transform.d * (mouseX - transform.e) - transform.c * (mouseY - transform.f)) / det;
        const glyphY = (transform.a * (mouseY - transform.f) - transform.b * (mouseX - transform.e)) / det;

        let foundIndex = -1;

        // Check each glyph using path hit testing
        let xPosition = 0;
        for (let i = 0; i < this.shapedGlyphs.length; i++) {
            const glyph = this.shapedGlyphs[i];
            const glyphId = glyph.g;
            const xOffset = glyph.dx || 0;
            const yOffset = glyph.dy || 0;
            const xAdvance = glyph.ax || 0;

            const x = xPosition + xOffset;
            const y = yOffset;

            // Check if point is within this glyph's path
            try {
                const glyphData = this.hbFont.glyphToPath(glyphId);
                if (glyphData) {
                    const path = new Path2D(glyphData);

                    // Create a temporary context for hit testing with proper transform
                    this.ctx.save();

                    // Apply the same transform as rendering
                    this.ctx.setTransform(transform.a, transform.b, transform.c, transform.d, transform.e, transform.f);
                    this.ctx.translate(x, y);

                    // Test if mouse point is in path (in canvas coordinates)
                    if (this.ctx.isPointInPath(path, this.mouseX, this.mouseY)) {
                        foundIndex = i;
                        this.ctx.restore();
                        break;
                    }

                    this.ctx.restore();
                }
            } catch (error) {
                // Skip this glyph if path extraction fails
            }

            xPosition += xAdvance;
        }

        if (foundIndex !== this.hoveredGlyphIndex) {
            this.hoveredGlyphIndex = foundIndex;
            this.render();
        }
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
            // Store current variation settings to restore after font reload
            const previousVariationSettings = { ...this.variationSettings };

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

                // Restore previous variation settings before updating UI
                // This ensures the sliders show the previous values
                this.variationSettings = previousVariationSettings;

                // Update axes UI (will restore slider positions from variationSettings)
                this.updateAxesUI();

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

    setVariation(axisTag, value) {
        const previousValue = this.variationSettings[axisTag] !== undefined
            ? this.variationSettings[axisTag]
            : this.getVariationAxes().find(a => a.tag === axisTag)?.defaultValue || 0;

        // Cancel any ongoing animation
        if (this.isAnimating) {
            this.isAnimating = false;
        }

        // Set up animation
        this.animationStartValues = { ...this.variationSettings };
        this.animationTargetValues = { ...this.variationSettings, [axisTag]: value };
        this.animationCurrentFrame = 0;
        this.isAnimating = true;

        // Start animation loop
        this.animateVariation();
    }

    animateVariation() {
        if (!this.isAnimating) return;

        this.animationCurrentFrame++;
        const progress = Math.min(this.animationCurrentFrame / this.animationFrames, 1.0);

        // Ease-out cubic for smoother animation
        const easedProgress = 1 - Math.pow(1 - progress, 3);

        // Interpolate all axes
        for (const axisTag in this.animationTargetValues) {
            const startValue = this.animationStartValues[axisTag] || this.animationTargetValues[axisTag];
            const targetValue = this.animationTargetValues[axisTag];
            this.variationSettings[axisTag] = startValue + (targetValue - startValue) * easedProgress;
        }

        this.shapeText();

        if (progress < 1.0) {
            requestAnimationFrame(() => this.animateVariation());
        } else {
            // Ensure we end exactly at target values
            this.variationSettings = { ...this.animationTargetValues };
            this.isAnimating = false;
            this.shapeText();
        }
    }

    getVariationAxes() {
        if (!this.opentypeFont || !this.opentypeFont.tables.fvar) {
            return [];
        }
        return this.opentypeFont.tables.fvar.axes || [];
    }

    updateAxesUI() {
        if (!this.axesSection) return;

        // Clear existing axes
        this.axesSection.innerHTML = '';

        const axes = this.getVariationAxes();

        if (axes.length === 0) {
            return; // No variable axes
        }

        // Add section title
        const title = document.createElement('div');
        title.textContent = 'Variable Axes';
        title.style.fontSize = '12px';
        title.style.fontWeight = '600';
        title.style.color = 'var(--text-secondary)';
        title.style.textTransform = 'uppercase';
        title.style.letterSpacing = '0.5px';
        title.style.marginTop = '8px';
        this.axesSection.appendChild(title);

        // Create slider for each axis
        axes.forEach(axis => {
            const axisContainer = document.createElement('div');
            axisContainer.style.display = 'flex';
            axisContainer.style.flexDirection = 'column';
            axisContainer.style.gap = '4px';

            // Label row (axis name and value)
            const labelRow = document.createElement('div');
            labelRow.style.display = 'flex';
            labelRow.style.justifyContent = 'space-between';
            labelRow.style.alignItems = 'center';
            labelRow.style.fontSize = '13px';

            const axisLabel = document.createElement('span');
            axisLabel.textContent = axis.name.en || axis.tag;
            axisLabel.style.color = 'var(--text-primary)';
            axisLabel.style.fontWeight = '500';

            const valueLabel = document.createElement('span');
            valueLabel.style.color = 'var(--text-secondary)';
            valueLabel.style.fontFamily = 'var(--font-mono)';
            valueLabel.style.fontSize = '12px';
            valueLabel.textContent = axis.defaultValue.toFixed(0);

            labelRow.appendChild(axisLabel);
            labelRow.appendChild(valueLabel);

            // Slider
            const slider = document.createElement('input');
            slider.type = 'range';
            slider.min = axis.minValue;
            slider.max = axis.maxValue;
            slider.step = 1;
            slider.style.width = '100%';

            // Restore previous value if it exists, otherwise use default
            const initialValue = this.variationSettings[axis.tag] !== undefined
                ? this.variationSettings[axis.tag]
                : axis.defaultValue;

            slider.value = initialValue;
            valueLabel.textContent = initialValue.toFixed(0);

            // Initialize variation setting
            this.variationSettings[axis.tag] = initialValue;

            // Update on change
            slider.addEventListener('input', (e) => {
                const value = parseFloat(e.target.value);
                valueLabel.textContent = value.toFixed(0);
                this.setVariation(axis.tag, value);
            });

            axisContainer.appendChild(labelRow);
            axisContainer.appendChild(slider);
            this.axesSection.appendChild(axisContainer);
        });

        console.log(`Created ${axes.length} variable axis sliders`);
    }

    shapeText() {
        if (!this.hb || !this.hbFont || !this.textBuffer) {
            this.shapedGlyphs = [];
            this.bidiRuns = [];
            this.render();
            return;
        }

        try {
            // Apply variation settings if any
            if (Object.keys(this.variationSettings).length > 0) {
                this.hbFont.setVariations(this.variationSettings);
            }

            // Use BiDi algorithm if available, otherwise fallback to simple shaping
            if (this.bidi) {
                this.shapeTextWithBidi();
            } else {
                this.shapeTextSimple();
            }

            console.log('Shaped glyphs:', this.shapedGlyphs);
            if (this.bidiRuns.length > 0) {
                console.log('BiDi runs:', this.bidiRuns);
            }

            // Render the result
            this.render();
        } catch (error) {
            console.error('Error shaping text:', error);
            this.shapedGlyphs = [];
            this.bidiRuns = [];
            this.render();
        }
    }

    shapeTextSimple() {
        // Simple shaping without BiDi support (old behavior)
        const buffer = this.hb.createBuffer();
        buffer.addText(this.textBuffer);
        buffer.guessSegmentProperties();

        // Shape the text
        this.hb.shape(this.hbFont, buffer);

        // Get glyph information
        this.shapedGlyphs = buffer.json();
        this.bidiRuns = [];

        // Clean up
        buffer.destroy();

        // Build cluster map for cursor positioning
        this.buildClusterMap();
        this.updateCursorVisualPosition();
    }

    shapeTextWithBidi() {
        // Get embedding levels from bidi-js
        const embedLevels = this.bidi.getEmbeddingLevels(this.textBuffer);
        this.embeddingLevels = embedLevels; // Store for cursor logic
        console.log('Embedding levels:', embedLevels);

        // First, shape the text in LOGICAL order with proper direction per run
        // Split into runs by embedding level
        const runs = [];
        let currentLevel = embedLevels.levels[0];
        let runStart = 0;

        for (let i = 1; i <= this.textBuffer.length; i++) {
            if (i === this.textBuffer.length || embedLevels.levels[i] !== currentLevel) {
                const runText = this.textBuffer.substring(runStart, i);
                const direction = currentLevel % 2 === 0 ? 'ltr' : 'rtl';
                runs.push({
                    text: runText,
                    level: currentLevel,
                    direction: direction,
                    start: runStart,
                    end: i
                });
                if (i < this.textBuffer.length) {
                    currentLevel = embedLevels.levels[i];
                    runStart = i;
                }
            }
        }

        console.log('Logical runs:', runs.map(r => `${r.direction}:${r.level}:"${r.text}"`));

        // Shape each run with HarfBuzz in its logical direction
        const shapedRuns = [];
        for (const run of runs) {
            const buffer = this.hb.createBuffer();
            buffer.addText(run.text);
            buffer.setDirection(run.direction);
            buffer.guessSegmentProperties();

            this.hb.shape(this.hbFont, buffer);
            const glyphs = buffer.json();
            buffer.destroy();

            // Adjust cluster values to be relative to the full string, not the run
            for (const glyph of glyphs) {
                glyph.cl = (glyph.cl || 0) + run.start;
            }

            shapedRuns.push({
                ...run,
                glyphs: glyphs
            });
        }

        // Now reorder the runs using bidi-js
        const reorderedIndices = this.bidi.getReorderedIndices(this.textBuffer, embedLevels);

        // Map character indices to runs
        const charToRun = [];
        for (let i = 0; i < shapedRuns.length; i++) {
            for (let j = shapedRuns[i].start; j < shapedRuns[i].end; j++) {
                charToRun[j] = i;
            }
        }

        // Build visual glyph order by following reordered indices
        const allGlyphs = [];
        let lastRunIdx = -1;
        let runGlyphOffset = 0;

        for (const charIdx of reorderedIndices) {
            const runIdx = charToRun[charIdx];
            if (runIdx !== lastRunIdx) {
                // Switched to a different run - add all its glyphs
                const run = shapedRuns[runIdx];
                allGlyphs.push(...run.glyphs);
                lastRunIdx = runIdx;
            }
        }

        this.shapedGlyphs = allGlyphs;
        this.bidiRuns = shapedRuns;

        // Build cluster map for cursor positioning
        this.buildClusterMap();
        this.updateCursorVisualPosition();

        console.log('Final shaped glyphs:', this.shapedGlyphs.length);
    }

    render() {
        if (!this.ctx || !this.canvas) return;

        const rect = this.canvas.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;

        // Clear canvas
        this.ctx.save();
        this.ctx.setTransform(1, 0, 0, 1, 0, 0);
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

        // Fill background (different color based on focus state)
        // Get computed CSS variable values
        const computedStyle = getComputedStyle(document.documentElement);

        // Check if the editor view has the 'focused' class
        const editorView = document.querySelector('#view-editor');
        const isViewFocused = editorView && editorView.classList.contains('focused');

        if (isViewFocused) {
            // Active/focused background (same as .view.focused)
            this.ctx.fillStyle = computedStyle.getPropertyValue('--bg-active').trim();
        } else {
            // Inactive background (same as .view)
            this.ctx.fillStyle = computedStyle.getPropertyValue('--bg-secondary').trim();
        }
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

        // Draw selection highlight
        this.drawSelection();

        // Draw shaped glyphs
        this.drawShapedGlyphs();

        // Draw cursor
        this.drawCursor();

        // Draw glyph name tooltip (still in transformed space)
        this.drawGlyphTooltip();

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

        if (!this.hbFont) {
            return;
        }

        const invScale = 1 / this.scale;
        let xPosition = 0;

        // Clear glyph bounds for hit testing
        this.glyphBounds = [];

        // Use black on white or white on black based on theme
        const isDarkTheme = document.documentElement.getAttribute('data-theme') !== 'light';
        const normalColor = isDarkTheme ? '#ffffff' : '#000000';
        const hoverColor = '#ff00ff'; // Magenta for hover

        this.shapedGlyphs.forEach((glyph, glyphIndex) => {
            const glyphId = glyph.g;
            const xOffset = glyph.dx || 0;
            const yOffset = glyph.dy || 0;
            const xAdvance = glyph.ax || 0;
            const yAdvance = glyph.ay || 0;

            const x = xPosition + xOffset;
            const y = yOffset;

            // Store bounds for hit testing (approximate with advance width)
            this.glyphBounds.push({
                x: x,
                y: y,
                width: xAdvance,
                height: 1000 // Font units height approximation
            });

            // Set color based on hover state
            const isHovered = glyphIndex === this.hoveredGlyphIndex;
            this.ctx.fillStyle = isHovered ? hoverColor : normalColor;

            try {
                // Get glyph outline from HarfBuzz (supports variations)
                const glyphData = this.hbFont.glyphToPath(glyphId);

                if (glyphData) {
                    this.ctx.save();
                    this.ctx.translate(x, y);

                    // Draw the path from HarfBuzz data
                    // No need to flip Y here - the main transform matrix already flips Y
                    this.ctx.beginPath();

                    // Parse the SVG path data
                    const path = new Path2D(glyphData);

                    this.ctx.fill(path);

                    this.ctx.restore();
                }
            } catch (error) {
                // Fallback to OpenType.js if HarfBuzz glyph drawing fails
                if (this.opentypeFont) {
                    const otGlyph = this.opentypeFont.glyphs.get(glyphId);

                    if (otGlyph) {
                        this.ctx.save();
                        this.ctx.translate(x, y);

                        const path = otGlyph.getPath(0, 0, 1000);
                        this.ctx.beginPath();

                        for (const cmd of path.commands) {
                            switch (cmd.type) {
                                case 'M':
                                    this.ctx.moveTo(cmd.x, -cmd.y);
                                    break;
                                case 'L':
                                    this.ctx.lineTo(cmd.x, -cmd.y);
                                    break;
                                case 'Q':
                                    this.ctx.quadraticCurveTo(cmd.x1, -cmd.y1, cmd.x, -cmd.y);
                                    break;
                                case 'C':
                                    this.ctx.bezierCurveTo(cmd.x1, -cmd.y1, cmd.x2, -cmd.y2, cmd.x, -cmd.y);
                                    break;
                                case 'Z':
                                    this.ctx.closePath();
                                    break;
                            }
                        }

                        this.ctx.fill();
                        this.ctx.restore();
                    }
                }
            }

            xPosition += xAdvance;
        });
    }

    drawGlyphTooltip() {
        // Draw glyph name tooltip on hover (in font coordinate space)
        if (this.hoveredGlyphIndex >= 0 && this.hoveredGlyphIndex < this.shapedGlyphs.length) {
            const glyphId = this.shapedGlyphs[this.hoveredGlyphIndex].g;
            let glyphName = `GID ${glyphId}`;

            // Get glyph name from compiled font via OpenType.js
            if (this.opentypeFont && this.opentypeFont.glyphs.get(glyphId)) {
                const glyph = this.opentypeFont.glyphs.get(glyphId);
                if (glyph.name) {
                    glyphName = glyph.name;
                }
            }

            // Get glyph position and advance from shaped data
            const shapedGlyph = this.shapedGlyphs[this.hoveredGlyphIndex];
            const glyphBounds = this.glyphBounds[this.hoveredGlyphIndex];
            const glyphWidth = shapedGlyph.ax || 0;
            const glyphYOffset = shapedGlyph.dy || 0; // Y offset from HarfBuzz shaping

            // Get glyph bounding box to find bottom edge
            let glyphYMin = 0;
            if (this.opentypeFont && this.opentypeFont.glyphs.get(glyphId)) {
                const glyph = this.opentypeFont.glyphs.get(glyphId);
                const bbox = glyph.getBoundingBox();
                glyphYMin = bbox.y1; // y1 is the minimum Y (bottom edge)
            }

            // Position tooltip centered under the glyph
            // In font coordinates: Y increases upward, so negative Y is below baseline
            // Note: glyphBounds.x already includes dx offset from HarfBuzz
            const tooltipX = glyphBounds.x + (glyphWidth / 2);
            const tooltipY = glyphYOffset + glyphYMin - 100; // 100 units below bottom of bounding box, including HB Y offset

            const invScale = 1 / this.scale;
            const isDarkTheme = document.documentElement.getAttribute('data-theme') !== 'light';

            // Save context to flip text right-side up
            this.ctx.save();
            this.ctx.translate(tooltipX, tooltipY);
            this.ctx.scale(1, -1); // Flip Y to make text right-side up

            // Font size and metrics (scaled to remain constant regardless of zoom)
            const fontSize = 16 * invScale;
            this.ctx.font = `${fontSize}px IBM Plex Mono`;
            const metrics = this.ctx.measureText(glyphName);
            const padding = 10 * invScale;
            const bgWidth = metrics.width + padding * 2;
            const bgHeight = fontSize * 1.8;

            // Center horizontally around origin
            const bgX = -bgWidth / 2;
            const bgY = 0; // Top of box at origin

            // Draw background
            this.ctx.fillStyle = isDarkTheme ? 'rgba(40, 40, 40, 0.95)' : 'rgba(255, 255, 255, 0.95)';
            this.ctx.fillRect(bgX, bgY, bgWidth, bgHeight);

            // Draw border
            this.ctx.strokeStyle = isDarkTheme ? 'rgba(255, 255, 255, 0.3)' : 'rgba(0, 0, 0, 0.3)';
            this.ctx.lineWidth = 2 * invScale;
            this.ctx.strokeRect(bgX, bgY, bgWidth, bgHeight);

            // Draw text
            this.ctx.fillStyle = isDarkTheme ? 'rgba(255, 255, 255, 0.9)' : 'rgba(0, 0, 0, 0.9)';
            this.ctx.fillText(glyphName, bgX + padding, bgY + fontSize * 0.85 + padding / 2 + 4);

            this.ctx.restore();
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

    // ==================== Cursor Methods ====================

    onFocus() {
        this.isFocused = true;
        this.cursorVisible = true;
        this.render();
    }

    onBlur() {
        this.isFocused = false;
        this.render();
    }

    onKeyDown(e) {
        // Handle cursor navigation and text editing

        // Cmd+A / Ctrl+A - Select All
        if ((e.metaKey || e.ctrlKey) && e.key === 'a') {
            e.preventDefault();
            this.selectAll();
            return;
        }
        
        // Cmd+C / Ctrl+C - Copy
        if ((e.metaKey || e.ctrlKey) && e.key === 'c') {
            e.preventDefault();
            this.copySelection();
            return;
        }
        
        // Cmd+X / Ctrl+X - Cut
        if ((e.metaKey || e.ctrlKey) && e.key === 'x') {
            e.preventDefault();
            this.cutSelection();
            return;
        }
        
        // Cmd+V / Ctrl+V - Paste
        if ((e.metaKey || e.ctrlKey) && e.key === 'v') {
            e.preventDefault();
            this.paste();
            return;
        }

        if (e.key === 'ArrowLeft') {
            e.preventDefault();
            if (e.shiftKey) {
                this.moveCursorLeftWithSelection();
            } else {
                this.clearSelection();
                this.moveCursorLeft();
            }
        } else if (e.key === 'ArrowRight') {
            e.preventDefault();
            if (e.shiftKey) {
                this.moveCursorRightWithSelection();
            } else {
                this.clearSelection();
                this.moveCursorRight();
            }
        } else if (e.key === 'Backspace') {
            e.preventDefault();
            this.deleteBackward();
        } else if (e.key === 'Delete') {
            e.preventDefault();
            this.deleteForward();
        } else if (e.key === 'Home') {
            e.preventDefault();
            if (e.shiftKey) {
                this.moveToStartWithSelection();
            } else {
                this.clearSelection();
                this.cursorPosition = 0;
                this.updateCursorVisualPosition();
                this.render();
            }
        } else if (e.key === 'End') {
            e.preventDefault();
            if (e.shiftKey) {
                this.moveToEndWithSelection();
            } else {
                this.clearSelection();
                this.cursorPosition = this.textBuffer.length;
                this.updateCursorVisualPosition();
                this.render();
            }
        } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
            // Regular character input
            e.preventDefault();
            this.insertText(e.key);
        }
    }

    moveCursorLeft() {
        console.log('=== Move Cursor Left ===');
        this.logCursorState();

        // Left arrow = backward in logical order (decrease position)
        this.moveCursorLogicalBackward();
        this.render();
    }

    moveCursorRight() {
        console.log('=== Move Cursor Right ===');
        this.logCursorState();

        // Right arrow = forward in logical order (increase position)
        this.moveCursorLogicalForward();
        this.render();
    }

    moveCursorLogicalBackward() {
        if (this.cursorPosition > 0) {
            this.cursorPosition--;
            console.log('Moved to logical position:', this.cursorPosition);
            this.updateCursorVisualPosition();
        }
    }

    moveCursorLogicalForward() {
        if (this.cursorPosition < this.textBuffer.length) {
            this.cursorPosition++;
            console.log('Moved to logical position:', this.cursorPosition);
            this.updateCursorVisualPosition();
        }
    }

    isPositionRTL(pos) {
        // Check if a logical position is in an RTL context
        if (!this.embeddingLevels || !this.embeddingLevels.levels) {
            return false;
        }

        if (pos < 0 || pos >= this.embeddingLevels.levels.length) {
            return false;
        }

        // Odd levels are RTL
        return this.embeddingLevels.levels[pos] % 2 === 1;
    }

    getRunAtPosition(pos) {
        // Find which BiDi run contains this logical position
        if (!this.bidiRuns || this.bidiRuns.length === 0) {
            return null;
        }

        for (const run of this.bidiRuns) {
            if (pos >= run.start && pos < run.end) {
                console.log(`Position ${pos} is in ${run.direction} run [${run.start}-${run.end}]: "${run.text}"`);
                return run;
            }
        }

        // If at the very end, return the last run
        if (pos === this.textBuffer.length && this.bidiRuns.length > 0) {
            const lastRun = this.bidiRuns[this.bidiRuns.length - 1];
            console.log(`Position ${pos} is at end of ${lastRun.direction} run [${lastRun.start}-${lastRun.end}]: "${lastRun.text}"`);
            return lastRun;
        }

        console.log(`Position ${pos} is not in any run`);
        return null;
    }

    logCursorState() {
        console.log('=== Cursor State ===');
        console.log('Logical position:', this.cursorPosition);
        console.log('Visual X:', this.cursorX);
        console.log('Text buffer:', this.textBuffer);
        const run = this.getRunAtPosition(this.cursorPosition);
        if (run) {
            console.log('Current run:', run.direction, `[${run.start}-${run.end}]`, `"${run.text}"`);
        }
        console.log('==================');
    }

    // ==================== Selection Methods ====================

    clearSelection() {
        this.selectionStart = null;
        this.selectionEnd = null;
    }

    hasSelection() {
        return this.selectionStart !== null && this.selectionEnd !== null && this.selectionStart !== this.selectionEnd;
    }

    getSelectionRange() {
        if (!this.hasSelection()) {
            return { start: this.cursorPosition, end: this.cursorPosition };
        }
        return {
            start: Math.min(this.selectionStart, this.selectionEnd),
            end: Math.max(this.selectionStart, this.selectionEnd)
        };
    }

    selectAll() {
        this.selectionStart = 0;
        this.selectionEnd = this.textBuffer.length;
        this.cursorPosition = this.textBuffer.length;
        console.log('Selected all:', `"${this.textBuffer.slice(0, this.textBuffer.length)}"`, `[${this.selectionStart}-${this.selectionEnd}]`);
        this.updateCursorVisualPosition();
        this.render();
    }

    moveCursorLeftWithSelection() {
        // Start selection if none exists
        if (!this.hasSelection()) {
            this.selectionStart = this.cursorPosition;
        }

        // Move cursor
        this.moveCursorLogicalBackward();

        // Update selection end
        this.selectionEnd = this.cursorPosition;

        if (this.hasSelection()) {
            const range = this.getSelectionRange();
            console.log('Selection:', `"${this.textBuffer.slice(range.start, range.end)}"`, `[${range.start}-${range.end}]`);
        }

        this.render();
    }

    moveCursorRightWithSelection() {
        // Start selection if none exists
        if (!this.hasSelection()) {
            this.selectionStart = this.cursorPosition;
        }

        // Move cursor
        this.moveCursorLogicalForward();

        // Update selection end
        this.selectionEnd = this.cursorPosition;

        if (this.hasSelection()) {
            const range = this.getSelectionRange();
            console.log('Selection:', `"${this.textBuffer.slice(range.start, range.end)}"`, `[${range.start}-${range.end}]`);
        }

        this.render();
    }

    moveToStartWithSelection() {
        if (!this.hasSelection()) {
            this.selectionStart = this.cursorPosition;
        }
        this.cursorPosition = 0;
        this.selectionEnd = this.cursorPosition;
        const range = this.getSelectionRange();
        if (range.start !== range.end) {
            console.log('Selection:', `"${this.textBuffer.slice(range.start, range.end)}"`, `[${range.start}-${range.end}]`);
        }
        this.updateCursorVisualPosition();
        this.render();
    }

    moveToEndWithSelection() {
        if (!this.hasSelection()) {
            this.selectionStart = this.cursorPosition;
        }
        this.cursorPosition = this.textBuffer.length;
        this.selectionEnd = this.cursorPosition;
        const range = this.getSelectionRange();
        if (range.start !== range.end) {
            console.log('Selection:', `"${this.textBuffer.slice(range.start, range.end)}"`, `[${range.start}-${range.end}]`);
        }
        this.updateCursorVisualPosition();
        this.render();
    }
    
    // ==================== Clipboard Methods ====================
    
    async copySelection() {
        if (!this.hasSelection()) {
            return;
        }
        
        const range = this.getSelectionRange();
        const selectedText = this.textBuffer.slice(range.start, range.end);
        
        try {
            await navigator.clipboard.writeText(selectedText);
            console.log('Copied to clipboard:', `"${selectedText}"`);
        } catch (err) {
            console.error('Failed to copy to clipboard:', err);
        }
    }
    
    async cutSelection() {
        if (!this.hasSelection()) {
            return;
        }
        
        // Copy first
        await this.copySelection();
        
        // Then delete
        const range = this.getSelectionRange();
        console.log('Cutting selection:', `"${this.textBuffer.slice(range.start, range.end)}"`, `[${range.start}-${range.end}]`);
        this.textBuffer = this.textBuffer.slice(0, range.start) + this.textBuffer.slice(range.end);
        this.cursorPosition = range.start;
        this.clearSelection();
        
        console.log('New cursor position:', this.cursorPosition);
        console.log('New text:', this.textBuffer);
        
        // Save to localStorage
        localStorage.setItem('glyphCanvasTextBuffer', this.textBuffer);
        
        // Reshape and render
        this.shapeText();
        this.updateCursorVisualPosition();
        
        // If text is now empty, reset cursor to origin
        if (this.textBuffer.length === 0) {
            this.cursorPosition = 0;
            this.cursorX = 0;
        }
        
        this.render();
    }
    
    async paste() {
        try {
            const text = await navigator.clipboard.readText();
            console.log('Pasting from clipboard:', `"${text}"`);
            
            // insertText already handles replacing selection
            this.insertText(text);
        } catch (err) {
            console.error('Failed to paste from clipboard:', err);
        }
    }

    insertText(text) {
        // If there's a selection, delete it first
        if (this.hasSelection()) {
            const range = this.getSelectionRange();
            this.textBuffer = this.textBuffer.slice(0, range.start) + this.textBuffer.slice(range.end);
            this.cursorPosition = range.start;
            this.clearSelection();
        }

        // Insert text at cursor position
        this.textBuffer = this.textBuffer.slice(0, this.cursorPosition) +
            text +
            this.textBuffer.slice(this.cursorPosition);
        this.cursorPosition += text.length;

        // Save to localStorage
        localStorage.setItem('glyphCanvasTextBuffer', this.textBuffer);

        // Reshape and render
        this.shapeText();
        this.updateCursorVisualPosition();
        this.render();
    }

    deleteBackward() {
        console.log('=== Delete Backward (Backspace) ===');
        this.logCursorState();

        // If there's a selection, delete it
        if (this.hasSelection()) {
            const range = this.getSelectionRange();
            console.log('Deleting selection:', `"${this.textBuffer.slice(range.start, range.end)}"`, `[${range.start}-${range.end}]`);
            this.textBuffer = this.textBuffer.slice(0, range.start) + this.textBuffer.slice(range.end);
            this.cursorPosition = range.start;
            this.clearSelection();

            console.log('New cursor position:', this.cursorPosition);
            console.log('New text:', this.textBuffer);

            // Save to localStorage
            localStorage.setItem('glyphCanvasTextBuffer', this.textBuffer);

            // Reshape and render
            this.shapeText();
            this.updateCursorVisualPosition();

            // If text is now empty, reset cursor to origin
            if (this.textBuffer.length === 0) {
                this.cursorPosition = 0;
                this.cursorX = 0;
            }

            this.render();
        } else if (this.cursorPosition > 0) {
            // Backspace always deletes the character BEFORE cursor (position - 1)
            console.log('Deleting char at position', this.cursorPosition - 1, ':', this.textBuffer[this.cursorPosition - 1]);
            this.textBuffer = this.textBuffer.slice(0, this.cursorPosition - 1) +
                this.textBuffer.slice(this.cursorPosition);
            this.cursorPosition--;

            console.log('New cursor position:', this.cursorPosition);
            console.log('New text:', this.textBuffer);

            // Save to localStorage
            localStorage.setItem('glyphCanvasTextBuffer', this.textBuffer);

            // Reshape and render
            this.shapeText();
            this.updateCursorVisualPosition();

            // If text is now empty, reset cursor to origin
            if (this.textBuffer.length === 0) {
                this.cursorPosition = 0;
                this.cursorX = 0;
            }

            this.render();
        }
    }

    deleteForward() {
        console.log('=== Delete Forward (Delete key) ===');
        this.logCursorState();

        // If there's a selection, delete it
        if (this.hasSelection()) {
            const range = this.getSelectionRange();
            console.log('Deleting selection:', `"${this.textBuffer.slice(range.start, range.end)}"`, `[${range.start}-${range.end}]`);
            this.textBuffer = this.textBuffer.slice(0, range.start) + this.textBuffer.slice(range.end);
            this.cursorPosition = range.start;
            this.clearSelection();

            console.log('New cursor position:', this.cursorPosition);
            console.log('New text:', this.textBuffer);

            // Save to localStorage
            localStorage.setItem('glyphCanvasTextBuffer', this.textBuffer);

            // Reshape and render
            this.shapeText();
            this.updateCursorVisualPosition();

            // If text is now empty, reset cursor to origin
            if (this.textBuffer.length === 0) {
                this.cursorPosition = 0;
                this.cursorX = 0;
            }

            this.render();
        } else if (this.cursorPosition < this.textBuffer.length) {
            // Delete key always deletes the character AT cursor (position)
            console.log('Deleting char at position', this.cursorPosition, ':', this.textBuffer[this.cursorPosition]);
            this.textBuffer = this.textBuffer.slice(0, this.cursorPosition) +
                this.textBuffer.slice(this.cursorPosition + 1);

            // Cursor stays at same logical position
            // But we need to ensure it doesn't exceed text length
            if (this.cursorPosition > this.textBuffer.length) {
                this.cursorPosition = this.textBuffer.length;
            }

            console.log('New cursor position:', this.cursorPosition);
            console.log('New text:', this.textBuffer);

            // Save to localStorage
            localStorage.setItem('glyphCanvasTextBuffer', this.textBuffer);

            // Reshape and render
            this.shapeText();
            this.updateCursorVisualPosition();

            // If text is now empty, reset cursor to origin
            if (this.textBuffer.length === 0) {
                this.cursorPosition = 0;
                this.cursorX = 0;
            }

            this.render();
        }
    }

    findClusterAt(logicalPos) {
        // Find the cluster (glyph + its character range) at a logical position
        if (!this.clusterMap || this.clusterMap.length === 0) {
            return null;
        }

        // Find cluster that contains this logical position
        for (const cluster of this.clusterMap) {
            if (logicalPos >= cluster.start && logicalPos < cluster.end) {
                return cluster;
            }
        }

        return null;
    }

    buildClusterMap() {
        // Build a map from logical character positions to visual glyphs
        // Group glyphs by cluster to handle multi-glyph clusters correctly
        this.clusterMap = [];

        if (!this.shapedGlyphs || this.shapedGlyphs.length === 0) {
            return;
        }

        console.log('=== Building Cluster Map ===');
        console.log('Text buffer:', this.textBuffer);
        console.log('Shaped glyphs count:', this.shapedGlyphs.length);

        // Group consecutive glyphs with the same cluster value
        let xPosition = 0;
        let i = 0;

        while (i < this.shapedGlyphs.length) {
            const glyph = this.shapedGlyphs[i];
            const clusterStart = glyph.cl || 0;
            const isRTL = this.isPositionRTL(clusterStart);

            // Find all glyphs that belong to this cluster
            let clusterWidth = 0;
            let j = i;
            while (j < this.shapedGlyphs.length && (this.shapedGlyphs[j].cl || 0) === clusterStart) {
                clusterWidth += this.shapedGlyphs[j].ax || 0;
                j++;
            }

            // Determine cluster end
            let clusterEnd;
            if (isRTL) {
                // RTL: look backward for the next different cluster
                if (i > 0) {
                    const prevCluster = this.shapedGlyphs[i - 1].cl || 0;
                    clusterEnd = prevCluster;
                } else {
                    // First cluster - look forward for next different cluster
                    clusterEnd = this.textBuffer.length;
                    for (let k = j; k < this.shapedGlyphs.length; k++) {
                        const nextCluster = this.shapedGlyphs[k].cl || 0;
                        if (nextCluster !== clusterStart) {
                            clusterEnd = nextCluster;
                            break;
                        }
                    }
                }
                if (clusterStart >= clusterEnd) {
                    clusterEnd = clusterStart + 1;
                }
            } else {
                // LTR: look forward for the next cluster
                if (j < this.shapedGlyphs.length) {
                    const nextCluster = this.shapedGlyphs[j].cl || this.textBuffer.length;
                    // If next cluster value is less than current (RTL following LTR), 
                    // this cluster only covers one character
                    if (nextCluster > clusterStart) {
                        clusterEnd = nextCluster;
                    } else {
                        clusterEnd = clusterStart + 1;
                    }
                } else {
                    clusterEnd = this.textBuffer.length;
                }
            }

            console.log(`Cluster [${clusterStart}-${clusterEnd}): ${j - i} glyphs, x=${xPosition.toFixed(0)}, width=${clusterWidth.toFixed(0)}, RTL=${isRTL}`);

            this.clusterMap.push({
                glyphIndex: i,
                glyphCount: j - i,
                start: clusterStart,
                end: clusterEnd,
                x: xPosition,
                width: clusterWidth,
                isRTL: isRTL
            });

            xPosition += clusterWidth;
            i = j; // Move to next cluster
        }

        console.log('===========================');
    }

    updateCursorVisualPosition() {
        // Calculate the visual X position of the cursor based on logical position
        console.log('updateCursorVisualPosition: cursor at logical position', this.cursorPosition);
        this.cursorX = 0;

        if (!this.clusterMap || this.clusterMap.length === 0) {
            console.log('No cluster map');
            return;
        }

        console.log('Cluster map:', this.clusterMap.map(c => `[${c.start}-${c.end}) @ x=${c.x.toFixed(0)}, RTL=${c.isRTL}`));

        // Find the cluster that contains or is adjacent to this position
        // Priority: Check if position is the END of a cluster first (to handle boundaries correctly)
        let found = false;

        // First pass: Check if this position is at the END of any cluster
        for (const cluster of this.clusterMap) {
            if (this.cursorPosition === cluster.end && this.cursorPosition > cluster.start) {
                console.log(`Position ${this.cursorPosition} is at END of cluster [${cluster.start}-${cluster.end}), isRTL: ${cluster.isRTL}`);

                if (cluster.isRTL) {
                    // RTL: cursor after last char = left edge
                    this.cursorX = cluster.x;
                    console.log('RTL cluster end -> left edge x =', this.cursorX);
                } else {
                    // LTR: cursor after last char = right edge
                    this.cursorX = cluster.x + cluster.width;
                    console.log('LTR cluster end -> right edge x =', this.cursorX);
                }
                found = true;
                break;
            }
        }

        // Second pass: Check if this position is at the START of a cluster
        if (!found) {
            for (const cluster of this.clusterMap) {
                if (this.cursorPosition === cluster.start) {
                    console.log(`Position ${this.cursorPosition} is at START of cluster [${cluster.start}-${cluster.end}), isRTL: ${cluster.isRTL}`);

                    if (cluster.isRTL) {
                        // RTL: cursor before first char = right edge
                        this.cursorX = cluster.x + cluster.width;
                        console.log('RTL cluster start -> right edge x =', this.cursorX);
                    } else {
                        // LTR: cursor before first char = left edge
                        this.cursorX = cluster.x;
                        console.log('LTR cluster start -> left edge x =', this.cursorX);
                    }
                    found = true;
                    break;
                }
            }
        }

        // Third pass: Check if position is INSIDE a cluster
        if (!found) {
            for (const cluster of this.clusterMap) {
                if (this.cursorPosition > cluster.start && this.cursorPosition < cluster.end) {
                    console.log(`Position ${this.cursorPosition} is INSIDE cluster [${cluster.start}-${cluster.end}), isRTL: ${cluster.isRTL}`);

                    // Inside a cluster - interpolate
                    const progress = (this.cursorPosition - cluster.start) / (cluster.end - cluster.start);
                    if (cluster.isRTL) {
                        // RTL: interpolate from right to left
                        this.cursorX = cluster.x + cluster.width * (1 - progress);
                        console.log('RTL inside cluster, progress', progress.toFixed(2), '-> x =', this.cursorX);
                    } else {
                        // LTR: interpolate from left to right
                        this.cursorX = cluster.x + cluster.width * progress;
                        console.log('LTR inside cluster, progress', progress.toFixed(2), '-> x =', this.cursorX);
                    }
                    found = true;
                    break;
                }
            }
        }

        if (!found) {
            console.warn('Could not find visual position for logical position', this.cursorPosition);
        }
    }

    getClickedCursorPosition(e) {
        // Convert click position to cursor position
        const rect = this.canvas.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        // Transform to glyph space
        const transform = this.getTransformMatrix();
        const det = transform.a * transform.d - transform.b * transform.c;
        const glyphX = (transform.d * (mouseX - transform.e) - transform.c * (mouseY - transform.f)) / det;
        const glyphY = (transform.a * (mouseY - transform.f) - transform.b * (mouseX - transform.e)) / det;

        // Check if clicking within cursor height range (same as cursor drawing)
        // Cursor goes from 1000 (top) to -300 (bottom)
        if (glyphY > 1000 || glyphY < -300) {
            return null; // Clicked outside cursor height - allow panning
        }

        if (!this.clusterMap || this.clusterMap.length === 0) {
            return 0;
        }

        // Find closest cursor position accounting for RTL
        let closestPos = 0;
        let closestDist = Infinity;

        // Check each cluster
        for (const cluster of this.clusterMap) {
            if (cluster.isRTL) {
                // RTL: start position is at RIGHT edge, end position is at LEFT edge
                const rightEdge = cluster.x + cluster.width;
                const leftEdge = cluster.x;

                // Distance to start position (right edge)
                const distStart = Math.abs(glyphX - rightEdge);
                if (distStart < closestDist) {
                    closestDist = distStart;
                    closestPos = cluster.start;
                }

                // Distance to end position (left edge)
                const distEnd = Math.abs(glyphX - leftEdge);
                if (distEnd < closestDist) {
                    closestDist = distEnd;
                    closestPos = cluster.end;
                }

                // Intermediate positions if multi-character cluster
                if (cluster.end - cluster.start > 1) {
                    for (let i = cluster.start + 1; i < cluster.end; i++) {
                        const progress = (i - cluster.start) / (cluster.end - cluster.start);
                        // RTL: interpolate from right to left
                        const intermediateX = rightEdge - cluster.width * progress;
                        const distIntermediate = Math.abs(glyphX - intermediateX);
                        if (distIntermediate < closestDist) {
                            closestDist = distIntermediate;
                            closestPos = i;
                        }
                    }
                }
            } else {
                // LTR: start position is at LEFT edge, end position is at RIGHT edge
                const leftEdge = cluster.x;
                const rightEdge = cluster.x + cluster.width;

                // Distance to start position (left edge)
                const distStart = Math.abs(glyphX - leftEdge);
                if (distStart < closestDist) {
                    closestDist = distStart;
                    closestPos = cluster.start;
                }

                // Distance to end position (right edge)
                const distEnd = Math.abs(glyphX - rightEdge);
                if (distEnd < closestDist) {
                    closestDist = distEnd;
                    closestPos = cluster.end;
                }

                // Intermediate positions if multi-character cluster
                if (cluster.end - cluster.start > 1) {
                    for (let i = cluster.start + 1; i < cluster.end; i++) {
                        const progress = (i - cluster.start) / (cluster.end - cluster.start);
                        // LTR: interpolate from left to right
                        const intermediateX = leftEdge + cluster.width * progress;
                        const distIntermediate = Math.abs(glyphX - intermediateX);
                        if (distIntermediate < closestDist) {
                            closestDist = distIntermediate;
                            closestPos = i;
                        }
                    }
                }
            }
        }

        return closestPos;
    }

    drawSelection() {
        // Draw selection highlight
        if (!this.hasSelection() || !this.clusterMap || this.clusterMap.length === 0) {
            return;
        }

        const range = this.getSelectionRange();
        const invScale = 1 / this.scale;

        console.log('=== Drawing Selection ===');
        console.log('Selection range:', range);
        console.log('Text:', `"${this.textBuffer.slice(range.start, range.end)}"`);

        // Draw selection highlight for each cluster in range
        this.ctx.fillStyle = 'rgba(100, 150, 255, 0.3)';

        for (const cluster of this.clusterMap) {
            // Check if this cluster overlaps with selection
            const clusterStart = cluster.start;
            const clusterEnd = cluster.end;

            // Skip if cluster is completely outside selection
            if (clusterEnd <= range.start || clusterStart >= range.end) {
                continue;
            }

            console.log(`Drawing selection for cluster [${clusterStart}-${clusterEnd}), RTL=${cluster.isRTL}, x=${cluster.x.toFixed(0)}, width=${cluster.width.toFixed(0)}`);

            // Calculate which part of the cluster is selected
            // Use the actual overlap, not interpolated positions
            const selStart = Math.max(range.start, clusterStart);
            const selEnd = Math.min(range.end, clusterEnd);

            console.log(`  Selection overlap: [${selStart}-${selEnd})`);

            // Check if we're selecting the entire cluster or just part of it
            const isFullySelected = (selStart === clusterStart && selEnd === clusterEnd);
            const isPartiallySelected = !isFullySelected;

            // Calculate visual position and width for selected portion
            let highlightX, highlightWidth;

            if (isFullySelected) {
                // Entire cluster is selected - draw full width
                highlightX = cluster.x;
                highlightWidth = cluster.width;
                console.log(`  Full cluster selected: x=${highlightX.toFixed(0)}, width=${highlightWidth.toFixed(0)}`);
            } else if (cluster.isRTL) {
                // RTL: right edge is start, left edge is end
                const rightEdge = cluster.x + cluster.width;
                const leftEdge = cluster.x;

                // Only interpolate if this is a multi-character cluster
                if (clusterEnd - clusterStart > 1) {
                    const startProgress = (selStart - clusterStart) / (clusterEnd - clusterStart);
                    const endProgress = (selEnd - clusterStart) / (clusterEnd - clusterStart);

                    const startX = rightEdge - cluster.width * startProgress;
                    const endX = rightEdge - cluster.width * endProgress;

                    highlightX = Math.min(startX, endX);
                    highlightWidth = Math.abs(startX - endX);
                    console.log(`  RTL partial (multi-char): progress ${startProgress.toFixed(2)}-${endProgress.toFixed(2)}, x=${highlightX.toFixed(0)}, width=${highlightWidth.toFixed(0)}`);
                } else {
                    // Single character cluster - select full width
                    highlightX = cluster.x;
                    highlightWidth = cluster.width;
                    console.log(`  RTL partial (single-char): x=${highlightX.toFixed(0)}, width=${highlightWidth.toFixed(0)}`);
                }
            } else {
                // LTR: left edge is start, right edge is end

                // Only interpolate if this is a multi-character cluster
                if (clusterEnd - clusterStart > 1) {
                    const startProgress = (selStart - clusterStart) / (clusterEnd - clusterStart);
                    const endProgress = (selEnd - clusterStart) / (clusterEnd - clusterStart);

                    highlightX = cluster.x + cluster.width * startProgress;
                    highlightWidth = cluster.width * (endProgress - startProgress);
                    console.log(`  LTR partial (multi-char): progress ${startProgress.toFixed(2)}-${endProgress.toFixed(2)}, x=${highlightX.toFixed(0)}, width=${highlightWidth.toFixed(0)}`);
                } else {
                    // Single character cluster - select full width
                    highlightX = cluster.x;
                    highlightWidth = cluster.width;
                    console.log(`  LTR partial (single-char): x=${highlightX.toFixed(0)}, width=${highlightWidth.toFixed(0)}`);
                }
            }

            // Draw highlight rectangle
            this.ctx.fillRect(highlightX, -300, highlightWidth, 1300);
        }

        console.log('========================');
    }

    drawCursor() {
        // Draw the text cursor at the current position
        if (!this.cursorVisible) {
            return;
        }

        const invScale = 1 / this.scale;

        console.log(`Drawing cursor at x=${this.cursorX.toFixed(0)} for logical position ${this.cursorPosition}`);

        // Draw cursor line - dimmed when not focused, bright when focused
        const opacity = this.isFocused ? 0.8 : 0.3;
        this.ctx.strokeStyle = `rgba(255, 255, 255, ${opacity})`;
        this.ctx.lineWidth = 2 * invScale;
        this.ctx.beginPath();
        this.ctx.moveTo(this.cursorX, 1000); // Top (above cap height, positive Y is up in font space)
        this.ctx.lineTo(this.cursorX, -300);   // Bottom (below baseline, negative Y is down)
        this.ctx.stroke();
    }
}

// Initialize when document is ready
document.addEventListener('DOMContentLoaded', () => {
    // Wait for the editor view to be ready
    const initCanvas = () => {
        const editorContent = document.querySelector('#view-editor .view-content');
        if (editorContent) {
            // Create main container with flexbox layout
            const mainContainer = document.createElement('div');
            mainContainer.style.display = 'flex';
            mainContainer.style.width = '100%';
            mainContainer.style.height = '100%';
            mainContainer.style.overflow = 'hidden';

            // Create sidebar toolbar
            const sidebar = document.createElement('div');
            sidebar.id = 'glyph-editor-sidebar';
            sidebar.style.width = '300px';
            sidebar.style.minWidth = '300px';
            sidebar.style.height = '100%';
            sidebar.style.backgroundColor = 'var(--bg-secondary)';
            sidebar.style.borderLeft = '1px solid var(--border-primary)';
            sidebar.style.padding = '16px';
            sidebar.style.overflowY = 'auto';
            sidebar.style.display = 'flex';
            sidebar.style.flexDirection = 'column';
            sidebar.style.gap = '16px';

            // Create canvas container
            const canvasContainer = document.createElement('div');
            canvasContainer.id = 'glyph-canvas-container';
            canvasContainer.style.flex = '1';
            canvasContainer.style.height = '100%';
            canvasContainer.style.position = 'relative';

            // Assemble layout (canvas first, then sidebar on the right)
            mainContainer.appendChild(canvasContainer);
            mainContainer.appendChild(sidebar);
            editorContent.appendChild(mainContainer);

            // Initialize canvas
            window.glyphCanvas = new GlyphCanvas('glyph-canvas-container');

            // Create variable axes container (initially empty)
            const axesSection = document.createElement('div');
            axesSection.id = 'glyph-axes-section';
            axesSection.style.display = 'flex';
            axesSection.style.flexDirection = 'column';
            axesSection.style.gap = '12px';
            sidebar.appendChild(axesSection);

            // Store reference to sidebar for later updates
            window.glyphCanvas.sidebar = sidebar;
            window.glyphCanvas.axesSection = axesSection;

            // Observe when the editor view gains/loses focus (via 'focused' class)
            const editorView = document.querySelector('#view-editor');
            if (editorView) {
                const observer = new MutationObserver((mutations) => {
                    mutations.forEach((mutation) => {
                        if (mutation.type === 'attributes' && mutation.attributeName === 'class') {
                            // Render when focused class changes
                            window.glyphCanvas.render();
                        }
                    });
                });
                observer.observe(editorView, { attributes: true, attributeFilter: ['class'] });
            }

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
