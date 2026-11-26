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

/**
 * Arabic glyphs, the only ones in right-to-left kerning: beh-ar kerns first
 * with its left group BEH, alef-ar second with its right group ALEF.
 */
export const FUZZ_ARABIC_GLYPHS: Record<string, number> = {
    'beh-ar': 0x0628,
    'alef-ar': 0x0627,
    'reh-ar': 0x0631
};
/** Right-to-left pairs, read from the right: first glyph, then second. */
export const FUZZ_RTL_KERN_PAIRS = [
    'beh-ar:alef-ar',
    'reh-ar:alef-ar',
    'alef-ar:beh-ar',
    'beh-ar:@ALEF',
    '@BEH:alef-ar',
    '@BEH:@ALEF'
];

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
    'adieresis.ss01',
    'p',
    'q',
    ...Object.keys(FUZZ_ARABIC_GLYPHS)
];

/** Text that shapes to every fuzz glyph, so the compiled check sees all. */
// U+E001 maps to adieresis.ss01 only while a Unicode edit has added it.
export const FUZZ_TEXT = 'lnmıaoäáöiï̈́̇pq\u0628\u0627\u0631';

/**
 * `p` takes the outline-structure edits (points and contours added and
 * removed, direction, open and closed, transforms, anchors, free,
 * background and variation drawings); `q` is built from manual components.
 */
export const FUZZ_STRUCTURE_GLYPH = 'p';
export const FUZZ_COMPONENT_GLYPH = 'q';
/** Glyphs the fuzz adds, renames and deletes start with this. */
export const FUZZ_NEW_GLYPH_PREFIX = 'fuzz.';
/** Second feature the fuzz adds, removes and moves. */
export const FUZZ_EXTRA_FEATURE: [string, string] = [
    'ss02',
    'sub o by odieresis;'
];
/**
 * Declared as a Latin font declares them. The prefix edit drops `latn` at
 * times: then the compiler registers marks under DFLT alone while kerning
 * still adds a `latn` record, and Latin text loses mark positioning.
 */
export const FUZZ_LANGUAGE_SYSTEMS =
    'languagesystem DFLT dflt;\nlanguagesystem latn dflt;';
export const FUZZ_LANGUAGE_SYSTEMS_DFLT_ONLY = 'languagesystem DFLT dflt;';

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
    first: { L: ['l'], ALEF: ['alef-ar'] } as Record<string, string[]>,
    second: { A: ['a'], BEH: ['beh-ar'] } as Record<string, string[]>
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
const MANUAL = { 'com.schriftgestalt.Glyphs.alignment': -1 };

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

