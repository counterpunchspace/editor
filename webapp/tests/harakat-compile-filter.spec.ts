import { test, expect } from './fixtures';
import { type Page } from '@playwright/test';
import {
    openFileFromFilesView,
    waitForEditingFontBytes,
    waitForOpenSessionReady,
    waitForPredicate
} from './helpers/snapshot-helper';

async function waitForLivePython(page: Page): Promise<void> {
    await waitForPredicate(
        page,
        () => {
            const win = window as typeof window & {
                __fontEditorReadyState?: string;
                pyodide?: { runPythonAsync?: unknown };
            };
            return (
                win.__fontEditorReadyState === 'ready' &&
                typeof win.pyodide?.runPythonAsync === 'function'
            );
        },
        180000
    );
}

test('Harakat guide, setting, and compile hooks', async ({ page }) => {
    await page.goto('/?test=true');
    await openFileFromFilesView(page, 'Fustat.glyphs');
    await waitForOpenSessionReady(page, 'Fustat.glyphs');
    await waitForLivePython(page);

    await page.evaluate(() => {
        const win = window as typeof window & {
            focusView?: (id: string) => void;
            fontInfoManager?: { switchTab?: (tab: string) => void };
        };
        win.focusView?.('view-fontinfo');
        win.fontInfoManager?.switchTab?.('compile_filters');
    });
    await page.getByRole('button', { name: 'Add filter' }).waitFor({
        state: 'visible',
        timeout: 60000
    });
    await page.evaluate(async () => {
        const win = window as typeof window & {
            focusView?: (id: string) => void;
            fontInfoManager?: {
                switchTab?: (tab: string) => void;
                linkCompileFilter?: (pluginId: string) => Promise<void>;
            };
        };
        win.focusView?.('view-fontinfo');
        win.fontInfoManager?.switchTab?.('compile_filters');
        await win.fontInfoManager?.linkCompileFilter?.('harakat');
    });

    const linked = await page.evaluate(() => {
        const font = window.currentFontModel as {
            upm: number;
            masters: Array<{
                id: string;
                guides?: Array<{ name?: string; pos: { y: number } }>;
            }>;
            getPluginSetting: (pluginId: string, settingId: string) => unknown;
            format_specific?: Record<string, unknown>;
        };
        const master = font.masters[0];
        const guide = (master.guides || []).find(
            (item) => item.name === 'min_top_harakat'
        );
        const settings = font.getPluginSetting(
            'harakat',
            'minimum_by_master'
        ) as Record<string, number> | undefined;
        return {
            linked: font.format_specific?.['com.counterpunch.compile-filters'],
            upm: font.upm,
            masterId: master.id,
            guideY: guide?.pos.y,
            setting: settings?.[master.id],
            settingKeys: settings ? Object.keys(settings) : null,
            pluginSettings: JSON.stringify(
                font.format_specific?.['com.counterpunch.plugin-settings'] ??
                    null
            ),
            guideCount: (master.guides || []).filter(
                (item) => item.name === 'min_top_harakat'
            ).length
        };
    });

    if (linked.setting !== linked.upm / 2) {
        throw new Error(JSON.stringify(linked));
    }
    expect(linked.linked).toEqual(['harakat']);
    expect(linked.guideCount).toBe(1);
    expect(linked.guideY).toBe(linked.upm / 2);
    expect(linked.setting).toBe(linked.upm / 2);

    const moved = await page.evaluate(async () => {
        const win = window as typeof window & {
            compileFilterHost?: {
                onGuideCommitted: (change: unknown) => Promise<boolean>;
            };
            fontManager?: {
                recompileEditingFont?: () => Promise<unknown>;
            };
        };
        let recompiled = false;
        const fontManager = win.fontManager;
        const original = fontManager?.recompileEditingFont?.bind(fontManager);
        if (fontManager) {
            fontManager.recompileEditingFont = async () => {
                recompiled = true;
                return original ? original() : true;
            };
        }
        const font = window.currentFontModel as {
            masters: Array<{
                id: string;
                guides?: Array<{
                    name?: string;
                    pos: { x: number; y: number };
                }>;
            }>;
            getPluginSetting: (pluginId: string, settingId: string) => unknown;
        };
        const master = font.masters[0];
        const guide = (master.guides || []).find(
            (item) => item.name === 'min_top_harakat'
        );
        if (!guide) {
            throw new Error('min_top_harakat guide missing');
        }
        guide.pos.y = 640;
        const wrote = await win.compileFilterHost?.onGuideCommitted({
            kind: 'position',
            scope: 'master',
            masterId: master.id,
            name: 'min_top_harakat',
            pos: { x: guide.pos.x, y: 640 }
        });
        const settings = font.getPluginSetting(
            'harakat',
            'minimum_by_master'
        ) as Record<string, number>;
        if (fontManager && original) {
            fontManager.recompileEditingFont = original;
        }
        return { wrote, recompiled, setting: settings[master.id] };
    });

    expect(moved.wrote).toBe(true);
    expect(moved.recompiled).toBe(true);
    expect(moved.setting).toBe(640);

    await page.evaluate(async () => {
        const win = window as typeof window & {
            fontInfoManager?: {
                unlinkCompileFilter?: (pluginId: string) => Promise<void>;
            };
        };
        await win.fontInfoManager?.unlinkCompileFilter?.('harakat');
    });
    const removed = await page.evaluate(() => {
        const font = window.currentFontModel as {
            masters: Array<{
                guides?: Array<{ name?: string }>;
            }>;
            getPluginSetting: (pluginId: string, settingId: string) => unknown;
        };
        const master = font.masters[0];
        return {
            guides: (master.guides || []).filter(
                (item) => item.name === 'min_top_harakat'
            ).length,
            setting: (
                font.getPluginSetting('harakat', 'minimum_by_master') as Record<
                    string,
                    number
                >
            )[master.id as never]
        };
    });
    expect(removed.guides).toBe(0);
    expect(removed.setting).toBe(640);

    await page.evaluate(async () => {
        const win = window as typeof window & {
            fontInfoManager?: {
                linkCompileFilter?: (pluginId: string) => Promise<void>;
            };
        };
        await win.fontInfoManager?.linkCompileFilter?.('harakat');
    });
    const restored = await page.evaluate(() => {
        const font = window.currentFontModel as {
            masters: Array<{
                guides?: Array<{ name?: string; pos: { y: number } }>;
            }>;
        };
        const guide = (font.masters[0].guides || []).find(
            (item) => item.name === 'min_top_harakat'
        );
        return guide?.pos.y;
    });
    expect(restored).toBe(640);

    const compiled = await page.evaluate(async () => {
        const win = window as typeof window & {
            pyodide: { runPythonAsync(code: string): Promise<string> };
        };
        const raw = await win.pyodide.runPythonAsync(`
import json
plugin = _CP_COMPILE_FILTERS["harakat"]
layer = {
    "anchors": [{"name": "top", "x": 10, "y": 100}],
    "shapes": [{"reference": "dotabove-ar"}],
    "master": {"type": "DefaultForMaster", "master": "m"},
}
ctx = {"settings": {"minimum_by_master": {"m": 400}}, "masterId": "m"}
hook = getattr(plugin, "filter_layer_json_propagated_anchors", None)
raised = None if hook is None else hook(layer, ctx)
font = {
    "upm": 1000,
    "masters": [{"id": "m", "location": {"wght": 400}}],
    "axes": [{"tag": "wght"}],
    "features": {"features": [["ccmp", {"code": "sub noon-ar\\t\\t\\tby noonghunna-ar dotabove-ar;"}]]},
    "glyphs": [
        {"name": "noon-ar", "category": "Letter", "layers": [{"id": "l", "master": {"master": "m"}, "anchors": [{"name": "top", "x": 0, "y": 200}]}]},
        {"name": "noonghunna-ar", "category": "Letter", "layers": [{"id": "l", "master": {"master": "m"}, "anchors": [{"name": "top", "x": 0, "y": 200}]}]},
        {"name": "alef-ar", "category": "Letter", "layers": [{"id": "l", "master": {"master": "m"}, "anchors": [{"name": "top", "x": 0, "y": 700}]}]},
        {"name": "lam-ar", "category": "Letter", "layers": [{"id": "l", "master": {"master": "m"}, "anchors": [{"name": "top", "x": 0, "y": 450}]}]},
        {"name": "dotabove-ar", "category": "Mark", "layers": [{"id": "l", "master": {"master": "m"}, "anchors": [{"name": "_top", "x": 0, "y": 0}, {"name": "top", "x": 0, "y": 80}]}]},
        {"name": "fatha-ar", "category": "Mark", "codepoints": [1614], "layers": [{"id": "l", "master": {"master": "m"}, "anchors": [{"name": "_top", "x": 0, "y": 0}, {"name": "top", "x": 0, "y": 40}], "yMin": 0, "yMax": 40}]},
        {"name": "damma-ar", "category": "Mark", "codepoints": [1615], "layers": [{"id": "l", "master": {"master": "m"}, "anchors": [{"name": "_top", "x": 0, "y": 0}], "yMin": 0, "yMax": 100}]},
        {"name": "sukun-ar", "category": "Mark", "boundsOnly": True, "codepoints": [1618], "layers": [{"id": "l", "master": {"master": "m"}, "anchors": [{"name": "_top", "x": 0, "y": 0}], "yMin": 0, "yMax": 200}]},
    ],
}
features = plugin.filter_font_json(font, ctx)
def _shift(result, prefix):
    text = "" if result is None else result["features"]
    for line in text.splitlines():
        if line.startswith(prefix):
            return line.split("<0 ", 1)[1].split(" ", 1)[0]
    return None
skel = {"name": "skel-ar", "category": "Letter", "layers": [{"id": "l", "master": {"master": "m"}, "anchors": [{"name": "top", "x": 0, "y": 200}]}]}
dot = {"name": "dotabove-ar", "category": "Mark", "layers": [{"id": "l", "master": {"master": "m"}, "anchors": [{"name": "_top", "x": 0, "y": 0}, {"name": "top", "x": 0, "y": 80}]}]}
marks = [glyph for glyph in font["glyphs"] if glyph["name"] in ("fatha-ar", "damma-ar", "sukun-ar")]
ccmp_font = {
    "upm": 1000,
    "masters": font["masters"],
    "axes": font["axes"],
    "features": {"features": [["ccmp", {"code": "sub beh-ar by skel-ar dotabove-ar;"}]]},
    "glyphs": [{"name": "beh-ar", "category": "Letter", "layers": [{"id": "l", "master": {"master": "m"}, "anchors": []}]}] + [skel, dot] + marks,
}
component_font = {
    "upm": 1000,
    "masters": font["masters"],
    "axes": font["axes"],
    "features": {"features": []},
    "glyphs": [{
        "name": "beh-ar",
        "category": "Letter",
        "layers": [{
            "id": "l",
            "master": {"master": "m"},
            "anchors": [],
            "components": [
                {"reference": "skel-ar", "matrix": [1, 0, 0, 1, 0, 0]},
                {"reference": "dotabove-ar", "matrix": [1, 0, 0, 1, 0, 200]},
            ],
        }],
    }, skel, dot] + marks,
}
ccmp_features = plugin.filter_font_json(ccmp_font, ctx)
component_features = plugin.filter_font_json(component_font, ctx)
json.dumps({
    "raised": raised,
    "features": None if features is None else features["features"],
    "ccmpShift": _shift(ccmp_features, "pos skel-ar dotabove-ar fatha-ar'"),
    "componentShift": _shift(component_features, "pos beh-ar fatha-ar'"),
})
`);
        return JSON.parse(raw) as {
            raised: unknown;
            features: string;
            ccmpShift: string | null;
            componentShift: string | null;
        };
    });

    expect(compiled.raised).toBeNull();
    expect(compiled.features).toContain('fatha-ar');
    // Guide 400. Centers sit 20, 50, and 100 above ``_top``. Sukun is
    // bounds-only, so it sets the center line and is not named in a rule.
    // Chain floor 120: fatha 120+80, damma 120+50. Bare floor 200.
    expect(compiled.features).toContain(
        "pos noonghunna-ar dotabove-ar fatha-ar' <0 200 0 0>;"
    );
    expect(compiled.features).toContain(
        "pos noonghunna-ar dotabove-ar damma-ar' <0 170 0 0>;"
    );
    expect(compiled.features).toContain(
        "pos noonghunna-ar fatha-ar' <0 280 0 0>;"
    );
    expect(compiled.features).toContain(
        "pos noonghunna-ar damma-ar' <0 250 0 0>;"
    );
    // Lam's top is 450, fifty above the guide. Fatha's center is still
    // eighty below the shared line, so it moves thirty. Damma already meets it.
    expect(compiled.features).toContain("pos lam-ar fatha-ar' <0 30 0 0>;");
    expect(compiled.features).not.toContain("pos lam-ar damma-ar'");
    expect(compiled.features).not.toContain('alef-ar');
    expect(compiled.features).not.toContain('sukun-ar');
    expect(compiled.features).not.toMatch(/\blookup\s/);
    expect(compiled.features).not.toContain("@harakat'");
    expect(compiled.features).not.toContain('dotabove-ar]');
    expect(compiled.ccmpShift).toBe('200');
    expect(compiled.componentShift).toBe(compiled.ccmpShift);
});

