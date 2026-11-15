/**
 * Helpers for the live cloud fuzz spec: a fixture font with automatic
 * composites and metrics-key chains, page-side edit operations that use the
 * editor’s own commit paths, and the checks every step runs in every window.
 */
import { expect, type Page } from '@playwright/test';
import { rectLineNodes } from './babelfont-test-data';

export const FUZZ_STATIONS = [
    { id: 'M1', wght: 100 },
    { id: 'M2', wght: 900 }
] as const;
export type FuzzStationId = (typeof FUZZ_STATIONS)[number]['id'];

/** Location the compiled outlines are compared at (between the masters). */
export const FUZZ_COMPARE_LOCATION = { wght: 500 };

/** Every glyph the fuzz edits or that follows an edited glyph. */
export const FUZZ_GLYPHS = [
    'l',
    'n',
    'm',
    'idotless',
    'a',
    'o',
    'dieresiscomb',
    'acutecomb',
    'dotaccentcomb',
    'adieresis',
    'aacute',
    'odieresis',
    'i',
    'idieresis',
    'adieresis.ss01'
];

/** Text that shapes to every fuzz glyph, so the compiled check sees all. */
// U+E001 maps to adieresis.ss01 only while a Unicode edit has added it.
export const FUZZ_TEXT = 'lnmıaoäáöiï̈́̇';

export const FUZZ_BASES_WITH_TOP = ['a', 'o', 'idotless'];
export const FUZZ_MARKS = ['dieresiscomb', 'acutecomb', 'dotaccentcomb'];
export const FUZZ_OUTLINE_GLYPHS = [
    'l',
    'n',
    'm',
    'idotless',
    'a',
    'o',
    ...FUZZ_MARKS
];
export const FUZZ_WIDTH_GLYPHS = ['l', 'a', 'o'];
export const FUZZ_COMPOSITES = [
    'adieresis',
    'aacute',
    'odieresis',
    'i',
    'idieresis'
];
export const FUZZ_KERN_PAIRS = [
    'a:o',
    'o:a',
    'l:n',
    'n:o',
    'i:l',
    // Group pairs: `@L` is the first-side group of `l`, `@A` the second-side
    // group of `a` (see FUZZ_KERN_GROUPS).
    '@L:a',
    'o:@A'
];

/** Kerning groups of the fixture: first side (MMK_R) and second side (MMK_L). */
export const FUZZ_KERN_GROUPS = {
    first: { L: ['l'] } as Record<string, string[]>,
    second: { A: ['a'] } as Record<string, string[]>
};
/** Glyphs a kerning-group edit adds to or removes from the group `L`. */
export const FUZZ_GROUP_GLYPHS = ['n', 'm'];
/** The feature the fuzz edits, and its code before any edit. */
export const FUZZ_FEATURE_TAG = 'ss01';
export const FUZZ_FEATURE_CODE = 'sub adieresis by adieresis.ss01;';
/** Glyph whose catalog entry a Unicode edit changes (not in the text run). */
export const FUZZ_UNICODE_GLYPH = 'adieresis.ss01';
/** The extra codepoint a Unicode edit adds or removes. */
export const FUZZ_EXTRA_CODEPOINT = 0xe001;
/**
 * Room layout the fuzz font is saved with: several catalog and kerning
 * rooms, so edits cross rooms. Real fonts get this many only with
 * thousands of glyphs or tens of thousands of pairs.
 */
export const FUZZ_ROOM_LAYOUT = { catalogBuckets: 3, kerningBuckets: 3 };

/** Metrics keys the fixture sets, as [glyph, side, source, offset]. */
export const FUZZ_METRICS_KEYS: Array<
    [string, 'left' | 'right', string, number]
> = [
    ['n', 'left', 'l', 0],
    ['n', 'right', 'l', 0],
    ['m', 'left', 'n', 0],
    ['m', 'right', 'n', 0],
    ['idotless', 'left', 'l', -5],
    ['idotless', 'right', 'l', -5]
];

type Rect = [number, number, number, number];
type StationShapes = { rects: Rect[]; width: number; anchors?: Anchor[] };
type Anchor = { name: string; x: number; y: number };

function rectPath([x0, y0, x1, y1]: Rect) {
    return {
        nodes: rectLineNodes(x0, y0, x1, y0, x1, y1, x0, y1),
        closed: true
    };
}

function outlineGlyph(
    name: string,
    codepoints: number[],
    perStation: Record<FuzzStationId, StationShapes>,
    options: { category?: string; formatSpecific?: Record<string, string> } = {}
) {
    return {
        name,
        category: options.category ?? 'Base',
        ...(codepoints.length ? { codepoints } : {}),
        layers: FUZZ_STATIONS.map(({ id }) => ({
            width: perStation[id].width,
            id,
            master: { type: 'DefaultForMaster', master: id },
            shapes: perStation[id].rects.map(rectPath),
            anchors: perStation[id].anchors ?? [],
            guides: [],
            format_specific: {}
        })),
        exported: true,
        format_specific: options.formatSpecific ?? {}
    };
}