function manualComponent(reference: string, x: number, y: number) {
    return { ...component(reference, x, y), format_specific: { ...MANUAL } };
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
        },
        p: {
            M1: {
                rects: [
                    [60, -200, 120, 500],
                    [120, 0, 420, 500]
                ],
                width: 480,
                anchors: [{ name: 'bottom', x: 90, y: -200 }]
            },
            M2: {
                rects: [
                    [60, -200, 200, 500],
                    [200, 0, 500, 500]
                ],
                width: 560,
                anchors: [{ name: 'bottom', x: 130, y: -200 }]
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
        'adieresis.ss01': [0xe000],
        'p': [0x70],
        'q': [0x71]
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
    const arabicGlyphs = Object.entries(FUZZ_ARABIC_GLYPHS).map(
        ([name, codepoint], index) =>
            outlineGlyph(name, [codepoint], {
                M1: {
                    rects: [[40, 0, 100 + index * 60, 300]],
                    width: 200 + index * 60
                },
                M2: {
                    rects: [[40, 0, 160 + index * 60, 300]],
                    width: 260 + index * 60
                }
            })
    );
    const glyphs = [
        notdef,
        ...arabicGlyphs,
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
            name: FUZZ_COMPONENT_GLYPH,
            category: 'Base',
            codepoints: codepoints[FUZZ_COMPONENT_GLYPH],
            layers: FUZZ_STATIONS.map(({ id }) => ({
                width: bases.o[id].width + 160,
                id,
                master: { type: 'DefaultForMaster', master: id },
                shapes: [
                    manualComponent('o', 0, 0),
                    manualComponent('l', bases.o[id].width - 40, -200)
                ],
                anchors: [],
                guides: [],
                format_specific: {}
            })),
            exported: true,
            format_specific: {}
        },
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
        instances: [
            {
                id: 'regular',
                name: { dflt: 'Regular' },
                location: { wght: 400 },
                custom_names: {},
                variable: false,
                format_specific: {}
            }
        ],
        masters: FUZZ_STATIONS.map(({ id, wght }) => ({
            name: { dflt: id === 'M1' ? 'Light' : 'Bold' },
            id,
            location: { wght },
            guides: [],
            metrics: {
                'XHeight': 500,
                'CapHeight': 700,
                'Ascender': 750,
                'Descender': -250,
                'XHeight overshoot': 10
            },
            kerning: {},
            kerning_rtl: {
                'beh-ar:alef-ar': id === 'M1' ? -20 : -40,
                '@BEH:@ALEF': id === 'M1' ? -30 : -50
            },
            custom_ot_values: {},
            format_specific: {}
        })),
        glyphs,
        date: new Date().toISOString(),
        names: { family_name: { dflt: familyName } },
        features: {
            classes: { fuzz: { code: 'a o' } },
            prefixes: { languagesystems: { code: FUZZ_LANGUAGE_SYSTEMS } },
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
    /** Every layer of every fuzz glyph, keyed by layer id: station, free,
     *  background and variation drawings alike; null for a missing glyph. */
    glyphs: Record<string, unknown>;
    /** Glyph-level data: category, production name, export, metrics keys,
     *  feature-variation rules, and what each layer is. */
    props: Record<string, unknown>;
    kerning: Record<string, Record<string, number>>;
    kerningRtl: Record<string, Record<string, number>>;
    /** Code of the fuzz feature (features room). */
    features: string | null;
    /** Feature tags in order, the other features' code, prefixes, classes. */
    featureSet: unknown;
    /** Kerning groups, first and second side, members sorted. */
    groups: Record<string, Record<string, string[]>>;
    /** Codepoints of every fuzz glyph (catalog rooms). */
    catalog: Record<string, number[]>;
    /** Font-wide data: axes, stations, instances and font info. */
    font: Record<string, unknown>;
};

/**
 * For each drawing, whether this window’s model still matches its own
 * documents (width, every shape and anchor), with the pending
 * collaborator-cascade previews: the evidence that tells drift (the model
 * differs) from a missing update (the documents differ).
 */
export async function readModelVsDocuments(
    page: Page,
    drawings: Array<[string, string]>
): Promise<string[]> {
    return page.evaluate((targets) => {
        const w = window as any;
        const lines = targets.map(([glyphName, drawingId]) => {
            const drift = w.changeBridge?.describeStoredDrawingDrift?.(
                glyphName,
                drawingId,
                w.currentFontModel
                    ?.findGlyph?.(glyphName)
                    ?.findDrawingById?.(drawingId)
            );
            if (!drift) {
                return `${glyphName}/${drawingId}: no sync engine`;
            }
            return drift.difference
                ? `${glyphName}/${drawingId}: model ${drift.model} DRIFTED from documents ${drift.stored}: ${drift.difference}`
                : `${glyphName}/${drawingId}: model matches its documents (${drift.model})`;
        });
        const pending = (w.remoteCascadePreview?.pendingTargets ?? []).map(
            (target: { glyphName: string; layerId: string }) =>
                `${target.glyphName}/${target.layerId}`
        );
        lines.push(`cascade previews: ${pending.join(', ') || 'none'}`);
        return lines;
    }, drawings);
}

export type CollabTraceEntry = {
    sequence: number;
    at: number;
    kind: string;
    glyphs: string[];
    detail: Record<string, unknown>;
};

/** The window’s collaboration trace (js/collab-trace.ts); empty if closed. */
export async function readCollabTrace(page: Page): Promise<CollabTraceEntry[]> {
    return page
        .evaluate(() => (window as any).__collabTrace?.entries ?? [])
        .catch(() => []);
}

/**
 * Trace entries as lines, `#sequence at+ms kind [glyphs] detail`: the last
 * `limit` entries that touched one of `focus`, or the last ones of all.
 */
export function formatCollabTrace(
    entries: CollabTraceEntry[],
    focus: string[] = [],
    limit = 40
): string[] {
    const wanted = new Set(focus);
    const chosen = wanted.size
        ? entries.filter((entry) =>
              entry.glyphs.some((glyph) => wanted.has(glyph))
          )
        : entries;
    return chosen
        .slice(-limit)
        .map(
            (entry) =>
                `#${entry.sequence} ${entry.at}ms ${entry.kind} [${entry.glyphs.join(' ')}] ${JSON.stringify(entry.detail).slice(0, 500)}`
        );
}

/** This window’s font model, normalised: rounded, anchors sorted. */
/**
 * A window that opens the font holds the glyphs its text shows and what they
 * need (a sparse working set); the overview loads the others as it shows
 * them. Load every live catalog glyph this window lacks, the way the
 * overview would, so its model can be compared whole. Returns their names.
 */
export async function loadCatalogGlyphs(page: Page): Promise<string[]> {
    return page.evaluate(async (text) => {
        const w = window as any;
        const bridge = w.patchSyncEngine;
        const fontJson = bridge?._fontJson;
        const catalog =
            fontJson?.glyphCatalog ??
            fontJson?.format_specific?.['com.counterpunch.cloud']
                ?.glyphCatalog ??
            {};
        const names = Object.values(catalog as Record<string, any>)
            .filter(
                (entry: any) =>
                    entry?.name &&
                    entry.deleted !== true &&
                    !bridge.hasResidentGlyphDocument?.(`glyph:${entry.glyphId}`)
            )
            .map((entry: any) => String(entry.name));
        if (names.length) {
            await w.cloudPlugin.ensureSparseHydration({
                text,
                glyphNames: names,
                purpose: 'ui'
            });
        }
        return names;
    }, FUZZ_TEXT);
}

export async function readFuzzSnapshot(page: Page): Promise<FuzzSnapshot> {
    return page.evaluate(
        ({ names, featureTag, newPrefix }) => {
            const w = window as any;
            const round = (value: unknown) =>
                typeof value === 'number'
                    ? Math.round(value * 1000) / 1000
                    : value;
            const nodeOf = (node: any) => [
                round(node.x),
                round(node.y),
                String(node.nodetype ?? node.type ?? '').charAt(0),
                node.smooth ? 1 : 0
            ];
            const componentOf = (
                reference: string,
                transform: any,
                automatic: boolean
            ) => {
                const scale = (transform?.scale ?? [1, 1]).map(round);
                return {
                    reference,
                    translation: (transform?.translation ?? [0, 0]).map(round),
                    automatic,
                    ...(scale[0] !== 1 || scale[1] !== 1 ? { scale } : {})
                };
            };
            // Model shapes, for drawings the model reaches.
            const shape = (item: any) => {
                if (item.isComponent?.()) {
                    const component = item.asComponent();
                    return componentOf(
                        component.reference,
                        component.transform,
                        component.automaticAlignment === true
                    );
                }
                const path = item.asPath();
                return {
                    nodes: (path?.nodes ?? []).map(nodeOf),
                    closed: path?.closed !== false
                };
            };
            // Stored shapes, for layers outside glyph.drawings.
            const rawShape = (item: any) =>
                typeof item?.reference === 'string'
                    ? componentOf(
                          item.reference,
                          item.transform,
                          item.format_specific?.[
                              'com.schriftgestalt.Glyphs.alignment'
                          ] === 1
                      )
                    : {
                          nodes: (item?.nodes ?? []).map(nodeOf),
                          closed: item?.closed !== false
                      };
            const anchorsOf = (anchors: any[]) =>
                (anchors ?? [])
                    .map((anchor: any) => [
                        anchor.name,
                        round(anchor.x),
                        round(anchor.y)
                    ])
                    .sort((left: any, right: any) =>
                        String(left[0]).localeCompare(String(right[0]))
                    );
            const glyphs: Record<string, unknown> = {};
            const props: Record<string, unknown> = {};
            const kerning: Record<string, Record<string, number>> = {};
            const kerningRtl: Record<string, Record<string, number>> = {};
            const catalog: Record<string, number[]> = {};
            const font = w.currentFontModel;
            const allNames = [
                ...names,
                ...(font?.glyphs ?? [])
                    .map((glyph: any) => glyph.name)
                    .filter(
                        (name: string) =>
                            name.startsWith(newPrefix) && !names.includes(name)
                    )
                    .sort()
            ];
            const featureList = font?.features?.features ?? [];
            const feature = featureList.find(
                (entry: any) => entry?.[0] === featureTag
            );
            const features: string | null = feature?.[1]?.code ?? null;
            const featureSet = {
                tags: featureList.map((entry: any) => entry?.[0]),
                code: Object.fromEntries(
                    featureList
                        .filter((entry: any) => entry?.[0] !== featureTag)
                        .map((entry: any) => [entry[0], entry[1]?.code ?? ''])
                ),
                prefixes: Object.fromEntries(
                    Object.entries(font?.features?.prefixes ?? {}).map(
                        ([name, value]: [string, any]) => [name, value?.code]
                    )
                ),
                classes: Object.fromEntries(
                    Object.entries(font?.features?.classes ?? {}).map(
                        ([name, value]: [string, any]) => [name, value?.code]
                    )
                )
            };
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
            for (const name of allNames) {
                const glyph = font?.findGlyph?.(name);
                catalog[name] = [...(glyph?.codepoints ?? [])].sort(
                    (left: number, right: number) => left - right
                );
                if (!glyph) {
                    glyphs[name] = null;
                    props[name] = null;
                    continue;
                }
                const layers: any[] =
                    (glyph.toJSON?.() ?? glyph.data)?.layers ?? [];
                glyphs[name] = Object.fromEntries(
                    layers.map((layer) => {
                        const drawing = (glyph.drawings ?? []).find(
                            (item: any) => item.id === layer.id
                        );
                        return [
                            layer.id,
                            {
                                width: round(drawing?.width ?? layer.width),
                                shapes: drawing
                                    ? (drawing.shapes ?? []).map(shape)
                                    : (layer.shapes ?? []).map(rawShape),
                                anchors: anchorsOf(
                                    drawing ? drawing.anchors : layer.anchors
                                )
                            }
                        ];
                    })
                );
                props[name] = {
                    category: glyph.category ?? null,
                    production_name: glyph.production_name ?? null,
                    exported: glyph.exported !== false,
                    leftMetricsKey: glyph.leftMetricsKey ?? null,
                    rightMetricsKey: glyph.rightMetricsKey ?? null,
                    variations: (glyph.featureVariations ?? [])
                        .map((variation: any) =>
                            JSON.stringify(variation.axisRules ?? null)
                        )
                        .sort(),
                    layers: Object.fromEntries(
                        layers.map((layer) => [
                            layer.id,
                            [
                                layer.is_background === true
                                    ? 'background'
                                    : (layer.master?.type ?? 'none'),
                                layer.master?.master ?? null,
                                layer.location ?? null,
                                layer.background_layer_id ?? null
                            ]
                        ])
                    )
                };
            }
            for (const station of font?.stations ?? []) {
                kerning[station.id] = { ...(station.kerning ?? {}) };
                kerningRtl[station.id] = { ...(station.kerning_rtl ?? {}) };
            }
            const sortedPairs = (pairs: Record<string, number>) =>
                Object.fromEntries(
                    Object.entries(pairs)
                        .filter(([, value]) => value !== 0 && value != null)
                        .sort(([left], [right]) => left.localeCompare(right))
                        .map(([pair, value]) => [pair, round(value) as number])
                );
            for (const stationId of Object.keys(kerning)) {
                kerning[stationId] = sortedPairs(kerning[stationId]);
                kerningRtl[stationId] = sortedPairs(kerningRtl[stationId]);
            }
            const plain = (value: unknown) =>
                value === undefined ? null : JSON.parse(JSON.stringify(value));
            const fontData = {
                axes: plain(
                    (font?.axes ?? []).map((axis: any) => [
                        axis.tag,
                        axis.min,
                        axis.default,
                        axis.max
                    ])
                ),
                stations: plain(
                    (font?.stations ?? []).map((station: any) => ({
                        id: station.id,
                        name: station.name,
                        location: station.location,
                        metrics: station.metrics
                    }))
                ),
                instances: plain(
                    (font?.instances ?? []).map((instance: any) => ({
                        id: instance.id,
                        name: instance.name,
                        location: instance.location
                    }))
                ),
                info: plain({
                    version: font?.version,
                    designer: font?.names?.designer,
                    vendor: font?.custom_ot_values?.os2_vendor_id ?? null
                })
            };
            return {
                glyphs,
                props,
                kerning,
                kerningRtl,
                features,
                featureSet,
                groups,
                catalog,
                font: fontData
            };
        },
        {
            names: FUZZ_GLYPHS,
            featureTag: FUZZ_FEATURE_TAG,
            newPrefix: FUZZ_NEW_GLYPH_PREFIX
        }
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
        .toBe(stationId)
        .catch(async (error) => {
            const state = await page.evaluate(
                ({ name }) => {
                    const w = window as any;
                    const canvas = w.glyphCanvas;
                    const editor = canvas?.outlineEditor;
                    return {
                        inText: (
                            canvas?.textRunEditor?.glyphNameBuffer ?? []
                        ).includes(name),
                        shaped: canvas?.textRunEditor?.glyphNameBuffer ?? null,
                        text: canvas?.textRunEditor?.textBuffer ?? null,
                        modelHas: !!w.currentFontModel?.findGlyph?.(name),
                        currentGlyph: editor?.currentGlyphName ?? null,
                        selectedDrawing: editor?.selectedDrawingId ?? null,
                        location: canvas?.axesManager?.variationSettings ?? null
                    };
                },
                { name: glyphName }
            );
            throw new Error(
                `${error instanceof Error ? error.message : String(error)}\n${JSON.stringify(state)}\n${(
                    await describeGlyphLayers(page, [glyphName])
                ).join('\n')}`
            );
        });
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
    | {
          kind: 'kern';
          master: FuzzStationId;
          pair: string;
          value: number;
          rtl?: boolean;
      }
    | {
          kind: 'kern-delete';
          master: FuzzStationId;
          pair: string;
          rtl?: boolean;
      }
    | {
          kind: 'kern-group';
          master: FuzzStationId;
          glyph: string;
          group: string;
          include: boolean;
          side?: 'first' | 'second';
      }
    | ExtendedFuzzEdit
    | { kind: 'feature'; master: FuzzStationId; value: number }
    | { kind: 'unicode'; master: FuzzStationId; glyph: string; add: boolean }
    | { kind: 'undo' | 'redo'; glyph: string; master: FuzzStationId };

/**
 * Edits beyond the first ten kinds: outline structure, transforms,
 * keyboard nudges, components, anchors, glyph properties and metrics keys,
 * free, background and variation drawings, glyphs added, renamed and
 * deleted, kerning groups, the feature list, prefixes and classes, station
 * metrics, instances and font info. Structural edits change every drawing
 * of the glyph alike, so the glyph stays compatible.
 */
export type ExtendedFuzzEdit =
    | {
          kind: 'node-insert' | 'node-remove' | 'smooth';
          glyph: string;
          master: FuzzStationId;
          shape: number;
          node: number;
      }
    | {
          kind: 'contour-add';
          glyph: string;
          master: FuzzStationId;
          rect: [number, number, number, number];
      }
    | {
          kind: 'contour-remove' | 'contour-reverse';
          glyph: string;
          master: FuzzStationId;
          shape: number;
      }
    | {
          kind: 'contour-open';
          glyph: string;
          master: FuzzStationId;
          shape: number;
          closed: boolean;
      }
    | {
          kind: 'transform';
          glyph: string;
          master: FuzzStationId;
          op: 'scale' | 'rotate' | 'flip';
      }
    | {
          kind: 'nudge';
          glyph: string;
          master: FuzzStationId;
          target: 'point' | 'anchor' | 'component';
          shape: number;
          index: number;
          key: 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown';
          shift: boolean;
      }
    | {
          kind: 'component-add';
          glyph: string;
          master: FuzzStationId;
          reference: string;
          x: number;
          y: number;
      }
    | {
          kind: 'component-remove' | 'component-decompose';
          glyph: string;
          master: FuzzStationId;
          shape: number;
      }
    | {
          kind: 'component-swap';
          glyph: string;
          master: FuzzStationId;
          shape: number;
          reference: string;
      }
    | {
          kind: 'component-transform';
          glyph: string;
          master: FuzzStationId;
          shape: number;
          dx: number;
          dy: number;
          scale: number;
      }
    | {
          kind: 'anchor-add';
          glyph: string;
          master: FuzzStationId;
          name: string;
          x: number;
          y: number;
      }
    | {
          kind: 'anchor-remove';
          glyph: string;
          master: FuzzStationId;
          name: string;
      }
    | {
          kind: 'anchor-rename';
          glyph: string;
          master: FuzzStationId;
          name: string;
          to: string;
      }
    | {
          kind: 'glyph-property';
          glyph: string;
          master: FuzzStationId;
          property: 'category' | 'production_name' | 'exported';
          value: string | boolean | null;
      }
    | {
          kind: 'metrics-key';
          glyph: string;
          master: FuzzStationId;
          side: 'left' | 'right';
          value: string | null;
      }
    | {
          kind: 'free-drawing';
          glyph: string;
          master: FuzzStationId;
          op: 'add' | 'remove' | 'edit';
          wght: number;
          drawing: string | null;
          dx: number;
          dy: number;
      }
    | {
          kind: 'background';
          glyph: string;
          master: FuzzStationId;
          op: 'add' | 'edit' | 'clear';
          dx: number;
          dy: number;
      }
    | {
          kind: 'variation';
          glyph: string;
          master: FuzzStationId;
          op: 'add' | 'remove' | 'edit';
          min: number;
          dx: number;
          dy: number;
      }
    | {
          kind: 'glyph-add' | 'glyph-delete';
          master: FuzzStationId;
          name: string;
      }
    | {
          kind: 'glyph-rename';
          master: FuzzStationId;
          name: string;
          to: string;
      }
    | {
          kind: 'kern-group-delete';
          master: FuzzStationId;
          side: 'first' | 'second';
          group: string;
      }
    | {
          kind: 'feature-list';
          master: FuzzStationId;
          op: 'add' | 'remove' | 'move';
      }
    | { kind: 'feature-prefix'; master: FuzzStationId; value: number }
    | { kind: 'feature-class'; master: FuzzStationId; members: string[] }
    | {
          kind: 'station-metric';
          master: FuzzStationId;
          key: string;
          value: number;
      }
    | {
          kind: 'instance';
          master: FuzzStationId;
          op: 'add' | 'edit' | 'remove';
          id: string;
          wght: number;
      }
    | {
          kind: 'font-info';
          master: FuzzStationId;
          field: 'designer' | 'version' | 'vendor';
          value: number;
      };

const EXTENDED_KINDS = new Set<string>([
    'node-insert',
    'node-remove',
    'smooth',
    'contour-add',
    'contour-remove',
    'contour-reverse',
    'contour-open',
    'transform',
    'nudge',
    'component-add',
    'component-remove',
    'component-decompose',
    'component-swap',
    'component-transform',
    'anchor-add',
    'anchor-remove',
    'anchor-rename',
    'glyph-property',
    'metrics-key',
    'free-drawing',
    'background',
    'variation',
    'glyph-add',
    'glyph-delete',
    'glyph-rename',
    'kern-group-delete',
    'feature-list',
    'feature-prefix',
    'feature-class',
    'station-metric',
    'instance',
    'font-info'
]);

export function isExtendedFuzzEdit(edit: FuzzEdit): edit is ExtendedFuzzEdit {
    return EXTENDED_KINDS.has(edit.kind);
}

function describeExtendedFuzzEdit(edit: ExtendedFuzzEdit): string {
    const at =
        'glyph' in edit ? `${edit.glyph}/${edit.master}` : `${edit.master}`;
    switch (edit.kind) {
        case 'node-insert':
        case 'node-remove':
        case 'smooth':
            return `${edit.kind} ${at} shape ${edit.shape} node ${edit.node}`;
        case 'contour-add':
            return `contour-add ${at} [${edit.rect.join(', ')}]`;
        case 'contour-remove':
        case 'contour-reverse':
        case 'component-remove':
        case 'component-decompose':
            return `${edit.kind} ${at} shape ${edit.shape}`;
        case 'contour-open':
            return `${edit.closed ? 'close' : 'open'} contour ${at} shape ${edit.shape}`;
        case 'transform':
            return `transform ${at} ${edit.op}`;
        case 'nudge':
            return `nudge ${at} ${edit.target} ${edit.target === 'point' ? `${edit.shape}:` : ''}${edit.index} ${edit.shift ? 'shift+' : ''}${edit.key}`;
        case 'component-add':
            return `component-add ${at} ${edit.reference} at (${edit.x}, ${edit.y})`;
        case 'component-swap':
            return `component-swap ${at} shape ${edit.shape} to ${edit.reference}`;
        case 'component-transform':
            return `component-transform ${at} shape ${edit.shape} by (${edit.dx}, ${edit.dy}) scale ${edit.scale}`;
        case 'anchor-add':
            return `anchor-add ${at} ${edit.name} at (${edit.x}, ${edit.y})`;
        case 'anchor-remove':
            return `anchor-remove ${at} ${edit.name}`;
        case 'anchor-rename':
            return `anchor-rename ${at} ${edit.name} to ${edit.to}`;
        case 'glyph-property':
            return `glyph-property ${edit.glyph} ${edit.property} = ${JSON.stringify(edit.value)}`;
        case 'metrics-key':
            return `metrics-key ${edit.glyph} ${edit.side} = ${JSON.stringify(edit.value)}`;
        case 'free-drawing':
            return `free-drawing ${edit.op} ${edit.glyph} at wght ${edit.wght}${edit.op === 'edit' ? ` by (${edit.dx}, ${edit.dy})` : ''}`;
        case 'background':
            return `background ${edit.op} ${at}${edit.op === 'edit' ? ` by (${edit.dx}, ${edit.dy})` : ''}`;
        case 'variation':
            return `variation ${edit.op} ${edit.glyph} wght ≥ ${edit.min}${edit.op === 'edit' ? ` by (${edit.dx}, ${edit.dy})` : ''}`;
        case 'glyph-add':
        case 'glyph-delete':
            return `${edit.kind} ${edit.name}`;
        case 'glyph-rename':
            return `glyph-rename ${edit.name} to ${edit.to}`;
        case 'kern-group-delete':
            return `delete ${edit.side} kerning group @${edit.group}`;
        case 'feature-list':
            return `feature-list ${edit.op} ${FUZZ_EXTRA_FEATURE[0]}`;
        case 'feature-prefix':
            return `languagesystems ${edit.value % 2 ? 'DFLT only' : 'DFLT and latn'}, mark ${edit.value}`;
        case 'feature-class':
            return `class @fuzz = [${edit.members.join(' ')}]`;
        case 'station-metric':
            return `station-metric ${edit.master} ${edit.key} = ${edit.value}`;
        case 'instance':
            return `instance ${edit.op} ${edit.id} at wght ${edit.wght}`;
        case 'font-info':
            return `font-info ${edit.field} = ${edit.value}`;
    }
}

export function describeFuzzEdit(edit: FuzzEdit): string {
    if (isExtendedFuzzEdit(edit)) {
        return describeExtendedFuzzEdit(edit);
    }
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
            return `kern${edit.rtl ? ' rtl' : ''} ${edit.pair}/${edit.master} = ${edit.value}`;
        case 'kern-delete':
            return `delete kern${edit.rtl ? ' rtl' : ''} ${edit.pair}/${edit.master}`;
        case 'kern-group':
            return `${edit.include ? 'add' : 'remove'} ${edit.glyph} ${edit.include ? 'to' : 'from'} ${edit.side ?? 'first'} kerning group @${edit.group}`;
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
    try {
        await applyFuzzEditUnguarded(page, edit, options);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes('read-only')) {
            throw error;
        }
        // Why the window refused: its own session, or what main relayed.
        const why = await page
            .evaluate(() => {
                const w = window as any;
                const plugin = w.cloudPlugin;
                return JSON.stringify({
                    linked: w.windowRole?.isLinkedWindow?.() === true,
                    relayedCanMutate: plugin?._relayedCanMutate ?? null,
                    relayedStatus: plugin?._relayedConnectionStatus ?? null,
                    linkedReadOnly: w.windowSync?.linkedReadOnly ?? null,
                    mainMissing: w.windowSync?.mainMissingLatched ?? null,
                    sessionAllows: plugin?._sessionAllowsMutation?.() ?? null,
                    connectionStatus: plugin?.connectionStatus ?? null,
                    walHealth: plugin?._liveSession?.walHealth ?? null,
                    offlineLevel: plugin?._offlineEditLimit?.level ?? null,
                    role: plugin?.getCurrentAssetRole?.() ?? null
                });
            })
            .catch(() => 'unknown');
        throw new Error(`${message}\nread-only state: ${why}`);
    }
}

async function applyFuzzEditUnguarded(
    page: Page,
    edit: FuzzEdit,
    options: { awaitCloud?: boolean } = {}
) {
    await openFuzzGlyph(page, fuzzEditOpenGlyph(edit), edit.master);
    if (isExtendedFuzzEdit(edit)) {
        await applyExtendedFuzzEdit(page, edit, options.awaitCloud !== false);
        return;
    }
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
                        if (step.rtl) {
                            const next = { ...station.kerning_rtl };
                            delete next[step.pair];
                            station.kerning_rtl = next;
                        } else {
                            const next = { ...station.kerning };
                            delete next[step.pair];
                            station.kerning = next;
                        }
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
                        const property =
                            step.side === 'second'
                                ? 'second_kern_groups'
                                : 'first_kern_groups';
                        const groups: Record<string, string[]> = {};
                        for (const [name, members] of Object.entries(
                            font[property] ?? {}
                        )) {
                            const list = members as string[];
                            groups[name] = step.include
                                ? list.filter((member) => member !== step.glyph)
                                : [...list];
                        }
                        const members = (groups[step.group] ?? []).filter(
                            (name) => name !== step.glyph
                        );
                        groups[step.group] = step.include
                            ? [...members, step.glyph]
                            : members;
                        font[property] = groups;
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
                        if (step.rtl) {
                            station.kerning_rtl = {
                                ...station.kerning_rtl,
                                [step.pair]: step.value
                            };
                        } else {
                            station.kerning = {
                                ...station.kerning,
                                [step.pair]: step.value
                            };
                        }
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

/**
 * Apply an extended edit in this window: a model transaction, as the editor
 * commits it, except glyph add, rename and delete (which record their own
 * transaction) and the keyboard nudge (the outline editor's own key path).
 */
async function applyExtendedFuzzEdit(
    page: Page,
    edit: ExtendedFuzzEdit,
    awaitCloud: boolean
) {
    await page.evaluate(
        async ({
            step,
            awaitCloud: wait,
            stationIds,
            extra,
            systems,
            dfltOnly
        }) => {
            const w = window as any;
            const bridge = w.patchSyncEngine;
            const font = w.currentFontModel;
            const plain = (value: unknown) =>
                value === undefined
                    ? undefined
                    : JSON.parse(JSON.stringify(value));
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
            const glyphName = 'glyph' in step ? step.glyph : '';
            const glyph = glyphName ? font.findGlyph(glyphName) : null;
            const atStation = (id: string) => {
                const drawing = glyph.findDrawingById(id);
                if (!drawing) {
                    throw new Error(`${glyphName} has no drawing ${id}`);
                }
                return drawing;
            };
            const rawLayers = (): any[] =>
                (glyph.toJSON?.() ?? glyph.data)?.layers ?? [];
            // Every drawing that interpolates with the others: station,
            // free and variation drawings, not backgrounds.
            const compatible = () => {
                // Not by background links: a background links back to its
                // foreground too.
                return rawLayers()
                    .filter((layer) => layer.is_background !== true)
                    .map((layer) => {
                        const drawing =
                            glyph.findDrawingById(layer.id) ??
                            (glyph.featureVariations ?? [])
                                .map((variation: any) =>
                                    variation.findDrawingById?.(layer.id)
                                )
                                .find(Boolean);
                        if (!drawing) {
                            throw new Error(
                                `${glyphName} drawing ${layer.id} is not reachable`
                            );
                        }
                        return drawing;
                    });
            };
            const pathAt = (drawing: any, index: number) => {
                const path = drawing.shapes[index]?.asPath?.();
                if (!path || drawing.shapes[index]?.isComponent?.()) {
                    throw new Error(
                        `${glyphName} shape ${index} is not a contour`
                    );
                }
                return path;
            };
            const componentAt = (drawing: any, index: number) => {
                const shape = drawing.shapes[index];
                if (!shape?.isComponent?.()) {
                    throw new Error(
                        `${glyphName} shape ${index} is not a component`
                    );
                }
                return shape.asComponent();
            };
            const appendRect = (path: any, [x0, y0, x1, y1]: number[]) => {
                path.appendNode(x0, y0, 'Line');
                path.appendNode(x1, y0, 'Line');
                path.appendNode(x1, y1, 'Line');
                path.appendNode(x0, y1, 'Line');
            };
            // Copy shapes and anchors into a new drawing, each point mixed
            // from two drawings (t = 0 copies `from`) and moved by dy.
            const copyMixed = (
                target: any,
                from: any,
                to: any,
                t: number,
                dy = 0
            ) => {
                const mix = (a: number, b: number) =>
                    Math.round(a + (b - a) * t);
                from.shapes.forEach((shape: any, index: number) => {
                    const other = to.shapes[index];
                    if (shape.isComponent?.()) {
                        const a = shape.asComponent();
                        const b = other.asComponent();
                        const [ax, ay] = a.transform?.translation ?? [0, 0];
                        const [bx, by] = b.transform?.translation ?? [0, 0];
                        target.addComponent(a.reference, {
                            translation: [mix(ax, bx), mix(ay, by) + dy],
                            scale: [1, 1],
                            rotation: 0,
                            skew: [0, 0]
                        });
                        return;
                    }
                    const a = shape.asPath();
                    const b = other.asPath();
                    const path = target.addPath(a.closed !== false);
                    a.nodes.forEach((node: any, nodeIndex: number) => {
                        const peer = b.nodes[nodeIndex];
                        path.appendNode(
                            mix(node.x, peer.x),
                            mix(node.y, peer.y) + dy,
                            node.nodetype,
                            node.smooth
                        );
                    });
                });
                (from.anchors ?? []).forEach((anchor: any, index: number) => {
                    const peer = to.anchors[index];
                    target.addAnchor(
                        mix(anchor.x, peer.x),
                        mix(anchor.y, peer.y) + dy,
                        anchor.name
                    );
                });
            };
            const moveFirstNode = (drawing: any, dx: number, dy: number) => {
                const node = drawing.paths?.[0]?.nodes?.[0];
                if (!node) {
                    throw new Error(
                        `${glyphName} drawing ${drawing.id} has no point`
                    );
                }
                node.x = node.x + dx;
                node.y = node.y + dy;
            };
            const outline = (label: string, mutate: () => void) =>
                transact(label, 'keyboard-outline', null, mutate);
            const fontInfo = (label: string, mutate: () => void) =>
                transact(label, 'font-info', null, mutate);

            switch (step.kind) {
                case 'node-insert':
                    outline('Insert point', () => {
                        for (const drawing of compatible()) {
                            const path = pathAt(drawing, step.shape);
                            const count = path.nodes.length;
                            const before =
                                path.nodes[(step.node - 1 + count) % count];
                            const after = path.nodes[step.node];
                            path.insertNode(
                                step.node,
                                Math.round((before.x + after.x) / 2),
                                Math.round((before.y + after.y) / 2),
                                'Line'
                            );
                        }
                    });
                    break;
                case 'node-remove':
                    outline('Delete point', () => {
                        for (const drawing of compatible()) {
                            pathAt(drawing, step.shape).removeNode(step.node);
                        }
                    });
                    break;
                case 'smooth':
                    // Smoothness is part of a point's type when drawings
                    // interpolate, so it changes in every drawing alike.
                    outline('Toggle smooth', () => {
                        const smooth = !pathAt(
                            atStation(step.master),
                            step.shape
                        ).nodes[step.node].smooth;
                        for (const drawing of compatible()) {
                            pathAt(drawing, step.shape).nodes[
                                step.node
                            ].smooth = smooth;
                        }
                    });
                    break;
                case 'contour-add':
                    outline('Add contour', () => {
                        for (const drawing of compatible()) {
                            appendRect(drawing.addPath(true), step.rect);
                        }
                    });
                    break;
                case 'contour-remove':
                    outline('Delete contour', () => {
                        for (const drawing of compatible()) {
                            pathAt(drawing, step.shape);
                            drawing.removeShape(step.shape);
                        }
                    });
                    break;
                case 'contour-reverse':
                    outline('Reverse contour direction', () => {
                        for (const drawing of compatible()) {
                            const path = pathAt(drawing, step.shape);
                            const nodes = path.nodes.map((node: any) => [
                                node.x,
                                node.y,
                                node.nodetype,
                                node.smooth
                            ]);
                            while (path.nodes.length) {
                                path.removeNode(0);
                            }
                            for (const [
                                x,
                                y,
                                type,
                                smooth
                            ] of nodes.reverse()) {
                                path.appendNode(x, y, type, smooth);
                            }
                        }
                    });
                    break;
                case 'contour-open':
                    outline(
                        step.closed ? 'Close contour' : 'Open contour',
                        () => {
                            for (const drawing of compatible()) {
                                pathAt(drawing, step.shape).closed =
                                    step.closed;
                            }
                        }
                    );
                    break;
                case 'transform': {
                    const drawing = atStation(step.master);
                    const points = drawing.paths.flatMap(
                        (path: any) => path.nodes
                    );
                    const xs = points.map((node: any) => node.x);
                    const ys = points.map((node: any) => node.y);
                    const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
                    const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
                    const angle = (10 * Math.PI) / 180;
                    const map = (x: number, y: number): [number, number] => {
                        if (step.op === 'scale') {
                            return [cx + (x - cx) * 1.1, cy + (y - cy) * 1.1];
                        }
                        if (step.op === 'rotate') {
                            return [
                                cx +
                                    (x - cx) * Math.cos(angle) -
                                    (y - cy) * Math.sin(angle),
                                cy +
                                    (x - cx) * Math.sin(angle) +
                                    (y - cy) * Math.cos(angle)
                            ];
                        }
                        return [2 * cx - x, y];
                    };
                    outline('Transform', () => {
                        for (const item of [
                            ...points,
                            ...(drawing.anchors ?? [])
                        ]) {
                            const [x, y] = map(item.x, item.y);
                            item.x = Math.round(x);
                            item.y = Math.round(y);
                        }
                    });
                    break;
                }
                case 'nudge': {
                    const editor = w.glyphCanvas.outlineEditor;
                    const before = JSON.stringify(
                        atStation(step.master).toJSON()
                    );
                    // Read the drawing the model holds now, not one captured
                    // before the key: the commit may rebuild the glyph, and a
                    // detached object that moved must not count as a move.
                    const current = () =>
                        JSON.stringify(
                            w.currentFontModel
                                ?.findGlyph?.(step.glyph)
                                ?.findDrawingById?.(step.master)
                                ?.toJSON?.() ?? null
                        );
                    editor.selectedPoints =
                        step.target === 'point'
                            ? [
                                  {
                                      contourIndex: step.shape,
                                      nodeIndex: step.index
                                  }
                              ]
                            : [];
                    editor.selectedAnchors =
                        step.target === 'anchor' ? [step.index] : [];
                    editor.selectedComponents =
                        step.target === 'component' ? [step.shape] : [];
                    const canvas = w.glyphCanvas.canvas;
                    const init = {
                        key: step.key,
                        code: step.key,
                        shiftKey: step.shift,
                        bubbles: true,
                        cancelable: true
                    };
                    canvas.dispatchEvent(new KeyboardEvent('keydown', init));
                    canvas.dispatchEvent(new KeyboardEvent('keyup', init));
                    const deadline = Date.now() + 5000;
                    while (current() === before && Date.now() < deadline) {
                        await new Promise((resolve) => setTimeout(resolve, 50));
                    }
                    await editor.flushPendingKeyboardPreviewCommit?.();
                    editor.selectedPoints = [];
                    editor.selectedAnchors = [];
                    editor.selectedComponents = [];
                    const after = current();
                    if (after === 'null') {
                        throw new Error(
                            `${step.glyph} has no drawing ${step.master} after the ${step.key} key`
                        );
                    }
                    if (after === before) {
                        throw new Error(`the ${step.key} key moved nothing`);
                    }
                    break;
                }
                case 'component-add':
                    transact(
                        'Add component',
                        'component-property',
                        null,
                        () => {
                            for (const drawing of compatible()) {
                                drawing.addComponent(step.reference, {
                                    translation: [step.x, step.y],
                                    scale: [1, 1],
                                    rotation: 0,
                                    skew: [0, 0]
                                });
                            }
                        }
                    );
                    break;
                case 'component-remove':
                    transact(
                        'Remove component',
                        'component-property',
                        null,
                        () => {
                            for (const drawing of compatible()) {
                                componentAt(drawing, step.shape);
                                drawing.removeShape(step.shape);
                            }
                        }
                    );
                    break;
                case 'component-swap':
                    transact(
                        'Change component',
                        'component-property',
                        null,
                        () => {
                            for (const drawing of compatible()) {
                                componentAt(drawing, step.shape).reference =
                                    step.reference;
                            }
                        }
                    );
                    break;
                case 'component-decompose':
                    transact(
                        'Decompose component',
                        'component-property',
                        null,
                        () => {
                            for (const drawing of compatible()) {
                                componentAt(drawing, step.shape).decompose();
                            }
                        }
                    );
                    break;
                case 'component-transform':
                    transact(
                        'Transform component',
                        'component-property',
                        null,
                        () => {
                            const drawing = atStation(step.master);
                            const component = componentAt(drawing, step.shape);
                            const transform = plain(component.transform) ?? {};
                            const [x, y] = transform.translation ?? [0, 0];
                            component.transform = {
                                ...transform,
                                translation: [x + step.dx, y + step.dy],
                                scale: [step.scale, step.scale]
                            };
                            // As the editor does: an automatically aligned
                            // composite keeps the scale and is placed again.
                            drawing.invalidateContentCaches?.();
                            drawing.invalidateLayoutCache?.();
                            drawing.rebuildAutomaticComposition?.();
                        }
                    );
                    break;
                case 'anchor-add':
                    outline('Add anchor', () => {
                        for (const drawing of compatible()) {
                            drawing.addAnchor(step.x, step.y, step.name);
                        }
                    });
                    break;
                case 'anchor-remove':
                    outline('Delete anchor', () => {
                        for (const drawing of compatible()) {
                            const index = (drawing.anchors ?? []).findIndex(
                                (anchor: any) => anchor.name === step.name
                            );
                            if (index >= 0) {
                                drawing.removeAnchor(index);
                            }
                        }
                    });
                    break;
                case 'anchor-rename':
                    outline('Rename anchor', () => {
                        for (const drawing of compatible()) {
                            const anchor = (drawing.anchors ?? []).find(
                                (item: any) => item.name === step.name
                            );
                            if (anchor) {
                                anchor.name = step.to;
                            }
                        }
                    });
                    break;
                case 'glyph-property':
                    fontInfo('Set glyph property', () => {
                        glyph[step.property] =
                            step.value === null ? undefined : step.value;
                    });
                    break;
                case 'metrics-key':
                    transact(
                        'Set metrics key',
                        'keyboard-sidebearing',
                        null,
                        () => {
                            glyph[`${step.side}MetricsKey`] =
                                step.value ?? undefined;
                            for (const drawing of glyph.drawings ?? []) {
                                drawing.recomputeOwnMetricsKeys?.();
                            }
                        }
                    );
                    break;
                case 'free-drawing':
                    if (step.op === 'add') {
                        outline('Add free drawing', () => {
                            const from = atStation(stationIds[0]);
                            const to = atStation(stationIds[1]);
                            const t = (step.wght - 100) / 800;
                            const drawing = glyph.addDrawing(
                                Math.round(
                                    from.width + (to.width - from.width) * t
                                ),
                                { type: 'FreeFloating' }
                            );
                            drawing.location = { wght: step.wght };
                            copyMixed(drawing, from, to, t);
                        });
                    } else if (step.op === 'remove') {
                        outline('Remove free drawing', () => {
                            glyph.removeDrawingById(step.drawing);
                        });
                    } else {
                        outline('Move point', () => {
                            moveFirstNode(
                                glyph.findDrawingById(step.drawing),
                                step.dx,
                                step.dy
                            );
                        });
                    }
                    break;
                case 'background': {
                    const foreground = atStation(step.master);
                    if (step.op === 'add') {
                        outline('Add background contour', () => {
                            const background =
                                glyph.addBackgroundDrawing(foreground);
                            appendRect(
                                background.addPath(true),
                                [30, -120, 260, 80]
                            );
                        });
                    } else if (step.op === 'edit') {
                        outline('Move background point', () => {
                            moveFirstNode(
                                foreground.backgroundDrawing,
                                step.dx,
                                step.dy
                            );
                        });
                    } else {
                        outline('Clear background', () => {
                            const background = foreground.backgroundDrawing;
                            while (background.shapes.length) {
                                background.removeShape(0);
                            }
                        });
                    }
                    break;
                }
                case 'variation':
                    if (step.op === 'add') {
                        // As the editor's Add variation does: it makes the
                        // variation's drawings, one per station. The range
                        // stays between the stations: at a station inside it
                        // the text shows the variation, and the edits that
                        // open the glyph there would find no base glyph.
                        outline('Add variation', () => {
                            glyph.addFeatureVariation([
                                { min: step.min, max: step.min + 150 }
                            ]);
                        });
                    } else if (step.op === 'remove') {
                        outline('Remove variation', () => {
                            glyph.removeFeatureVariation(
                                glyph.featureVariations[0]
                            );
                        });
                    } else {
                        outline('Move point', () => {
                            moveFirstNode(
                                glyph.featureVariations[0].findDrawingByStationId(
                                    step.master
                                ),
                                step.dx,
                                step.dy
                            );
                        });
                    }
                    break;
                case 'glyph-add':
                    font.addGlyph(step.name, 'Base');
                    break;
                case 'glyph-delete':
                    font.deleteGlyphs([step.name]);
                    break;
                case 'glyph-rename':
                    font.renameGlyphs(new Map([[step.name, step.to]]));
                    break;
                case 'kern-group-delete':
                    transact(
                        'Delete kern group',
                        'keyboard-kerning-groups',
                        'kerning-groups',
                        () => {
                            const property =
                                step.side === 'second'
                                    ? 'second_kern_groups'
                                    : 'first_kern_groups';
                            const groups = plain(font[property]) ?? {};
                            delete groups[step.group];
                            font[property] = groups;
                        }
                    );
                    break;
                case 'feature-list':
                case 'feature-prefix':
                case 'feature-class':
                    transact('Edit features', 'feature-code', 'feature', () => {
                        const features = plain(font.features);
                        if (step.kind === 'feature-list') {
                            const list: any[] = features.features ?? [];
                            if (step.op === 'add') {
                                list.push([extra[0], { code: extra[1] }]);
                            } else if (step.op === 'remove') {
                                features.features = list.filter(
                                    (entry) => entry[0] !== extra[0]
                                );
                            } else {
                                features.features = [
                                    list.at(-1),
                                    ...list.slice(0, -1)
                                ];
                            }
                        } else if (step.kind === 'feature-prefix') {
                            features.prefixes = {
                                ...features.prefixes,
                                languagesystems: {
                                    code: `${step.value % 2 ? dfltOnly : systems}\n# fuzz ${step.value}`
                                }
                            };
                        } else {
                            features.classes = {
                                ...features.classes,
                                fuzz: { code: step.members.join(' ') }
                            };
                        }
                        font.features = features;
                    });
                    break;
                case 'station-metric':
                    fontInfo('Edit station metrics', () => {
                        const station = font.stations.find(
                            (item: any) => item.id === step.master
                        );
                        station.metrics = {
                            ...plain(station.metrics),
                            [step.key]: step.value
                        };
                    });
                    break;
                case 'instance': {
                    // Font Info's own commit: the instances setter alone
                    // records nothing.
                    let list: any[] = plain(font.instances) ?? [];
                    if (step.op === 'add') {
                        list.push({
                            id: step.id,
                            name: { dflt: `Fuzz ${step.wght}` },
                            location: { wght: step.wght },
                            custom_names: {},
                            variable: false,
                            format_specific: {}
                        });
                    } else if (step.op === 'edit') {
                        list = list.map((instance) =>
                            instance.id === step.id
                                ? {
                                      ...instance,
                                      name: { dflt: `Fuzz ${step.wght}` },
                                      location: {
                                          ...instance.location,
                                          wght: step.wght
                                      }
                                  }
                                : instance
                        );
                    } else {
                        list = list.filter(
                            (instance) => instance.id !== step.id
                        );
                    }
                    w.fontInfoManager.commitInstancesListChange(
                        'Edit instances',
                        list
                    );
                    break;
                }
                case 'font-info':
                    fontInfo('Edit font info', () => {
                        if (step.field === 'designer') {
                            font.names = {
                                ...plain(font.names),
                                designer: { dflt: `Fuzz ${step.value}` }
                            };
                        } else if (step.field === 'version') {
                            font.version = [1, step.value % 1000];
                        } else {
                            font.custom_ot_values = {
                                ...plain(font.custom_ot_values),
                                os2_vendor_id: `FZ${String(step.value % 100).padStart(2, '0')}`
                            };
                        }
                    });
                    break;
            }
            if (wait) {
                await bridge.waitForPendingCloudCommits?.();
            }
        },
        {
            step: edit,
            awaitCloud,
            stationIds: FUZZ_STATIONS.map((station) => station.id),
            extra: FUZZ_EXTRA_FEATURE,
            systems: FUZZ_LANGUAGE_SYSTEMS,
            dfltOnly: FUZZ_LANGUAGE_SYSTEMS_DFLT_ONLY
        }
    );
}

/** Edits of font-wide data, made with `a` open in the editor. */
export function isFontWideFuzzEdit(edit: FuzzEdit): boolean {
    return (
        !('glyph' in edit) ||
        edit.kind === 'kern-group' ||
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

/**
 * A glyph-level metrics key the check can evaluate (`=name`, `=name+10`,
 * `=name-5`), as [source glyph, offset]; null for anything else.
 */
function parseMetricsKey(value: unknown): [string, number] | null {
    const match =
        /^=?\s*([A-Za-z0-9._-]+?)\s*(?:([+-])\s*(\d+(?:\.\d+)?))?$/.exec(
            String(value ?? '')
        );
    if (!match || !value) {
        return null;
    }
    const offset = match[3]
        ? Number(match[3]) * (match[2] === '-' ? -1 : 1)
        : 0;
    return [match[1], offset];
}

/** Keyed sidebearings that no longer match their source glyph. */
export function metricsKeyMismatches(snapshot: FuzzSnapshot): string[] {
    // Bounds from contours only; a drawing with components is skipped.
    const bounds = (glyph: string, station: string) => {
        const drawing = (snapshot.glyphs[glyph] as any)?.[station];
        const shapes = drawing?.shapes ?? [];
        if (shapes.some((shape: any) => shape.reference)) {
            return null;
        }
        const xs = shapes.flatMap((shape: any) =>
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
    for (const [glyph, props] of Object.entries(snapshot.props)) {
        for (const side of ['left', 'right'] as const) {
            const key = parseMetricsKey((props as any)?.[`${side}MetricsKey`]);
            if (!key) {
                continue;
            }
            const [source, offset] = key;
            for (const { id } of FUZZ_STATIONS) {
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
    // A recompile that fails is part of the answer, not a reason to stop.
    const recompileError = await page.evaluate(async () => {
        try {
            await (window as any).fontManager?.recompileEditingFont?.();
            return null;
        } catch (error) {
            return error instanceof Error ? error.message : String(error);
        }
    });
    await page.waitForTimeout(1500);
    const after = await readCompiledOutlines(page);
    const healed =
        !after.error &&
        JSON.stringify(after.editing) === JSON.stringify(after.fresh);
    // A compile that fails on a glyph names it: show that glyph's layers.
    const failing = [
        ...new Set(
            [
                ...String(after.error ?? '').matchAll(
                    /GlyphError\((?:\s|\\n)*([^,\s\\]+)/g
                )
            ].map((match) => match[1])
        )
    ];
    const layers = failing.length
        ? `\n${(await describeGlyphLayers(page, failing)).join('\n')}`
        : '';
    return `editing worker differs from fresh worker for: ${workerDiff.join(', ') || 'none'}; recompile ${healed ? 'fixes' : 'does not fix'} the font${recompileError ? ` (recompile failed: ${recompileError.slice(0, 300)})` : ''}${layers}`;
}

/**
 * Each stored layer of these glyphs, as the model holds them: id, station
 * link, background flag, and per shape the point types (l line, c curve,
 * o off-curve, q quadratic; s smooth) or the component.
 */
export async function describeGlyphLayers(
    page: Page,
    glyphNames: string[]
): Promise<string[]> {
    return page.evaluate((names) => {
        const w = window as any;
        return names.map((name: string) => {
            const glyph = w.currentFontModel?.findGlyph?.(name);
            const layers = (glyph?.toJSON?.() ?? glyph?.data)?.layers ?? [];
            return `${name}:\n${layers
                .map(
                    (layer: any) =>
                        `  ${layer.id} ${layer.master?.type ?? ''} ${layer.master?.master ?? ''}${layer.is_background ? ' background' : ''}${layer.background_layer_id ? ` (background ${layer.background_layer_id})` : ''}: ${(
                            layer.shapes ?? []
                        )
                            .map((shape: any) =>
                                shape.reference
                                    ? `[${shape.reference}]`
                                    : `${shape.closed === false ? 'open ' : ''}${(
                                          shape.nodes ?? []
                                      )
                                          .map(
                                              (node: any) =>
                                                  `${String(node.nodetype ?? '')
                                                      .charAt(0)
                                                      .toLowerCase()}${node.smooth ? 's' : ''}`
                                          )
                                          .join('')}`
                            )
                            .join(' | ')}`
                )
                .join('\n')}`;
        });
    }, glyphNames);
}
