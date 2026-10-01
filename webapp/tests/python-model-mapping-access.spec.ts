import { test, expect } from './fixtures';
import { type Page } from '@playwright/test';
import {
    focusView,
    openFileFromFilesView,
    waitForCanvasReady,
    waitForOpenSessionReady,
    waitForPredicate
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

test.describe('Python model mapping access (live Pyodide)', () => {
    test('documented mapping access works in the real Python runtime', async ({
        page
    }) => {
        await page.goto('/?test=true');
        await waitForCanvasReady(page);
        await focusView(page, 'ControlOrMeta+Shift+E', 'view-editor');
        await openFileFromFilesView(page, 'Fustat.glyphs');
        await waitForOpenSessionReady(page, 'Fustat.glyphs');
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