const AUTOMATIC = { 'com.schriftgestalt.Glyphs.alignment': 1 };

function component(reference: string, x: number, y: number) {
    return {
        reference,
        format_specific: { ...AUTOMATIC },
        transform: {
            translation: [x, y],
            scale: [1, 1],
            rotation: 0,
            skew: [0, 0],
            order: 'RestOfTheWorld'
        }
    };
}

/** Two-master font: line-only contours, so bounds equal node extremes. */
export function makeFuzzFontJson(familyName: string): string {
    const bases: Record<string, Record<FuzzStationId, StationShapes>> = {
        l: {
            M1: { rects: [[80, 0, 140, 700]], width: 220 },
            M2: { rects: [[80, 0, 220, 700]], width: 300 }
        },
        n: {
            M1: {
                rects: [
                    [80, 0, 140, 500],
                    [380, 0, 440, 500]
                ],
                width: 520
            },
            M2: {
                rects: [
                    [80, 0, 220, 500],
                    [380, 0, 520, 500]
                ],
                width: 600
            }
        },
        m: {
            M1: {
                rects: [
                    [80, 0, 140, 500],
                    [330, 0, 390, 500],
                    [580, 0, 640, 500]
                ],
                width: 720
            },
            M2: {
                rects: [
                    [80, 0, 220, 500],
                    [330, 0, 470, 500],
                    [580, 0, 720, 500]
                ],
                width: 800
            }
        },
        idotless: {
            M1: {
                rects: [[75, 0, 135, 500]],
                width: 210,
                anchors: [{ name: 'top', x: 105, y: 500 }]
            },
            M2: {
                rects: [[75, 0, 215, 500]],
                width: 290,
                anchors: [{ name: 'top', x: 145, y: 500 }]
            }
        },
        a: {
            M1: {
                rects: [[60, 0, 400, 500]],
                width: 460,
                anchors: [{ name: 'top', x: 230, y: 500 }]
            },
            M2: {
                rects: [[60, 0, 480, 500]],
                width: 540,
                anchors: [{ name: 'top', x: 270, y: 500 }]
            }
        },
        o: {
            M1: {
                rects: [[60, 0, 440, 500]],
                width: 500,
                anchors: [{ name: 'top', x: 250, y: 500 }]
            },
            M2: {
                rects: [[60, 0, 520, 500]],
                width: 580,
                anchors: [{ name: 'top', x: 290, y: 500 }]
            }
        }
    };
    const marks: Record<string, Record<FuzzStationId, StationShapes>> = {
        dieresiscomb: {
            M1: {
                rects: [
                    [-100, 560, -40, 620],
                    [40, 560, 100, 620]
                ],
                width: 0,
                anchors: [{ name: '_top', x: 0, y: 500 }]
            },
            M2: {
                rects: [
                    [-120, 560, -30, 650],
                    [30, 560, 120, 650]
                ],
                width: 0,
                anchors: [{ name: '_top', x: 0, y: 500 }]
            }
        },
        acutecomb: {
            M1: {
                rects: [[-30, 560, 60, 700]],
                width: 0,
                anchors: [{ name: '_top', x: 0, y: 500 }]
            },
            M2: {
                rects: [[-40, 560, 80, 720]],
                width: 0,
                anchors: [{ name: '_top', x: 0, y: 500 }]
            }
        },
        dotaccentcomb: {
            M1: {
                rects: [[-30, 560, 30, 620]],
                width: 0,
                anchors: [{ name: '_top', x: 0, y: 500 }]
            },
            M2: {
                rects: [[-45, 560, 45, 650]],
                width: 0,
                anchors: [{ name: '_top', x: 0, y: 500 }]
            }
        }
    };
    const metricsFormatSpecific = (glyph: string) => {
        const keys = FUZZ_METRICS_KEYS.filter(([name]) => name === glyph);
        const value = (source: string, offset: number) =>
            offset
                ? `=${source}${offset < 0 ? '' : '+'}${offset}`
                : `=${source}`;
        const result: Record<string, string> = {};
        for (const [, side, source, offset] of keys) {
            result[side === 'left' ? 'metric_left' : 'metric_right'] = value(
                source,
                offset
            );
        }
        return result;
    };
    const codepoints: Record<string, number[]> = {
        'l': [0x6c],
        'n': [0x6e],
        'm': [0x6d],
        'idotless': [0x131],
        'a': [0x61],
        'o': [0x6f],
        'dieresiscomb': [0x308],
        'acutecomb': [0x301],
        'dotaccentcomb': [0x307],
        'adieresis': [0xe4],
        'aacute': [0xe1],
        'odieresis': [0xf6],
        'i': [0x69],
        'idieresis': [0xef],
        'adieresis.ss01': [0xe000]
    };
    const composites: Array<[string, string, string]> = [
        ['adieresis', 'a', 'dieresiscomb'],
        ['aacute', 'a', 'acutecomb'],
        ['odieresis', 'o', 'dieresiscomb'],
        ['i', 'idotless', 'dotaccentcomb'],
        ['idieresis', 'idotless', 'dieresiscomb']
    ];
    const compositeGlyph = (name: string, base: string, mark: string) => ({
        name,
        category: 'Base',
        codepoints: codepoints[name],
        layers: FUZZ_STATIONS.map(({ id }) => {
            const top = bases[base][id].anchors![0];
            return {
                width: bases[base][id].width,
                id,
                master: { type: 'DefaultForMaster', master: id },
                shapes: [
                    component(base, 0, 0),
                    component(mark, top.x, top.y - 500)
                ],
                anchors: [],
                guides: [],
                format_specific: {}
            };
        }),
        exported: true,
        format_specific: {}
    });
    const notdef = outlineGlyph('.notdef', [], {
        M1: { rects: [[50, 0, 450, 700]], width: 500 },
        M2: { rects: [[50, 0, 450, 700]], width: 500 }
    });
    const glyphs = [
        notdef,
        ...Object.entries(bases).map(([name, perStation]) =>
            outlineGlyph(name, codepoints[name], perStation, {
                formatSpecific: metricsFormatSpecific(name)
            })
        ),
        ...Object.entries(marks).map(([name, perStation]) =>
            outlineGlyph(name, codepoints[name], perStation, {
                category: 'Mark'
            })
        ),
        ...composites.map(([name, base, mark]) =>
            compositeGlyph(name, base, mark)
        ),
        {
            name: 'adieresis.ss01',
            category: 'Base',
            codepoints: codepoints['adieresis.ss01'],
            layers: FUZZ_STATIONS.map(({ id }) => ({
                width: bases.a[id].width,
                id,
                master: { type: 'DefaultForMaster', master: id },
                shapes: [component('adieresis', 0, 0)],
                anchors: [],
                guides: [],
                format_specific: {}
            })),
            exported: true,
            format_specific: {}
        }
    ];
    return JSON.stringify({
        upm: 1000,
        version: [1, 0],
        axes: [
            {
                name: { dflt: 'Weight' },
                tag: 'wght',
                min: 100,
                default: 100,
                max: 900
            }
        ],
        instances: [],
        masters: FUZZ_STATIONS.map(({ id, wght }) => ({
            name: { dflt: id === 'M1' ? 'Light' : 'Bold' },
            id,
            location: { wght },
            guides: [],
            metrics: {},
            kerning: {},
            custom_ot_values: {},
            format_specific: {}
        })),
        glyphs,
        date: new Date().toISOString(),
        names: { family_name: { dflt: familyName } },
        features: {
            classes: {},
            prefixes: {},
            features: [[FUZZ_FEATURE_TAG, { code: FUZZ_FEATURE_CODE }]]
        },
        first_kern_groups: FUZZ_KERN_GROUPS.first,
        second_kern_groups: FUZZ_KERN_GROUPS.second,
        format_specific: {}
    });
}

