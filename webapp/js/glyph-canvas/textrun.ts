// The text run editor is responsible for
// - holding the Unicode buffer state
// - shaping text and updating a glyph buffer
// - cluster mapping
// - cursor movement
// - selection handling

import { Font } from 'opentype.js';
import { Logger } from '../logger';
import type { FeaturesManager } from './features';
import type { AxesManager } from './variations';

import bidiFactory from 'bidi-js';

let console: Logger = new Logger('TextRun', false);

export interface ShapedGlyph {
    dx: number;
    dy: number;
    ax: number;
    ay: number;
    cl: number; // Cluster
    g: number; // Glyph ID
}

export class TextRunEditor {
    featuresManager: FeaturesManager;
    axesManager: AxesManager;
    textBuffer: string;
    shapedGlyphs: ShapedGlyph[];
    hb: any;
    hbFont: any;
    hbFace: any;
    hbBlob: any;
    opentypeFont: Font | null;
    bidi: any;
    bidiRuns: any[];
    selectedGlyphIndex: number;
    cursorPosition: number;
    cursorVisible: boolean;
    cursorBlinkInterval: any;
    cursorX: number;
    clusterMap: any[];
    embeddingLevels: any;
    callbacks: Record<string, Function>;
    selectionStart: number | null;
    selectionEnd: number | null;
    fontBlob: Uint8Array | null;

    constructor(featuresManager: FeaturesManager, axesManager: AxesManager) {
        this.featuresManager = featuresManager;
        this.axesManager = axesManager;
        // Default text buffer - will be overridden by font's display_string if available
        this.textBuffer =
            localStorage.getItem('glyphCanvasTextBuffer') || 'Hamburgevons';
        this.shapedGlyphs = [];
        // HarfBuzz instance and objects
        this.hb = null;
        this.hbFont = null;
        this.hbFace = null;
        this.hbBlob = null;
        this.fontBlob = null;

        this.opentypeFont = null; // OpenType.js font instance

        // Bidirectional text support
        this.bidi = bidiFactory();
        this.bidiRuns = []; // Store bidirectional runs for rendering

        // Selected glyph (glyph after cursor in logical order)
        this.selectedGlyphIndex = -1;

        // Cursor state
        this.cursorPosition = 0; // Logical position in textBuffer (0 = before first char)
        this.cursorVisible = true;
        this.cursorBlinkInterval = null;
        this.cursorX = 0; // Visual X position for rendering
        this.clusterMap = []; // Maps logical char positions to visual glyph info
        this.embeddingLevels = null; // BiDi embedding levels for cursor logic

        // Selection state
        this.selectionStart = null; // Start of selection (null = no selection)
        this.selectionEnd = null; // End of selection

        this.callbacks = {}; // For notifying GlyphCanvas of updates
    }

    on(event: string, callback: Function) {
        this.callbacks[event] = callback;
    }

    call(event: string, ...args: any[]) {
        if (this.callbacks[event]) {
            this.callbacks[event](...args);
        }
    }

    init() {
        // Load HarfBuzz
        this.loadHarfBuzz();
    }