type ShapedMark = {
    name: string;
    dy: number;
    vowel: boolean;
    topY: number;
    inkMin: number;
    inkY: number;
};
type ShapedCluster = { base: string; marks: ShapedMark[] };
type Shaped = {
    clusters: ShapedCluster[];
    guideY: number | null;
    settingY: number | null;
    tallestOffset: number;
};

const HARAKAT_WORD = 'حَّرَّكاَّتّْ';

async function shapeHarakatWord(page: Page): Promise<Shaped> {
    return page.evaluate(() => {
        const win = window as typeof window & {
            glyphCanvas?: {
                textRunEditor?: {
                    shapedGlyphs?: Array<{ g: number; dy: number }>;
                    getGlyphNameForGid?: (gid: number) => string;
                    shapeText?: (skipRender?: boolean) => void;
                    swapFontBlob?: (bytes: Uint8Array) => void;
                };
            };
            fontManager?: { editingFont?: Uint8Array };
        };
        type Anchor = { name: string; y: number };
        type Layer = {
            master?: { master?: string };
            anchors?: Anchor[];
            data?: { shapes?: Array<{ nodes?: Array<{ y?: number }> }> };
        };
        const font = window.currentFontModel as {
            axes?: Array<{ tag: string; map?: Array<[number, number]> }>;
            masters: Array<{
                id: string;
                location?: Record<string, number>;
                guides?: Array<{ name?: string; pos: { y: number } }>;
            }>;
            glyphs?: Array<{
                codepoints?: number[];
                layers?: Layer[];
            }>;
            getPluginSetting(pluginId: string, settingId: string): unknown;
            findGlyph(name: string):
                | {
                      category?: string;
                      codepoints?: number[];
                      layers?: Layer[];
                  }
                | undefined;
        };
        const axis = (font.axes || []).find((item) => item.tag === 'wght');
        const pair = (axis?.map || []).find((item) => Number(item[0]) === 400);
        const design = pair ? Number(pair[1]) : 400;
        const master = font.masters.find(
            (item) => Number(item.location?.wght) === design
        );
        const guide = (master?.guides || []).find(
            (item) => item.name === 'min_top_harakat'
        );
        const vowels = new Set<number>([
            ...Array.from({ length: 0x0656 - 0x064b }, (_, i) => 0x064b + i),
            0x065a,
            0x065b,
            0x0670
        ]);
        const nodeBounds = (
            layer: Layer | undefined
        ): { min: number; max: number } | null => {
            let min: number | null = null;
            let max: number | null = null;
            for (const shape of layer?.data?.shapes || []) {
                for (const node of shape.nodes || []) {
                    if (typeof node.y !== 'number') {
                        continue;
                    }
                    min = min === null ? node.y : Math.min(min, node.y);
                    max = max === null ? node.y : Math.max(max, node.y);
                }
            }
            return min === null || max === null ? null : { min, max };
        };
        let tallestOffset = 0;
        for (const glyph of font.glyphs || []) {
            if (!(glyph.codepoints || []).some((cp) => vowels.has(cp))) {
                continue;
            }
            const layer = (glyph.layers || []).find(
                (item) => item.master?.master === master?.id
            );
            const top = (layer?.anchors || []).find(
                (item) => item.name === '_top'
            );
            const ink = nodeBounds(layer);
            if (!top || !ink) {
                continue;
            }
            tallestOffset = Math.max(
                tallestOffset,
                (ink.min + ink.max) / 2 - top.y
            );
        }

        const editor = win.glyphCanvas?.textRunEditor;
        const compiled = win.fontManager?.editingFont;
        if (compiled) {
            editor?.swapFontBlob?.(compiled);
        }
        editor?.shapeText?.(true);
        // Right-to-left run: HarfBuzz returns it in visual order.
        const logical = (editor?.shapedGlyphs || []).slice().reverse();
        const clusters: ShapedCluster[] = [];
        for (const glyph of logical) {
            const name = editor?.getGlyphNameForGid?.(glyph.g) || '';
            const model = font.findGlyph(name);
            if (model?.category !== 'Mark') {
                clusters.push({ base: name, marks: [] });
                continue;
            }
            const layer = (model.layers || []).find(
                (item) => item.master?.master === master?.id
            );
            const top = (layer?.anchors || []).find(
                (item) => item.name === '_top'
            );
            const ink = nodeBounds(layer);
            clusters[clusters.length - 1]?.marks.push({
                name,
                dy: glyph.dy,
                vowel:
                    Boolean(top) &&
                    (model.codepoints || []).some((cp) => vowels.has(cp)),
                topY: top?.y ?? 0,
                inkMin: ink?.min ?? top?.y ?? 0,
                inkY: ink?.max ?? top?.y ?? 0
            });
        }
        const settings = (font.getPluginSetting(
            'harakat',
            'minimum_by_master'
        ) || {}) as Record<string, number>;
        return {
            clusters,
            guideY: guide ? guide.pos.y : null,
            settingY: master ? (settings[master.id] ?? null) : null,
            tallestOffset
        };
    });
}