/** Open a font from JSON in the memory filesystem, as the launcher does. */
export async function loadFuzzFont(page: Page, familyName: string) {
    const json = makeFuzzFontJson(familyName);
    const fontPath = `/user/${familyName}.babelfont`;
    await page.evaluate(
        async ({ json: fontJson, path }) => {
            const plugin = (window as any).pluginRegistry.get('memory');
            const adapter = plugin?.getAdapter?.();
            try {
                await adapter?.createFolder?.('/user');
            } catch {
                // Exists already.
            }
            await adapter?.writeFile?.(path, fontJson);
            window.dispatchEvent(
                new CustomEvent('fontLoaded', {
                    detail: {
                        path,
                        babelfontJson: fontJson,
                        sourcePlugin: plugin
                    }
                })
            );
        },
        { json, path: fontPath }
    );
    await page.waitForFunction(
        (path) => {
            const current = (window as any).fontManager?.currentFont;
            const editorFile = (window as any).stateManager?.editor_file || '';
            return (
                !!current &&
                (current.path === path ||
                    editorFile.includes(path.replace(/^\/+/, '')))
            );
        },
        fontPath,
        { timeout: 30000 }
    );
    await waitForAutomaticComposites(page);
}

export async function waitForAutomaticComposites(page: Page) {
    await page.waitForFunction(
        (names) => {
            const font = (window as any).currentFontModel;
            return names.every((name: string) =>
                (font?.findGlyph?.(name)?.drawings ?? []).every(
                    (drawing: any) =>
                        drawing?.isAutomaticAlignedDrawing?.() === true
                )
            );
        },
        FUZZ_COMPOSITES,
        { timeout: 30000 }
    );
}

