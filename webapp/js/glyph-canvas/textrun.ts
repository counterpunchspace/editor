// The text run editor is responsible for
// - holding the Unicode buffer state
// - shaping text and updating a glyph buffer
// - cluster mapping
// - cursor movement
// - selection handling

import { Logger } from '../logger';
import type { FeaturesManager } from './features';
import type { AxesManager } from './variations';
import type { UserspaceLocation } from '../locations';
import APP_SETTINGS from '../settings';
import { recordLiveTextDiagnostic } from '../live-text-diagnostics';
import {
    parseClipboardPayloads,
    readClipboardPayloadsAsync
} from '../clipboard';
import {
    get_glyph_name,
    get_glyph_order
} from '../../wasm-dist/babelfont_fontc_web';
import { collectKerningGroupMemberships } from './kerning-group-widget';
import {
    resolvePreferredKerningPairValue,
    type KerningContainer
} from '../kerning-utils';
import bidiFactory from 'bidi-js';

import {
    markUserTextBufferWritten,
    userTextBufferHasBeenWritten
} from './text-buffer-session';
import {
    applyLineLayoutToGlyphs,
    computeEmLineHeightUnit,
    computeUsedLineHeight,
    DEFAULT_LINE_HEIGHT_PERCENT,
    DEFAULT_TEXT_ALIGN,
    findLineIndexForFontY,
    getShapedGlyphPosition,
    isTextAlign,
    lineBaselineY,
    lineOriginX,
    lineRangeAt,
    normalizeTextNewlines,
    parseLineHeightPercent,
    splitTextLines,
    type TextAlign
} from './text-run-layout';
import { textLayoutControls } from './text-layout-controls';

export { userTextBufferHasBeenWritten };

let console: Logger = new Logger('TextRun');

export interface ShapedGlyph {
    dx: number;
    dy: number;
    ax: number;
    ay: number;
    cl: number; // Cluster
    g: number; // Glyph ID
    explicitGlyphName?: string;
    explicitTokenStart?: number;
    explicitTokenEnd?: number;
    lineIndex?: number;
    lineOriginX?: number;
    baselineY?: number;
}

interface ExplicitGlyphToken {
    name: string;
    start: number;
    end: number;
}

interface ExplicitGlyphOutlineData {
    name: string;
    width?: number;
    shapes?: any[];
    bounds?: {
        xMin: number;
        yMin: number;
        xMax: number;
        yMax: number;
    };
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
    shapingHbFont: any;
    shapingHbFace: any;
    shapingHbBlob: any;
    // Stage 2 output: glyph names in current visual order
    glyphNameBuffer: string[];
    intrinsicGlyphAdvances: Map<string, number>;
    // GID→name map for the editing font (rebuilt when editing font changes)
    editingFontNameToGid: Map<string, number>;
    explicitGlyphTokens: ExplicitGlyphToken[];
    explicitGlyphOutlineCache: Map<string, ExplicitGlyphOutlineData>;
    explicitGlyphOutlinePending: Set<string>;
    explicitGlyphOutlineGeneration: number;
    textBufferWriteGeneration: number;
    displayTextBuffer: string;
    displayIndexToRawStart: number[];
    displayIndexToRawEnd: number[];
    bidi: any;
    bidiRuns: any[];
    selectedGlyphIndex: number;
    cursorPosition: number;
    cursorVisible: boolean;
    cursorBlinkInterval: any;
    cursorX: number;
    cursorY: number;
    clusterMap: any[];
    lineHeightPercent: number;
    textAlign: TextAlign;
    layoutVersion: number;
    embeddingLevels: any;
    callbacks: Record<string, Function[]>;
    selectionStart: number | null;
    selectionEnd: number | null;
    fontBlob: Uint8Array | null;
    shapingFontBlob: Uint8Array | null;
    selectedMasterId: string | null; // Currently selected master ID for text mode rendering
    spaceKeyTimer: number | null; // Timer for space key delay
    spaceKeyPressTime: number | null; // Timestamp when space was pressed
    spaceActivatedPreview: boolean; // Whether space key activated preview mode
    saveTextBufferToFontTimer: any; // Debounce timer for saveTextBufferToFont()
    cursorStyleBeforePreview: string | null; // Cursor style before entering preview mode

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
        this.shapingHbFont = null;
        this.shapingHbFace = null;
        this.shapingHbBlob = null;
        this.fontBlob = null;
        this.shapingFontBlob = null;

        // Stage 2 output
        this.glyphNameBuffer = [];
        this.intrinsicGlyphAdvances = new Map();
        this.editingFontNameToGid = new Map();
        this.explicitGlyphTokens = [];
        this.explicitGlyphOutlineCache = new Map();
        this.explicitGlyphOutlinePending = new Set();
        this.explicitGlyphOutlineGeneration = 0;
        this.textBufferWriteGeneration = 0;
        this.displayTextBuffer = this.textBuffer;
        this.displayIndexToRawStart = [];
        this.displayIndexToRawEnd = [];
        this.layoutVersion = 0;

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
        this.cursorY = 0;
        this.lineHeightPercent = DEFAULT_LINE_HEIGHT_PERCENT;
        this.textAlign = DEFAULT_TEXT_ALIGN;
        this.clusterMap = []; // Maps logical char positions to visual glyph info
        this.embeddingLevels = null; // BiDi embedding levels for cursor logic

        // Selection state
        this.selectionStart = null; // Start of selection (null = no selection)
        this.selectionEnd = null; // End of selection

        // Master selection for text mode
        // Space key delay for preview mode in text mode
        this.spaceKeyTimer = null;
        this.spaceKeyPressTime = null;
        this.spaceActivatedPreview = false;
        this.saveTextBufferToFontTimer = null;
        this.cursorStyleBeforePreview = null;

        this.selectedMasterId = null; // No master selected by default