    async loadHarfBuzz() {
        try {
            // Wait for createHarfBuzz to be available
            if (typeof window.createHarfBuzz === 'undefined') {
                console.log('Waiting for HarfBuzz to load...');
                await new Promise<void>((resolve, reject) => {
                    let attempts = 0;
                    const check = () => {
                        if (typeof window.createHarfBuzz !== 'undefined') {
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
            const hbModule = await window.createHarfBuzz();
            this.hb = window.hbjs(hbModule);
            console.log('HarfBuzz initialized successfully');

            // If we have a font loaded, shape it
            if (this.fontBlob) {
                this.shapeText();
            }
        } catch (error) {
            console.error('Error loading HarfBuzz:', error);
            console.log(
                '[TextRun]',
                'Text shaping will not be available. Glyphs will be displayed as placeholder boxes.'
            );
        }
    }

    async _navigateGlyphLogical(direction: number) {
        if (
            this.selectedGlyphIndex < 0 ||
            this.selectedGlyphIndex >= this.shapedGlyphs.length
        ) {
            return;
        }

        const currentGlyph = this.shapedGlyphs[this.selectedGlyphIndex];
        const currentClusterPos = currentGlyph.cl || 0;
        const isCurrentRTL = this.isPositionRTL(currentClusterPos);

        const step = direction * (isCurrentRTL ? -1 : 1);
        for (
            let i = this.selectedGlyphIndex + step;
            i >= 0 && i < this.shapedGlyphs.length;
            i += step
        ) {
            const glyph = this.shapedGlyphs[i];
            if ((glyph.cl || 0) === currentClusterPos) {
                await this.selectGlyphByIndex(i, true);
                return;
            }
        }

        let nextPosition = currentClusterPos + direction;
        while (nextPosition >= 0 && nextPosition <= this.textBuffer.length) {
            const isNextRTL = this.isPositionRTL(nextPosition);
            // In RTL text, when moving forward (direction=1), we want the last glyph in the cluster (base glyph)
            // When moving backward (direction=-1), we want the first glyph (which may be a mark)
            // In LTR text, we always want the first glyph
            const glyphIndex =
                isNextRTL && direction > 0
                    ? this.findLastGlyphAtClusterPosition(nextPosition)
                    : this.findFirstGlyphAtClusterPosition(nextPosition);
            if (glyphIndex >= 0) {
                await this.selectGlyphByIndex(glyphIndex, true);
                return;
            }
            nextPosition += direction;
        }
    }

    async navigateToNextGlyphLogical() {
        await this._navigateGlyphLogical(1);
    }

    async navigateToPreviousGlyphLogical() {
        await this._navigateGlyphLogical(-1);
    }

    _findGlyphAtClusterPosition(
        clusterPos: number,
        searchFromEnd = false
    ): number {
        if (!this.shapedGlyphs || this.shapedGlyphs.length === 0) {
            return -1;
        }

        const start = searchFromEnd ? this.shapedGlyphs.length - 1 : 0;
        const end = searchFromEnd ? -1 : this.shapedGlyphs.length;
        const step = searchFromEnd ? -1 : 1;

        for (let i = start; i !== end; i += step) {
            const glyph = this.shapedGlyphs[i];
            if ((glyph.cl || 0) === clusterPos) {
                return i;
            }
        }

        return -1;
    }

    findFirstGlyphAtClusterPosition(clusterPos: number): number {
        return this._findGlyphAtClusterPosition(clusterPos, false);
    }

    findLastGlyphAtClusterPosition(clusterPos: number): number {
        return this._findGlyphAtClusterPosition(clusterPos, true);
    }

    setTextBuffer(text: string) {
        this.textBuffer = text || '';

        // Save to localStorage
        try {
            localStorage.setItem('glyphCanvasTextBuffer', this.textBuffer);
        } catch (e) {
            console.warn(
                '[TextRun]',
                'Failed to save text buffer to localStorage:',
                e
            );
        }

        // Save to font object via Python
        this.saveTextBufferToFont();

        // Trigger font recompilation (debounced)
        this.call('textchanged');

        this.shapeText();
    }

    async selectGlyphByIndex(glyphIndex: number, fromKeyboard = false) {
        // Select a glyph by its index in the shaped glyphs array

        this.call('exitcomponentediting'); // Ensure any component editing is exited

        // Store the previous index to pass to the event handler
        const previousIndex = this.selectedGlyphIndex;

        if (glyphIndex >= 0 && glyphIndex < this.shapedGlyphs.length) {
            this.selectedGlyphIndex = glyphIndex;

            // Set logical cursor position to the start of this glyph's cluster
            const glyph = this.shapedGlyphs[glyphIndex];
            const clusterPos = glyph.cl || 0;
            this.cursorPosition = clusterPos;
            this.updateCursorVisualPosition();

            console.log(
                '[TextRun]',
                `Entered glyph edit mode - selected glyph at index ${this.selectedGlyphIndex}, cluster position ${clusterPos}`
            );
        } else {
            console.log(`Deselected glyph`);
        }
        this.call(
            'glyphselected',
            this.selectedGlyphIndex,
            previousIndex,
            fromKeyboard
        );
    }

    getGlyphIndexAtCursorPosition() {
        if (!this.shapedGlyphs || this.shapedGlyphs.length === 0) {
            return;
        }

        // Find the glyph at the cursor position
        const targetPosition = this.cursorPosition;
        const isRTL = this.isPositionRTL(targetPosition);

        console.log(
            '[TextRun]',
            `Looking for glyph at cursor position ${targetPosition}, isRTL: ${isRTL}`
        );

        // First, try to find a cluster that starts at this position
        let glyphIndex = -1;
        if (isRTL) {
            glyphIndex = this.findLastGlyphAtClusterPosition(targetPosition);
        } else {
            glyphIndex = this.findFirstGlyphAtClusterPosition(targetPosition);
        }

        // If no cluster starts at this position, find the glyph by logical position within its cluster
        if (glyphIndex < 0) {
            for (let i = 0; i < this.shapedGlyphs.length; i++) {
                const glyphInfo = this.isGlyphFromTypedCharacter(i);
                if (
                    glyphInfo.isTyped &&
                    glyphInfo.logicalPosition === targetPosition
                ) {
                    glyphIndex = i;
                    console.log(
                        '[TextRun]',
                        `Found glyph ${i} at logical position ${targetPosition} within its cluster`
                    );
                    break;
                }
            }
        }
        return glyphIndex;
    }

    getGlyphIndexAtClick(glyphX: number, glyphY: number) {
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
                        const progress =
                            (i - cluster.start) / (cluster.end - cluster.start);
                        // RTL: interpolate from right to left
                        const intermediateX =
                            rightEdge - cluster.width * progress;
                        const distIntermediate = Math.abs(
                            glyphX - intermediateX
                        );
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
                        const progress =
                            (i - cluster.start) / (cluster.end - cluster.start);
                        // LTR: interpolate from left to right
                        const intermediateX =
                            leftEdge + cluster.width * progress;
                        const distIntermediate = Math.abs(
                            glyphX - intermediateX
                        );
                        if (distIntermediate < closestDist) {
                            closestDist = distIntermediate;
                            closestPos = i;
                        }
                    }
                }
            }
        }

        // Ensure we don't return a position beyond the text length
        if (closestPos > this.textBuffer.length) {
            closestPos = this.textBuffer.length;
        }

        // If the closest position is too far away from the click, return null (allow panning)
        // This prevents clicking in empty space where text used to be
        const maxDistance = 500; // Maximum distance in font units to consider a valid click
        if (closestDist > maxDistance) {
            return null;
        }

        return closestPos;
    }

    moveCursorLogicalBackward() {
        if (this.cursorPosition > 0) {
            this.cursorPosition--;
            console.log(
                '[TextRun]',
                'Moved to logical position:',
                this.cursorPosition
            );
            this.updateCursorVisualPosition();
        }
    }

    moveCursorLogicalForward() {
        if (this.cursorPosition < this.textBuffer.length) {
            this.cursorPosition++;
            console.log(
                '[TextRun]',
                'Moved to logical position:',
                this.cursorPosition
            );
            this.updateCursorVisualPosition();
        }
    }

    isPositionRTL(pos: number) {
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

    isGlyphFromTypedCharacter(glyphIndex: number) {
        // Determine if a glyph corresponds to a typed character or is a result of shaping
        // Returns: { isTyped: boolean, logicalPosition: number }

        if (glyphIndex < 0 || glyphIndex >= this.shapedGlyphs.length) {
            return { isTyped: false, logicalPosition: -1 };
        }

        const glyph = this.shapedGlyphs[glyphIndex];
        const clusterValue = glyph.cl || 0;

        // Check if there's a character at this cluster position in the original text buffer
        // If clusterValue points to a valid position in textBuffer, it's typed
        // If clusterValue points beyond or the glyph is additional (like a ligature component),
        // it's shaped

        // Get all glyphs in this cluster
        const glyphsInCluster = this.shapedGlyphs.filter(
            (g) => (g.cl || 0) === clusterValue
        );

        // Count how many characters this cluster represents
        // Find the next cluster value to determine the range
        let nextClusterValue = this.textBuffer.length;
        for (const g of this.shapedGlyphs) {
            const cl = g.cl || 0;
            if (cl > clusterValue && cl < nextClusterValue) {
                nextClusterValue = cl;
            }
        }

        const characterCount = nextClusterValue - clusterValue;
        const glyphCount = glyphsInCluster.length;

        // Find which position this glyph is within the cluster
        const positionInCluster = glyphsInCluster.findIndex(
            (g) => this.shapedGlyphs.indexOf(g) === glyphIndex
        );

        console.log(
            '[TextRun]',
            `Glyph ${glyphIndex}: cluster=${clusterValue}, pos in cluster=${positionInCluster}, chars=${characterCount}, glyphs=${glyphCount}`
        );

        // If this glyph's position in the cluster is less than the character count,
        // it corresponds to a typed character
        const isTyped = positionInCluster < characterCount;

        // The logical position depends on direction
        // For RTL, the visual buffer order is reversed from logical order
        let logicalPosition;
        if (isTyped) {
            const isRTL = this.isPositionRTL(clusterValue);
            if (isRTL) {
                // RTL: reverse the position within the cluster
                // Visual position 0 -> logical position (clusterValue + characterCount - 1)
                // Visual position 1 -> logical position (clusterValue + characterCount - 2)
                logicalPosition =
                    clusterValue + (characterCount - 1 - positionInCluster);
                console.log(
                    '[TextRun]',
                    `  RTL: visual pos ${positionInCluster} -> logical pos ${logicalPosition} (cluster ${clusterValue}, ${characterCount} chars)`
                );
            } else {
                // LTR: position is straightforward
                logicalPosition = clusterValue + positionInCluster;
                console.log(
                    '[TextRun]',
                    `  LTR: visual pos ${positionInCluster} -> logical pos ${logicalPosition}`
                );
            }
        } else {
            logicalPosition = clusterValue;
        }

        return { isTyped, logicalPosition };
    }

    getRunAtPosition(pos: number) {
        // Find which BiDi run contains this logical position
        if (!this.bidiRuns || this.bidiRuns.length === 0) {
            return null;
        }

        for (const run of this.bidiRuns) {
            if (pos >= run.start && pos < run.end) {
                console.log(
                    '[TextRun]',
                    `Position ${pos} is in ${run.direction} run [${run.start}-${run.end}]: "${run.text}"`
                );
                return run;
            }
        }

        // If at the very end, return the last run
        if (pos === this.textBuffer.length && this.bidiRuns.length > 0) {
            const lastRun = this.bidiRuns[this.bidiRuns.length - 1];
            console.log(
                '[TextRun]',
                `Position ${pos} is at end of ${lastRun.direction} run [${lastRun.start}-${lastRun.end}]: "${lastRun.text}"`
            );
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
            console.log(
                '[TextRun]',
                'Current run:',
                run.direction,
                `[${run.start}-${run.end}]`,
                `"${run.text}"`
            );
        }
        console.log('==================');
    }

    moveCursorLeft() {
        console.log('=== Move Cursor Left ===');
        this.logCursorState();

        // Left arrow = backward in logical order (decrease position)
        this.moveCursorLogicalBackward();
        this.call('cursormoved');
    }

    moveCursorRight() {
        console.log('=== Move Cursor Right ===');
        this.logCursorState();

        // Right arrow = forward in logical order (increase position)
        this.moveCursorLogicalForward();
        this.call('cursormoved');
    }

    // ==================== Selection Methods ====================

    clearSelection() {
        this.selectionStart = null;
        this.selectionEnd = null;
    }

    hasSelection() {
        return (
            this.selectionStart !== null &&
            this.selectionEnd !== null &&
            this.selectionStart !== this.selectionEnd
        );
    }

    getSelectionRange() {
        if (!this.hasSelection()) {
            return { start: this.cursorPosition, end: this.cursorPosition };
        }
        return {
            start: Math.min(this.selectionStart!, this.selectionEnd!),
            end: Math.max(this.selectionStart!, this.selectionEnd!)
        };
    }

    selectAll() {
        this.selectionStart = 0;
        this.selectionEnd = this.textBuffer.length;
        this.cursorPosition = this.textBuffer.length;
        console.log(
            '[TextRun]',
            'Selected all:',
            `"${this.textBuffer.slice(0, this.textBuffer.length)}"`,
            `[${this.selectionStart}-${this.selectionEnd}]`
        );
        this.updateCursorVisualPosition();
        this.call('cursormoved');
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
            console.log(
                '[TextRun]',
                'Selection:',
                `"${this.textBuffer.slice(range.start, range.end)}"`,
                `[${range.start}-${range.end}]`
            );
        }

        this.call('cursormoved');
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
            console.log(
                '[TextRun]',
                'Selection:',
                `"${this.textBuffer.slice(range.start, range.end)}"`,
                `[${range.start}-${range.end}]`
            );
        }
        this.call('cursormoved');
    }