export type FuzzSnapshot = {
    glyphs: Record<string, unknown>;
    kerning: Record<string, Record<string, number>>;
    /** Code of the fuzz feature (features room). */
    features: string | null;
    /** Kerning groups, first and second side, members sorted. */
    groups: Record<string, Record<string, string[]>>;
    /** Codepoints of every fuzz glyph (catalog rooms). */
    catalog: Record<string, number[]>;
};

/** This window’s font model, normalised: rounded, anchors sorted. */
export async function readFuzzSnapshot(page: Page): Promise<FuzzSnapshot> {
    return page.evaluate(
        ({ names, featureTag }) => {
            const w = window as any;
            const round = (value: unknown) =>
                typeof value === 'number'
                    ? Math.round(value * 1000) / 1000
                    : value;
            const shape = (item: any) => {
                if (item.isComponent?.()) {
                    const component = item.asComponent();
                    const translation = component.transform?.translation ?? [
                        0, 0
                    ];
                    return {
                        reference: component.reference,
                        translation: translation.map(round),
                        automatic: component.automaticAlignment === true
                    };
                }
                const path = item.asPath();
                return {
                    nodes: (path?.nodes ?? []).map((node: any) => [
                        round(node.x),
                        round(node.y)
                    ]),
                    closed: path?.closed !== false
                };
            };
            const drawing = (item: any) => ({
                width: round(item.width),
                shapes: (item.shapes ?? []).map(shape),
                anchors: (item.anchors ?? [])
                    .map((anchor: any) => [
                        anchor.name,
                        round(anchor.x),
                        round(anchor.y)
                    ])
                    .sort((left: any, right: any) =>
                        String(left[0]).localeCompare(String(right[0]))
                    )
            });
            const glyphs: Record<string, unknown> = {};
            const kerning: Record<string, Record<string, number>> = {};
            const catalog: Record<string, number[]> = {};
            const font = w.currentFontModel;
            const feature = (font?.features?.features ?? []).find(
                (entry: any) => entry?.[0] === featureTag
            );
            const features: string | null = feature?.[1]?.code ?? null;
            const sortedGroups = (
                groups: Record<string, string[]> | undefined
            ) =>
                Object.fromEntries(
                    Object.entries(groups ?? {})
                        .filter(([, members]) => members?.length)
                        .sort(([left], [right]) => left.localeCompare(right))
                        .map(([name, members]) => [name, [...members].sort()])
                );
            const groups = {
                first: sortedGroups(font?.first_kern_groups),
                second: sortedGroups(font?.second_kern_groups)
            };
            {
                for (const name of names) {
                    const glyph = font?.findGlyph?.(name);
                    catalog[name] = [...(glyph?.codepoints ?? [])].sort(
                        (left: number, right: number) => left - right
                    );
                    glyphs[name] = glyph
                        ? Object.fromEntries(
                              (glyph.drawings ?? []).map((item: any) => [
                                  item.id,
                                  drawing(item)
                              ])
                          )
                        : null;
                }
                for (const station of font?.stations ?? []) {
                    kerning[station.id] = { ...(station.kerning ?? {}) };
                }
            }
            for (const stationId of Object.keys(kerning)) {
                kerning[stationId] = Object.fromEntries(
                    Object.entries(kerning[stationId])
                        .filter(([, value]) => value !== 0 && value != null)
                        .sort(([left], [right]) => left.localeCompare(right))
                        .map(([pair, value]) => [pair, round(value) as number])
                );
            }
            return { glyphs, kerning, features, groups, catalog };
        },
        { names: FUZZ_GLYPHS, featureTag: FUZZ_FEATURE_TAG }
    );
}

/**
 * Put the fuzz text in this window and open `glyphName` in the editor at
 * `masterId`’s location, so an edit lands in that master’s layer and its
 * history belongs to this glyph, as when a person edits it.
 */
export async function openFuzzGlyph(
    page: Page,
    glyphName: string,
    stationId: FuzzStationId
) {
    const wght = FUZZ_STATIONS.find(
        (station) => station.id === stationId
    )!.wght;
    await page.evaluate(
        async ({ text, name, location }) => {
            const w = window as any;
            const canvas = w.glyphCanvas;
            const editor = canvas.textRunEditor;
            if (editor.textBuffer !== text) {
                editor.setTextBuffer(text);
                await editor.shapeText?.(true);
            }
            const index = (editor.glyphNameBuffer ?? []).indexOf(name);
            if (index >= 0) {
                await editor.selectGlyphByIndex(index, true);
            }
            canvas.outlineEditor.active = true;
            canvas.outlineEditor.currentGlyphName = name;
            const axes = canvas.axesManager;
            axes?.setVariation?.('wght', location);
            axes?.call?.('onSliderChange', 'wght', location);
            await canvas.doUIUpdateAsync?.();
            await canvas.outlineEditor.autoSelectMatchingDrawing?.();
            await canvas.doUIUpdateAsync?.();
        },
        { text: FUZZ_TEXT, name: glyphName, location: wght }
    );
    await expect
        .poll(
            () =>
                page.evaluate(
                    ({ name }) => {
                        const editor = (window as any).glyphCanvas
                            ?.outlineEditor;
                        return editor?.currentGlyphName === name
                            ? editor.selectedDrawingId
                            : null;
                    },
                    { name: glyphName }
                ),
            { timeout: 15000, message: `open ${glyphName} at ${stationId}` }
        )
        .toBe(stationId);
}

