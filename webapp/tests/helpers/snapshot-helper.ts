/**
 * Test Snapshot Helper
 *
 * Captures comprehensive application state for snapshot testing.
 * Add new data points by extending the AppSnapshot interface and captureSnapshot function.
 */

export interface AppSnapshot {
    timestamp: number;
    label: string;

    // OpenType features and axis locations
    appliedFeatures: any;
    axisLocations: any;

    // Glyph stack and mode
    glyphStack: any;
    isInterpolating: boolean;
    isAnimating: boolean;

    // Canvas state (pan/zoom only - screenshots handled separately)
    canvasPan: { x: number; y: number };
    canvasZoom: number;

    // Text mode
    cursorPosition: number | null;
    textModeActive: boolean;

    // Editing mode
    activeGlyph: string | null;
    editingMode: boolean;

    // Text on canvas
    displayedText: string | null;
}

/**
 * Prepare snapshot for comparison by removing timestamp
 */
export function snapshotForComparison(snapshot: AppSnapshot): string {
    const { timestamp, ...snapshotWithoutTimestamp } = snapshot;
    return JSON.stringify(snapshotWithoutTimestamp, null, 2);
}

/**
 * Capture complete application state snapshot
 * Call this from tests at points where you want to record state
 */
export async function captureSnapshot(
    page: any,
    label: string
): Promise<AppSnapshot> {
    return await page.evaluate((snapshotLabel: string) => {
        // Helper to safely access window properties
        const safeGet = (path: string) => {
            try {
                const parts = path.split('.');
                let obj: any = window;
                for (const part of parts) {
                    obj = obj?.[part];
                }
                return obj;
            } catch {
                return null;
            }
        };

        // Extract SVG representation of canvas
        const glyphCanvas = safeGet('glyphCanvas');
        const textRunEditor = glyphCanvas?.textRunEditor;
        const viewportManager = glyphCanvas?.viewportManager;
        const featuresManager = glyphCanvas?.featuresManager;
        const axesManager = glyphCanvas?.axesManager;

        const snapshot: AppSnapshot = {
            timestamp: Date.now(),
            label: snapshotLabel,

            // OpenType features and axis locations
            appliedFeatures: JSON.parse(
                JSON.stringify(featuresManager?.featureSettings || null)
            ),
            axisLocations: JSON.parse(
                JSON.stringify(axesManager?.variationSettings || null)
            ),

            // Glyph stack and mode
            glyphStack: glyphCanvas?.outlineEditor?.glyphStack || null,
            isInterpolating:
                glyphCanvas?.outlineEditor?.isInterpolating || false,
            isAnimating: glyphCanvas?.outlineEditor?.isAnimating || false,

            // Canvas state (pan/zoom only - screenshots handled separately)
            canvasPan: viewportManager
                ? {
                      x: viewportManager.panX,
                      y: viewportManager.panY
                  }
                : { x: 0, y: 0 },
            canvasZoom: viewportManager?.scale || 1,

            // Text mode
            cursorPosition: textRunEditor?.cursorPosition ?? null,
            textModeActive: textRunEditor?.isTextMode || false,

            // Editing mode
            activeGlyph: glyphCanvas?.outlineEditor?.currentGlyphName || null,
            editingMode: glyphCanvas?.outlineEditor?.active || false,

            // Text on canvas
            displayedText: textRunEditor?.textBuffer || null
        };

        // Ensure everything is JSON-serializable by doing a round-trip
        return JSON.parse(JSON.stringify(snapshot));
    }, label);
}

/**
 * Compare two snapshots and return differences
 * Useful for debugging test failures
 */
export function compareSnapshots(
    snapshot1: AppSnapshot,
    snapshot2: AppSnapshot
): any {
    const differences: any = {};

    const keys = Object.keys(snapshot1) as Array<keyof AppSnapshot>;
    for (const key of keys) {
        if (key === 'timestamp' || key === 'label') continue;

        const val1 = JSON.stringify(snapshot1[key]);
        const val2 = JSON.stringify(snapshot2[key]);

        if (val1 !== val2) {
            differences[key] = {
                before: snapshot1[key],
                after: snapshot2[key]
            };
        }
    }

    return differences;
}

/**
 * Wait for app to be fully loaded (loading overlay hidden)
 */
export async function waitForCanvasReady(page: any) {
    // Wait for loading overlay to be hidden (app fully initialized)
    // WebKit can be slower, so we use a longer timeout
    await page.waitForFunction(
        () => {
            const loadingOverlay = document.getElementById('loading-overlay');
            return (
                loadingOverlay && loadingOverlay.classList.contains('hidden')
            );
        },
        { timeout: 120000 } // 2 minutes for slower browsers like WebKit
    );

    // Additional check to ensure canvas is actually ready
    await page.waitForFunction(
        () => {
            return (
                window.glyphCanvas &&
                window.glyphCanvas.canvas &&
                window.glyphCanvas.renderer
            );
        },
        { timeout: 10000 }
    );
}

/**
 * Wait for font to be loaded
 */
export async function waitForFontLoaded(page: any) {
    await page.waitForFunction(
        () => {
            return window.currentFontModel && window.fontManager?.currentFont;
        },
        { timeout: 15000 }
    );
}

/**
 * Take a complete snapshot (JSON + PNG) with a 100ms wait
 * This wrapper combines both snapshot types and adds a stabilization delay
 */
export async function takeSnapshot(
    page: any,
    snapshotNumber: string,
    label: string,
    expect: any
): Promise<any> {
    // Wait 100ms for rendering to stabilize
    await page.waitForTimeout(100);

    // Capture state snapshot
    const snapshot = await captureSnapshot(page, label);

    // Assert JSON snapshot
    expect(snapshotForComparison(snapshot)).toMatchSnapshot(
        `${snapshotNumber}-${label}.json`
    );

    // Assert PNG screenshot
    await expect(
        page.locator('#glyph-canvas-container canvas')
    ).toHaveScreenshot(`${snapshotNumber}-${label}.png`);

    return snapshot;
}
