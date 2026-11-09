import { test, expect } from './fixtures';
import { type Page } from '@playwright/test';
import {
    focusView,
    openFileFromFilesView,
    waitForCanvasReady,
    waitForEditingFontBytes,
    waitForOpenSessionReady,
    waitForPredicate,
    waitForShapedTextBuffer
} from './helpers/snapshot-helper';

const PYTHON_MODEL_ACCESS_PROBE = `
import json

font = Font()
master = font.masters[0]
glyph = font.glyphs[0]
layer = glyph.layers[0]

if "A:V" not in master.kerning:
    master.kerning["A:V"] = 0
master.kerning["A:V"] = -80
master.kerning_rtl["reh-ar:alef-ar"] = -80

original_family = font.names.family_name.dflt
font.names.family_name.dflt = "PyAccessTest"
family_written = font.names.family_name.dflt
font.names.family_name.dflt = original_family

original_master_name = master.name.dflt
master.name.dflt = "ProbeMaster"
master_name_written = master.name.dflt
master.name.dflt = original_master_name

axis = font.axes[0] if font.axes else None
axis_name = None
axis_name_repr = None
if axis is not None:
    axis_name_repr = repr(axis.name)
    axis_name = axis.name.dflt

anchor_lookup_error = None
try:
    _ = layer.anchors
except Exception as error:
    anchor_lookup_error = f"{type(error).__name__}: {error}"

glyph_anchor_lookup_error = None
try:
    _ = glyph.anchors
except Exception as error:
    glyph_anchor_lookup_error = f"{type(error).__name__}: {error}"

name_repr = repr(master.name)
location_repr = repr(master.location)
metrics_repr = repr(master.metrics)
names_repr = repr(font.names)
family_repr = repr(font.names.family_name)
joined_repr = name_repr + location_repr + metrics_repr + names_repr + family_repr

json.dumps({
    "name_type": type(master.name).__name__,
    "location_type": type(master.location).__name__,
    "metrics_type": type(master.metrics).__name__,
    "names_type": type(font.names).__name__,
    "family_name_type": type(font.names.family_name).__name__,
    "kerning_type": type(master.kerning).__name__,
    "name_dflt": master.name.dflt,
    "master_name_written": master_name_written,
    "name_repr": name_repr,
    "name_str": str(master.name),
    "name_to_py_type": type(master.name.to_py()).__name__,
    "name_to_py": master.name.to_py(),
    "location_repr": location_repr,
    "location_wght": master.location.wght,
    "location_to_py": master.location.to_py(),
    "metrics_repr": metrics_repr,
    "metrics_xheight": master.metrics.XHeight,
    "metrics_keys": list(master.metrics),
    "family_name_dflt": font.names.family_name.dflt,
    "family_written": family_written,
    "kerning_av": master.kerning["A:V"],
    "kerning_as_dict": master.kerning.as_dict(),
    "kerning_rtl": master.kerning_rtl["reh-ar:alef-ar"],
    "axis_name": axis_name,
    "axis_name_repr": axis_name_repr,
    "layer_anchors_type": type(layer.anchors).__name__,
    "glyph_anchors_type": type(glyph.anchors).__name__,
    "anchor_lookup_error": anchor_lookup_error,
    "glyph_anchor_lookup_error": glyph_anchor_lookup_error,
    "contains_object_object": "[object Object]" in joined_repr,
    "contains_jsproxy": "JsProxy" in joined_repr or "pyodide" in joined_repr,
})
`;

async function waitForLivePython(page: Page): Promise<void> {
    await waitForPredicate(
        page,
        () => {
            const win = window as any;
            return (
                win.__fontEditorReadyState === 'ready' &&
                typeof win.pyodide?.runPythonAsync === 'function' &&
                win.pyodide?.__counterpunchPythonExecutionWrapperInstalled ===
                    true &&
                !!win.currentFontModel
            );
        },
        180000
    );
}

async function runPythonJson(
    page: Page,
    code: string
): Promise<Record<string, unknown>> {
    return page.evaluate(async (pythonCode: string) => {
        const win = window as any;
        const result = await win.pyodide.runPythonAsync(pythonCode);
        if (typeof result === 'string') {
            return JSON.parse(result);
        }
        if (result && typeof result.toJs === 'function') {
            const converted = result.toJs({
                dict_converter: Object.fromEntries
            });
            result.destroy?.();
            return converted;
        }
        return result;
    }, code);
}