export type FuzzEdit =
    | {
          kind: 'outline';
          glyph: string;
          master: FuzzStationId;
          shape: number;
          node: number;
          dx: number;
          dy: number;
      }
    | {
          kind: 'anchor';
          glyph: string;
          master: FuzzStationId;
          anchor: string;
          dx: number;
          dy: number;
      }
    | { kind: 'width'; glyph: string; master: FuzzStationId; dw: number }
    | {
          kind: 'align';
          glyph: string;
          master: FuzzStationId;
          automatic: boolean;
      }
    | { kind: 'kern'; master: FuzzStationId; pair: string; value: number }
    | { kind: 'kern-delete'; master: FuzzStationId; pair: string }
    | {
          kind: 'kern-group';
          master: FuzzStationId;
          glyph: string;
          group: string;
          include: boolean;
      }
    | { kind: 'feature'; master: FuzzStationId; value: number }
    | { kind: 'unicode'; master: FuzzStationId; glyph: string; add: boolean }
    | { kind: 'undo' | 'redo'; glyph: string; master: FuzzStationId };

export function describeFuzzEdit(edit: FuzzEdit): string {
    switch (edit.kind) {
        case 'outline':
            return `outline ${edit.glyph}/${edit.master} shape ${edit.shape} node ${edit.node} by (${edit.dx}, ${edit.dy})`;
        case 'anchor':
            return `anchor ${edit.glyph}/${edit.master} ${edit.anchor} by (${edit.dx}, ${edit.dy})`;
        case 'width':
            return `width ${edit.glyph}/${edit.master} by ${edit.dw}`;
        case 'align':
            return `automatic alignment ${edit.automatic ? 'on' : 'off'} ${edit.glyph}/${edit.master}`;
        case 'kern':
            return `kern ${edit.pair}/${edit.master} = ${edit.value}`;
        case 'kern-delete':
            return `delete kern ${edit.pair}/${edit.master}`;
        case 'kern-group':
            return `${edit.include ? 'add' : 'remove'} ${edit.glyph} ${edit.include ? 'to' : 'from'} kerning group @${edit.group}`;
        case 'feature':
            return `feature ${FUZZ_FEATURE_TAG} code, mark ${edit.value}`;
        case 'unicode':
            return `${edit.add ? 'add' : 'remove'} U+${FUZZ_EXTRA_CODEPOINT.toString(16).toUpperCase()} ${edit.add ? 'to' : 'from'} ${edit.glyph}`;
        default:
            return `${edit.kind} ${edit.glyph}/${edit.master}`;
    }
}

/**
 * Apply one edit in this window through the path the editor itself uses:
 * model transactions for point, width, component and kerning edits, the
 * canvas anchor-drag commit (with automatic recomposition) for anchors, and
 * the Undo command for undo and redo. Resolves once the edit is committed.
 */