        this.callbacks = {}; // For notifying GlyphCanvas of updates
        this.applyLayoutSettingsFromState();
    }

    on(event: string, callback: Function) {
        if (!this.callbacks[event]) {
            this.callbacks[event] = [];
        }
        this.callbacks[event].push(callback);
    }

    call(event: string, ...args: any[]) {
        if (this.callbacks[event]) {
            for (const callback of this.callbacks[event]) {
                callback(...args);
            }
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

    private getClusterRangeForGlyphIndex(
        glyphIndex: number
    ): { start: number; end: number } | null {
        for (const cluster of this.clusterMap) {
            const clusterEndIndex = cluster.glyphIndex + cluster.glyphCount;
            if (
                glyphIndex >= cluster.glyphIndex &&
                glyphIndex < clusterEndIndex
            ) {
                return {
                    start: cluster.start,
                    end: cluster.end
                };
            }
        }

        const glyph = this.shapedGlyphs[glyphIndex];
        if (!glyph) {
            return null;
        }

        const start = glyph.explicitTokenStart ?? glyph.cl ?? 0;
        const end = glyph.explicitTokenEnd ?? start + 1;
        return { start, end };
    }

    private findPreferredInsertedGlyphIndex(
        insertStart: number,
        insertEnd: number
    ): number {
        let fallbackIndex = -1;
        let explicitGlyphIndex = -1;

        for (let i = 0; i < this.shapedGlyphs.length; i++) {
            const glyph = this.shapedGlyphs[i];
            const glyphStart = glyph.explicitTokenStart ?? glyph.cl ?? -1;

            if (glyphStart < insertStart || glyphStart >= insertEnd) {
                continue;
            }

            fallbackIndex = i;
            if (glyph.explicitGlyphName) {
                explicitGlyphIndex = i;
            }
        }

        if (explicitGlyphIndex >= 0) {
            return explicitGlyphIndex;
        }

        return fallbackIndex;
    }

    private syncTextBufferToStateManager() {
        if (!window.stateManager) {
            return;
        }

        window.stateManager.editor_text_buffer = this.textBuffer;
    }

    applyLayoutSettingsFromState(): void {
        const lineHeight = parseLineHeightPercent(
            window.stateManager?.editor_line_height
        );
        this.lineHeightPercent =
            lineHeight === null ? DEFAULT_LINE_HEIGHT_PERCENT : lineHeight;
        const align = window.stateManager?.editor_text_align;
        this.textAlign = isTextAlign(align) ? align : DEFAULT_TEXT_ALIGN;
    }

    setLineHeightPercent(percent: number, options?: { skipShape?: boolean }) {
        const numeric = parseLineHeightPercent(percent);
        this.lineHeightPercent =
            numeric === null ? DEFAULT_LINE_HEIGHT_PERCENT : numeric;
        if (window.stateManager) {
            window.stateManager.editor_line_height = this.lineHeightPercent;
        }
        if (!options?.skipShape) {
            this.relayoutLines();
        }
        textLayoutControls.render();
    }

    setTextAlign(align: TextAlign, options?: { skipShape?: boolean }) {
        this.textAlign = isTextAlign(align) ? align : DEFAULT_TEXT_ALIGN;
        if (window.stateManager) {
            window.stateManager.editor_text_align = this.textAlign;
        }
        if (!options?.skipShape) {
            this.relayoutLines();
        }
        textLayoutControls.render();
    }

    getUsedLineHeight(): number {
        return computeUsedLineHeight(
            computeEmLineHeightUnit(window.currentFontModel?.upm),
            this.lineHeightPercent
        );
    }

    getLineCount(): number {
        return splitTextLines(this.textBuffer || '').length;
    }

    getLineRangeAt(position: number) {
        return lineRangeAt(this.textBuffer || '', position);
    }

    getActiveBaselineY(): number {
        const selectedIndex = this.selectedGlyphIndex;
        if (selectedIndex >= 0 && selectedIndex < this.shapedGlyphs.length) {
            return this.shapedGlyphs[selectedIndex].baselineY ?? 0;
        }
        return lineBaselineY(
            this.getLineRangeAt(this.cursorPosition).lineIndex,
            this.getUsedLineHeight()
        );
    }

    relayoutLines() {
        this.applyMultilineLayout();
        this.buildClusterMap();
        this.updateCursorVisualPosition();
        this.call('render');
        this.call('cursormoved');
    }

    setTextBuffer(text: string) {
        this.textBuffer = normalizeTextNewlines(text || '');
        this.textBufferWriteGeneration += 1;
        markUserTextBufferWritten();
        this.syncTextBufferToStateManager();

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

        // Shape text first to populate glyphNameBuffer BEFORE triggering recompilation
        // This ensures the debounced recompile has the correct subset glyph list
        this.shapeText();

        // Trigger font recompilation (debounced) - now glyphNameBuffer is populated
        this.call('textchanged');
    }

    setTextBufferForNavigation(text: string) {
        this.textBuffer = text || '';
        this.textBufferWriteGeneration += 1;
        markUserTextBufferWritten();
        this.syncTextBufferToStateManager();

        // Shape immediately for visual update but do not persist to font/localStorage
        // and do not trigger textchanged (which can cascade into full compile dirtying).
        this.shapeText();
    }

    async selectGlyphByIndex(glyphIndex: number, fromKeyboard = false) {
        // Select a glyph by its index in the shaped glyphs array

        this.call('exitcomponentediting'); // Ensure any component editing is exited

        // Clear text selection when entering edit mode
        // Selection state is preserved but hidden until we exit edit mode
        this.clearSelection();

        // Store the previous index to pass to the event handler
        const previousIndex = this.selectedGlyphIndex;

        if (glyphIndex >= 0 && glyphIndex < this.shapedGlyphs.length) {
            // Update selected glyph index
            this.selectedGlyphIndex = glyphIndex;

            // Dispatch event for URL sync (in editing mode, cursor = glyph index)
            window.dispatchEvent(
                new CustomEvent('editorModeChanged', {
                    detail: { mode: 'edit' }
                })
            );
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

    getGlyphIndexAtClick(glyphX: number, glyphY?: number) {
        if (!this.clusterMap || this.clusterMap.length === 0) {
            return 0;
        }

        const usedLineHeight = this.getUsedLineHeight();
        const lineIndex =
            typeof glyphY === 'number' && Number.isFinite(glyphY)
                ? findLineIndexForFontY(
                      glyphY,
                      this.getLineCount(),
                      usedLineHeight
                  )
                : findLineIndexForFontY(
                      this.cursorY,
                      this.getLineCount(),
                      usedLineHeight
                  );
        const lineClusters = this.clusterMap.filter(
            (cluster) => (cluster.lineIndex ?? 0) === lineIndex
        );
        const clusters =
            lineClusters.length > 0 ? lineClusters : this.clusterMap;

        // Find closest cursor position accounting for RTL. Clicks far left/right
        // of the run snap to the nearest end — same as a normal text editor.
        let closestPos = 0;
        let closestDist = Infinity;

        // Check each cluster
        for (const cluster of clusters) {
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
                if (
                    !cluster.isAtomicCluster &&
                    cluster.end - cluster.start > 1
                ) {
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
                if (
                    !cluster.isAtomicCluster &&
                    cluster.end - cluster.start > 1
                ) {
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

        return closestPos;
    }

    moveCursorToBufferEdge(position: number, withSelection: boolean) {
        if (withSelection) {
            this.extendSelectionTo(position);
        } else {
            this.clearSelection();
            this.cursorPosition = position;
            this.updateCursorVisualPosition();
            this.call('cursormoved');
        }
    }

    moveCursorToLineEdge(edge: 'start' | 'end', withSelection: boolean) {
        const line = this.getLineRangeAt(this.cursorPosition);
        const position = edge === 'start' ? line.start : line.end;
        if (withSelection) {
            this.extendSelectionTo(position);
        } else {
            this.clearSelection();
            this.cursorPosition = position;
            this.updateCursorVisualPosition();
            this.call('cursormoved');
        }
    }

    moveCursorVertically(direction: -1 | 1, withSelection: boolean) {
        const lines = splitTextLines(this.textBuffer || '');
        const currentLine = this.getLineRangeAt(this.cursorPosition);
        const nextIndex = currentLine.lineIndex + direction;
        if (nextIndex < 0 || nextIndex >= lines.length) {
            return;
        }
        const target = this.getGlyphIndexAtClick(
            this.cursorX,
            lineBaselineY(nextIndex, this.getUsedLineHeight())
        );
        if (withSelection) {
            this.extendSelectionTo(target);
        } else {
            this.clearSelection();
            this.cursorPosition = target;
            this.updateCursorVisualPosition();
            this.call('cursormoved');
        }
    }

    moveCursorLogicalBackward() {
        const token = this.findExplicitGlyphTokenForBackspace(
            this.cursorPosition
        );
        if (token) {
            this.cursorPosition = token.start;
            console.log(
                '[TextRun]',
                'Moved to start of explicit glyph token:',
                token
            );
            this.updateCursorVisualPosition();
            return;
        }

        const escapedSlash = this.findEscapedSlashForBackspace(
            this.cursorPosition
        );
        if (escapedSlash) {
            this.cursorPosition = escapedSlash.start;
            this.updateCursorVisualPosition();
            return;
        }

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
        const token = this.findExplicitGlyphTokenForDelete(this.cursorPosition);
        if (token) {
            this.cursorPosition = token.end;
            console.log(
                '[TextRun]',
                'Moved to end of explicit glyph token:',
                token
            );
            this.updateCursorVisualPosition();
            return;
        }

        const escapedSlash = this.findEscapedSlashForDelete(
            this.cursorPosition
        );
        if (escapedSlash) {
            this.cursorPosition = escapedSlash.end;
            this.updateCursorVisualPosition();
            return;
        }

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
        this.call('render');
    }

    moveCursorRight() {
        console.log('=== Move Cursor Right ===');
        this.logCursorState();

        // Right arrow = forward in logical order (increase position)
        this.moveCursorLogicalForward();
        this.call('cursormoved');
        this.call('render');
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

    /**
     * Begin a mouse-driven text selection at `position`.
     * When `extendExisting` is true (Shift-click), keep the current selection
     * anchor (or the caret if there is none) and move only the active end.
     */
    beginMouseSelection(position: number, extendExisting = false) {
        const clamped = Math.max(0, Math.min(position, this.textBuffer.length));
        if (extendExisting) {
            if (this.selectionStart === null) {
                this.selectionStart = this.cursorPosition;
            }
        } else {
            this.selectionStart = clamped;
        }
        this.selectionEnd = clamped;
        this.cursorPosition = clamped;
        this.updateCursorVisualPosition();
        this.call('cursormoved');
    }

    /** Extend the active end of a mouse-driven selection to `position`. */
    extendMouseSelection(position: number) {
        const clamped = Math.max(0, Math.min(position, this.textBuffer.length));
        if (this.selectionStart === null) {
            this.selectionStart = this.cursorPosition;
        }
        if (this.selectionEnd === clamped && this.cursorPosition === clamped) {
            return;
        }
        this.selectionEnd = clamped;
        this.cursorPosition = clamped;
        this.updateCursorVisualPosition();
        this.call('cursormoved');
    }

    /**
     * Finish a mouse-driven selection. Collapsed ranges become a caret only
     * (no highlight), matching standard text editors.
     */
    finishMouseSelection() {
        if (!this.hasSelection()) {
            this.clearSelection();
        }
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
        this.call('render');
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
        this.call('render');
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

    extendSelectionTo(position: number) {
        const clamped = Math.max(0, Math.min(position, this.textBuffer.length));
        if (!this.hasSelection() && this.selectionStart === null) {
            this.selectionStart = this.cursorPosition;
        }
        this.cursorPosition = clamped;
        this.selectionEnd = clamped;
        this.updateCursorVisualPosition();
        this.call('cursormoved');
        this.call('render');
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
            window.glyphCanvas?.rememberClipboardPasteKind?.('text');
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
        const editorFocused = !!document
            .getElementById('view-editor')
            ?.classList.contains('focused');
        if (!editorFocused) {
            return;
        }

        try {
            // Async read so Fontra tagged MIME is visible (readText alone is not).
            const payloads = await readClipboardPayloadsAsync();
            const editorStillFocused = !!document
                .getElementById('view-editor')
                ?.classList.contains('focused');
            if (!editorStillFocused) {
                return;
            }

            // Use the same parser as the outline and overview paste routes so
            // structured layer/glyph documents never enter the text buffer.
            const parsed = parseClipboardPayloads(payloads);
            if (parsed) {
                window.glyphCanvas?.rememberClipboardPasteKind?.(parsed.kind);
                return;
            }

            const text =
                payloads.find((payload) => payload.type === 'text/plain')
                    ?.data ?? (await navigator.clipboard.readText());
            const fallbackParsed = parseClipboardPayloads([
                { type: 'text/plain', data: text }
            ]);
            if (fallbackParsed) {
                window.glyphCanvas?.rememberClipboardPasteKind?.(
                    fallbackParsed.kind
                );
                return;
            }
            if (!text) {
                return;
            }
            window.glyphCanvas?.rememberClipboardPasteKind?.('text');
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
        const inserted = normalizeTextNewlines(text);
        this.textBuffer =
            this.textBuffer.slice(0, this.cursorPosition) +
            inserted +
            this.textBuffer.slice(this.cursorPosition);
        this.cursorPosition += inserted.length;

        this.reshapeAndRender();
    }

    async insertTextAfterSelectedGlyph(text: string) {
        if (
            this.selectedGlyphIndex < 0 ||
            this.selectedGlyphIndex >= this.shapedGlyphs.length
        ) {
            this.insertText(text);
            return;
        }

        const clusterRange = this.getClusterRangeForGlyphIndex(
            this.selectedGlyphIndex
        );
        if (!clusterRange) {
            this.insertText(text);
            return;
        }

        const insertionStart = clusterRange.end;
        this.cursorPosition = insertionStart;
        this.insertText(text);

        const insertedGlyphIndex = this.findPreferredInsertedGlyphIndex(
            insertionStart,
            insertionStart + text.length
        );
        if (insertedGlyphIndex >= 0) {
            await this.selectGlyphByIndex(insertedGlyphIndex);
        }
    }

    /**
     * Insert text at the cursor without letting an incomplete editing subset
     * temporarily replace the active edit target with a `.notdef` glyph.
     */
    insertTextPreservingSelectedGlyph(text: string): void {
        if (
            this.selectedGlyphIndex < 0 ||
            this.selectedGlyphIndex >= this.shapedGlyphs.length
        ) {
            this.insertText(text);
            return;
        }

        const selectedCluster = this.getClusterRangeForGlyphIndex(
            this.selectedGlyphIndex
        );
        const insertionStart = this.cursorPosition;
        if (!selectedCluster || insertionStart > selectedCluster.start) {
            this.insertText(text);
            return;
        }

        // The synchronous reshape uses the current subset, which may not yet
        // contain the inserted Unicode glyph. Hide the selection for that one
        // provisional shape so edit-mode syncing cannot select its GID 0.
        this.selectedGlyphIndex = -1;
        this.insertText(text);

        const shiftedClusterStart = selectedCluster.start + text.length;
        this.selectedGlyphIndex =
            this.findFirstGlyphAtClusterPosition(shiftedClusterStart);
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

            this.reshapeAndRender('backspace');
        } else if (this.cursorPosition > 0) {
            const token = this.findExplicitGlyphTokenForBackspace(
                this.cursorPosition
            );
            if (token) {
                console.log(
                    '[TextRun]',
                    `Deleting explicit glyph token ${token.name} at [${token.start}-${token.end}]`
                );
                this.textBuffer =
                    this.textBuffer.slice(0, token.start) +
                    this.textBuffer.slice(token.end);
                this.cursorPosition = token.start;
                this.reshapeAndRender('backspace');
                return;
            }

            const escapedSlash = this.findEscapedSlashForBackspace(
                this.cursorPosition
            );
            if (escapedSlash) {
                this.textBuffer =
                    this.textBuffer.slice(0, escapedSlash.start) +
                    this.textBuffer.slice(escapedSlash.end);
                this.cursorPosition = escapedSlash.start;
                this.reshapeAndRender('backspace');
                return;
            }

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

            this.reshapeAndRender('backspace');
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
            const token = this.findExplicitGlyphTokenForDelete(
                this.cursorPosition
            );
            if (token) {
                console.log(
                    '[TextRun]',
                    `Deleting explicit glyph token ${token.name} at [${token.start}-${token.end}]`
                );
                this.textBuffer =
                    this.textBuffer.slice(0, token.start) +
                    this.textBuffer.slice(token.end);
                this.cursorPosition = token.start;
                this.reshapeAndRender();
                return;
            }

            const escapedSlash = this.findEscapedSlashForDelete(
                this.cursorPosition
            );
            if (escapedSlash) {
                this.textBuffer =
                    this.textBuffer.slice(0, escapedSlash.start) +
                    this.textBuffer.slice(escapedSlash.end);
                this.cursorPosition = escapedSlash.start;
                this.reshapeAndRender();
                return;
            }

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

    reshapeAndRender(cursorMoveReason?: 'backspace') {
        this.call('willreshape');
        console.log('New cursor position:', this.cursorPosition);
        console.log('New text:', this.textBuffer);

        // Reshape first to populate glyphNameBuffer BEFORE triggering recompilation
        this.shapeText();

        // Save to localStorage and trigger recompilation (now glyphNameBuffer is populated)
        this.saveTextBuffer();

        this.updateCursorVisualPosition();

        // If text is now empty, reset cursor to origin
        if (this.textBuffer.length === 0) {
            this.cursorPosition = 0;
            this.cursorX = 0;
            this.cursorY = 0;
        }

        this.call('cursormoved', cursorMoveReason);
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
        this.clusterMap = [];
        this.layoutVersion++;

        const lines = splitTextLines(this.textBuffer || '');
        const usedLineHeight = this.getUsedLineHeight();
        const glyphsByLine = new Map<number, ShapedGlyph[]>();
        for (const glyph of this.shapedGlyphs || []) {
            const lineIndex = glyph.lineIndex ?? 0;
            const lineGlyphs = glyphsByLine.get(lineIndex) || [];
            lineGlyphs.push(glyph);
            glyphsByLine.set(lineIndex, lineGlyphs);
        }

        const lineWidths = lines.map((_, lineIndex) => {
            const lineGlyphs = glyphsByLine.get(lineIndex) || [];
            return lineGlyphs.reduce((sum, glyph) => sum + (glyph.ax || 0), 0);
        });
        const maxWidth = lineWidths.reduce(
            (max, width) => Math.max(max, width),
            0
        );

        console.log('=== Building Cluster Map ===');
        console.log('Text buffer:', this.textBuffer);

        for (const line of lines) {
            const lineGlyphs = glyphsByLine.get(line.lineIndex) || [];
            const baselineY = lineBaselineY(line.lineIndex, usedLineHeight);
            const originX =
                lineGlyphs[0]?.lineOriginX ??
                lineOriginX(
                    this.textAlign,
                    lineWidths[line.lineIndex] ?? 0,
                    maxWidth
                );
            const clusterValues = new Set<number>();
            for (const glyph of lineGlyphs) {
                clusterValues.add(glyph.cl || 0);
            }
            const sortedClusters = Array.from(clusterValues).sort(
                (a, b) => a - b
            );
            const clusterBounds = new Map<number, number>();
            for (let i = 0; i < sortedClusters.length; i++) {
                const start = sortedClusters[i];
                const nextStart =
                    i < sortedClusters.length - 1
                        ? sortedClusters[i + 1]
                        : line.end;
                clusterBounds.set(start, Math.min(nextStart, line.end));
            }

            let xPosition = originX;
            let glyphOffset = 0;
            while (glyphOffset < lineGlyphs.length) {
                const glyph = lineGlyphs[glyphOffset];
                const clusterStart = glyph.cl || 0;
                const isExplicitToken = !!glyph.explicitGlyphName;
                let clusterWidth = 0;
                let j = glyphOffset;
                while (
                    j < lineGlyphs.length &&
                    (lineGlyphs[j].cl || 0) === clusterStart
                ) {
                    clusterWidth += lineGlyphs[j].ax || 0;
                    j++;
                }

                let clusterEnd =
                    clusterBounds.get(clusterStart) || clusterStart + 1;
                if (
                    isExplicitToken &&
                    typeof glyph.explicitTokenEnd === 'number' &&
                    glyph.explicitTokenEnd > clusterStart
                ) {
                    clusterEnd = Math.min(glyph.explicitTokenEnd, line.end);
                }
                clusterEnd = Math.min(clusterEnd, line.end);

                const isRTL = this.isPositionRTL(clusterStart);
                const globalGlyphIndex = this.shapedGlyphs.indexOf(glyph);
                this.clusterMap.push({
                    glyphIndex: globalGlyphIndex,
                    glyphCount: j - glyphOffset,
                    start: clusterStart,
                    end: clusterEnd,
                    x: xPosition,
                    y: baselineY,
                    width: clusterWidth,
                    lineIndex: line.lineIndex,
                    isRTL: isRTL,
                    isExplicitToken: isExplicitToken,
                    isAtomicCluster:
                        isExplicitToken ||
                        this.isEscapedSlashRange(clusterStart, clusterEnd)
                });
                xPosition += clusterWidth;
                glyphOffset = j;
            }

            if (line.newlineIndex !== null) {
                const lastCluster =
                    this.clusterMap[this.clusterMap.length - 1] || null;
                const isRTL = lastCluster?.isRTL || false;
                const newlineX = isRTL ? originX : xPosition;
                this.clusterMap.push({
                    glyphIndex: -1,
                    glyphCount: 0,
                    start: line.newlineIndex,
                    end: line.newlineIndex + 1,
                    x: newlineX,
                    y: baselineY,
                    width: 0,
                    lineIndex: line.lineIndex,
                    isRTL,
                    isExplicitToken: false,
                    isAtomicCluster: true,
                    isNewline: true
                });
            } else if (lineGlyphs.length === 0) {
                this.clusterMap.push({
                    glyphIndex: -1,
                    glyphCount: 0,
                    start: line.start,
                    end: line.start,
                    x: originX,
                    y: baselineY,
                    width: 0,
                    lineIndex: line.lineIndex,
                    isRTL: false,
                    isExplicitToken: false,
                    isAtomicCluster: true
                });
            }
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
        const caretLine = this.getLineRangeAt(this.cursorPosition);
        this.cursorY = lineBaselineY(
            caretLine.lineIndex,
            this.getUsedLineHeight()
        );

        if (!this.clusterMap || this.clusterMap.length === 0) {
            console.log('No cluster map');
            return;
        }

        // Get glyph names for each cluster for debugging
        // Use glyphNameBuffer instead of looking up GIDs in font manager
        // to avoid GID mismatch issues with subsetted fonts
        const clusterWithNames = this.clusterMap.map((c) => {
            const glyphNames = [];
            for (let i = 0; i < c.glyphCount; i++) {
                const glyphIndex = c.glyphIndex + i;
                const glyphName = this.glyphNameBuffer[glyphIndex];
                if (glyphName) {
                    glyphNames.push(glyphName);
                } else {
                    const glyph = this.shapedGlyphs[glyphIndex];
                    const glyphId = glyph ? glyph.g : '?';
                    glyphNames.push(`GID${glyphId}`);
                }
            }
            return `[${c.start}-${c.end}) @ x=${c.x.toFixed(0)}, RTL=${c.isRTL}, glyphs=[${glyphNames.join(', ')}]`;
        });
        console.log('Cluster map:', clusterWithNames);

        const lineClusters = this.clusterMap.filter(
            (cluster) => (cluster.lineIndex ?? 0) === caretLine.lineIndex
        );

        // Find the cluster that contains or is adjacent to this position
        // Priority: Check if position is the START of a cluster FIRST (more important than END)
        let found = false;

        // First pass: Check if this position is at the START of any cluster
        for (const cluster of lineClusters) {
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
            for (const cluster of lineClusters) {
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
            for (const cluster of lineClusters) {
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

        // RTL live kerning preview may override caret X; LTR uses default edge.
        const kerningCursorX =
            window.glyphCanvas?.getTextModeKerningCursorFontX?.() ?? null;
        if (kerningCursorX !== null && Number.isFinite(kerningCursorX)) {
            this.cursorX = kerningCursorX;
        }
    }

    handleKeyDown(e: KeyboardEvent) {
        // Space bar - start timer to distinguish between typing space and activating preview mode
        if (e.code === 'Space' && !e.metaKey && !e.ctrlKey) {
            e.preventDefault();

            // Ignore key repeats - only handle the first press
            if (this.spaceKeyTimer !== null) {
                return;
            }

            // Record press time
            this.spaceKeyPressTime = Date.now();

            // Start timer for preview mode activation
            const delay = APP_SETTINGS.OUTLINE_EDITOR.PREVIEW_MODE_DELAY;
            this.spaceActivatedPreview = false;
            this.spaceKeyTimer = window.setTimeout(() => {
                // Timer expired - activate preview mode via outline editor
                this.spaceActivatedPreview = true;
                this.call('activatePreviewMode');
            }, delay);

            return;
        }

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

        // Cmd+V / Ctrl+V - Paste text only when #view-editor has .focused.
        // Do not preventDefault when another view is focused — that would
        // suppress the document `paste` event (overview whole-glyph paste).
        if ((e.metaKey || e.ctrlKey) && e.key === 'v') {
            const editorFocused = !!document
                .getElementById('view-editor')
                ?.classList.contains('focused');
            if (!editorFocused) {
                return;
            }
            e.preventDefault();
            this.paste();
            return;
        }

        // Arrow keys without modifier - cursor movement
        if (e.key === 'ArrowLeft' && !e.metaKey && !e.ctrlKey) {
            e.preventDefault();
            if (e.shiftKey) {
                this.moveCursorLeftWithSelection();
            } else {
                this.clearSelection();
                this.moveCursorLeft();
            }
            return;
        }

        if (e.key === 'ArrowRight' && !e.metaKey && !e.ctrlKey) {
            e.preventDefault();
            if (e.shiftKey) {
                this.moveCursorRightWithSelection();
            } else {
                this.clearSelection();
                this.moveCursorRight();
            }
            return;
        }

        if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) {
            e.preventDefault();
            this.insertText('\n');
            return;
        }

        if (e.key === 'ArrowUp' && !e.metaKey && !e.ctrlKey) {
            e.preventDefault();
            this.moveCursorVertically(-1, e.shiftKey);
            return;
        }

        if (e.key === 'ArrowDown' && !e.metaKey && !e.ctrlKey) {
            e.preventDefault();
            this.moveCursorVertically(1, e.shiftKey);
            return;
        }

        // Backspace and Delete
        if (e.key === 'Backspace') {
            e.preventDefault();
            this.deleteBackward();
            return;
        }

        if (e.key === 'Delete') {
            e.preventDefault();
            this.deleteForward();
            return;
        }

        // Home and End keys
        if (e.key === 'Home') {
            e.preventDefault();
            if (e.metaKey || e.ctrlKey) {
                this.moveCursorToBufferEdge(0, e.shiftKey);
                return;
            }
            this.moveCursorToLineEdge('start', e.shiftKey);
            return;
        }

        if (e.key === 'End') {
            e.preventDefault();
            if (e.metaKey || e.ctrlKey) {
                this.moveCursorToBufferEdge(this.textBuffer.length, e.shiftKey);
                return;
            }
            this.moveCursorToLineEdge('end', e.shiftKey);
            return;
        }

        // Regular character input (only if not a modifier key combo)
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
            e.preventDefault();
            if (e.key === '/') {
                // Escape literal slash typing in the raw text buffer.
                // Token parser will resolve "//" back to a single Unicode slash.
                this.insertText('//');
            } else {
                this.insertText(e.key);
            }
            return;
        }

        // Don't prevent default for unhandled keys - let browser shortcuts work
    }

    handleKeyUp(e: KeyboardEvent) {
        // Space bar release - either insert space or exit preview mode
        if (e.code === 'Space') {
            e.preventDefault();
            console.log(
                '[TextRun] Space key released, spaceActivatedPreview:',
                this.spaceActivatedPreview
            );

            // Clear the timer if it hasn't fired yet
            if (this.spaceKeyTimer !== null) {
                clearTimeout(this.spaceKeyTimer);
                this.spaceKeyTimer = null;
            }

            this.spaceKeyPressTime = null;

            // Check if preview mode was activated
            if (this.spaceActivatedPreview) {
                // Long press - deactivate preview mode
                console.log('[TextRun] Long press - deactivating preview mode');
                this.call('deactivatePreviewMode');
                // Reset flag after a short delay to ensure it doesn't get inserted
                setTimeout(() => {
                    this.spaceActivatedPreview = false;
                }, 10);
            } else {
                // Quick press - insert space character
                console.log('[TextRun] Quick press - inserting space');
                this.insertText(' ');
            }

            return;
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

        this.destroyShapingHarfbuzz();
    }

    destroyShapingHarfbuzz() {
        if (this.shapingHbFont) {
            this.shapingHbFont.destroy();
            this.shapingHbFont = null;
        }
        if (this.shapingHbFace) {
            this.shapingHbFace.destroy();
            this.shapingHbFace = null;
        }
        if (this.shapingHbBlob) {
            this.shapingHbBlob.destroy();
            this.shapingHbBlob = null;
        }
        this.shapingFontBlob = null;
    }

    invalidateExplicitGlyphOutlineCache(): void {
        this.explicitGlyphOutlineCache.clear();
        this.explicitGlyphOutlinePending.clear();
        this.explicitGlyphOutlineGeneration += 1;
    }

    async setFont(fontData: Uint8Array, isInitialLoad: boolean = false) {
        console.log(
            '[TextRun]',
            '🔵 TextRunEditor.setFont() called, current textBuffer:',
            this.textBuffer,
            'isInitialLoad:',
            isInitialLoad
        );

        // Clean up old HarfBuzz objects before creating new ones to prevent memory leak
        this.destroyHarfbuzz();
        this.invalidateExplicitGlyphOutlineCache();

        // Store font blob
        this.fontBlob = fontData;

        this.hbBlob = this.hb.createBlob(fontData);
        this.hbFace = this.hb.createFace(this.hbBlob, 0); // 0 = first face
        this.hbFont = this.hb.createFont(this.hbFace);

        console.log('Font loaded into HarfBuzz');

        // Load display string from font only on initial load, not during recompilation
        if (isInitialLoad) {
            await this.loadTextBufferFromFont();
        }

        console.log(
            '[TextRun]',
            '🔵 TextRunEditor.setFont() completed, textBuffer is now:',
            this.textBuffer
        );

        this.rebuildEditingFontNameToGid();
    }

    setShapingFontBlob(fontData: Uint8Array): void {
        this.destroyShapingHarfbuzz();
        this.shapingFontBlob = fontData;
        this.shapingHbBlob = this.hb.createBlob(fontData);
        this.shapingHbFace = this.hb.createFace(this.shapingHbBlob, 0);
        this.shapingHbFont = this.hb.createFont(this.shapingHbFace);

        if (
            this.shapingHbFont &&
            Object.keys(this.axesManager.variationSettings).length > 0
        ) {
            this.shapingHbFont.setVariations(
                this.axesManager.variationSettings
            );
        }
    }

    /**
     * Swap the HarfBuzz font blob without reshaping.
     * Used during interactive outline editing to update glyph outlines
     * while preserving existing shaped text positions (advances, kerning, GPOS).
     * The renderer reads outlines from hbFont.glyphToPath() (fresh) and
     * positions from shapedGlyphs (stale but correct for outline-only changes).
     */
    swapFontBlob(fontData: Uint8Array): void {
        this.destroyHarfbuzz();
        this.invalidateExplicitGlyphOutlineCache();
        this.fontBlob = fontData;
        this.hbBlob = this.hb.createBlob(fontData);
        this.hbFace = this.hb.createFace(this.hbBlob, 0);
        this.hbFont = this.hb.createFont(this.hbFace);

        // Restore variation settings so glyphToPath returns correct outlines
        if (
            this.hbFont &&
            Object.keys(this.axesManager.variationSettings).length > 0
        ) {
            this.hbFont.setVariations(this.axesManager.variationSettings);
        }

        this.rebuildEditingFontNameToGid();
    }

    private getActiveShapingFont(): any {
        return this.shapingHbFont || this.hbFont;
    }

    private ensureShapingFontFromCompiledEditingFont(): void {
        if (this.getActiveShapingFont()) {
            return;
        }
        const compiled = window.fontManager?.editingFont;
        if (!compiled || compiled.length === 0) {
            return;
        }
        this.swapFontBlob(compiled);
    }

    private getActiveShapingFontBlob(): Uint8Array | null {
        return this.shapingFontBlob || this.fontBlob;
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

        if (
            this.textBufferWriteGeneration > 0 ||
            userTextBufferHasBeenWritten()
        ) {
            console.log(
                '[TextRun]',
                'ℹ️ Skipping font display string; the text buffer was already written'
            );
            return;
        }

        try {
            const appId = window.APP_SETTINGS?.APP_ID;
            const key = `${appId}.display_string`;
            const generationAtStart = this.textBufferWriteGeneration;

            console.log(
                '[TextRun]',
                '🔍 Looking for display string with key:',
                key
            );

            const result = window.fontManager?.getFormatSpecific(key);
            // If we got a display string from the font, use it (prioritize over localStorage)
            if (result !== null && result !== undefined && result !== '') {
                if (
                    generationAtStart !== this.textBufferWriteGeneration ||
                    userTextBufferHasBeenWritten()
                ) {
                    console.log(
                        '[TextRun]',
                        'ℹ️ Skipping font display string; the text buffer was already written'
                    );
                    return;
                }
                if (this.textBuffer && this.textBuffer !== result) {
                    console.log(
                        '[TextRun]',
                        'ℹ️ Skipping font display string; live buffer already differs',
                        this.textBuffer,
                        result
                    );
                    return;
                }
                console.log(
                    '[TextRun]',
                    '✅ Loaded display string from font:',
                    result
                );
                this.textBuffer = result;
                this.syncTextBufferToStateManager();
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
        this.syncTextBufferToStateManager();

        try {
            localStorage.setItem('glyphCanvasTextBuffer', this.textBuffer);
        } catch (e) {
            console.warn(
                '[TextRun]',
                'Failed to save text buffer to localStorage:',
                e
            );
        }

        // Debounce save to font object via Python (not time-critical;
        // localStorage already captures the text buffer immediately)
        if (this.saveTextBufferToFontTimer) {
            clearTimeout(this.saveTextBufferToFontTimer);
        }
        this.saveTextBufferToFontTimer = setTimeout(() => {
            this.saveTextBufferToFontTimer = null;
            this.saveTextBufferToFont();
        }, 1000);

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

    shapeText(
        skipRender: boolean = false,
        variationLocation?: UserspaceLocation
    ) {
        this.call('willreshape');
        if (!this.textBuffer) {
            this.shapedGlyphs = [];
            this.bidiRuns = [];
            this.explicitGlyphTokens = [];
            this.intrinsicGlyphAdvances.clear();
            this.buildClusterMap();
            this.updateCursorVisualPosition();
            this.call('render');
            return;
        }

        this.ensureShapingFontFromCompiledEditingFont();

        try {
            const previousExplicitGlyphTokens = [...this.explicitGlyphTokens];
            this.buildDisplayTextMapping();
            this.explicitGlyphTokens = this.parseExplicitGlyphTokens(
                previousExplicitGlyphTokens
            );

            // Single-stage processing with editing font.
            const shapingFont = this.getActiveShapingFont();
            if (shapingFont) {
                const location =
                    variationLocation ?? this.axesManager.variationSettings;
                if (Object.keys(location).length > 0) {
                    shapingFont.setVariations(location);
                    // Keep the drawing font's variations in lockstep so
                    // glyphHAdvance / glyphToPath for explicit tokens track
                    // the same interpolated location as reshaping.
                    if (
                        this.hbFont &&
                        this.hbFont !== shapingFont &&
                        typeof this.hbFont.setVariations === 'function'
                    ) {
                        this.hbFont.setVariations(location);
                    }
                }
                this.shapeLines(shapingFont);
            } else {
                // Explicit /.glyph tokens can still layout and paint from the
                // source model + getGlyphOutlines without a compiled binary.
                this.shapeExplicitGlyphTokensWithoutBinaryFont();
            }

            if (this.textBuffer && this.shapedGlyphs.length === 0) {
                const compiled = window.fontManager?.editingFont;
                if (compiled && compiled.length > 0) {
                    this.swapFontBlob(compiled);
                    const retryFont = this.getActiveShapingFont();
                    if (retryFont) {
                        const retryLocation =
                            variationLocation ??
                            this.axesManager.variationSettings;
                        if (Object.keys(retryLocation).length > 0) {
                            retryFont.setVariations(retryLocation);
                        }
                        this.shapeLines(retryFont);
                    }
                }
            }

            // Seed intrinsic widths from unkerned advances, then fold model
            // kerning into explicit-token adjacencies (HarfBuzz never sees
            // those pairs). Rebuild clusters after so positions match.
            this.rebuildIntrinsicGlyphAdvanceCache();
            if (this.applyModelKerningForExplicitTokenAdjacencies()) {
                this.applyMultilineLayout();
                this.buildClusterMap();
                this.updateCursorVisualPosition();
            }
            recordLiveTextDiagnostic('text.reshape.completed', this, {
                skipRender,
                variationLocation: variationLocation || null
            });

            console.log('Shaped glyphs:', this.shapedGlyphs);
            if (this.bidiRuns.length > 0) {
                console.log('BiDi runs:', this.bidiRuns);
            }

            // Render the result (unless explicitly skipped)
            if (!skipRender) {
                this.call('render');
            }

            // Shaping can change the glyphs adjacent to the current cursor
            // without changing cursorPosition itself, so cursor-dependent UI
            // such as the kerning panel needs an explicit refresh here.
            this.call('cursormoved');

            // Prefetch explicit glyph outlines/advances in background for tokens
            // that are missing in the current editing font subset.
            this.prefetchExplicitGlyphOutlinesForCurrentState();
        } catch (error) {
            console.error('Error shaping text:', error);
            this.shapedGlyphs = [];
            this.bidiRuns = [];
            this.intrinsicGlyphAdvances.clear();
            this.call('render');
        }
    }

    /**
     * Fold object-model kerning into shaped advances for pairs that include at
     * least one explicit `/glyphname` token. Pure text–text pairs keep HarfBuzz
     * GPOS kerning only (no double application).
     *
     * LTR and RTL both adjust the visually-left glyph's `ax` by the preferred
     * model value (same precedence as text-mode overlays). For RTL that is the
     * Second operand; for LTR the First — matching live-preview glyph choice
     * and HB's advance-stream effect after reshape + pan anchor.
     *
     * Must run after `rebuildIntrinsicGlyphAdvanceCache` so kerning is not
     * baked into sidebearing intrinsic baselines.
     *
     * @returns true when any advance changed (caller should rebuild clusters)
     */
    applyModelKerningForExplicitTokenAdjacencies(): boolean {
        if (!this.shapedGlyphs.length) {
            return false;
        }

        const fontModel = window.currentFontModel;
        if (!fontModel?.masters?.length) {
            return false;
        }

        const master =
            (this.selectedMasterId &&
                fontModel.masters.find(
                    (candidate: { id?: string }) =>
                        candidate.id === this.selectedMasterId
                )) ||
            null;
        if (!master) {
            return false;
        }

        let changed = false;

        for (let i = 0; i < this.shapedGlyphs.length - 1; i++) {
            const leftGlyph = this.shapedGlyphs[i];
            const rightGlyph = this.shapedGlyphs[i + 1];
            const leftExplicit = !!leftGlyph.explicitGlyphName;
            const rightExplicit = !!rightGlyph.explicitGlyphName;
            if (!leftExplicit && !rightExplicit) {
                continue;
            }

            const leftCluster = leftGlyph.cl || 0;
            const rightCluster = rightGlyph.cl || 0;
            const leftIsRTL = this.isPositionRTL(leftCluster);
            const rightIsRTL = this.isPositionRTL(rightCluster);
            if (leftIsRTL !== rightIsRTL) {
                continue;
            }
            if ((leftGlyph.lineIndex ?? 0) !== (rightGlyph.lineIndex ?? 0)) {
                continue;
            }

            const leftName =
                leftGlyph.explicitGlyphName || this.glyphNameBuffer[i] || null;
            const rightName =
                rightGlyph.explicitGlyphName ||
                this.glyphNameBuffer[i + 1] ||
                null;
            if (!leftName || !rightName) {
                continue;
            }

            // Kerning first/second are logical pair operands. In LTR visual
            // order that is left→right; in RTL visual order left is Second
            // and right is First.
            const isRTL = leftIsRTL;
            const firstGlyphName = isRTL ? rightName : leftName;
            const secondGlyphName = isRTL ? leftName : rightName;

            const firstKeys = [
                firstGlyphName,
                ...collectKerningGroupMemberships(
                    fontModel.first_kern_groups,
                    firstGlyphName
                ).map((name) => `@${name}`)
            ];
            const secondKeys = [
                secondGlyphName,
                ...collectKerningGroupMemberships(
                    fontModel.second_kern_groups,
                    secondGlyphName
                ).map((name) => `@${name}`)
            ];

            const kerning = (isRTL ? master.kerning_rtl : master.kerning) as
                KerningContainer | undefined;
            const value = resolvePreferredKerningPairValue(
                kerning,
                firstKeys,
                secondKeys
            );
            if (value === null || value === 0) {
                continue;
            }

            leftGlyph.ax = (leftGlyph.ax || 0) + value;
            changed = true;
        }

        return changed;
    }

    /**
     * Layout explicit /.glyphname tokens when no compiled editing font is
     * available for HarfBuzz. Advances come from the source model; outlines
     * are filled asynchronously by prefetchExplicitGlyphOutlinesForCurrentState.
     */
    private shapeExplicitGlyphTokensWithoutBinaryFont() {
        this.bidiRuns = [];
        if (!this.explicitGlyphTokens.length) {
            this.shapedGlyphs = [];
            this.glyphNameBuffer = [];
            this.buildClusterMap();
            this.updateCursorVisualPosition();
            return;
        }

        this.shapedGlyphs = this.explicitGlyphTokens.map((token) => {
            const glyph = this.buildExplicitTokenGlyph(token);
            const line = this.getLineRangeAt(token.start);
            glyph.lineIndex = line.lineIndex;
            return glyph;
        });
        this.glyphNameBuffer = this.explicitGlyphTokens.map(
            (token) => token.name
        );
        this.applyMultilineLayout();
        this.buildClusterMap();
        this.updateCursorVisualPosition();
    }

    private resolveIntrinsicAdvanceForGlyph(
        glyphName: string,
        glyphIndex: number
    ): number | null {
        if (!glyphName) {
            return null;
        }

        const glyph = this.shapedGlyphs[glyphIndex];
        if (glyph?.explicitGlyphName) {
            return this.estimateExplicitGlyphAdvance(glyph.explicitGlyphName);
        }

        const glyphCanvas = window.glyphCanvas;
        const currentGlyphName = glyphCanvas?.outlineEditor?.active
            ? glyphCanvas.getCurrentGlyphName?.()
            : null;
        if (currentGlyphName === glyphName) {
            const currentLayer = (glyphCanvas as any)?.getCurrentLayerModel?.();
            if (currentLayer && Number.isFinite(currentLayer.width)) {
                return currentLayer.width;
            }
        }

        const fontModel = window.currentFontModel;
        const modelGlyph = fontModel?.findGlyph?.(glyphName);
        if (!modelGlyph) {
            return null;
        }

        let layer =
            this.selectedMasterId && modelGlyph.findLayerByMasterId
                ? modelGlyph.findLayerByMasterId(this.selectedMasterId)
                : null;

        if (!layer && modelGlyph.layers && modelGlyph.layers.length > 0) {
            layer = modelGlyph.layers[0];
        }

        if (layer && Number.isFinite(layer.width)) {
            return layer.width;
        }

        return null;
    }

    /**
     * Seed the advance baseline that `refreshGlyphAdvancesLive` measures its
     * deltas against.
     *
     * The baseline MUST come from `glyph.ax` — the value those deltas are
     * applied to. Seeding it from a model layer width instead desynchronises
     * the two, because the object model is recomposed ahead of the compiled
     * font during a live drag. The difference then gets folded into `ax` and
     * persists as a constant per-drag offset (derived glyphs such as an
     * automatically composed `adieresis` showed a fixed phantom RSB, and the
     * viewport pan computed by `computePrecedingAdvanceDelta` inherited the
     * same error). `shapeText` masked it at commit by rebuilding `ax` from the
     * font.
     *
     * `resolveIntrinsicAdvanceForGlyph` remains the fallback for glyphs with no
     * usable shaped advance — notably explicit-name glyphs with `g === 0`,
     * which carry no real font advance and must keep their estimate.
     */
    private rebuildIntrinsicGlyphAdvanceCache(): void {
        this.intrinsicGlyphAdvances.clear();

        for (
            let glyphIndex = 0;
            glyphIndex < this.shapedGlyphs.length;
            glyphIndex++
        ) {
            const glyph = this.shapedGlyphs[glyphIndex];
            const glyphName =
                glyph.explicitGlyphName || this.glyphNameBuffer[glyphIndex];

            if (!glyphName || this.intrinsicGlyphAdvances.has(glyphName)) {
                continue;
            }

            const shapedAdvance = glyph?.ax;
            if (
                !glyph?.explicitGlyphName &&
                typeof shapedAdvance === 'number' &&
                Number.isFinite(shapedAdvance)
            ) {
                this.intrinsicGlyphAdvances.set(glyphName, shapedAdvance);
                continue;
            }

            const intrinsicAdvance = this.resolveIntrinsicAdvanceForGlyph(
                glyphName,
                glyphIndex
            );
            if (
                intrinsicAdvance !== null &&
                Number.isFinite(intrinsicAdvance)
            ) {
                this.intrinsicGlyphAdvances.set(glyphName, intrinsicAdvance);
            }
        }
    }

    buildDisplayTextMapping() {
        const rawText = this.textBuffer || '';
        const displayChars: string[] = [];
        const startMap: number[] = [];
        const endMap: number[] = [];

        let rawIndex = 0;
        while (rawIndex < rawText.length) {
            if (rawText[rawIndex] === '\n') {
                rawIndex += 1;
                continue;
            }

            if (
                rawText[rawIndex] === '/' &&
                rawIndex + 1 < rawText.length &&
                rawText[rawIndex + 1] === '/'
            ) {
                displayChars.push('/');
                startMap.push(rawIndex);
                endMap.push(rawIndex + 2);
                rawIndex += 2;
                continue;
            }

            displayChars.push(rawText[rawIndex]);
            startMap.push(rawIndex);
            endMap.push(rawIndex + 1);
            rawIndex += 1;
        }

        this.displayTextBuffer = displayChars.join('');
        this.displayIndexToRawStart = startMap;
        this.displayIndexToRawEnd = endMap;
    }

    mapDisplayStartToRaw(displayIndex: number): number {
        if (displayIndex >= this.displayIndexToRawStart.length) {
            return this.textBuffer.length;
        }
        return this.displayIndexToRawStart[displayIndex];
    }

    mapDisplayEndToRaw(displayIndex: number): number {
        if (displayIndex >= this.displayIndexToRawEnd.length) {
            return this.textBuffer.length;
        }
        return this.displayIndexToRawEnd[displayIndex];
    }

    /**
     * Rebuild the current glyph-name buffer from the latest shaped glyph stream.
     */
    private rebuildGlyphNameBufferFromShapedGlyphs() {
        const shapingFontBlob = this.getActiveShapingFontBlob();
        if (!shapingFontBlob || !this.shapedGlyphs.length) {
            this.glyphNameBuffer = [];
            return;
        }

        const names: string[] = [];

        for (const glyph of this.shapedGlyphs) {
            if (glyph.explicitGlyphName) {
                names.push(glyph.explicitGlyphName);
                continue;
            }

            if (!Number.isFinite(glyph.g)) {
                continue;
            }

            try {
                const name = get_glyph_name(shapingFontBlob, glyph.g);
                names.push(name || '.notdef');
            } catch (error) {
                console.warn(
                    '[TextRun]',
                    `Failed to resolve glyph name for gid ${glyph.g}:`,
                    error
                );
            }
        }

        this.glyphNameBuffer = names;
    }

    getGlyphNameForGid(gid: number): string {
        if (!Number.isFinite(gid)) {
            return '';
        }

        const shapingFontBlob = this.getActiveShapingFontBlob();
        if (shapingFontBlob) {
            try {
                const resolvedName = get_glyph_name(shapingFontBlob, gid);
                if (resolvedName) {
                    return resolvedName;
                }
            } catch (error) {
                console.warn(
                    '[TextRun]',
                    `Failed to resolve glyph name for gid ${gid}:`,
                    error
                );
            }
        }

        for (const [glyphName, mappedGid] of this.editingFontNameToGid) {
            if (mappedGid === gid) {
                return glyphName;
            }
        }

        return '';
    }

    /**
     * Rebuild the name→GID map from the current editing font bytes.
     * Called when the editing font is reloaded.
     */
    rebuildEditingFontNameToGid() {
        this.editingFontNameToGid.clear();
        if (!this.fontBlob) {
            console.log('rebuildEditingFontNameToGid: no fontBlob, skipping');
            return;
        }
        try {
            const glyphOrder = get_glyph_order(this.fontBlob);
            for (let gid = 0; gid < glyphOrder.length; gid++) {
                this.editingFontNameToGid.set(glyphOrder[gid], gid);
            }
            console.log(
                `Built editing font name→GID map: ${glyphOrder.length} glyphs, sample:`,
                Array.from(this.editingFontNameToGid.entries()).slice(0, 10)
            );
        } catch (e) {
            console.error('Failed to build editing font name→GID map:', e);
        }
    }

    /**
     * Stage 2: Shape text with editing font using BiDi-aware run processing.
     * Splits text into BiDi runs, shapes each separately, then reorders into visual order.
     * This ensures correct rendering of mixed LTR/RTL text.
     */
    shapeStage2WithBiDiRuns() {
        if (!this.hbFont || !this.hb) {
            console.log('Stage 2: skipped (no hbFont or hb)');
            this.shapedGlyphs = [];
            this.buildClusterMap();
            this.updateCursorVisualPosition();
            return;
        }

        if (Object.keys(this.axesManager.variationSettings).length > 0) {
            this.hbFont.setVariations(this.axesManager.variationSettings);
        }

        this.buildDisplayTextMapping();
        this.shapeLines(this.hbFont);
        console.log('Stage 2 shaped glyphs:', this.shapedGlyphs.length);
    }

    isWhitespaceCharacter(char: string): boolean {
        return /\s/.test(char);
    }

    isEscapedSlashAt(text: string, index: number): boolean {
        return (
            index >= 0 &&
            index < text.length - 1 &&
            text[index] === '/' &&
            text[index + 1] === '/'
        );
    }

    isEscapedDisplaySlashAt(displayIndex: number): boolean {
        if (
            displayIndex < 0 ||
            displayIndex >= this.displayIndexToRawStart.length
        ) {
            return false;
        }

        const rawStart = this.displayIndexToRawStart[displayIndex];
        const rawEnd = this.displayIndexToRawEnd[displayIndex];

        if (rawEnd - rawStart < 2) {
            return false;
        }

        return this.isEscapedSlashAt(this.textBuffer || '', rawStart);
    }

    isEscapedSlashRange(start: number, end: number): boolean {
        if (!this.textBuffer) {
            return false;
        }
        return (
            end - start === 2 && this.isEscapedSlashAt(this.textBuffer, start)
        );
    }

    findEscapedSlashForBackspace(
        cursorPosition: number
    ): { start: number; end: number } | null {
        const text = this.textBuffer || '';
        for (let i = 0; i < text.length - 1; i++) {
            if (!this.isEscapedSlashAt(text, i)) {
                continue;
            }
            const start = i;
            const end = i + 2;
            if (cursorPosition > start && cursorPosition <= end) {
                return { start, end };
            }
        }
        return null;
    }

    findEscapedSlashForDelete(
        cursorPosition: number
    ): { start: number; end: number } | null {
        const text = this.textBuffer || '';
        for (let i = 0; i < text.length - 1; i++) {
            if (!this.isEscapedSlashAt(text, i)) {
                continue;
            }
            const start = i;
            const end = i + 2;
            if (cursorPosition >= start && cursorPosition < end) {
                return { start, end };
            }
        }
        return null;
    }

    parseExplicitGlyphTokens(
        previousTokens: ExplicitGlyphToken[] = []
    ): ExplicitGlyphToken[] {
        const tokens: ExplicitGlyphToken[] = [];
        const text = this.displayTextBuffer || '';
        const fontModel = window.currentFontModel;

        if (!text || !fontModel) {
            return tokens;
        }

        const previousTokenByStart = new Map<number, ExplicitGlyphToken>();
        for (const token of previousTokens) {
            previousTokenByStart.set(token.start, token);
        }

        let i = 0;
        while (i < text.length) {
            // A display slash generated from raw "//" is always literal and must
            // never start explicit glyph token parsing.
            if (this.isEscapedDisplaySlashAt(i)) {
                i++;
                continue;
            }

            if (text[i] !== '/') {
                i++;
                continue;
            }

            const start = this.mapDisplayStartToRaw(i);

            const previousToken = previousTokenByStart.get(start);
            if (
                previousToken &&
                this.shouldPreserveAppendedTokenBoundary(
                    previousToken,
                    fontModel
                )
            ) {
                tokens.push(previousToken);
                while (
                    i < text.length &&
                    this.mapDisplayStartToRaw(i) < previousToken.end
                ) {
                    i++;
                }
                continue;
            }

            const nameStart = i + 1;
            let cursor = nameStart;

            while (
                cursor < text.length &&
                text[cursor] !== '/' &&
                !this.isWhitespaceCharacter(text[cursor])
            ) {
                cursor++;
            }

            const name = text.slice(nameStart, cursor);
            if (!name) {
                i = start + 1;
                continue;
            }

            const terminator = cursor < text.length ? text[cursor] : '';
            const hasSlashTerminator = terminator === '/';
            const hasWhitespaceTerminator =
                terminator !== '' && this.isWhitespaceCharacter(terminator);
            const hasEolTerminator = terminator === '';

            // Explicit names are only valid when terminated by slash (next explicit token)
            // or by whitespace (which ends the explicit-token sequence and is not rendered),
            // or by end-of-line.
            if (
                !hasSlashTerminator &&
                !hasWhitespaceTerminator &&
                !hasEolTerminator
            ) {
                i = start + 1;
                continue;
            }

            const glyph = fontModel.findGlyph(name);
            if (!glyph) {
                i = start + 1;
                continue;
            }

            let end = this.mapDisplayStartToRaw(cursor);
            if (hasWhitespaceTerminator) {
                end = this.mapDisplayEndToRaw(cursor);
            } else if (hasEolTerminator) {
                end = this.textBuffer.length;
            }
            tokens.push({ name, start, end });

            if (hasWhitespaceTerminator) {
                i = end;
            } else {
                i = cursor;
            }
        }

        return tokens;
    }

    shouldPreserveAppendedTokenBoundary(
        token: ExplicitGlyphToken,
        fontModel: any
    ): boolean {
        const text = this.textBuffer || '';

        if (token.end <= token.start || token.end >= text.length) {
            return false;
        }

        const expectedTokenText = `/${token.name}`;
        if (text.slice(token.start, token.end) !== expectedTokenText) {
            return false;
        }

        // The token itself must still resolve to a glyph.
        if (!fontModel.findGlyph(token.name)) {
            return false;
        }

        const nextChar = text[token.end];
        if (!nextChar) {
            return false;
        }

        // Preserve boundaries when a previously valid EOL token gets text appended.
        // This keeps the token stable and treats appended text as regular text.
        return nextChar !== '/';
    }

    findExplicitGlyphTokenStartingAt(
        position: number
    ): ExplicitGlyphToken | null {
        for (const token of this.explicitGlyphTokens) {
            if (token.start === position) {
                return token;
            }
        }
        return null;
    }

    findExplicitGlyphTokenForBackspace(
        cursorPosition: number
    ): ExplicitGlyphToken | null {
        for (const token of this.explicitGlyphTokens) {
            if (cursorPosition > token.start && cursorPosition <= token.end) {
                return token;
            }
        }
        return null;
    }

    findExplicitGlyphTokenForDelete(
        cursorPosition: number
    ): ExplicitGlyphToken | null {
        for (const token of this.explicitGlyphTokens) {
            if (cursorPosition >= token.start && cursorPosition < token.end) {
                return token;
            }
        }
        return null;
    }

    findExplicitGlyphTokenByCluster(
        cluster: number
    ): ExplicitGlyphToken | null {
        for (const token of this.explicitGlyphTokens) {
            if (cluster >= token.start && cluster < token.end) {
                return token;
            }
        }
        return null;
    }

    getCurrentVariationLocationSnapshot(): import('../locations').UserspaceLocation {
        const location: import('../locations').UserspaceLocation = {};
        const settings = this.axesManager?.variationSettings || {};
        const keys = Object.keys(settings).sort();

        for (const key of keys) {
            location[key] = settings[key];
        }

        return location;
    }

    serializeVariationLocation(
        location: import('../locations').UserspaceLocation
    ): string {
        const keys = Object.keys(location).sort();
        const normalized: Record<string, number> = {};
        for (const key of keys) {
            normalized[key] = Number(location[key]);
        }
        return JSON.stringify(normalized);
    }

    getCurrentVariationLocationKey(): string {
        return this.serializeVariationLocation(
            this.getCurrentVariationLocationSnapshot()
        );
    }

    makeExplicitGlyphCacheKey(glyphName: string, locationKey: string): string {
        return `${glyphName}|${locationKey}`;
    }

    getCachedExplicitGlyphOutline(
        glyphName: string
    ): ExplicitGlyphOutlineData | null {
        const key = this.makeExplicitGlyphCacheKey(
            glyphName,
            this.getCurrentVariationLocationKey()
        );
        return this.explicitGlyphOutlineCache.get(key) || null;
    }

    getCachedExplicitGlyphAdvance(glyphName: string): number | null {
        const outline = this.getCachedExplicitGlyphOutline(glyphName);
        if (outline && typeof outline.width === 'number') {
            return outline.width;
        }
        return null;
    }

    refreshGlyphAdvanceDeltasLive(
        glyphAdvanceDeltas: Record<string, number>,
        options: { render?: boolean } = {}
    ): boolean {
        const glyphAdvances: Record<string, number> = {};

        for (const [glyphName, advanceDelta] of Object.entries(
            glyphAdvanceDeltas
        )) {
            if (
                !Number.isFinite(advanceDelta) ||
                Math.abs(advanceDelta) <= 0.01
            ) {
                continue;
            }

            const intrinsicAdvance = this.intrinsicGlyphAdvances.get(glyphName);
            if (
                typeof intrinsicAdvance !== 'number' ||
                !Number.isFinite(intrinsicAdvance)
            ) {
                continue;
            }

            glyphAdvances[glyphName] = intrinsicAdvance + advanceDelta;
        }

        if (Object.keys(glyphAdvances).length === 0) {
            return false;
        }

        return this.refreshGlyphAdvancesLive(glyphAdvances, options);
    }

    refreshGlyphAdvancesLive(
        glyphAdvances: Record<string, number>,
        options: { render?: boolean } = {}
    ): boolean {
        recordLiveTextDiagnostic('text.advance-refresh.requested', this, {
            glyphAdvances: { ...glyphAdvances },
            render: options.render !== false
        });
        if (!this.shapedGlyphs || this.shapedGlyphs.length === 0) {
            return false;
        }

        let metricsChanged = false;
        const advanceDeltas = new Map<string, number>();

        for (const [glyphName, nextAdvance] of Object.entries(glyphAdvances)) {
            if (!Number.isFinite(nextAdvance)) {
                continue;
            }

            const previousIntrinsicAdvance =
                this.intrinsicGlyphAdvances.get(glyphName);
            if (
                previousIntrinsicAdvance === undefined ||
                !Number.isFinite(previousIntrinsicAdvance)
            ) {
                continue;
            }

            const advanceDelta = nextAdvance - previousIntrinsicAdvance;
            if (Math.abs(advanceDelta) <= 0.01) {
                continue;
            }

            advanceDeltas.set(glyphName, advanceDelta);
            this.intrinsicGlyphAdvances.set(glyphName, nextAdvance);
        }

        if (advanceDeltas.size === 0) {
            return false;
        }

        for (
            let glyphIndex = 0;
            glyphIndex < this.shapedGlyphs.length;
            glyphIndex++
        ) {
            const glyph = this.shapedGlyphs[glyphIndex];
            const glyphName =
                glyph.explicitGlyphName || this.glyphNameBuffer[glyphIndex];

            if (!glyphName) {
                continue;
            }

            const advanceDelta = advanceDeltas.get(glyphName);
            if (advanceDelta === undefined || !Number.isFinite(advanceDelta)) {
                continue;
            }

            glyph.ax = (glyph.ax || 0) + advanceDelta;
            metricsChanged = true;
        }

        if (!metricsChanged) {
            return false;
        }

        recordLiveTextDiagnostic('text.advance-refresh.applied', this, {
            glyphAdvances: { ...glyphAdvances },
            advanceDeltas: Object.fromEntries(advanceDeltas),
            render: options.render !== false
        });

        this.buildClusterMap();
        this.updateCursorVisualPosition();
        if (options.render !== false) {
            this.call('render');
        }
        return true;
    }

    async prefetchExplicitGlyphOutlinesForCurrentState() {
        if (!this.shapedGlyphs || this.shapedGlyphs.length === 0) {
            return;
        }

        // Drag-time editing compiles share the same worker as explicit-token
        // outline prefetch. Let the live editing compile win and refill any
        // missing token outlines after the drag settles.
        if (window.glyphCanvas?.outlineEditor?.draggingSomething) {
            return;
        }

        const fontComp = (window as any).fontCompilation;
        if (!fontComp || typeof fontComp.sendMessage !== 'function') {
            return;
        }

        const locationSnapshot = this.getCurrentVariationLocationSnapshot();
        const locationKey = this.serializeVariationLocation(locationSnapshot);
        const requestGeneration = this.explicitGlyphOutlineGeneration;

        const glyphNamesToFetch = new Set<string>();
        for (const glyph of this.shapedGlyphs) {
            if (!glyph.explicitGlyphName) {
                continue;
            }

            // Only prefetch when explicit token isn't available in the current editing font subset.
            if (glyph.g !== 0) {
                continue;
            }

            const cacheKey = this.makeExplicitGlyphCacheKey(
                glyph.explicitGlyphName,
                locationKey
            );
            if (this.explicitGlyphOutlineCache.has(cacheKey)) {
                continue;
            }
            if (this.explicitGlyphOutlinePending.has(cacheKey)) {
                continue;
            }

            glyphNamesToFetch.add(glyph.explicitGlyphName);
        }

        if (!glyphNamesToFetch.size) {
            return;
        }

        const requestedNames = Array.from(glyphNamesToFetch);
        for (const glyphName of requestedNames) {
            this.explicitGlyphOutlinePending.add(
                this.makeExplicitGlyphCacheKey(glyphName, locationKey)
            );
        }

        try {
            const response = await fontComp.sendMessage({
                type: 'getGlyphOutlines',
                glyphNames: requestedNames,
                location: locationSnapshot,
                flattenComponents: true
            });

            if (response?.error) {
                console.warn(
                    '[TextRun]',
                    'Explicit glyph outline prefetch failed:',
                    response.error
                );
                return;
            }

            const outlines: ExplicitGlyphOutlineData[] = JSON.parse(
                response.outlinesJson || '[]'
            );

            if (this.explicitGlyphOutlineGeneration !== requestGeneration) {
                return;
            }

            for (const outline of outlines) {
                if (!outline?.name) {
                    continue;
                }
                const cacheKey = this.makeExplicitGlyphCacheKey(
                    outline.name,
                    locationKey
                );
                this.explicitGlyphOutlineCache.set(cacheKey, outline);
            }

            // Always merge the received outlines into the cache (they are
            // keyed by their own location, so future reads at that location
            // are O(1)). Only attempt to patch the live shapedGlyphs widths
            // and trigger a re-render when the worker's location still
            // matches the current variation location — otherwise a newer
            // shapeText() pass will seed widths via synchronous Rust
            // interpolation.
            const isSameLocation =
                this.getCurrentVariationLocationKey() === locationKey;
            if (!isSameLocation) {
                return;
            }

            const requestedSet = new Set(requestedNames);
            let metricsChanged = false;
            let visibleTokenFound = false;

            for (const glyph of this.shapedGlyphs) {
                const explicitName = glyph.explicitGlyphName;
                if (!explicitName || !requestedSet.has(explicitName)) {
                    continue;
                }

                visibleTokenFound = true;

                if (glyph.g !== 0) {
                    continue;
                }

                const cached = this.explicitGlyphOutlineCache.get(
                    this.makeExplicitGlyphCacheKey(explicitName, locationKey)
                );
                if (!cached || typeof cached.width !== 'number') {
                    continue;
                }

                const previousAdvance = glyph.ax || 0;
                if (Math.abs(previousAdvance - cached.width) > 0.01) {
                    glyph.ax = cached.width;
                    this.intrinsicGlyphAdvances.set(explicitName, cached.width);
                    metricsChanged = true;
                }
            }

            if (metricsChanged) {
                this.buildClusterMap();
                this.updateCursorVisualPosition();
            }

            if (visibleTokenFound) {
                this.call('render');
            }
        } catch (error) {
            console.warn(
                '[TextRun]',
                'Error during explicit glyph outline prefetch:',
                error
            );
        } finally {
            for (const glyphName of requestedNames) {
                this.explicitGlyphOutlinePending.delete(
                    this.makeExplicitGlyphCacheKey(glyphName, locationKey)
                );
            }
        }
    }

    /**
     * Prefer the compiled editing font's variation-aware advance for explicit
     * /.name tokens that are present in the subset. This is what lets layer /
     * master switch animation update `/A` spacing the same way typed glyphs do.
     * Display-string shaping of `/A` itself cannot be reused: HarfBuzz shapes
     * the slash and name characters, not the named glyph.
     */
    private resolveExplicitGlyphAdvanceFromBinaryFont(
        glyphName: string
    ): number | null {
        const gid = this.editingFontNameToGid.get(glyphName);
        if (gid === undefined || gid === 0) {
            return null;
        }

        const fonts = [this.hbFont, this.getActiveShapingFont()];
        for (const font of fonts) {
            if (!font || typeof font.glyphHAdvance !== 'function') {
                continue;
            }
            const advance = font.glyphHAdvance(gid);
            if (typeof advance === 'number' && Number.isFinite(advance)) {
                return advance;
            }
        }

        return null;
    }

    private resolveExplicitGlyphAdvanceFromModel(
        glyphName: string
    ): number | null {
        const outlineEditor = window.glyphCanvas?.outlineEditor;
        if (
            outlineEditor?.active &&
            window.glyphCanvas?.getCurrentGlyphName?.() === glyphName
        ) {
            const liveWidth = outlineEditor.layerData?.width;
            if (typeof liveWidth === 'number' && Number.isFinite(liveWidth)) {
                return liveWidth;
            }
        }

        const fontModel = window.currentFontModel;
        if (!fontModel) {
            return null;
        }

        const glyph = fontModel.findGlyph(glyphName);
        if (!glyph) {
            return null;
        }

        const selectedMasterLayer =
            this.selectedMasterId && glyph.findLayerByMasterId
                ? glyph.findLayerByMasterId(this.selectedMasterId)
                : null;
        if (
            selectedMasterLayer &&
            typeof selectedMasterLayer.width === 'number'
        ) {
            return selectedMasterLayer.width;
        }

        const matchingLayer = outlineEditor?.findMatchingLayer?.(glyphName);
        if (matchingLayer && typeof matchingLayer.width === 'number') {
            return matchingLayer.width;
        }

        const fallbackLayer = glyph.layers?.[0];
        if (fallbackLayer && typeof fallbackLayer.width === 'number') {
            return fallbackLayer.width;
        }

        return null;
    }

    estimateExplicitGlyphAdvance(glyphName: string): number {
        const binaryAdvance =
            this.resolveExplicitGlyphAdvanceFromBinaryFont(glyphName);
        if (binaryAdvance !== null) {
            return binaryAdvance;
        }

        const cachedAdvance = this.getCachedExplicitGlyphAdvance(glyphName);
        if (cachedAdvance !== null) {
            return cachedAdvance;
        }

        const modelAdvance =
            this.resolveExplicitGlyphAdvanceFromModel(glyphName);
        if (modelAdvance !== null) {
            return modelAdvance;
        }

        return 250;
    }

    buildExplicitTokenGlyph(token: ExplicitGlyphToken): ShapedGlyph {
        const gid = this.editingFontNameToGid.get(token.name);
        return {
            dx: 0,
            dy: 0,
            ax: this.estimateExplicitGlyphAdvance(token.name),
            ay: 0,
            cl: token.start,
            g: gid ?? 0,
            explicitGlyphName: token.name,
            explicitTokenStart: token.start,
            explicitTokenEnd: token.end
        };
    }

    mergeExplicitGlyphTokensIntoShapedGlyphs(
        shapedGlyphs: ShapedGlyph[]
    ): ShapedGlyph[] {
        if (!this.explicitGlyphTokens.length) {
            return shapedGlyphs;
        }

        const merged: ShapedGlyph[] = [];
        const emittedTokenStarts = new Set<number>();

        for (const glyph of shapedGlyphs) {
            const cluster = glyph.cl || 0;
            const token = this.findExplicitGlyphTokenByCluster(cluster);

            if (!token) {
                merged.push(glyph);
                continue;
            }

            if (!emittedTokenStarts.has(token.start)) {
                merged.push(this.buildExplicitTokenGlyph(token));
                emittedTokenStarts.add(token.start);
            }
        }

        // Handle tokens that produced no clusters in the shaped stream
        for (const token of this.explicitGlyphTokens) {
            if (emittedTokenStarts.has(token.start)) {
                continue;
            }

            const tokenGlyph = this.buildExplicitTokenGlyph(token);
            let insertionIndex = merged.findIndex(
                (glyph) => (glyph.cl || 0) > token.start
            );
            if (insertionIndex < 0) {
                insertionIndex = merged.length;
            }
            merged.splice(insertionIndex, 0, tokenGlyph);
        }

        return merged;
    }

    displayRangeForRawRange(
        rawStart: number,
        rawEnd: number
    ): { start: number; end: number } {
        let start = this.displayIndexToRawStart.length;
        let end = this.displayIndexToRawStart.length;
        for (let i = 0; i < this.displayIndexToRawStart.length; i++) {
            const raw = this.displayIndexToRawStart[i];
            if (raw >= rawStart && raw < rawEnd) {
                if (start === this.displayIndexToRawStart.length) {
                    start = i;
                }
                end = i + 1;
            }
        }
        if (start > end) {
            return { start: 0, end: 0 };
        }
        return { start, end };
    }

    applyMultilineLayout() {
        const lines = splitTextLines(this.textBuffer || '');
        applyLineLayoutToGlyphs(
            this.shapedGlyphs,
            lines.length,
            this.getUsedLineHeight(),
            this.textAlign
        );
    }

    shapeLines(hbFont: any) {
        const lines = splitTextLines(this.textBuffer || '');
        const allGlyphs: ShapedGlyph[] = [];
        const allBidiRuns: any[] = [];
        this.embeddingLevels = {
            levels: new Array(this.displayTextBuffer.length).fill(0)
        };

        for (const line of lines) {
            const displayRange = this.displayRangeForRawRange(
                line.start,
                line.end
            );
            const lineGlyphs = this.bidi
                ? this.shapeDisplaySliceWithBidi(
                      hbFont,
                      displayRange.start,
                      displayRange.end,
                      allBidiRuns
                  )
                : this.shapeDisplaySliceSimple(
                      hbFont,
                      displayRange.start,
                      displayRange.end
                  );
            for (const glyph of lineGlyphs) {
                glyph.lineIndex = line.lineIndex;
            }
            allGlyphs.push(...lineGlyphs);
        }

        this.shapedGlyphs =
            this.mergeExplicitGlyphTokensIntoShapedGlyphs(allGlyphs);
        for (const glyph of this.shapedGlyphs) {
            if (glyph.lineIndex === undefined) {
                glyph.lineIndex = this.getLineRangeAt(glyph.cl || 0).lineIndex;
            }
        }
        this.bidiRuns = allBidiRuns;
        this.rebuildGlyphNameBufferFromShapedGlyphs();
        this.applyMultilineLayout();
        this.buildClusterMap();
        this.updateCursorVisualPosition();
    }

    shapeDisplaySliceSimple(
        hbFont: any,
        displayStart: number,
        displayEnd: number
    ): ShapedGlyph[] {
        const displayText = this.displayTextBuffer.slice(
            displayStart,
            displayEnd
        );
        if (!displayText) {
            return [];
        }

        const buffer = this.hb.createBuffer();
        buffer.addText(displayText);
        buffer.guessSegmentProperties();
        const features = this.featuresManager.getHarfBuzzFeatures();
        if (features) {
            this.hb.shape(hbFont, buffer, features);
        } else {
            this.hb.shape(hbFont, buffer);
        }
        const glyphs = buffer.json() as ShapedGlyph[];
        buffer.destroy();
        for (const glyph of glyphs) {
            glyph.cl = this.mapDisplayStartToRaw(
                (glyph.cl || 0) + displayStart
            );
        }
        return glyphs;
    }

    shapeDisplaySliceWithBidi(
        hbFont: any,
        displayStart: number,
        displayEnd: number,
        allBidiRuns: any[]
    ): ShapedGlyph[] {
        const displayText = this.displayTextBuffer.slice(
            displayStart,
            displayEnd
        );
        if (!displayText) {
            return [];
        }

        const embedLevels = this.bidi.getEmbeddingLevels(displayText);
        for (let i = 0; i < embedLevels.levels.length; i++) {
            this.embeddingLevels.levels[displayStart + i] =
                embedLevels.levels[i];
        }

        const runs: any[] = [];
        let currentLevel = embedLevels.levels[0];
        let runStart = 0;
        for (let i = 1; i <= displayText.length; i++) {
            if (
                i === displayText.length ||
                embedLevels.levels[i] !== currentLevel
            ) {
                const runText = displayText.substring(runStart, i);
                const direction = currentLevel % 2 === 0 ? 'ltr' : 'rtl';
                const absoluteStart = displayStart + runStart;
                const absoluteEnd = displayStart + i;
                runs.push({
                    text: runText,
                    level: currentLevel,
                    direction: direction,
                    displayStart: absoluteStart,
                    displayEnd: absoluteEnd,
                    start: this.mapDisplayStartToRaw(absoluteStart),
                    end: this.mapDisplayStartToRaw(absoluteEnd)
                });
                if (i < displayText.length) {
                    currentLevel = embedLevels.levels[i];
                    runStart = i;
                }
            }
        }

        const features = this.featuresManager.getHarfBuzzFeatures();
        const shapedRuns: any[] = [];
        for (const run of runs) {
            const buffer = this.hb.createBuffer();
            buffer.addText(run.text);
            buffer.setDirection(run.direction);
            buffer.guessSegmentProperties();
            if (features) {
                this.hb.shape(hbFont, buffer, features);
            } else {
                this.hb.shape(hbFont, buffer);
            }
            const glyphs = buffer.json();
            buffer.destroy();
            for (const glyph of glyphs) {
                glyph.cl = (glyph.cl || 0) + run.displayStart;
            }
            shapedRuns.push({
                ...run,
                glyphs
            });
        }

        const reorderedIndices = this.bidi.getReorderedIndices(
            displayText,
            embedLevels
        );
        const logicalPosToGlyphs = new Map();
        for (const run of shapedRuns) {
            for (const glyph of run.glyphs) {
                const clusterPos = glyph.cl || 0;
                if (!logicalPosToGlyphs.has(clusterPos)) {
                    logicalPosToGlyphs.set(clusterPos, []);
                }
                logicalPosToGlyphs.get(clusterPos).push(glyph);
            }
        }

        const addedClusters = new Set();
        const allGlyphs: any[] = [];
        for (const localIdx of reorderedIndices) {
            const charIdx = displayStart + localIdx;
            let clusterStart = charIdx;
            for (const [clusterPos] of logicalPosToGlyphs) {
                if (clusterPos <= charIdx) {
                    let nextClusterPos = displayEnd;
                    for (const [otherPos] of logicalPosToGlyphs) {
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
            if (
                !addedClusters.has(clusterStart) &&
                logicalPosToGlyphs.has(clusterStart)
            ) {
                allGlyphs.push(...logicalPosToGlyphs.get(clusterStart));
                addedClusters.add(clusterStart);
            }
        }

        for (const glyph of allGlyphs) {
            glyph.cl = this.mapDisplayStartToRaw(glyph.cl || 0);
        }
        allBidiRuns.push(...shapedRuns);
        return allGlyphs;
    }

    _getGlyphPosition(glyphIndex: number) {
        return getShapedGlyphPosition(this.shapedGlyphs, glyphIndex);
    }

    computePrecedingAdvanceDelta(
        glyphAdvances: Record<string, number>
    ): number {
        if (
            !this.shapedGlyphs ||
            this.shapedGlyphs.length === 0 ||
            this.selectedGlyphIndex <= 0
        ) {
            return 0;
        }

        const selectedLine =
            this.shapedGlyphs[this.selectedGlyphIndex]?.lineIndex ?? 0;
        let delta = 0;
        const limit = Math.min(
            this.selectedGlyphIndex,
            this.shapedGlyphs.length
        );
        for (let i = 0; i < limit; i++) {
            const glyph = this.shapedGlyphs[i];
            if ((glyph.lineIndex ?? 0) !== selectedLine) {
                continue;
            }
            const name = glyph.explicitGlyphName || this.glyphNameBuffer[i];
            if (!name) continue;

            const newAdvance = glyphAdvances[name];
            if (!Number.isFinite(newAdvance)) continue;

            const previousIntrinsicAdvance =
                this.intrinsicGlyphAdvances.get(name) ?? (glyph.ax || 0);
            delta += newAdvance - previousIntrinsicAdvance;
        }
        return delta;
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