async function enterFustatNodeEditLayer(page: Page): Promise<void> {
    await page.evaluate(async () => {
        const win = window as any;
        const glyphCanvas = win.glyphCanvas;
        const textRunEditor = glyphCanvas?.textRunEditor;
        const outlineEditor = glyphCanvas?.outlineEditor;
        const axesManager = glyphCanvas?.axesManager;
        const stateManager = win.stateManager;
        const fontManager = win.fontManager;

        if (!glyphCanvas || !textRunEditor || !outlineEditor || !axesManager) {
            throw new Error('Missing Fustat node-edit layer dependencies');
        }

        if (stateManager) {
            stateManager.editor_text_buffer = 'oö';
            stateManager.editor_cursor_position = 0;
            stateManager.editor_mode = 'edit';
            stateManager.editor_variation_location = { wght: 200 };
        }
        if (fontManager) {
            fontManager.currentText = 'oö';
            fontManager.updateEditingSubsetSnapshot?.(['o']);
        }

        textRunEditor.setTextBuffer('oö');
        outlineEditor.currentGlyphName = 'o';
        if (typeof axesManager.setAxisValue === 'function') {
            axesManager.setAxisValue('wght', 200);
            axesManager.updateAxisSliders?.();
        } else {
            axesManager.variationSettings = { wght: 200 };
        }
        await glyphCanvas.doUIUpdateAsync?.();
    });

    await waitForShapedTextBuffer(page, 'oö');

    await page.evaluate(async () => {
        const glyphCanvas = (window as any).glyphCanvas;
        const textRunEditor = glyphCanvas?.textRunEditor;
        const outlineEditor = glyphCanvas?.outlineEditor;
        if (!glyphCanvas || !textRunEditor || !outlineEditor) {
            throw new Error('Missing Fustat node-edit layer dependencies');
        }

        await textRunEditor.selectGlyphByIndex(0, true);
        outlineEditor.currentGlyphName = 'o';
        await glyphCanvas.doUIUpdateAsync?.();
        await outlineEditor.autoSelectMatchingLayer?.();
        await glyphCanvas.enterGlyphEditModeAtCursor?.();
        await glyphCanvas.doUIUpdateAsync?.();
    });

    await waitForPredicate(
        page,
        () => {
            const win = window as any;
            const outlineEditor = win.glyphCanvas?.outlineEditor;
            const layer = outlineEditor?.getCurrentLayerDataFromStack?.();
            return (
                typeof win.pyodide?.runPythonAsync === 'function' &&
                win.pyodide?.__counterpunchPythonExecutionWrapperInstalled ===
                    true &&
                outlineEditor?.active === true &&
                outlineEditor?.currentGlyphName === 'o' &&
                typeof outlineEditor?.selectedLayerId === 'string' &&
                Array.isArray(layer?.shapes) &&
                layer.shapes.some(
                    (shape: any) =>
                        Array.isArray(shape?.nodes) &&
                        typeof shape.nodes[0]?.y === 'number'
                )
            );
        },
        60000
    );
}