export async function applyFuzzEdit(
    page: Page,
    edit: FuzzEdit,
    options: { awaitCloud?: boolean } = {}
) {
    await openFuzzGlyph(page, fuzzEditOpenGlyph(edit), edit.master);
    await page.evaluate(
        async (step) => {
            const w = window as any;
            const bridge = w.patchSyncEngine;
            const font = w.currentFontModel;
            const transact = (
                label: string,
                source: string,
                editType: string | null,
                mutate: () => void
            ) => {
                bridge.beginTransaction(label, null, {
                    compileChangeSource: source,
                    compileEditType: editType
                });
                try {
                    mutate();
                } finally {
                    bridge.endTransaction();
                }
            };
            if (step.kind === 'undo' || step.kind === 'redo') {
                const compiled: string[] = [];
                const onCompiled = (event: Event) => {
                    const detail = (event as CustomEvent).detail ?? {};
                    compiled.push(
                        `${detail.fontRevisionKey}${detail.error ? ` error ${String(detail.error).slice(0, 120)}` : ''}`
                    );
                };
                window.addEventListener('editingFontCompiled', onCompiled);
                try {
                    await w.runBridgeUndoRedo(
                        step.kind,
                        step.glyph,
                        step.glyph,
                        step.master,
                        null
                    );
                } catch (error) {
                    await new Promise((resolve) => setTimeout(resolve, 15000));
                    throw new Error(
                        `${error instanceof Error ? error.message : String(error)}; requested ${w.fontManager?.currentFont?.compileRequestVersion}; compiles seen: ${compiled.join(', ') || 'none'}; worker quarantined ${w.fontManager?.workerMirrorQuarantined}, compile in flight ${!!w.fontManager?.editingCompileInFlight}`
                    );
                } finally {
                    window.removeEventListener(
                        'editingFontCompiled',
                        onCompiled
                    );
                }
            } else if (step.kind === 'kern-delete') {
                const station = font.stations.find(
                    (item: any) => item.id === step.master
                );
                transact(
                    'Delete kerning pair',
                    'keyboard-kerning-value',
                    'kerning-value',
                    () => {
                        const next = { ...station.kerning };
                        delete next[step.pair];
                        station.kerning = next;
                    }
                );
            } else if (step.kind === 'kern-group') {
                // The overview's kerning-group membership commit.
                transact(
                    step.include
                        ? 'Add kern group membership'
                        : 'Remove kern group membership',
                    'keyboard-kerning-groups',
                    'kerning-groups',
                    () => {
                        const groups: Record<string, string[]> = {};
                        for (const [name, members] of Object.entries(
                            font.first_kern_groups ?? {}
                        )) {
                            groups[name] = [...(members as string[])];
                        }
                        const members = (groups[step.group] ?? []).filter(
                            (name) => name !== step.glyph
                        );
                        groups[step.group] = step.include
                            ? [...members, step.glyph]
                            : members;
                        font.first_kern_groups = groups;
                    }
                );
            } else if (step.kind === 'feature') {
                // Font Info's feature-code commit: a synthetic change set on
                // the feature's history target.
                const features = font.features.features;
                const index = features.findIndex(
                    (entry: any) => entry[0] === step.tag
                );
                const codeData = features[index][1];
                const previous = codeData.code || '';
                const next = `${step.base}\n# fuzz mark ${step.value}`;
                const options = {
                    compileChangeSource: 'feature-code',
                    compileEditType: 'feature'
                };
                bridge.beginTransaction(
                    'Edit feature code',
                    {
                        type: 'feature',
                        key: `feature:${step.tag}:1`,
                        label: step.tag
                    },
                    options
                );
                try {
                    codeData.code = next;
                    bridge.applySyntheticChangeSet(
                        'Edit feature code',
                        [
                            {
                                op: 'set',
                                path: [
                                    'features',
                                    'features',
                                    index,
                                    1,
                                    'code'
                                ],
                                oldValue: previous,
                                newValue: next
                            }
                        ],
                        options
                    );
                } finally {
                    bridge.endTransaction();
                }
            } else if (step.kind === 'unicode') {
                // The overview's Unicode field commit.
                const glyph = font.findGlyph(step.glyph);
                const current: number[] = [...(glyph.codepoints ?? [])];
                const rest = current.filter(
                    (value) => value !== step.extraCodepoint
                );
                transact('Set glyph Unicode', 'font-info', null, () => {
                    const next = step.add
                        ? [...rest, step.extraCodepoint]
                        : rest;
                    glyph.codepoints = next.length ? next : undefined;
                });
            } else if (step.kind === 'kern') {
                const station = font.stations.find(
                    (item: any) => item.id === step.master
                );
                transact(
                    'Edit kerning pair',
                    'keyboard-kerning-value',
                    'kerning-value',
                    () => {
                        station.kerning = {
                            ...station.kerning,
                            [step.pair]: step.value
                        };
                    }
                );
            } else {
                const drawing = font
                    .findGlyph(step.glyph)
                    .findDrawingById(step.master);
                if (step.kind === 'outline') {
                    const node = drawing.paths[step.shape].nodes[step.node];
                    transact('Move point', 'keyboard-outline', null, () => {
                        node.x = node.x + step.dx;
                        node.y = node.y + step.dy;
                    });
                } else if (step.kind === 'width') {
                    transact('Set width', 'keyboard-sidebearing', null, () => {
                        drawing.width = drawing.width + step.dw;
                    });
                } else if (step.kind === 'align') {
                    transact(
                        'Automatic alignment',
                        'component-property',
                        null,
                        () => {
                            for (const shape of drawing.shapes) {
                                const component = shape.asComponent?.();
                                if (component) {
                                    component.automaticAlignment =
                                        step.automatic;
                                }
                            }
                            if (step.automatic) {
                                drawing.rebuildAutomaticComposition();
                            }
                        }
                    );
                } else if (step.kind === 'anchor') {
                    // The canvas anchor drag: move, recompose the automatic
                    // composites built on it, then sync the changed layers.
                    const anchor = drawing.anchors.find(
                        (item: any) => item.name === step.anchor
                    );
                    const affected = new Set<string>([step.glyph]);
                    w.changeBridge.runWithoutRecording(() => {
                        anchor.x = anchor.x + step.dx;
                        anchor.y = anchor.y + step.dy;
                        for (const name of font.rebuildAutomaticCompositesForGlyphs(
                            new Set([step.glyph]),
                            {
                                preferredDrawingId: step.master,
                                preferredSourceGlyphName: step.glyph
                            }
                        )) {
                            affected.add(name);
                        }
                    });
                    w.fontManager.currentFont.syncJsonFromModel();
                    const targets = [...affected].map((glyphName) => ({
                        glyphName,
                        layerId: step.master
                    }));
                    w.changeBridge.syncDrawingsFromJson(
                        targets,
                        'Drag anchor',
                        undefined,
                        undefined,
                        undefined,
                        targets,
                        'mouse-drag-anchor',
                        'mouse-drag-anchor',
                        null
                    );
                }
            }
            if (step.awaitCloud) {
                await bridge.waitForPendingCloudCommits?.();
            }
        },
        {
            ...edit,
            awaitCloud: options.awaitCloud !== false,
            tag: FUZZ_FEATURE_TAG,
            base: FUZZ_FEATURE_CODE,
            extraCodepoint: FUZZ_EXTRA_CODEPOINT
        }
    );
}