// How far each cluster's first vowel ``_top`` is from the guideline plus the
// gap from that vowel's ink center up to the highest vowel center.
function alignmentErrors(off: Shaped, on: Shaped): number[] {
    const guide = on.settingY ?? Number.NaN;
    const tallest = on.tallestOffset;
    return on.clusters.map((cluster, index) => {
        const first = cluster.marks.find((mark) => mark.vowel);
        const before = off.clusters[index]?.marks.find((mark) => mark.vowel);
        if (!first || !before) {
            return 0;
        }
        const natural = before.dy + before.topY;
        const offset = (first.inkMin + first.inkY) / 2 - first.topY;
        const aligned = guide + Math.max(0, tallest - offset);
        const expected = Math.max(natural, aligned);
        return Math.abs(first.dy + first.topY - expected);
    });
}

function expectHarakatAligned(off: Shaped, on: Shaped) {
    expect(on.clusters.map((cluster) => cluster.base)).toEqual(
        off.clusters.map((cluster) => cluster.base)
    );
    for (const [index, error] of alignmentErrors(off, on).entries()) {
        expect(error, JSON.stringify({ off, on, index })).toBeLessThanOrEqual(
            1
        );
    }
    for (const [index, cluster] of on.clusters.entries()) {
        const before = off.clusters[index].marks;
        const firstOn = cluster.marks.find((mark) => mark.vowel);
        const firstOff = before.find((mark) => mark.vowel);
        for (const [markIndex, mark] of cluster.marks.entries()) {
            const was = before[markIndex];
            const detail = JSON.stringify({ base: cluster.base, mark, was });
            expect(mark.name, detail).toBe(was.name);
            if (!mark.vowel) {
                expect(mark.dy, detail).toBe(was.dy);
            } else if (firstOn && firstOff) {
                // Stacked vowels move with the first one, not by its shift again.
                expect(mark.dy - firstOn.dy, detail).toBe(was.dy - firstOff.dy);
            }
        }
    }
}