// Live Pyodide against one Fustat session. The node-history step runs first
// because it counts the packets one Python edit sends; the mapping probe
// writes kerning and names afterwards.
test('Python in the live runtime: node history and model mapping access', async ({
    page
}) => {
    await page.goto('/?test=true');
    await waitForCanvasReady(page);
    await openFileFromFilesView(page, 'Fustat.glyphs');
    await waitForOpenSessionReady(page, 'Fustat.glyphs');
    await focusView(page, 'ControlOrMeta+Shift+E', 'view-editor');
    await waitForEditingFontBytes(page);

    await test.step('records only the active layer shape change for one Python node move', async () => {
        await enterFustatNodeEditLayer(page);

        const result = await page.evaluate(async () => {
            const win = window as any;
            const bridge = win.patchSyncEngine;
            const outlineEditor = win.glyphCanvas?.outlineEditor;
            const glyph = win.currentFontModel?.findGlyph?.('o');
            const layerId = outlineEditor?.selectedLayerId;
            const layer = glyph?.layers?.find(
                (candidate: any) => candidate.id === layerId
            );
            if (!bridge || !outlineEditor || !layer || !layerId) {
                throw new Error('Missing bridge or active Fustat layer');
            }

            const packets: Array<
                Array<{
                    op: string;
                    path: string;
                    workerReplayTargets: Array<{
                        glyphName: string;
                        layerId: string;
                    }>;
                }>
            > = [];
            const listener = (
                _update: Uint8Array,
                _message: unknown,
                entries: Array<{
                    op: string;
                    path: string;
                    workerReplayTargets?: Array<{
                        glyphName: string;
                        layerId: string;
                    }>;
                }>
            ) => {
                packets.push(
                    entries.map((entry) => ({
                        op: entry.op,
                        path: entry.path,
                        workerReplayTargets: entry.workerReplayTargets || []
                    }))
                );
            };
            bridge.onLocalUpdate(listener);

            try {
                const pathShape = layer.paths?.[0];
                if (!pathShape) {
                    throw new Error('Missing active Fustat path shape');
                }
                const beforeY = pathShape.nodes[0].y;
                await win.pyodide.runPythonAsync(
                    'Layer().paths[0].nodes[0].y += 100'
                );
                const updatedLayer = glyph.layers.find(
                    (candidate: any) => candidate.id === layerId
                );
                const updatedPathShape = updatedLayer?.paths?.[0];
                if (!updatedPathShape) {
                    throw new Error('Missing updated Fustat path shape');
                }
                const afterY = updatedPathShape.nodes[0].y;
                const currentFont = win.fontManager?.currentFont;
                let serializedNodeY = null;
                try {
                    const parsed = currentFont?.babelfontJson
                        ? JSON.parse(currentFont.babelfontJson)
                        : null;
                    const glyph = parsed?.glyphs?.find(
                        (candidate: any) => candidate.name === 'o'
                    );
                    const layer = glyph?.layers?.find(
                        (candidate: any) => candidate.id === layerId
                    );
                    serializedNodeY = layer?.shapes?.[0]?.nodes?.[0]?.y ?? null;
                } catch {
                    serializedNodeY = 'parse-error';
                }

                return {
                    beforeY,
                    afterY,
                    layerId,
                    packets,
                    txDepth: bridge._txDepth ?? bridge.txDepth ?? null,
                    recordingSuppressed: bridge._suppressRecording ?? null,
                    serializedNodeY,
                    hasHistoryContext: !!win.pythonExecutionHistoryContext
                };
            } finally {
                bridge.offLocalUpdate(listener);
            }
        });

        expect(result.afterY).toBe(result.beforeY + 100);
        expect(result.packets, JSON.stringify(result)).toHaveLength(1);
        expect(result.packets[0]).toEqual([
            {
                op: 'set',
                path: `glyphs.o:layers.${result.layerId}:shapes`,
                workerReplayTargets: [
                    { glyphName: 'o', layerId: result.layerId }
                ]
            }
        ]);
    });

    await test.step('documented mapping access works in the real Python runtime', async () => {
        await waitForLivePython(page);

        const probe = await runPythonJson(page, PYTHON_MODEL_ACCESS_PROBE);

        expect(probe.name_type).toBe('LiveDictProxy');
        expect(probe.location_type).toBe('LiveDictProxy');
        expect(probe.metrics_type).toBe('LiveDictProxy');
        expect(probe.names_type).toBe('LiveDictProxy');
        expect(probe.family_name_type).toBe('LiveDictProxy');
        expect(probe.name_to_py_type).toBe('dict');
        expect(probe.contains_object_object).toBe(false);
        expect(probe.contains_jsproxy).toBe(false);

        expect(typeof probe.name_dflt).toBe('string');
        expect(String(probe.name_dflt).length).toBeGreaterThan(0);
        expect(probe.master_name_written).toBe('ProbeMaster');
        expect(probe.name_str).toContain(String(probe.name_dflt));
        expect(String(probe.name_repr)).toContain(String(probe.name_dflt));

        expect(typeof probe.location_wght).toBe('number');
        expect(probe.location_to_py).toEqual(
            expect.objectContaining({ wght: probe.location_wght })
        );

        expect(typeof probe.metrics_xheight).toBe('number');
        expect(probe.metrics_keys).toEqual(
            expect.arrayContaining(['XHeight', 'Ascender', 'CapHeight'])
        );

        expect(typeof probe.family_name_dflt).toBe('string');
        expect(String(probe.family_name_dflt).length).toBeGreaterThan(0);
        expect(probe.family_written).toBe('PyAccessTest');
        expect(typeof probe.axis_name).toBe('string');
        expect(String(probe.axis_name).length).toBeGreaterThan(0);
        expect(String(probe.axis_name_repr)).not.toContain('[object Object]');

        expect(probe.kerning_av).toBe(-80);
        expect(probe.kerning_rtl).toBe(-80);
        expect(probe.kerning_as_dict).toEqual(
            expect.objectContaining({
                'A:V': -80
            })
        );

        expect(probe.anchor_lookup_error).toBeNull();
        expect(probe.glyph_anchor_lookup_error).toBeNull();
        expect(probe.glyph_anchors_type).toBe('list');

        const missingAttrError = await page.evaluate(async () => {
            const win = window as any;
            try {
                await win.pyodide.runPythonAsync(
                    'Font().masters[0].name.this_language_does_not_exist'
                );
                return null;
            } catch (error) {
                const raw =
                    error instanceof Error ? error.message : String(error);
                const cleaned =
                    typeof win.cleanPythonTraceback === 'function'
                        ? win.cleanPythonTraceback(raw)
                        : raw;
                return typeof win.sanitizePythonRuntimeError === 'function'
                    ? win.sanitizePythonRuntimeError(cleaned)
                    : cleaned;
            }
        });

        expect(missingAttrError).toBeTruthy();
        expect(missingAttrError!.toLowerCase()).toContain('attributeerror');
        expect(missingAttrError!.toLowerCase()).not.toContain('jsproxy');
        expect(missingAttrError!.toLowerCase()).not.toContain('pyodide');
    });
});