/** Edits of font-wide data, made with `a` open in the editor. */
export function isFontWideFuzzEdit(edit: FuzzEdit): boolean {
    return (
        edit.kind === 'kern' ||
        edit.kind === 'kern-delete' ||
        edit.kind === 'kern-group' ||
        edit.kind === 'feature' ||
        edit.kind === 'unicode'
    );
}

/** The glyph a window opens before it makes this edit. */
export function fuzzEditOpenGlyph(edit: FuzzEdit): string {
    return isFontWideFuzzEdit(edit) ? 'a' : (edit as { glyph: string }).glyph;
}

/**
 * The binary truth: the editing font this window compiled, against a fresh
 * full compile of this window’s current document in the isolated compiler.
 * Both are shaped with the fuzz text at the comparison location; each
 * glyph’s outline and advance must match.
 */
export async function readCompiledOutlines(page: Page): Promise<{
    editing: Array<{ path: string; advance: number }> | null;
    fresh: Array<{ path: string; advance: number }> | null;
    error?: string;
}> {
    return page.evaluate(
        async ({ text, location }) => {
            const w = window as any;
            const hb = w.glyphCanvas?.textRunEditor?.hb;
            const editingBytes: Uint8Array | null = w.fontManager?.editingFont;
            if (!hb || !editingBytes) {
                return { editing: null, fresh: null, error: 'not compiled' };
            }
            const shape = (bytes: Uint8Array) => {
                const blob = hb.createBlob(bytes);
                const face = hb.createFace(blob, 0);
                const font = hb.createFont(face);
                font.setVariations?.(location);
                const buffer = hb.createBuffer();
                buffer.addText(text);
                buffer.guessSegmentProperties();
                hb.shape(font, buffer);
                const glyphs = buffer.json().map((glyph: any) => ({
                    path: String(font.glyphToPath(glyph.g)),
                    advance: Math.round(Number(glyph.ax))
                }));
                buffer.destroy();
                font.destroy();
                face.destroy();
                blob.destroy();
                return glyphs;
            };
            try {
                const documents = w.fontManager.buildWorkerSeedDocumentSet();
                await w.fullFontCompilation.seedWorkerDocumentSet(documents);
                w.fullFontCompilation.setCompileFeatureOverlay('');
                const compiled = await w.fullFontCompilation.compileCached(
                    'user',
                    'fuzz-fresh.ttf'
                );
                return {
                    editing: shape(new Uint8Array(editingBytes)),
                    fresh: shape(new Uint8Array(compiled.result))
                };
            } catch (error) {
                return {
                    editing: null,
                    fresh: null,
                    error:
                        error instanceof Error ? error.message : String(error)
                };
            }
        },
        { text: FUZZ_TEXT, location: FUZZ_COMPARE_LOCATION }
    );
}

/**
 * Automatic composites must sit where recomposing them now would put them:
 * mismatches between stored and freshly computed placements and widths.
 */
export async function readCompositionMismatches(page: Page): Promise<string[]> {
    return page.evaluate(
        (names) => {
            const font = (window as any).currentFontModel;
            const mismatches: string[] = [];
            for (const name of names) {
                for (const drawing of font?.findGlyph?.(name)?.drawings ?? []) {
                    if (!drawing.isAutomaticAlignedDrawing?.()) {
                        continue;
                    }
                    drawing.invalidateLayoutCache?.();
                    const layout = drawing.getAutomaticCompositionLayout?.();
                    if (!layout) {
                        continue;
                    }
                    drawing.components.forEach(
                        (component: any, index: number) => {
                            const placement = layout.placements?.[index];
                            if (!placement) {
                                return;
                            }
                            const [x, y] = component.transform?.translation ?? [
                                0, 0
                            ];
                            if (
                                Math.abs(x - placement.translationX) > 0.5 ||
                                Math.abs(y - placement.translationY) > 0.5
                            ) {
                                mismatches.push(
                                    `${name}/${drawing.id} component ${index} at (${x}, ${y}), recomposes to (${placement.translationX}, ${placement.translationY})`
                                );
                            }
                        }
                    );
                    const width =
                        drawing.getAutomaticCompositionDerivedWidth?.(layout);
                    if (
                        typeof width === 'number' &&
                        Math.abs(drawing.width - width) > 0.5
                    ) {
                        mismatches.push(
                            `${name}/${drawing.id} width ${drawing.width}, recomposes to ${width}`
                        );
                    }
                }
            }
            return mismatches;
        },
        FUZZ_COMPOSITES.concat(['adieresis.ss01'])
    );
}