test('the Harakat guide aligns the first vowel and moves stacks in unison', async ({
    page
}) => {
    await page.goto('/?test=true');
    await openFileFromFilesView(page, 'Fustat.glyphs');
    await waitForOpenSessionReady(page, 'Fustat.glyphs');
    await waitForLivePython(page);

    await page.evaluate((word) => {
        const win = window as typeof window & {
            focusView?: (id: string) => void;
            fontManager?: { currentText?: string };
            glyphCanvas?: {
                textRunEditor?: {
                    setTextBuffer?: (text: string) => void;
                    shapeText?: (skipRender?: boolean) => void;
                    axesManager?: {
                        setAxisValue?: (tag: string, value: number) => void;
                        variationSettings?: Record<string, number>;
                    };
                };
            };
        };
        win.fontManager!.currentText = word;
        win.focusView?.('view-glyph');
        const editor = win.glyphCanvas?.textRunEditor;
        editor?.setTextBuffer?.(word);
        editor?.axesManager?.setAxisValue?.('wght', 400);
        if (editor?.axesManager) {
            editor.axesManager.variationSettings = { wght: 400 };
        }
        editor?.shapeText?.(true);
    }, HARAKAT_WORD);
    await waitForEditingFontBytes(page);
    await expect
        .poll(async () => (await shapeHarakatWord(page)).clusters.length, {
            timeout: 60000
        })
        .toBe(5);

    const off = await shapeHarakatWord(page);
    expect(
        off.clusters.filter((cluster) =>
            cluster.marks.some((mark) => mark.vowel)
        ).length,
        JSON.stringify(off)
    ).toBe(4);

    await page.evaluate(async () => {
        const win = window as typeof window & {
            fontInfoManager?: {
                linkCompileFilter?: (pluginId: string) => Promise<void>;
            };
        };
        await win.fontInfoManager?.linkCompileFilter?.('harakat');
    });

    await expect
        .poll(
            async () =>
                Math.max(...alignmentErrors(off, await shapeHarakatWord(page))),
            { timeout: 90000 }
        )
        .toBeLessThanOrEqual(1);
    const on = await shapeHarakatWord(page);
    expect(on.tallestOffset).toBeGreaterThan(40);
    expectHarakatAligned(off, on);

    const overlay = await page.evaluate(
        () => window.fontCompilation?.compileFeatureOverlay || ''
    );
    expect(overlay).toContain("pos hah-ar.init shadda-ar' <0 ");
    expect(overlay).toContain("pos hah-ar.init fatha-ar' <0 ");
    expect(overlay).not.toMatch(/\blookup\s/);
    expect(overlay).not.toContain("@harakat'");
    expect(overlay.split('\n')[0]).not.toContain('dotabove-ar');

    const alef = on.clusters.findIndex((cluster) =>
        cluster.base.startsWith('alef-ar')
    );
    expect(alef).toBeGreaterThanOrEqual(0);
    // Something below the guideline did move.
    expect(
        on.clusters.some(
            (cluster, index) =>
                cluster.marks[0]?.dy !== off.clusters[index].marks[0]?.dy
        )
    ).toBe(true);

    const moved = await page.evaluate(async () => {
        const win = window as typeof window & {
            compileFilterHost?: {
                onGuideCommitted: (change: unknown) => Promise<boolean>;
            };
            patchSyncEngine?: {
                beginTransaction: (
                    label: string,
                    glyph: null,
                    meta: Record<string, unknown>
                ) => void;
                endTransaction: () => void;
            };
        };
        type Font = {
            masters: Array<{
                id: string;
                guides?: Array<{
                    name?: string;
                    pos: { x: number; y: number };
                }>;
            }>;
        };
        const raised: number[] = [];
        const count = (window.currentFontModel as Font).masters.length;
        for (let index = 0; index < count; index += 1) {
            // Each commit recompiles and can replace master data, so wrappers
            // from before it would write into detached objects.
            const master = (window.currentFontModel as Font).masters[index];
            const guide = (master.guides || []).find(
                (item) => item.name === 'min_top_harakat'
            );
            if (!guide) {
                continue;
            }
            const nextY = guide.pos.y + 200;
            win.patchSyncEngine?.beginTransaction('Drag guide', null, {
                compileChangeSource: 'mouse-drag-guide',
                compileEditType: 'guide'
            });
            try {
                guide.pos.y = nextY;
            } finally {
                win.patchSyncEngine?.endTransaction();
            }
            const wrote = await win.compileFilterHost?.onGuideCommitted({
                kind: 'position',
                scope: 'master',
                masterId: master.id,
                name: 'min_top_harakat',
                pos: { x: guide.pos.x, y: nextY }
            });
            raised.push(nextY);
            if (!wrote) {
                throw new Error(`guide write failed for ${master.id}`);
            }
        }
        return {
            nextY: raised[0],
            masterId: (window.currentFontModel as Font).masters[0].id
        };
    });

    await expect
        .poll(
            async () =>
                Math.max(...alignmentErrors(off, await shapeHarakatWord(page))),
            { timeout: 90000 }
        )
        .toBeLessThanOrEqual(1);
    const raisedShape = await shapeHarakatWord(page);
    expect(raisedShape.settingY, JSON.stringify(raisedShape)).toBe(
        (on.settingY ?? 0) + 200
    );
    expect(raisedShape.guideY, JSON.stringify(raisedShape)).toBe(
        raisedShape.settingY
    );
    expectHarakatAligned(off, raisedShape);

    const stored = await page.evaluate((masterId) => {
        const font = window.currentFontModel as {
            getPluginSetting: (pluginId: string, settingId: string) => unknown;
            format_specific?: Record<string, unknown>;
        };
        const settings = font.getPluginSetting(
            'harakat',
            'minimum_by_master'
        ) as Record<string, number>;
        return {
            flat: Object.prototype.hasOwnProperty.call(
                font.format_specific || {},
                'com.counterpunch.plugin-settings'
            ),
            value: settings[masterId]
        };
    }, moved.masterId);
    expect(stored.flat).toBe(true);
    expect(stored.value).toBe(moved.nextY);
});