    moveToStartWithSelection() {
        if (!this.hasSelection()) {
            this.selectionStart = this.cursorPosition;
        }
        this.cursorPosition = 0;
        this.selectionEnd = this.cursorPosition;
        const range = this.getSelectionRange();
        if (range.start !== range.end) {
            console.log(
                'Selection:',
                `"${this.textBuffer.slice(range.start, range.end)}"`,
                `[${range.start}-${range.end}]`
            );
        }
        this.updateCursorVisualPosition();
        this.call('cursormoved');
    }

    moveToEndWithSelection() {
        if (!this.hasSelection()) {
            this.selectionStart = this.cursorPosition;
        }
        this.cursorPosition = this.textBuffer.length;
        this.selectionEnd = this.cursorPosition;
        const range = this.getSelectionRange();
        if (range.start !== range.end) {
            console.log(
                'Selection:',
                `"${this.textBuffer.slice(range.start, range.end)}"`,
                `[${range.start}-${range.end}]`
            );
        }
        this.updateCursorVisualPosition();
        this.call('cursormoved');
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
            console.log(
                '[TextRun]',
                'Copied to clipboard:',
                `"${selectedText}"`
            );
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
        console.log(
            '[TextRun]',
            'Cutting selection:',
            `"${this.textBuffer.slice(range.start, range.end)}"`,
            `[${range.start}-${range.end}]`
        );
        this.textBuffer =
            this.textBuffer.slice(0, range.start) +
            this.textBuffer.slice(range.end);
        this.cursorPosition = range.start;
        this.clearSelection();
        this.reshapeAndRender();
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

    insertText(text: string) {
        // If there's a selection, delete it first
        if (this.hasSelection()) {
            const range = this.getSelectionRange();
            this.textBuffer =
                this.textBuffer.slice(0, range.start) +
                this.textBuffer.slice(range.end);
            this.cursorPosition = range.start;
            this.clearSelection();
        }

        // Insert text at cursor position
        this.textBuffer =
            this.textBuffer.slice(0, this.cursorPosition) +
            text +
            this.textBuffer.slice(this.cursorPosition);
        this.cursorPosition += text.length;

        this.reshapeAndRender();
    }

    deleteBackward() {
        console.log('=== Delete Backward (Backspace) ===');
        this.logCursorState();

        // If there's a selection, delete it
        if (this.hasSelection()) {
            const range = this.getSelectionRange();
            console.log(
                'Deleting selection:',
                `"${this.textBuffer.slice(range.start, range.end)}"`,
                `[${range.start}-${range.end}]`
            );
            this.textBuffer =
                this.textBuffer.slice(0, range.start) +
                this.textBuffer.slice(range.end);
            this.cursorPosition = range.start;
            this.clearSelection();

            this.reshapeAndRender();
        } else if (this.cursorPosition > 0) {
            // Backspace always deletes the character BEFORE cursor (position - 1)
            console.log(
                '[TextRun]',
                'Deleting char at position',
                this.cursorPosition - 1,
                ':',
                this.textBuffer[this.cursorPosition - 1]
            );
            this.textBuffer =
                this.textBuffer.slice(0, this.cursorPosition - 1) +
                this.textBuffer.slice(this.cursorPosition);
            this.cursorPosition--;

            this.reshapeAndRender();
        }
    }

    deleteForward() {
        console.log('=== Delete Forward (Delete key) ===');
        this.logCursorState();

        // If there's a selection, delete it
        if (this.hasSelection()) {
            const range = this.getSelectionRange();
            console.log(
                'Deleting selection:',
                `"${this.textBuffer.slice(range.start, range.end)}"`,
                `[${range.start}-${range.end}]`
            );
            this.textBuffer =
                this.textBuffer.slice(0, range.start) +
                this.textBuffer.slice(range.end);
            this.cursorPosition = range.start;
            this.clearSelection();

            this.reshapeAndRender();
        } else if (this.cursorPosition < this.textBuffer.length) {
            // Delete key always deletes the character AT cursor (position)
            console.log(
                '[TextRun]',
                'Deleting char at position',
                this.cursorPosition,
                ':',
                this.textBuffer[this.cursorPosition]
            );
            this.textBuffer =
                this.textBuffer.slice(0, this.cursorPosition) +
                this.textBuffer.slice(this.cursorPosition + 1);

            // Cursor stays at same logical position
            // But we need to ensure it doesn't exceed text length
            if (this.cursorPosition > this.textBuffer.length) {
                this.cursorPosition = this.textBuffer.length;
            }

            this.reshapeAndRender();
        }
    }

    reshapeAndRender() {
        console.log('New cursor position:', this.cursorPosition);
        console.log('New text:', this.textBuffer);

        // Save to localStorage and trigger recompilation
        this.saveTextBuffer();

        // Reshape and render
        this.shapeText();
        this.updateCursorVisualPosition();

        // If text is now empty, reset cursor to origin
        if (this.textBuffer.length === 0) {
            this.cursorPosition = 0;
            this.cursorX = 0;
        }

        this.call('cursormoved');
    }

    findClusterAt(logicalPos: number) {
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
        console.log(
            '[TextRun]',
            'Shaped glyphs count:',
            this.shapedGlyphs.length
        );

        // First pass: collect all unique cluster values to determine proper boundaries
        const clusterValues = new Set<number>();
        for (const glyph of this.shapedGlyphs) {
            clusterValues.add(glyph.cl || 0);
        }
        const sortedClusters = Array.from(clusterValues).sort((a, b) => a - b);

        // Create a map from cluster start to cluster end
        const clusterBounds = new Map();
        for (let i = 0; i < sortedClusters.length; i++) {
            const start = sortedClusters[i];
            const end =
                i < sortedClusters.length - 1
                    ? sortedClusters[i + 1]
                    : this.textBuffer.length;
            clusterBounds.set(start, end);
        }

        // Group consecutive glyphs with the same cluster value
        let xPosition = 0;
        let i = 0;

        while (i < this.shapedGlyphs.length) {
            const glyph = this.shapedGlyphs[i];
            const clusterStart = glyph.cl || 0;

            // Find all glyphs that belong to this cluster
            let clusterWidth = 0;
            let j = i;
            while (
                j < this.shapedGlyphs.length &&
                (this.shapedGlyphs[j].cl || 0) === clusterStart
            ) {
                clusterWidth += this.shapedGlyphs[j].ax || 0;
                j++;
            }

            // Get the proper cluster end from our bounds map
            const clusterEnd =
                clusterBounds.get(clusterStart) || clusterStart + 1;

            // Determine the RTL status based on the cluster start position
            const isRTL = this.isPositionRTL(clusterStart);

            console.log(
                '[TextRun]',
                `Cluster [${clusterStart}-${clusterEnd}): ${j - i} glyphs, x=${xPosition.toFixed(0)}, width=${clusterWidth.toFixed(0)}, RTL=${isRTL}`
            );

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
        console.log(
            '[TextRun]',
            'updateCursorVisualPosition: cursor at logical position',
            this.cursorPosition
        );
        this.cursorX = 0;

        if (!this.clusterMap || this.clusterMap.length === 0) {
            console.log('No cluster map');
            return;
        }

        // Get glyph names for each cluster for debugging
        const clusterWithNames = this.clusterMap.map((c) => {
            const glyphNames = [];
            for (let i = 0; i < c.glyphCount; i++) {
                const glyph = this.shapedGlyphs[c.glyphIndex + i];
                if (!glyph) {
                    console.warn(
                        '[TextRun]',
                        'Missing glyph at index',
                        c.glyphIndex + i
                    );
                    continue;
                }
                const glyphId = glyph.g;
                let glyphName = `GID${glyphId}`;

                // Get glyph name from font manager (source font) instead of compiled font
                if (
                    window.fontManager &&
                    window.fontManager.currentFont?.babelfontData
                ) {
                    glyphName = window.fontManager.getGlyphName(glyphId);
                } else if (
                    this.opentypeFont &&
                    this.opentypeFont.glyphs.get(glyphId)
                ) {
                    glyphName =
                        this.opentypeFont.glyphs.get(glyphId).name || glyphName;
                }
                glyphNames.push(glyphName);
            }
            return `[${c.start}-${c.end}) @ x=${c.x.toFixed(0)}, RTL=${c.isRTL}, glyphs=[${glyphNames.join(', ')}]`;
        });
        console.log('Cluster map:', clusterWithNames);

        // Find the cluster that contains or is adjacent to this position
        // Priority: Check if position is the START of a cluster FIRST (more important than END)
        let found = false;

        // First pass: Check if this position is at the START of any cluster
        for (const cluster of this.clusterMap) {
            if (this.cursorPosition === cluster.start) {
                console.log(
                    '[TextRun]',
                    `Position ${this.cursorPosition} is at START of cluster [${cluster.start}-${cluster.end}), isRTL: ${cluster.isRTL}`
                );

                if (cluster.isRTL) {
                    // RTL: cursor before first char = right edge
                    this.cursorX = cluster.x + cluster.width;
                    console.log(
                        '[TextRun]',
                        'RTL cluster start -> right edge x =',
                        this.cursorX
                    );
                } else {
                    // LTR: cursor before first char = left edge
                    this.cursorX = cluster.x;
                    console.log(
                        '[TextRun]',
                        'LTR cluster start -> left edge x =',
                        this.cursorX
                    );
                }
                found = true;
                break;
            }
        }

        // Second pass: Check if this position is at the END of any cluster
        if (!found) {
            for (const cluster of this.clusterMap) {
                if (
                    this.cursorPosition === cluster.end &&
                    this.cursorPosition > cluster.start
                ) {
                    console.log(
                        '[TextRun]',
                        `Position ${this.cursorPosition} is at END of cluster [${cluster.start}-${cluster.end}), isRTL: ${cluster.isRTL}`
                    );

                    if (cluster.isRTL) {
                        // RTL: cursor after last char = left edge
                        this.cursorX = cluster.x;
                        console.log(
                            '[TextRun]',
                            'RTL cluster end -> left edge x =',
                            this.cursorX
                        );
                    } else {
                        // LTR: cursor after last char = right edge
                        this.cursorX = cluster.x + cluster.width;
                        console.log(
                            '[TextRun]',
                            'LTR cluster end -> right edge x =',
                            this.cursorX
                        );
                    }
                    found = true;
                    break;
                }
            }
        }

        // Third pass: Check if position is INSIDE a cluster
        if (!found) {
            for (const cluster of this.clusterMap) {
                if (
                    this.cursorPosition > cluster.start &&
                    this.cursorPosition < cluster.end
                ) {
                    console.log(
                        '[TextRun]',
                        `Position ${this.cursorPosition} is INSIDE cluster [${cluster.start}-${cluster.end}), isRTL: ${cluster.isRTL}`
                    );

                    // Inside a cluster - interpolate
                    const progress =
                        (this.cursorPosition - cluster.start) /
                        (cluster.end - cluster.start);
                    if (cluster.isRTL) {
                        // RTL: interpolate from right to left
                        this.cursorX =
                            cluster.x + cluster.width * (1 - progress);
                        console.log(
                            '[TextRun]',
                            'RTL inside cluster, progress',
                            progress.toFixed(2),
                            '-> x =',
                            this.cursorX
                        );
                    } else {
                        // LTR: interpolate from left to right
                        this.cursorX = cluster.x + cluster.width * progress;
                        console.log(
                            '[TextRun]',
                            'LTR inside cluster, progress',
                            progress.toFixed(2),
                            '-> x =',
                            this.cursorX
                        );
                    }
                    found = true;
                    break;
                }
            }
        }

        if (!found) {
            console.warn(
                '[TextRun]',
                'Could not find visual position for logical position',
                this.cursorPosition
            );
        }
    }

    handleKeyDown(e: KeyboardEvent) {
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
                this.call('cursormoved');
            }
        } else if (e.key === 'End') {
            e.preventDefault();
            if (e.shiftKey) {
                this.moveToEndWithSelection();
            } else {
                this.clearSelection();
                this.cursorPosition = this.textBuffer.length;
                this.updateCursorVisualPosition();
                this.call('cursormoved');
            }
        } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
            // Regular character input
            e.preventDefault();
            this.insertText(e.key);
        }
    }

    destroyHarfbuzz() {
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
    }

    async setFont(fontData: Uint8Array) {
        console.log(
            '[TextRun]',
            '🔵 TextRunEditor.setFont() called, current textBuffer:',
            this.textBuffer
        );

        // Store font blob
        this.fontBlob = fontData;

        this.hbBlob = this.hb.createBlob(fontData);
        this.hbFace = this.hb.createFace(this.hbBlob, 0); // 0 = first face
        this.hbFont = this.hb.createFont(this.hbFace);

        console.log('Font loaded into HarfBuzz');

        // Load display string from font if available
        await this.loadTextBufferFromFont();

        console.log(
            '[TextRun]',
            '🔵 TextRunEditor.setFont() completed, textBuffer is now:',
            this.textBuffer
        );
    }
    // Load text buffer from font.format_specific via Python
    async loadTextBufferFromFont() {
        // Check if loading from font is enabled
        if (!window.APP_SETTINGS?.TEXT_DISPLAY?.LOAD_FROM_FONT) {
            console.log(
                '[TextRun]',
                'ℹ️ Loading display string from font is disabled'
            );
            return;
        }

        if (!window.pyodide) {
            console.log(
                '[TextRun]',
                '⚠️ Pyodide not ready, cannot load display string from font'
            );
            return; // Python not ready yet
        }

        try {
            const appId = window.APP_SETTINGS?.APP_ID;
            const key = `${appId}.display_string`;

            console.log(
                '[TextRun]',
                '🔍 Looking for display string with key:',
                key
            );

            const result = window.fontManager?.getFormatSpecific(key);
            // If we got a display string from the font, use it (prioritize over localStorage)
            if (result !== null && result !== undefined && result !== '') {
                console.log(
                    '[TextRun]',
                    '✅ Loaded display string from font:',
                    result
                );
                this.textBuffer = result;
                // Update localStorage to match
                try {
                    localStorage.setItem(
                        'glyphCanvasTextBuffer',
                        this.textBuffer
                    );
                } catch (e) {
                    console.warn(
                        '[TextRun]',
                        'Failed to save text buffer to localStorage:',
                        e
                    );
                }
                // Don't call shapeText() here - let the caller handle it after setFont completes
                // Don't save back to font - we just loaded it from there!
            } else {
                console.log(
                    '[TextRun]',
                    'ℹ️ No display string in font, using current text buffer:',
                    this.textBuffer
                );
                // Font doesn't have a display string, so save the current one (from localStorage or default)
                // This ensures new fonts get the display string saved
                await this.saveTextBufferToFont();
            }
        } catch (e) {
            console.warn(
                '[TextRun]',
                '❌ Failed to load text buffer from font object:',
                e
            );
        }
    }

    // Helper to save text buffer and trigger recompilation
    saveTextBuffer() {
        try {
            localStorage.setItem('glyphCanvasTextBuffer', this.textBuffer);
        } catch (e) {
            console.warn(
                '[TextRun]',
                'Failed to save text buffer to localStorage:',
                e
            );
        }

        // Save to font object via Python
        this.saveTextBufferToFont();

        // Trigger font recompilation (debounced)
        this.call('textchanged');
    }

    // Save text buffer to font.format_specific via Python
    async saveTextBufferToFont() {
        if (!window.pyodide) {
            return; // Python not ready yet
        }

        const textToSave = this.textBuffer || '';
        const appId = window.APP_SETTINGS?.APP_ID;
        const key = `${appId}.display_string`;

        // Escape the text for Python string literal
        const escapedText = textToSave
            .replace(/\\/g, '\\\\')
            .replace(/"/g, '\\"')
            .replace(/\n/g, '\\n')
            .replace(/\r/g, '\\r')
            .replace(/\t/g, '\\t');

        window.fontManager?.setFormatSpecific(key, escapedText);
    }

    shapeText() {
        if (!this.hb || !this.hbFont || !this.textBuffer) {
            this.shapedGlyphs = [];
            this.bidiRuns = [];
            this.call('render');
            return;
        }

        try {
            // Apply variation settings if any
            if (Object.keys(this.axesManager.variationSettings).length > 0) {
                this.hbFont.setVariations(this.axesManager.variationSettings);
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
            this.call('render');
        } catch (error) {
            console.error('Error shaping text:', error);
            this.shapedGlyphs = [];
            this.bidiRuns = [];
            this.call('render');
        }
    }

    shapeTextSimple() {
        // Simple shaping without BiDi support (old behavior)
        const buffer = this.hb.createBuffer();
        buffer.addText(this.textBuffer);
        buffer.guessSegmentProperties();

        // Shape the text with features
        const features = this.featuresManager.getHarfBuzzFeatures();
        if (features) {
            this.hb.shape(this.hbFont, buffer, features);
        } else {
            this.hb.shape(this.hbFont, buffer);
        }

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
            if (
                i === this.textBuffer.length ||
                embedLevels.levels[i] !== currentLevel
            ) {
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

        console.log(
            '[TextRun]',
            'Logical runs:',
            runs.map((r) => `${r.direction}:${r.level}:"${r.text}"`)
        );

        // Shape each run with HarfBuzz in its logical direction
        const features = this.featuresManager.getHarfBuzzFeatures();
        const shapedRuns = [];
        for (const run of runs) {
            const buffer = this.hb.createBuffer();
            buffer.addText(run.text);
            buffer.setDirection(run.direction);
            buffer.guessSegmentProperties();

            if (features) {
                this.hb.shape(this.hbFont, buffer, features);
            } else {
                this.hb.shape(this.hbFont, buffer);
            }
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
        const reorderedIndices = this.bidi.getReorderedIndices(
            this.textBuffer,
            embedLevels
        );

        // For each run, create a map from logical position to glyphs
        const logicalPosToGlyphs = new Map();
        for (const run of shapedRuns) {
            // Group glyphs by their cluster value within this run
            for (const glyph of run.glyphs) {
                const clusterPos = glyph.cl || 0;
                if (!logicalPosToGlyphs.has(clusterPos)) {
                    logicalPosToGlyphs.set(clusterPos, []);
                }
                logicalPosToGlyphs.get(clusterPos).push(glyph);
            }
        }

        // Build visual glyph order by following reordered character indices
        // Track which clusters we've already added to avoid duplicates
        const addedClusters = new Set();
        const allGlyphs = [];

        for (const charIdx of reorderedIndices) {
            // Find the cluster that contains this character position
            // by looking for glyphs with cluster values <= charIdx
            let clusterStart = charIdx;

            // Find the actual cluster start for this character
            for (const [clusterPos, glyphs] of logicalPosToGlyphs) {
                if (clusterPos <= charIdx) {
                    // Check if this cluster might contain our character
                    // by finding the next cluster position
                    let nextClusterPos = this.textBuffer.length;
                    for (const [otherPos, _] of logicalPosToGlyphs) {
                        if (
                            otherPos > clusterPos &&
                            otherPos < nextClusterPos
                        ) {
                            nextClusterPos = otherPos;
                        }
                    }

                    if (charIdx >= clusterPos && charIdx < nextClusterPos) {
                        clusterStart = clusterPos;
                        break;
                    }
                }
            }

            // Add glyphs for this cluster if we haven't already
            if (
                !addedClusters.has(clusterStart) &&
                logicalPosToGlyphs.has(clusterStart)
            ) {
                const glyphs = logicalPosToGlyphs.get(clusterStart);
                allGlyphs.push(...glyphs);
                addedClusters.add(clusterStart);
            }
        }

        this.shapedGlyphs = allGlyphs;
        this.bidiRuns = shapedRuns;

        // Build cluster map for cursor positioning
        this.buildClusterMap();
        this.updateCursorVisualPosition();

        console.log(
            '[TextRun]',
            'Final shaped glyphs:',
            this.shapedGlyphs.length
        );
    }
    _getGlyphPosition(glyphIndex: number) {
        let xPosition = 0;
        for (let i = 0; i < glyphIndex; i++) {
            xPosition += this.shapedGlyphs[i].ax || 0;
        }
        const glyph = this.shapedGlyphs[glyphIndex];
        const xOffset = glyph.dx || 0;
        const yOffset = glyph.dy || 0;
        return { xPosition, xOffset, yOffset };
    }

    get selectedGlyph() {
        if (
            this.selectedGlyphIndex >= 0 &&
            this.selectedGlyphIndex < this.shapedGlyphs.length
        ) {
            return this.shapedGlyphs[this.selectedGlyphIndex];
        }
    }
}