/** Keyed sidebearings that no longer match their source glyph. */
export function metricsKeyMismatches(snapshot: FuzzSnapshot): string[] {
    const bounds = (glyph: string, station: string) => {
        const drawing = (snapshot.glyphs[glyph] as any)?.[station];
        const xs = (drawing?.shapes ?? []).flatMap((shape: any) =>
            (shape.nodes ?? []).map((node: any) => node[0])
        );
        if (!xs.length) {
            return null;
        }
        return {
            left: Math.min(...xs),
            right: drawing.width - Math.max(...xs)
        };
    };
    const mismatches: string[] = [];
    for (const { id } of FUZZ_STATIONS) {
        for (const [glyph, side, source, offset] of FUZZ_METRICS_KEYS) {
            const keyed = bounds(glyph, id);
            const from = bounds(source, id);
            if (!keyed || !from) {
                continue;
            }
            const expected = from[side] + offset;
            if (Math.abs(keyed[side] - expected) > 0.5) {
                mismatches.push(
                    `${glyph}/${id} ${side} sidebearing ${keyed[side]}, key =${source}${offset || ''} gives ${expected}`
                );
            }
        }
    }
    return mismatches;
}

/** The glyphs whose normalised data differs between two snapshots. */
export function changedFuzzGlyphs(
    before: FuzzSnapshot,
    after: FuzzSnapshot
): string[] {
    return FUZZ_GLYPHS.filter(
        (name) =>
            JSON.stringify(before.glyphs[name]) !==
            JSON.stringify(after.glyphs[name])
    );
}

/** The last entries of this window’s change log, for failure reports. */
export async function readChangeLogTail(page: Page, count = 25) {
    return page.evaluate((limit) => {
        const log: any[] = (window as any).patchSyncEngine?._changeLog ?? [];
        return log
            .slice(-limit)
            .map((entry) =>
                [
                    entry.historyAction,
                    entry.historyItemId,
                    entry.windowId,
                    entry.transactionLabel,
                    entry.compileChangeSource ?? '',
                    entry.path,
                    JSON.stringify(entry.oldValue)?.slice(0, 80),
                    JSON.stringify(entry.newValue)?.slice(0, 80)
                ].join(' | ')
            );
    }, count);
}

/**
 * Why a window’s compiled font is stale: which glyphs its editing worker
 * holds differently from the fresh full-font worker (stale worker data),
 * and whether a recompile from the worker it has fixes the font (a compile
 * that never ran).
 */
export async function diagnoseStaleCompile(page: Page): Promise<string> {
    const workerDiff = await page.evaluate(
        async ({ names, location }) => {
            const w = window as any;
            const outlines = async (compiler: any) => {
                const response = await compiler.sendMessage({
                    type: 'getGlyphOutlines',
                    glyphNames: names,
                    location,
                    flattenComponents: true
                });
                return JSON.parse(response.outlinesJson || '[]') as Array<{
                    name: string;
                    shapes: unknown;
                    width: unknown;
                }>;
            };
            try {
                const editing = await outlines(w.fontCompilation);
                const fresh = await outlines(w.fullFontCompilation);
                return names.filter((name: string) => {
                    const pick = (list: any[]) =>
                        JSON.stringify(
                            list.find((item) => item.name === name) ?? null,
                            (key, value) =>
                                key === 'anchors' ? undefined : value
                        );
                    return pick(editing) !== pick(fresh);
                });
            } catch (error) {
                return [
                    `error: ${error instanceof Error ? error.message : String(error)}`
                ];
            }
        },
        { names: FUZZ_GLYPHS, location: FUZZ_COMPARE_LOCATION }
    );
    await page.evaluate(() =>
        (window as any).fontManager?.recompileEditingFont?.()
    );
    await page.waitForTimeout(1500);
    const after = await readCompiledOutlines(page);
    const healed =
        !after.error &&
        JSON.stringify(after.editing) === JSON.stringify(after.fresh);
    return `editing worker differs from fresh worker for: ${workerDiff.join(', ') || 'none'}; recompile ${healed ? 'fixes' : 'does not fix'} the font`;
}
