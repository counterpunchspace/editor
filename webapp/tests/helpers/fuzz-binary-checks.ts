/**
 * Confirm the model through the compiled font: what a window compiled for
 * editing, read with HarfBuzz and a few table parsers, against what its
 * model says the font holds. The fuzz compares compiles with each other
 * elsewhere; this is what proves an edit reached the binary at all.
 *
 * The page only collects: the model's flattened outlines, anchors and
 * font data, and the binary's outlines, advances, shaping results and raw
 * tables. Parsing and comparing happen here, in plain functions.
 *
 * Compiled outlines are quadratic and rounded, so outlines compare as
 * contours (signed area and bounds, within a unit or two), never as nodes.
 */
import type { Page } from '@playwright/test';
import type { FuzzEdit, FuzzSnapshot } from './cloud-collab-fuzz';

export type Point = { x: number; y: number };
export type ModelNode = { x: number; y: number; nodetype?: string };
export type ModelPath = { nodes: ModelNode[]; closed?: boolean };
export type Location = Record<string, number>;

export type ModelDrawingFacts = {
    location: Location;
    width: number;
    /** Flattened outline, or null when components could not be resolved. */
    paths: ModelPath[] | null;
    anchors: Array<{ name: string; x: number; y: number }>;
};

export type ModelGlyphFacts = {
    name: string;
    productionName: string | null;
    category: string;
    /**
     * A mark of subcategory Nonspacing, stated or (without one) a combining
     * character, as Glyphs' data has it. It compiles without an advance.
     */
    nonspacing: boolean;
    codepoints: number[];
    hasComponents: boolean;
    /** By station id. */
    stations: Record<string, ModelDrawingFacts>;
    free: ModelDrawingFacts[];
    variations: Array<{
        rules: Array<{ axis: string; min?: number; max?: number }>;
        stations: Record<string, ModelDrawingFacts>;
    }>;
};

export type RawFacts = {
    error?: string;
    model: {
        axes: Array<{ tag: string; min: number; default: number; max: number }>;
        stations: Array<{
            id: string;
            location: Location;
            metrics: Record<string, number>;
            kerning: Record<string, number>;
            /** The pairs that are right-to-left, of `kerning`. */
            rtlPairs?: string[];
        }>;
        firstGroups: Record<string, string[]>;
        secondGroups: Record<string, string[]>;
        glyphs: ModelGlyphFacts[];
        features: Array<{ tag: string; code: string }>;
        languageSystems: string;
        /** Kerning and groups as the window's documents hold them. */
        documents: {
            kerning: Record<string, Record<string, number>>;
            firstGroups: Record<string, string[]>;
            secondGroups: Record<string, string[]>;
        } | null;
        designer: string | null;
        version: [number, number];
        vendor: string | null;
        instances: Array<{ name: string; location: Location }>;
    };
    binary: {
        glyphNames: string[];
        /** By location key, per glyph id: [svg path, advance]. */
        outlines: Record<string, Array<[string, number]>>;
        unicodes: number[];
        /** Codepoint to glyph id, shaped alone at the default location. */
        cmap: Record<string, number>;
        gsubFeatures: string[];
        gsubScripts: string[];
        /** `tag:codepoint` to glyph id, shaped with that feature on. */
        substitutions: Record<string, number>;
        /** Base glyph name to [location key, glyph id] samples. */
        variationSamples: Record<string, Array<[string, number]>>;
        /** `base+mark@locationKey` to [base gid, mark gid, dx, dy]. */
        marks: Record<string, [number, number, number, number]>;
        /** `left:right@locationKey` to [left gid, kern]. */
        kerning: Record<string, [number, number]>;
        names: Record<string, string>;
        tables: Record<string, string | null>;
    };
};

export function locationKey(location: Location): string {
    return Object.keys(location)
        .sort()
        .map((axis) => `${axis}=${location[axis]}`)
        .join(',');
}

/**
 * Everything the comparison needs, from one window. The binary is a full
 * compile of the window's current data, as the deferred catch-up compile
 * makes it: interactive and collaborators' edits first compile a minimal
 * font for the editing view (kerning only, outlines only…), and windows
 * that only receive an edit never run the catch-up pass.
 */
export async function collectBinaryFacts(page: Page): Promise<RawFacts> {
    return page.evaluate(async () => {
        const w = window as any;
        const hb = w.glyphCanvas?.textRunEditor?.hb;
        const font = w.currentFontModel;
        let bytes: Uint8Array | null = null;
        let compileError: string | null = null;
        try {
            await w.fullFontCompilation.seedWorkerDocumentSet(
                w.fontManager.buildWorkerSeedDocumentSet()
            );
            w.fullFontCompilation.setCompileFeatureOverlay('');
            const compiled = await w.fullFontCompilation.compileCached(
                'user',
                'fuzz-binary-check.ttf'
            );
            bytes = new Uint8Array(compiled.result);
        } catch (error) {
            compileError =
                error instanceof Error ? error.message : String(error);
        }
        const empty = {
            model: {
                axes: [],
                stations: [],
                firstGroups: {},
                secondGroups: {},
                glyphs: [],
                features: [],
                languageSystems: '',
                documents: null,
                designer: null,
                version: [0, 0] as [number, number],
                vendor: null,
                instances: []
            },
            binary: {
                glyphNames: [],
                outlines: {},
                unicodes: [],
                cmap: {},
                gsubFeatures: [],
                gsubScripts: [],
                substitutions: {},
                variationSamples: {},
                marks: {},
                kerning: {},
                names: {},
                tables: {}
            }
        };
        if (!hb || !bytes || !font) {
            return {
                ...empty,
                error: compileError ?? 'no compiled font or model'
            };
        }
        const plain = (value: unknown) =>
            value === undefined ? undefined : JSON.parse(JSON.stringify(value));
        const key = (location: Record<string, number>) =>
            Object.keys(location)
                .sort()
                .map((axis) => `${axis}=${location[axis]}`)
                .join(',');

        // ── Model ────────────────────────────────────────────────────
        const axes = (font.axes ?? []).map((axis: any) => ({
            tag: String(axis.tag),
            min: Number(axis.min),
            default: Number(axis.default),
            max: Number(axis.max)
        }));
        const full = (location: Record<string, number> | undefined) => {
            const result: Record<string, number> = {};
            for (const axis of axes) {
                result[axis.tag] = Number(location?.[axis.tag] ?? axis.default);
            }
            return result;
        };
        const stations = (font.stations ?? []).map((station: any) => ({
            id: String(station.id),
            location: full(plain(station.location)),
            metrics: plain(station.metrics) ?? {},
            // babelfont merges RTL pairs into the same set, RTL winning.
            kerning: {
                ...(plain(station.kerning) ?? {}),
                ...(plain(station.kerning_rtl) ?? {})
            },
            rtlPairs: Object.keys(plain(station.kerning_rtl) ?? {})
        }));
        const drawingFacts = (drawing: any, location: any) => {
            let paths: any[] | null = null;
            try {
                paths = plain(drawing.getAllPaths?.() ?? []);
            } catch {
                paths = null;
            }
            return {
                location: full(plain(location)),
                width: Number(drawing.width ?? 0),
                paths,
                anchors: (drawing.anchors ?? []).map((anchor: any) => ({
                    name: String(anchor.name),
                    x: Number(anchor.x),
                    y: Number(anchor.y)
                }))
            };
        };
        const stationById = new Map(
            stations.map((station: any) => [station.id, station])
        );
        const categoryName = (category: unknown) =>
            typeof category === 'string'
                ? category
                : category && typeof category === 'object'
                  ? `Custom:${(category as any).Custom ?? ''}`
                  : 'Unknown';
        const glyphs = (font.glyphs ?? [])
            .filter((glyph: any) => glyph.exported !== false)
            .map((glyph: any) => {
                const stationDrawings: Record<string, any> = {};
                const free: any[] = [];
                let hasComponents = false;
                for (const drawing of glyph.drawings ?? []) {
                    if (drawing.is_background) {
                        continue;
                    }
                    if (drawing.isVariationDrawing?.()) {
                        continue;
                    }
                    const station = drawing.station;
                    if ((drawing.components ?? []).length) {
                        hasComponents = true;
                    }
                    if (station?.type === 'DefaultForMaster') {
                        const at = stationById.get(station.master) as any;
                        if (at) {
                            stationDrawings[station.master] = drawingFacts(
                                drawing,
                                at.location
                            );
                        }
                    }
                }
                // Free drawings from the stored layers: glyph.drawings lists
                // only those tied to a station, not free-floating ones.
                const layers: any[] =
                    plain(glyph.toJSON?.() ?? glyph.data)?.layers ?? [];
                for (const layer of layers) {
                    const type = layer?.master?.type;
                    const located =
                        layer?.location && Object.keys(layer.location).length;
                    if (
                        layer?.is_background ||
                        layer?.format_specific?.[
                            'com.schriftgestalt.Glyphs.attr'
                        ]?.axisRules ||
                        !(
                            type === 'FreeFloating' ||
                            (type === 'AssociatedWithMaster' && located)
                        )
                    ) {
                        continue;
                    }
                    const shapes: any[] = layer.shapes ?? [];
                    if (shapes.some((shape) => shape?.reference)) {
                        hasComponents = true;
                    }
                    free.push({
                        location: full(layer.location),
                        width: Number(layer.width ?? 0),
                        paths: shapes.some((shape) => shape?.reference)
                            ? null
                            : shapes.map((shape) => ({
                                  nodes: shape.nodes ?? [],
                                  closed: shape.closed
                              })),
                        anchors: (layer.anchors ?? []).map((anchor: any) => ({
                            name: String(anchor.name),
                            x: Number(anchor.x),
                            y: Number(anchor.y)
                        }))
                    });
                }
                const variations = (glyph.featureVariations ?? []).map(
                    (variation: any) => {
                        const byStation: Record<string, any> = {};
                        for (const station of stations) {
                            const drawing = variation.findDrawingByStationId(
                                station.id
                            );
                            if (drawing) {
                                byStation[station.id] = drawingFacts(
                                    drawing,
                                    station.location
                                );
                            }
                        }
                        return {
                            rules: (variation.axisRules ?? []).map(
                                (rule: any, index: number) => ({
                                    axis: axes[index]?.tag ?? '',
                                    ...(rule?.min !== undefined
                                        ? { min: Number(rule.min) }
                                        : {}),
                                    ...(rule?.max !== undefined
                                        ? { max: Number(rule.max) }
                                        : {})
                                })
                            ),
                            stations: byStation
                        };
                    }
                );
                return {
                    name: String(glyph.name),
                    productionName: glyph.production_name ?? null,
                    category: categoryName(plain(glyph.category)),
                    nonspacing:
                        categoryName(plain(glyph.category)) === 'Mark' &&
                        (typeof glyph.format_specific?.subcategory === 'string'
                            ? glyph.format_specific.subcategory === 'Nonspacing'
                            : [...(glyph.codepoints ?? [])].some(
                                  (codepoint: unknown) =>
                                      /\p{Mn}/u.test(
                                          String.fromCodePoint(
                                              Number(codepoint)
                                          )
                                      )
                              )),
                    codepoints: [...(glyph.codepoints ?? [])].map(Number),
                    hasComponents,
                    stations: stationDrawings,
                    free,
                    variations
                };
            });
        const features = (font.features?.features ?? []).map((entry: any) => ({
            tag: String(entry?.[0] ?? ''),
            code: String(entry?.[1]?.code ?? '')
        }));
        const model = {
            axes,
            stations,
            firstGroups: plain(font.first_kern_groups) ?? {},
            secondGroups: plain(font.second_kern_groups) ?? {},
            glyphs,
            features,
            languageSystems: String(
                font.features?.prefixes?.languagesystems?.code ?? ''
            ),
            documents: (() => {
                const json = w.patchSyncEngine?.getFontJsonSnapshot?.();
                if (!json) return null;
                const kerning: Record<string, Record<string, number>> = {};
                for (const master of json.masters ?? []) {
                    kerning[String(master.id)] = {
                        ...(master.kerning ?? {}),
                        ...(master.kerning_rtl ?? {})
                    };
                }
                return {
                    kerning,
                    firstGroups: json.first_kern_groups ?? {},
                    secondGroups: json.second_kern_groups ?? {}
                };
            })(),
            designer: font.names?.designer?.dflt ?? null,
            version: (plain(font.version) ?? [0, 0]) as [number, number],
            vendor: font.custom_ot_values?.os2_vendor_id ?? null,
            instances: (font.instances ?? []).map((instance: any) => ({
                name: String(instance.name?.dflt ?? ''),
                location: full(plain(instance.location))
            }))
        };

        // ── Binary ───────────────────────────────────────────────────
        const blob = hb.createBlob(new Uint8Array(bytes));
        const face = hb.createFace(blob, 0);
        const fonts: any[] = [];
        const fontAt = (location: Record<string, number>) => {
            const instance = hb.createFont(face);
            instance.setVariations(location);
            fonts.push(instance);
            return instance;
        };
        const table = (tag: string): string | null => {
            const data: Uint8Array | undefined = face.reference_table(tag);
            if (!data?.length) {
                return null;
            }
            let text = '';
            for (const byte of data) {
                text += String.fromCharCode(byte);
            }
            return btoa(text);
        };
        try {
            const reference = fontAt(full({}));
            const maxp = face.reference_table('maxp');
            const numGlyphs = maxp?.length >= 6 ? (maxp[4] << 8) | maxp[5] : 0;
            const glyphNames: string[] = [];
            for (let gid = 0; gid < numGlyphs; gid += 1) {
                glyphNames.push(String(reference.glyphName(gid) ?? ''));
            }
            const shapeAt = (
                location: Record<string, number>,
                text: string,
                features?: string
            ) => {
                const instance = fontAt(location);
                const buffer = hb.createBuffer();
                buffer.addText(text);
                buffer.guessSegmentProperties();
                hb.shape(instance, buffer, features);
                const result = buffer.json().map((glyph: any) => ({
                    gid: Number(glyph.g),
                    cluster: Number(glyph.cl),
                    ax: Number(glyph.ax),
                    dx: Number(glyph.dx),
                    dy: Number(glyph.dy),
                    advance: Number(instance.glyphHAdvance(glyph.g))
                }));
                buffer.destroy();
                return result;
            };

            // Where outlines are read: every station, every free drawing.
            const locations = new Map<string, Record<string, number>>();
            for (const station of stations) {
                locations.set(key(station.location), station.location);
            }
            for (const glyph of glyphs) {
                for (const drawing of glyph.free) {
                    locations.set(key(drawing.location), drawing.location);
                }
            }
            const outlines: Record<string, Array<[string, number]>> = {};
            for (const [locationKey, location] of locations) {
                const instance = fontAt(location);
                const row: Array<[string, number]> = [];
                for (let gid = 0; gid < numGlyphs; gid += 1) {
                    row.push([
                        String(instance.glyphToPath(gid) ?? ''),
                        Number(instance.glyphHAdvance(gid))
                    ]);
                }
                outlines[locationKey] = row;
            }

            const unicodes = [...face.collectUnicodes()].map(Number);
            const defaults = full({});
            const cmap: Record<string, number> = {};
            const allCodepoints = new Set<number>(unicodes);
            for (const glyph of glyphs) {
                for (const codepoint of glyph.codepoints) {
                    allCodepoints.add(codepoint);
                }
            }
            for (const codepoint of allCodepoints) {
                const shaped = shapeAt(
                    defaults,
                    String.fromCodePoint(codepoint)
                );
                cmap[String(codepoint)] = shaped.length ? shaped[0].gid : -1;
            }

            const unique = (values: string[]) => [...new Set(values)].sort();
            const gsubFeatures = unique(
                face.getTableFeatureTags?.('GSUB') ?? []
            );
            const gsubScripts = unique(face.getTableScriptTags?.('GSUB') ?? []);
            const codepointOf = new Map<string, number>();
            for (const glyph of glyphs) {
                if (glyph.codepoints.length) {
                    codepointOf.set(glyph.name, glyph.codepoints[0]);
                }
            }
            const substitutions: Record<string, number> = {};
            for (const feature of features) {
                for (const match of feature.code.matchAll(
                    /^\s*sub\s+(\S+)\s+by\s+(\S+)\s*;/gm
                )) {
                    const codepoint = codepointOf.get(match[1]);
                    if (codepoint === undefined) {
                        continue;
                    }
                    const shaped = shapeAt(
                        defaults,
                        String.fromCodePoint(codepoint),
                        feature.tag
                    );
                    substitutions[`${feature.tag}:${codepoint}`] = shaped.length
                        ? shaped[0].gid
                        : -1;
                }
            }

            // Variations swap a glyph inside an axis range: sample each axis
            // between its ends, off the range edges.
            const variationSamples: Record<
                string,
                Array<[string, number]>
            > = {};
            for (const glyph of glyphs) {
                const codepoint = glyph.codepoints[0];
                if (codepoint === undefined) {
                    continue;
                }
                const edges = new Set<number>();
                for (const variation of glyph.variations) {
                    for (const rule of variation.rules) {
                        if (rule.min !== undefined) edges.add(rule.min);
                        if (rule.max !== undefined) edges.add(rule.max);
                    }
                }
                const samples: Array<[string, number]> = [];
                for (const axis of axes) {
                    const span = axis.max - axis.min;
                    for (let step = 1; step < 16; step += 1) {
                        const value = axis.min + (span * step) / 16;
                        if (edges.has(value)) {
                            continue;
                        }
                        const location = { ...defaults, [axis.tag]: value };
                        const shaped = shapeAt(
                            location,
                            String.fromCodePoint(codepoint)
                        );
                        samples.push([
                            key(location),
                            shaped.length ? shaped[0].gid : -1
                        ]);
                    }
                }
                variationSamples[glyph.name] = samples;
            }

            // Arabic text shapes right to left; it is not mixed with Latin
            // in a pair, and Latin marks are not put on it.
            const isArabic = (codepoint: number) =>
                codepoint >= 0x0600 && codepoint <= 0x06ff;

            // Marks: base + mark pairs that stay two glyphs (no precomposed
            // character in the font), on bases with outlines of their own.
            const marksByName = glyphs.filter(
                (glyph: any) =>
                    glyph.category === 'Mark' && glyph.codepoints.length
            );
            const bases = glyphs.filter(
                (glyph: any) =>
                    glyph.category !== 'Mark' &&
                    glyph.codepoints.length &&
                    !glyph.hasComponents &&
                    !isArabic(glyph.codepoints[0])
            );
            const marks: Record<string, [number, number, number, number]> = {};
            for (const base of bases) {
                for (const mark of marksByName) {
                    const text =
                        String.fromCodePoint(base.codepoints[0]) +
                        String.fromCodePoint(mark.codepoints[0]);
                    const composed = text.normalize('NFC');
                    if (
                        [...composed].length === 1 &&
                        unicodes.includes(composed.codePointAt(0)!)
                    ) {
                        continue;
                    }
                    for (const station of stations) {
                        const shaped = shapeAt(station.location, text);
                        if (shaped.length !== 2) {
                            continue;
                        }
                        marks[
                            `${base.name}+${mark.name}@${key(station.location)}`
                        ] = [
                            shaped[0].gid,
                            shaped[1].gid,
                            shaped[1].dx,
                            shaped[1].dy
                        ];
                    }
                }
            }

            // Kerning: every pair of glyphs that have a codepoint, in
            // logical order (an Arabic pair's first glyph is on the right),
            // as the shaped advances minus the glyphs' own.
            const kernGlyphs = glyphs.filter(
                (glyph: any) =>
                    glyph.category !== 'Mark' && glyph.codepoints.length
            );
            const kerning: Record<string, [number, number]> = {};
            for (const station of stations) {
                for (const left of kernGlyphs) {
                    for (const right of kernGlyphs) {
                        if (
                            isArabic(left.codepoints[0]) !==
                            isArabic(right.codepoints[0])
                        ) {
                            continue;
                        }
                        const shaped = shapeAt(
                            station.location,
                            String.fromCodePoint(left.codepoints[0]) +
                                String.fromCodePoint(right.codepoints[0])
                        );
                        if (shaped.length !== 2) {
                            continue;
                        }
                        const first = shaped.find(
                            (glyph: { cluster: number }) => glyph.cluster === 0
                        );
                        const kern = shaped.reduce(
                            (
                                sum: number,
                                glyph: { ax: number; advance: number }
                            ) => sum + glyph.ax - glyph.advance,
                            0
                        );
                        kerning[
                            `${left.name}:${right.name}@${key(station.location)}`
                        ] = [first ? first.gid : -1, kern];
                    }
                }
            }

            const names: Record<string, string> = {};
            for (const entry of face.listNames?.() ?? []) {
                const text = face.getName(entry.nameId, entry.language);
                if (text && names[String(entry.nameId)] === undefined) {
                    names[String(entry.nameId)] = String(text);
                }
            }
            const tables: Record<string, string | null> = {};
            for (const tag of ['OS/2', 'MVAR', 'fvar', 'head', 'GDEF']) {
                tables[tag] = table(tag);
            }
            return {
                model,
                binary: {
                    glyphNames,
                    outlines,
                    unicodes,
                    cmap,
                    gsubFeatures,
                    gsubScripts,
                    substitutions,
                    variationSamples,
                    marks,
                    kerning,
                    names,
                    tables
                }
            };
        } catch (error) {
            return {
                ...empty,
                model,
                error: error instanceof Error ? error.message : String(error)
            };
        } finally {
            for (const instance of fonts) {
                instance.destroy();
            }
            face.destroy();
            blob.destroy();
        }
    }) as Promise<RawFacts>;
}

// ── Outline geometry ─────────────────────────────────────────────────

export type ContourSummary = {
    area: number;
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
};

type Segment =
    | { kind: 'line'; p0: Point; p1: Point }
    | { kind: 'quad'; p0: Point; c: Point; p1: Point }
    | { kind: 'cubic'; p0: Point; c0: Point; c1: Point; p1: Point };

function segmentArea(segment: Segment): number {
    // Twice the signed area contribution (shoelace, exact for curves).
    const { p0, p1 } = segment;
    if (segment.kind === 'line') {
        return p0.x * p1.y - p1.x * p0.y;
    }
    if (segment.kind === 'quad') {
        const { c } = segment;
        return (
            (2 / 3) * (p0.x * c.y - c.x * p0.y) +
            (2 / 3) * (c.x * p1.y - p1.x * c.y) +
            (1 / 3) * (p0.x * p1.y - p1.x * p0.y)
        );
    }
    const { c0, c1 } = segment;
    const cross = (a: Point, b: Point) => a.x * b.y - b.x * a.y;
    return (
        (6 * cross(p0, c0) +
            3 * cross(p0, c1) +
            1 * cross(p0, p1) +
            3 * cross(c0, c1) +
            3 * cross(c0, p1) +
            6 * cross(c1, p1)) /
        10
    );
}

function extend(box: ContourSummary, point: Point) {
    box.minX = Math.min(box.minX, point.x);
    box.minY = Math.min(box.minY, point.y);
    box.maxX = Math.max(box.maxX, point.x);
    box.maxY = Math.max(box.maxY, point.y);
}

function segmentBounds(segment: Segment, box: ContourSummary) {
    extend(box, segment.p0);
    extend(box, segment.p1);
    const at = (t: number): Point => {
        const u = 1 - t;
        if (segment.kind === 'quad') {
            return {
                x:
                    u * u * segment.p0.x +
                    2 * u * t * segment.c.x +
                    t * t * segment.p1.x,
                y:
                    u * u * segment.p0.y +
                    2 * u * t * segment.c.y +
                    t * t * segment.p1.y
            };
        }
        if (segment.kind === 'cubic') {
            const { p0, c0, c1, p1 } = segment;
            return {
                x:
                    u * u * u * p0.x +
                    3 * u * u * t * c0.x +
                    3 * u * t * t * c1.x +
                    t * t * t * p1.x,
                y:
                    u * u * u * p0.y +
                    3 * u * u * t * c0.y +
                    3 * u * t * t * c1.y +
                    t * t * t * p1.y
            };
        }
        return segment.p0;
    };
    const roots = (a: number, b: number, c: number): number[] => {
        // Roots of a t² + b t + c in (0, 1).
        if (Math.abs(a) < 1e-12) {
            return Math.abs(b) < 1e-12 ? [] : [-c / b];
        }
        const disc = b * b - 4 * a * c;
        if (disc < 0) return [];
        const sq = Math.sqrt(disc);
        return [(-b + sq) / (2 * a), (-b - sq) / (2 * a)];
    };
    let ts: number[] = [];
    if (segment.kind === 'quad') {
        const { p0, c, p1 } = segment;
        for (const axis of ['x', 'y'] as const) {
            const denominator = p0[axis] - 2 * c[axis] + p1[axis];
            if (Math.abs(denominator) > 1e-12) {
                ts.push((p0[axis] - c[axis]) / denominator);
            }
        }
    } else if (segment.kind === 'cubic') {
        const { p0, c0, c1, p1 } = segment;
        for (const axis of ['x', 'y'] as const) {
            const a = -p0[axis] + 3 * c0[axis] - 3 * c1[axis] + p1[axis];
            const b = 2 * (p0[axis] - 2 * c0[axis] + c1[axis]);
            const c = c0[axis] - p0[axis];
            ts = ts.concat(roots(a, b, c));
        }
    }
    for (const t of ts) {
        if (t > 0 && t < 1) {
            extend(box, at(t));
        }
    }
}

function summarize(segments: Segment[]): ContourSummary | null {
    if (!segments.length) {
        return null;
    }
    const box: ContourSummary = {
        area: 0,
        minX: Infinity,
        minY: Infinity,
        maxX: -Infinity,
        maxY: -Infinity
    };
    let twice = 0;
    for (const segment of segments) {
        twice += segmentArea(segment);
        segmentBounds(segment, box);
    }
    box.area = twice / 2;
    return box;
}

/**
 * Contours of a model path list (babelfont nodes: Move, Line, OffCurve,
 * Curve, QCurve). Open paths count as closed, as the compiler closes them.
 */
export function modelContours(paths: ModelPath[]): ContourSummary[] {
    const result: ContourSummary[] = [];
    for (const path of paths) {
        const nodes = (path.nodes ?? []).map((node) => ({
            x: Number(node.x),
            y: Number(node.y),
            type: String(node.nodetype ?? 'Line').toLowerCase()
        }));
        if (!nodes.length) continue;
        const start = nodes.findIndex((node) => node.type !== 'offcurve');
        if (start < 0) continue;
        const ordered = [...nodes.slice(start), ...nodes.slice(0, start)];
        const segments: Segment[] = [];
        let current: Point = ordered[0];
        let offs: Point[] = [];
        const visit = [...ordered.slice(1), ordered[0]];
        for (const node of visit) {
            if (node.type === 'offcurve') {
                offs.push(node);
                continue;
            }
            if (node.type === 'curve' && offs.length === 2) {
                segments.push({
                    kind: 'cubic',
                    p0: current,
                    c0: offs[0],
                    c1: offs[1],
                    p1: node
                });
            } else if (offs.length) {
                // Quadratic spline: implied on-curve points between offs.
                let p0 = current;
                for (let index = 0; index < offs.length; index += 1) {
                    const c = offs[index];
                    const p1 =
                        index === offs.length - 1
                            ? node
                            : {
                                  x: (c.x + offs[index + 1].x) / 2,
                                  y: (c.y + offs[index + 1].y) / 2
                              };
                    segments.push({ kind: 'quad', p0, c, p1 });
                    p0 = p1;
                }
            } else if (node.x !== current.x || node.y !== current.y) {
                segments.push({ kind: 'line', p0: current, p1: node });
            }
            current = node;
            offs = [];
        }
        const summary = summarize(segments);
        if (summary) result.push(summary);
    }
    return result;
}

/** Contours of an SVG path from HarfBuzz (M, L, Q, C, Z). */
export function svgContours(path: string): ContourSummary[] {
    const result: ContourSummary[] = [];
    const tokens = path.match(/[MLQCZ]|-?\d*\.?\d+(?:e-?\d+)?/gi) ?? [];
    let index = 0;
    const number = () => Number(tokens[index++]);
    let segments: Segment[] = [];
    let start: Point | null = null;
    let current: Point = { x: 0, y: 0 };
    const close = () => {
        if (start && (current.x !== start.x || current.y !== start.y)) {
            segments.push({ kind: 'line', p0: current, p1: start });
        }
        const summary = summarize(segments);
        if (summary) result.push(summary);
        segments = [];
        start = null;
    };
    while (index < tokens.length) {
        const command = tokens[index++].toUpperCase();
        if (command === 'M') {
            if (segments.length) close();
            current = { x: number(), y: number() };
            start = current;
        } else if (command === 'L') {
            const p1 = { x: number(), y: number() };
            segments.push({ kind: 'line', p0: current, p1 });
            current = p1;
        } else if (command === 'Q') {
            const c = { x: number(), y: number() };
            const p1 = { x: number(), y: number() };
            segments.push({ kind: 'quad', p0: current, c, p1 });
            current = p1;
        } else if (command === 'C') {
            const c0 = { x: number(), y: number() };
            const c1 = { x: number(), y: number() };
            const p1 = { x: number(), y: number() };
            segments.push({ kind: 'cubic', p0: current, c0, c1, p1 });
            current = p1;
        } else if (command === 'Z') {
            close();
        }
    }
    if (segments.length) close();
    return result;
}

const BOUNDS_TOLERANCE = 2;

function contourTolerance(contour: ContourSummary): number {
    // Rounding to whole units moves each edge by up to half a unit, and the
    // quadratic approximation by up to one: about the perimeter times that.
    const perimeter =
        2 * (contour.maxX - contour.minX + (contour.maxY - contour.minY));
    return perimeter * 1.5 + Math.abs(contour.area) * 0.01 + 4;
}

/**
 * Match model contours to binary contours. The compiler reverses contour
 * direction for TrueType, so a binary area is the negated model area.
 * Returns what does not match, empty when all do.
 */
export function compareContours(
    expected: ContourSummary[],
    actual: ContourSummary[]
): string[] {
    const problems: string[] = [];
    // Degenerate contours (no area, a point or a line) draw nothing.
    const drawn = (contour: ContourSummary) =>
        Math.abs(contour.area) > 0.5 ||
        contour.maxX - contour.minX > 0.5 ||
        contour.maxY - contour.minY > 0.5;
    const wanted = expected.filter(drawn);
    const left = actual.filter(drawn);
    if (wanted.length !== left.length) {
        problems.push(`${left.length} contours, model has ${wanted.length}`);
    }
    const unmatched = [...left];
    for (const contour of wanted) {
        const target = -contour.area;
        const index = unmatched.findIndex(
            (candidate) =>
                Math.abs(candidate.minX - contour.minX) <= BOUNDS_TOLERANCE &&
                Math.abs(candidate.minY - contour.minY) <= BOUNDS_TOLERANCE &&
                Math.abs(candidate.maxX - contour.maxX) <= BOUNDS_TOLERANCE &&
                Math.abs(candidate.maxY - contour.maxY) <= BOUNDS_TOLERANCE &&
                Math.abs(candidate.area - target) <= contourTolerance(contour)
        );
        if (index < 0) {
            problems.push(
                `no contour like model [${Math.round(contour.minX)} ${Math.round(contour.minY)} ${Math.round(contour.maxX)} ${Math.round(contour.maxY)}] area ${Math.round(contour.area)}`
            );
        } else {
            unmatched.splice(index, 1);
        }
    }
    for (const contour of unmatched) {
        problems.push(
            `extra contour [${contour.minX} ${contour.minY} ${contour.maxX} ${contour.maxY}] area ${Math.round(contour.area)}`
        );
    }
    return problems;
}

/** A compact, comparable form of contours, for the per-edit change check. */
export function contourSignature(contours: ContourSummary[]): string {
    return contours
        .map(
            (contour) =>
                `${Math.round(contour.minX)},${Math.round(contour.minY)},${Math.round(contour.maxX)},${Math.round(contour.maxY)},${Math.round(contour.area)}`
        )
        .sort()
        .join(';');
}

// ── Table parsers ────────────────────────────────────────────────────

function bytesOf(base64: string | null | undefined): DataView | null {
    if (!base64) return null;
    const binary = Buffer.from(base64, 'base64');
    return new DataView(binary.buffer, binary.byteOffset, binary.byteLength);
}

/** GDEF glyph classes by glyph id (1 base, 2 ligature, 3 mark, 4 component). */
export function parseGdefClasses(base64: string | null): Map<number, number> {
    const classes = new Map<number, number>();
    const view = bytesOf(base64);
    if (!view || view.byteLength < 6) return classes;
    const offset = view.getUint16(4);
    if (!offset) return classes;
    const format = view.getUint16(offset);
    if (format === 1) {
        const startGlyph = view.getUint16(offset + 2);
        const count = view.getUint16(offset + 4);
        for (let index = 0; index < count; index += 1) {
            classes.set(
                startGlyph + index,
                view.getUint16(offset + 6 + index * 2)
            );
        }
    } else if (format === 2) {
        const count = view.getUint16(offset + 2);
        for (let index = 0; index < count; index += 1) {
            const record = offset + 4 + index * 6;
            const start = view.getUint16(record);
            const end = view.getUint16(record + 2);
            const value = view.getUint16(record + 4);
            for (let gid = start; gid <= end; gid += 1) classes.set(gid, value);
        }
    }
    return classes;
}

export type FvarFacts = {
    axes: Array<{ tag: string; min: number; default: number; max: number }>;
    instances: Array<{ nameId: number; coordinates: Location }>;
};

export function parseFvar(base64: string | null): FvarFacts {
    const view = bytesOf(base64);
    const result: FvarFacts = { axes: [], instances: [] };
    if (!view || view.byteLength < 16) return result;
    const axesOffset = view.getUint16(4);
    const axisCount = view.getUint16(8);
    const axisSize = view.getUint16(10);
    const instanceCount = view.getUint16(12);
    const instanceSize = view.getUint16(14);
    const fixed = (at: number) => view.getInt32(at) / 65536;
    for (let index = 0; index < axisCount; index += 1) {
        const at = axesOffset + index * axisSize;
        result.axes.push({
            tag: String.fromCharCode(
                view.getUint8(at),
                view.getUint8(at + 1),
                view.getUint8(at + 2),
                view.getUint8(at + 3)
            ),
            min: fixed(at + 4),
            default: fixed(at + 8),
            max: fixed(at + 12)
        });
    }
    const instancesOffset = axesOffset + axisCount * axisSize;
    for (let index = 0; index < instanceCount; index += 1) {
        const at = instancesOffset + index * instanceSize;
        const coordinates: Location = {};
        result.axes.forEach((axis, axisIndex) => {
            coordinates[axis.tag] = fixed(at + 4 + axisIndex * 4);
        });
        result.instances.push({ nameId: view.getUint16(at), coordinates });
    }
    return result;
}

export function normalize(
    location: Location,
    axes: Array<{ tag: string; min: number; default: number; max: number }>
): number[] {
    return axes.map((axis) => {
        const value = location[axis.tag] ?? axis.default;
        if (value === axis.default) return 0;
        if (value < axis.default) {
            return axis.default === axis.min
                ? 0
                : Math.max(
                      -1,
                      (value - axis.default) / (axis.default - axis.min)
                  );
        }
        return axis.max === axis.default
            ? 0
            : Math.min(1, (value - axis.default) / (axis.max - axis.default));
    });
}

/**
 * MVAR deltas at a normalized location, by value tag: what the variable
 * font adds to its default metrics there.
 */
export function mvarDeltas(
    base64: string | null,
    coords: number[]
): Record<string, number> {
    const view = bytesOf(base64);
    const deltas: Record<string, number> = {};
    if (!view || view.byteLength < 12) return deltas;
    const recordSize = view.getUint16(6);
    const recordCount = view.getUint16(8);
    const storeOffset = view.getUint16(10);
    if (!storeOffset) return deltas;
    const regionListOffset = storeOffset + view.getUint32(storeOffset + 2);
    const dataCount = view.getUint16(storeOffset + 6);
    const axisCount = view.getUint16(regionListOffset);
    const regionCount = view.getUint16(regionListOffset + 2);
    const f2dot14 = (at: number) => view.getInt16(at) / 16384;
    const scalars: number[] = [];
    for (let region = 0; region < regionCount; region += 1) {
        let scalar = 1;
        for (let axis = 0; axis < axisCount; axis += 1) {
            const at = regionListOffset + 4 + (region * axisCount + axis) * 6;
            const start = f2dot14(at);
            const peak = f2dot14(at + 2);
            const end = f2dot14(at + 4);
            const coord = coords[axis] ?? 0;
            if (peak === 0 || coord === peak) continue;
            if (
                coord <= Math.min(start, peak) ||
                coord >= Math.max(end, peak) ||
                (start < 0 && end > 0)
            ) {
                scalar = 0;
                break;
            }
            scalar *=
                coord < peak
                    ? (coord - start) / (peak - start)
                    : (end - coord) / (end - peak);
        }
        scalars.push(scalar);
    }
    const dataOffsets: number[] = [];
    for (let index = 0; index < dataCount; index += 1) {
        dataOffsets.push(
            storeOffset + view.getUint32(storeOffset + 8 + index * 4)
        );
    }
    const deltaFor = (outer: number, inner: number): number => {
        const at = dataOffsets[outer];
        if (at === undefined) return 0;
        const itemCount = view.getUint16(at);
        const wordDeltaCount = view.getUint16(at + 2);
        const regionIndexCount = view.getUint16(at + 4);
        if (inner >= itemCount) return 0;
        const regions: number[] = [];
        for (let index = 0; index < regionIndexCount; index += 1) {
            regions.push(view.getUint16(at + 6 + index * 2));
        }
        const longWords = (wordDeltaCount & 0x8000) !== 0;
        const wordCount = wordDeltaCount & 0x7fff;
        const wordSize = longWords ? 4 : 2;
        const smallSize = longWords ? 2 : 1;
        const rowSize =
            wordCount * wordSize + (regionIndexCount - wordCount) * smallSize;
        let cursor = at + 6 + regionIndexCount * 2 + inner * rowSize;
        let total = 0;
        for (let index = 0; index < regionIndexCount; index += 1) {
            let delta: number;
            if (index < wordCount) {
                delta = longWords
                    ? view.getInt32(cursor)
                    : view.getInt16(cursor);
                cursor += wordSize;
            } else {
                delta = longWords
                    ? view.getInt16(cursor)
                    : view.getInt8(cursor);
                cursor += smallSize;
            }
            total += delta * (scalars[regions[index]] ?? 0);
        }
        return total;
    };
    for (let index = 0; index < recordCount; index += 1) {
        const at = 12 + index * recordSize;
        const tag = String.fromCharCode(
            view.getUint8(at),
            view.getUint8(at + 1),
            view.getUint8(at + 2),
            view.getUint8(at + 3)
        );
        deltas[tag] = deltaFor(view.getUint16(at + 4), view.getUint16(at + 6));
    }
    return deltas;
}

export type Os2Facts = {
    typoAscender: number;
    xHeight: number;
    capHeight: number;
    vendor: string;
};

export function parseOs2(base64: string | null): Os2Facts | null {
    const view = bytesOf(base64);
    if (!view || view.byteLength < 90) return null;
    return {
        typoAscender: view.getInt16(68),
        xHeight: view.getInt16(86),
        capHeight: view.getInt16(88),
        vendor: String.fromCharCode(
            view.getUint8(58),
            view.getUint8(59),
            view.getUint8(60),
            view.getUint8(61)
        )
    };
}

export function parseHeadRevision(base64: string | null): number | null {
    const view = bytesOf(base64);
    return view && view.byteLength >= 8 ? view.getInt32(4) / 65536 : null;
}

// ── The comparison ───────────────────────────────────────────────────

/** Binary names the compiler gives glyphs without a production name. */
export function defaultBinaryNames(raw: RawFacts): Record<string, string> {
    // The binary keeps the model's glyph order after .notdef.
    const names: Record<string, string> = {};
    const exported = raw.model.glyphs.map((glyph) => glyph.name);
    const order =
        exported[0] === '.notdef' ? exported : ['.notdef', ...exported];
    order.forEach((name, gid) => {
        const glyph = raw.model.glyphs.find((entry) => entry.name === name);
        if (glyph?.productionName) return;
        const binaryName = raw.binary.glyphNames[gid];
        if (binaryName) names[name] = binaryName;
    });
    return names;
}

/**
 * Category facts: what the compiled font says, per area, so a step can
 * check that its edit changed the part it should (see confirmEditChanged).
 */
export type BinaryDigest = {
    glyphSet: string;
    glyphs: Record<string, string>;
    marks: string;
    kerning: string;
    cmap: string;
    gdef: string;
    gsub: string;
    metrics: string;
    names: string;
    instances: string;
    variations: Record<string, string>;
};

export function compareBinaryWithModel(
    raw: RawFacts,
    defaults: Record<string, string>
): { problems: string[]; digest: BinaryDigest } {
    const problems: string[] = [];
    const { model, binary } = raw;
    const digest: BinaryDigest = {
        glyphSet: binary.glyphNames.join(' '),
        glyphs: {},
        marks: '',
        kerning: '',
        cmap: '',
        gdef: '',
        gsub: '',
        metrics: '',
        names: '',
        instances: '',
        variations: {}
    };
    if (raw.error) {
        return {
            problems: [`could not read the compiled font: ${raw.error}`],
            digest
        };
    }
    const gidOf = new Map<string, number>();
    binary.glyphNames.forEach((name, gid) => {
        if (!gidOf.has(name)) gidOf.set(name, gid);
    });
    const binaryName = (glyph: ModelGlyphFacts) =>
        glyph.productionName ?? defaults[glyph.name] ?? glyph.name;
    const glyphByName = new Map(
        model.glyphs.map((glyph) => [glyph.name, glyph])
    );
    const gidOfGlyph = (name: string) => {
        const glyph = glyphByName.get(name);
        return glyph ? gidOf.get(binaryName(glyph)) : undefined;
    };

    // The glyph set: every exported glyph, under its binary name, plus one
    // glyph per variation (the compiler adds it, swapped in by rvrn).
    const variationGlyphs = model.glyphs.reduce(
        (count, glyph) => count + glyph.variations.length,
        0
    );
    const expectedCount =
        model.glyphs.length +
        (model.glyphs[0]?.name === '.notdef' ? 0 : 1) +
        variationGlyphs;
    if (binary.glyphNames.length !== expectedCount) {
        problems.push(
            `glyph count ${binary.glyphNames.length}, model exports ${expectedCount}`
        );
    }
    for (const glyph of model.glyphs) {
        if (gidOfGlyph(glyph.name) === undefined) {
            problems.push(
                `${glyph.name}: not in the compiled font as “${binaryName(glyph)}”`
            );
        }
    }

    // Rounded to whole units at the default; elsewhere each variation
    // region's delta is rounded on its own, so where several apply the
    // advance can be a unit off.
    const isDefault = (location: Location) =>
        model.axes.every(
            (axis) => (location[axis.tag] ?? axis.default) === axis.default
        );
    const advanceTolerance = (location: Location) =>
        isDefault(location) ? 0.5 : 1;

    // Outlines and advances at every station and free drawing.
    for (const glyph of model.glyphs) {
        const gid = gidOfGlyph(glyph.name);
        if (gid === undefined) continue;
        const parts: string[] = [];
        const check = (label: string, drawing: ModelDrawingFacts) => {
            const row = binary.outlines[locationKey(drawing.location)];
            if (!row) return;
            const [path, advance] = row[gid] ?? ['', 0];
            const actual = svgContours(path);
            parts.push(`${label}:${advance}:${contourSignature(actual)}`);
            const width = glyph.nonspacing ? 0 : drawing.width;
            if (
                Math.abs(advance - width) > advanceTolerance(drawing.location)
            ) {
                problems.push(
                    `${glyph.name} ${label}: advance ${advance}, model width ${width}`
                );
            }
            if (drawing.paths) {
                for (const problem of compareContours(
                    modelContours(drawing.paths),
                    actual
                )) {
                    problems.push(`${glyph.name} ${label}: ${problem}`);
                }
            }
        };
        for (const [stationId, drawing] of Object.entries(glyph.stations)) {
            check(stationId, drawing);
        }
        for (const drawing of glyph.free) {
            check(`free ${locationKey(drawing.location)}`, drawing);
        }
        digest.glyphs[glyph.name] = parts.sort().join('|');
    }

    // Variations: inside a range the glyph shapes to its variation glyph,
    // whose outlines at the stations are the variation's drawings.
    for (const glyph of model.glyphs) {
        const samples = binary.variationSamples[glyph.name];
        const baseGid = gidOfGlyph(glyph.name);
        if (!samples || baseGid === undefined) continue;
        const parts: string[] = [];
        for (const [sampleKey, gid] of samples) {
            const location = Object.fromEntries(
                sampleKey.split(',').map((pair) => {
                    const [axis, value] = pair.split('=');
                    return [axis, Number(value)];
                })
            ) as Location;
            const active = glyph.variations.find((variation) =>
                variation.rules.every(
                    (rule) =>
                        (rule.min === undefined ||
                            (location[rule.axis] ?? 0) >= rule.min) &&
                        (rule.max === undefined ||
                            (location[rule.axis] ?? 0) <= rule.max)
                )
            );
            parts.push(`${sampleKey}:${binary.glyphNames[gid] ?? gid}`);
            if (!active) {
                if (gid !== baseGid) {
                    problems.push(
                        `${glyph.name} at ${sampleKey}: shapes to ${binary.glyphNames[gid] ?? gid}, no variation there`
                    );
                }
                continue;
            }
            if (gid === baseGid) {
                problems.push(
                    `${glyph.name} at ${sampleKey}: not swapped for its variation`
                );
                continue;
            }
            for (const [stationId, drawing] of Object.entries(
                active.stations
            )) {
                const row = binary.outlines[locationKey(drawing.location)];
                if (!row) continue;
                const [path, advance] = row[gid] ?? ['', 0];
                const width = glyph.nonspacing ? 0 : drawing.width;
                if (
                    Math.abs(advance - width) >
                    advanceTolerance(drawing.location)
                ) {
                    problems.push(
                        `${glyph.name} variation ${stationId}: advance ${advance}, model width ${width}`
                    );
                }
                if (drawing.paths) {
                    for (const problem of compareContours(
                        modelContours(drawing.paths),
                        svgContours(path)
                    )) {
                        problems.push(
                            `${glyph.name} variation ${stationId}: ${problem}`
                        );
                    }
                }
                parts.push(
                    `${stationId}:${advance}:${contourSignature(svgContours(path))}`
                );
            }
        }
        digest.variations[glyph.name] = parts.join('|');
    }

    // cmap: each codepoint shapes to its glyph; no codepoint left over.
    const cmapParts: string[] = [];
    const modelCodepoints = new Set<number>();
    for (const glyph of model.glyphs) {
        const gid = gidOfGlyph(glyph.name);
        for (const codepoint of glyph.codepoints) {
            modelCodepoints.add(codepoint);
            const actual = binary.cmap[String(codepoint)];
            cmapParts.push(
                `${codepoint}:${binary.glyphNames[actual] ?? actual}`
            );
            if (gid !== undefined && actual !== gid) {
                problems.push(
                    `U+${codepoint.toString(16).toUpperCase().padStart(4, '0')}: shapes to ${binary.glyphNames[actual] ?? actual}, model maps it to ${glyph.name}`
                );
            }
        }
    }
    for (const codepoint of binary.unicodes) {
        if (!modelCodepoints.has(codepoint)) {
            problems.push(
                `U+${codepoint.toString(16).toUpperCase().padStart(4, '0')}: in the compiled cmap, on no exported glyph`
            );
        }
    }
    digest.cmap = cmapParts.sort().join(' ');

    // GDEF: Mark 3, Ligature 2, everything else a base.
    const gdef = parseGdefClasses(binary.tables.GDEF ?? null);
    const gdefParts: string[] = [];
    for (const glyph of model.glyphs) {
        const gid = gidOfGlyph(glyph.name);
        if (gid === undefined || glyph.name === '.notdef') continue;
        const expected =
            glyph.category === 'Mark'
                ? 3
                : glyph.category === 'Ligature'
                  ? 2
                  : 1;
        const actual = gdef.get(gid) ?? 0;
        gdefParts.push(`${glyph.name}:${actual}`);
        if (actual !== expected) {
            problems.push(
                `${glyph.name}: GDEF class ${actual}, category ${glyph.category} wants ${expected}`
            );
        }
    }
    digest.gdef = gdefParts.join(' ');

    // Marks: attached at base anchor minus mark anchor, relative to the pen
    // after the base, when exactly one anchor pair matches; else unmoved.
    // The compiler registers marks under the declared language systems
    // only, while kerning of Latin glyphs adds a `latn` record of its own:
    // without a declared `latn`, that leaves Latin text without mark
    // positioning (fontmake does the same). Kerning of other writing
    // scripts only adds their records.
    const latnDeclared = /^\s*languagesystem\s+latn\s+\w+\s*;/m.test(
        model.languageSystems
    );
    const latinGlyphs = new Set(
        model.glyphs
            .filter((glyph) =>
                glyph.codepoints.some((codepoint) =>
                    /\p{Script=Latin}/u.test(String.fromCodePoint(codepoint))
                )
            )
            .map((glyph) => glyph.name)
    );
    const sideGlyphs = (side: string): string[] =>
        side.startsWith('@')
            ? [
                  ...(model.firstGroups[side.slice(1)] ?? []),
                  ...(model.secondGroups[side.slice(1)] ?? [])
              ]
            : [side];
    // fontc drops a group–group pair that is 0 at every station.
    const droppedGroupPairs = new Set(
        [
            ...new Set(
                model.stations.flatMap((station) =>
                    Object.keys(station.kerning)
                )
            )
        ].filter(
            (pair) =>
                pair.split(':').every((side) => side.startsWith('@')) &&
                model.stations.every((station) => !station.kerning[pair])
        )
    );
    const hasLatinKerning = model.stations.some((station) =>
        Object.keys(station.kerning).some(
            (pair) =>
                !droppedGroupPairs.has(pair) &&
                pair
                    .split(':')
                    .some((side) =>
                        sideGlyphs(side).some((name) => latinGlyphs.has(name))
                    )
        )
    );
    const marksReachable = latnDeclared || !hasLatinKerning;
    const markParts: string[] = [];
    for (const [pairKey, [baseGid, markGid, dx, dy]] of Object.entries(
        binary.marks
    )) {
        markParts.push(`${pairKey}:${dx},${dy}`);
        const [names, atKey] = pairKey.split('@');
        const [baseName, markName] = names.split('+');
        const base = glyphByName.get(baseName);
        const mark = glyphByName.get(markName);
        if (!base || !mark) continue;
        // Inside one of its variation's ranges the base glyph shapes to its
        // variation glyph (the variation check above verifies that glyph).
        const pairLocation = Object.fromEntries(
            (atKey ?? '')
                .split(',')
                .filter(Boolean)
                .map((pair) => {
                    const [axis, value] = pair.split('=');
                    return [axis, Number(value)];
                })
        ) as Location;
        const baseSwapped =
            baseGid !== gidOfGlyph(baseName) &&
            base.variations.some((variation) =>
                variation.rules.every(
                    (rule) =>
                        (rule.min === undefined ||
                            (pairLocation[rule.axis] ?? 0) >= rule.min) &&
                        (rule.max === undefined ||
                            (pairLocation[rule.axis] ?? 0) <= rule.max)
                )
            );
        if (baseSwapped && markGid === gidOfGlyph(markName)) {
            continue;
        }
        if (
            baseGid !== gidOfGlyph(baseName) ||
            markGid !== gidOfGlyph(markName)
        ) {
            problems.push(
                `${pairKey}: shapes to ${binary.glyphNames[baseGid]} + ${binary.glyphNames[markGid]}`
            );
            continue;
        }
        if (base.category === 'Ligature') continue;
        const station = model.stations.find(
            (entry) => locationKey(entry.location) === atKey
        );
        const baseDrawing = station && base.stations[station.id];
        const markDrawing = station && mark.stations[station.id];
        if (!baseDrawing || !markDrawing) continue;
        const pairs = markDrawing.anchors
            .filter((anchor) => anchor.name.startsWith('_'))
            .map((anchor) => ({
                mark: anchor,
                base: baseDrawing.anchors.find(
                    (candidate) => candidate.name === anchor.name.slice(1)
                )
            }))
            .filter((pair) => pair.base);
        if (pairs.length > 1) continue;
        const row = binary.outlines[atKey];
        const baseAdvance = row ? row[baseGid][1] : baseDrawing.width;
        const expected =
            pairs.length && marksReachable
                ? [
                      Math.round(
                          pairs[0].base!.x - pairs[0].mark.x - baseAdvance
                      ),
                      Math.round(pairs[0].base!.y - pairs[0].mark.y)
                  ]
                : [0, 0];
        if (Math.abs(dx - expected[0]) > 1 || Math.abs(dy - expected[1]) > 1) {
            problems.push(
                `${pairKey}: mark at (${dx}, ${dy}), anchors put it at (${expected[0]}, ${expected[1]})`
            );
        }
    }
    digest.marks = markParts.sort().join(' ');

    // Kerning: glyph pair, then glyph–group, group–glyph, group–group. A
    // station without any pair is sparse: the compiler takes its values from
    // the other stations, so it is not checked.
    // Each station resolves its own pairs: a pair it lacks falls back to its
    // group pairs, as in fontmake and fontc.
    const documentKerning = (
        stationId: string,
        candidates: string[],
        left: string,
        right: string
    ) => {
        const documents = model.documents;
        if (!documents) return '';
        const groupsIn = (all: Record<string, string[]>, name: string) =>
            Object.entries(all)
                .filter(([, members]) => (members ?? []).includes(name))
                .map(([group]) => `@${group}`)
                .join('+') || 'none';
        const pairs = documents.kerning[stationId] ?? {};
        return `; documents: groups ${groupsIn(documents.firstGroups, left)} / ${groupsIn(documents.secondGroups, right)}, pairs ${
            candidates
                .filter((candidate) => pairs[candidate] !== undefined)
                .map((candidate) => `${candidate}=${pairs[candidate]}`)
                .join(' ') || 'none'
        }`;
    };
    const groupOf = (groups: Record<string, string[]>, name: string) =>
        Object.entries(groups).find(([, members]) =>
            members.includes(name)
        )?.[0];
    // Glyphs in right-to-left kerning kern first with their left group and
    // second with their right group (glyphsLib, fontc, babelfont).
    const rtlGlyphs = new Set<string>();
    for (const station of model.stations) {
        for (const pair of station.rtlPairs ?? []) {
            const separator = pair.indexOf(':', pair.startsWith('@') ? 1 : 0);
            const sides: Array<[string, Record<string, string[]>]> = [
                [pair.slice(0, separator), model.secondGroups],
                [pair.slice(separator + 1), model.firstGroups]
            ];
            for (const [key, groups] of sides) {
                if (key.startsWith('@')) {
                    for (const member of groups[key.slice(1)] ?? [])
                        rtlGlyphs.add(member);
                } else {
                    rtlGlyphs.add(key);
                }
            }
        }
    }
    const firstGroupOf = (name: string) =>
        groupOf(
            rtlGlyphs.has(name) ? model.secondGroups : model.firstGroups,
            name
        );
    const secondGroupOf = (name: string) =>
        groupOf(
            rtlGlyphs.has(name) ? model.firstGroups : model.secondGroups,
            name
        );
    const kernParts: string[] = [];
    for (const [pairKey, [leftGid, kern]] of Object.entries(binary.kerning)) {
        kernParts.push(`${pairKey}:${kern}`);
        const [names, atKey] = pairKey.split('@');
        const [left, right] = names.split(':');
        const station = model.stations.find(
            (entry) => locationKey(entry.location) === atKey
        );
        if (!station || !Object.keys(station.kerning).length) continue;
        if (leftGid !== gidOfGlyph(left)) continue;
        const leftGroup = firstGroupOf(left);
        const rightGroup = secondGroupOf(right);
        const candidates = [
            `${left}:${right}`,
            rightGroup ? `${left}:@${rightGroup}` : null,
            leftGroup ? `@${leftGroup}:${right}` : null,
            leftGroup && rightGroup ? `@${leftGroup}:@${rightGroup}` : null
        ].filter((entry): entry is string => !!entry);
        const found = candidates.find(
            (candidate) => station.kerning[candidate] !== undefined
        );
        const expected = found ? station.kerning[found] : 0;
        if (Math.abs(kern - expected) > 0.5) {
            const groups = (all: Record<string, string[]>, name: string) =>
                Object.entries(all)
                    .filter(([, members]) => members.includes(name))
                    .map(([group]) => `@${group}`)
                    .join('+') || 'none';
            problems.push(
                `kern ${left} ${right} at ${station.id}: ${kern}, model ${expected}${found ? ` (${found})` : ''}; groups ${groups(model.firstGroups, left)} / ${groups(model.secondGroups, right)}; pairs ${candidates
                    .filter(
                        (candidate) => station.kerning[candidate] !== undefined
                    )
                    .map(
                        (candidate) =>
                            `${candidate}=${station.kerning[candidate]}`
                    )
                    .join(
                        ' '
                    )}${documentKerning(station.id, candidates, left, right)}`
            );
        }
    }
    digest.kerning = kernParts.sort().join(' ');

    // GSUB: the model's features and scripts, and its simple substitutions.
    const expectedFeatures = [
        ...new Set([
            ...model.features
                .filter((feature) => /\bsub\b/.test(feature.code))
                .map((feature) => feature.tag),
            ...(variationGlyphs ? ['rvrn'] : [])
        ])
    ].sort();
    if (
        JSON.stringify(binary.gsubFeatures) !== JSON.stringify(expectedFeatures)
    ) {
        problems.push(
            `GSUB features ${binary.gsubFeatures.join(' ') || 'none'}, model ${expectedFeatures.join(' ') || 'none'}`
        );
    }
    const scripts = new Set<string>(['DFLT']);
    for (const match of model.languageSystems.matchAll(
        /^\s*languagesystem\s+(\w+)\s+\w+\s*;/gm
    )) {
        scripts.add(match[1]);
    }
    const expectedScripts = [...scripts].sort();
    if (
        expectedFeatures.length &&
        JSON.stringify(binary.gsubScripts) !== JSON.stringify(expectedScripts)
    ) {
        problems.push(
            `GSUB scripts ${binary.gsubScripts.join(' ')}, model ${expectedScripts.join(' ')}`
        );
    }
    const subParts: string[] = [];
    for (const feature of model.features) {
        for (const match of feature.code.matchAll(
            /^\s*sub\s+(\S+)\s+by\s+(\S+)\s*;/gm
        )) {
            const from = glyphByName.get(match[1]);
            const codepoint = from?.codepoints[0];
            if (codepoint === undefined) continue;
            const actual = binary.substitutions[`${feature.tag}:${codepoint}`];
            subParts.push(
                `${feature.tag}:${match[1]}:${binary.glyphNames[actual] ?? actual}`
            );
            const expected = gidOfGlyph(match[2]);
            if (expected !== undefined && actual !== expected) {
                problems.push(
                    `${feature.tag}: ${match[1]} shapes to ${binary.glyphNames[actual] ?? actual}, feature code says ${match[2]}`
                );
            }
        }
    }
    digest.gsub = `${binary.gsubFeatures.join(' ')}|${binary.gsubScripts.join(' ')}|${subParts.sort().join(' ')}`;

    // Station metrics: the default station in OS/2, the others as MVAR
    // deltas. The x-height overshoot has no place in a TrueType font.
    const os2 = parseOs2(binary.tables['OS/2'] ?? null);
    const fvar = parseFvar(binary.tables.fvar ?? null);
    const metricParts: string[] = [];
    if (os2) {
        const metricKeys: Array<[string, keyof Os2Facts, string]> = [
            ['XHeight', 'xHeight', 'xhgt'],
            ['CapHeight', 'capHeight', 'cpht'],
            ['Ascender', 'typoAscender', 'hasc']
        ];
        for (const station of model.stations) {
            const coords = normalize(
                station.location,
                fvar.axes.length ? fvar.axes : model.axes
            );
            const deltas = mvarDeltas(binary.tables.MVAR ?? null, coords);
            for (const [metric, field, tag] of metricKeys) {
                const expected = station.metrics[metric];
                if (typeof expected !== 'number') continue;
                const actual = Math.round(
                    (os2[field] as number) + (deltas[tag] ?? 0)
                );
                metricParts.push(`${station.id}:${metric}:${actual}`);
                if (Math.abs(actual - expected) > 0.5) {
                    problems.push(
                        `${metric} at ${station.id}: ${actual} in the compiled font, model ${expected}`
                    );
                }
            }
        }
    }
    digest.metrics = metricParts.join(' ');

    // Font info: designer (name 9), version (name 5 and head), vendor (OS/2).
    const designer = binary.names['9'] ?? null;
    if ((model.designer ?? null) !== designer) {
        problems.push(
            `designer “${designer ?? ''}” in the name table, model “${model.designer ?? ''}”`
        );
    }
    const version = `${model.version[0]}.${String(model.version[1]).padStart(3, '0')}`;
    if (!String(binary.names['5'] ?? '').startsWith(`Version ${version}`)) {
        problems.push(
            `version name “${binary.names['5'] ?? ''}”, model ${version}`
        );
    }
    const revision = parseHeadRevision(binary.tables.head ?? null);
    if (revision === null || Math.abs(revision - Number(version)) > 0.001) {
        problems.push(`head revision ${revision}, model ${version}`);
    }
    if (model.vendor && os2 && os2.vendor !== model.vendor) {
        problems.push(
            `vendor “${os2.vendor}” in OS/2, model “${model.vendor}”`
        );
    }
    digest.names = `${designer}|${binary.names['5']}|${os2?.vendor}|${revision}`;

    // Instances: fvar named instances, by name and coordinates.
    const actualInstances = fvar.instances
        .map(
            (instance) =>
                `${binary.names[String(instance.nameId)] ?? instance.nameId}@${locationKey(instance.coordinates)}`
        )
        .sort();
    const expectedInstances = model.instances
        .map((instance) => `${instance.name}@${locationKey(instance.location)}`)
        .sort();
    if (JSON.stringify(actualInstances) !== JSON.stringify(expectedInstances)) {
        problems.push(
            `named instances ${actualInstances.join(', ') || 'none'}, model ${expectedInstances.join(', ') || 'none'}`
        );
    }
    digest.instances = actualInstances.join(' ');

    return { problems, digest };
}

/**
 * After one edit, the part of the compiled font it must change, changed:
 * the check that an edit reached the binary at all, beside the comparison
 * with the model. Kinds that keep the geometry (inserting a point on a
 * line, smooth flags, opening a contour the compiler closes, decomposing,
 * feature comments and unused classes, undo) are left to that comparison.
 * A background drawing must change nothing. Null when the edit is
 * confirmed or not checked here.
 */
export function confirmEditChanged(
    edit: FuzzEdit,
    before: BinaryDigest,
    after: BinaryDigest,
    snapshotBefore: FuzzSnapshot,
    snapshotAfter: FuzzSnapshot
): string | null {
    const changed = (left: unknown, right: unknown) =>
        JSON.stringify(left) !== JSON.stringify(right);
    const glyphChanged = (glyph: string) => {
        if (
            before.glyphs[glyph] === undefined ||
            after.glyphs[glyph] === undefined
        ) {
            // Not exported before or after: the glyph set says it.
            return changed(before.glyphSet, after.glyphSet);
        }
        return changed(before.glyphs[glyph], after.glyphs[glyph]);
    };
    const glyph = 'glyph' in edit ? edit.glyph : null;
    const need = (ok: boolean, what: string) =>
        ok
            ? null
            : `the compiled font did not change: ${what}${glyph ? ` (${glyph}: ${after.glyphs[glyph] ?? 'not exported'})` : ''}`;
    const inSet = (glyph: string) =>
        before.glyphs[glyph] !== undefined || after.glyphs[glyph] !== undefined;
    switch (edit.kind) {
        case 'outline':
        case 'width':
        case 'contour-add':
        case 'contour-remove':
        case 'contour-reverse':
        case 'transform':
        case 'component-add':
        case 'component-remove':
        case 'component-swap':
        case 'component-transform':
            return inSet(edit.glyph)
                ? need(
                      glyphChanged(edit.glyph),
                      `${edit.glyph}’s outline or advance`
                  )
                : null;
        case 'nudge':
            if (edit.target === 'anchor') return null;
            return inSet(edit.glyph)
                ? need(glyphChanged(edit.glyph), `${edit.glyph}’s outline`)
                : null;
        case 'free-drawing': {
            if (!inSet(edit.glyph)) return null;
            // A free drawing is added as the interpolation at its location,
            // so adding or removing one draws nothing new; the compiled font
            // must be read there, though, and match it.
            const part = `free wght=${edit.wght}:`;
            const has = (digest: BinaryDigest) =>
                (digest.glyphs[edit.glyph] ?? '').includes(part);
            if (edit.op === 'add') {
                return has(after)
                    ? null
                    : `the free drawing at wght ${edit.wght} was not read from the compiled font: ${after.glyphs[edit.glyph]}`;
            }
            if (edit.op === 'remove') {
                return has(after)
                    ? `the removed free drawing at wght ${edit.wght} is still read: ${after.glyphs[edit.glyph]}`
                    : null;
            }
            return need(
                glyphChanged(edit.glyph),
                `${edit.glyph} at its free drawing’s location`
            );
        }
        case 'variation':
            return inSet(edit.glyph)
                ? need(
                      changed(
                          before.variations[edit.glyph],
                          after.variations[edit.glyph]
                      ),
                      `${edit.glyph}’s variation`
                  )
                : null;
        case 'background': {
            const { glyphSet: _a, ...left } = before;
            const { glyphSet: _b, ...right } = after;
            return changed(left, right)
                ? 'a background drawing changed the compiled font'
                : null;
        }
        case 'unicode':
            return need(changed(before.cmap, after.cmap), 'the cmap');
        case 'glyph-add':
        case 'glyph-delete':
        case 'glyph-rename':
            return need(
                changed(before.glyphSet, after.glyphSet),
                'the glyph set'
            );
        case 'glyph-property':
            if (!inSet(edit.glyph)) return null;
            if (edit.property === 'category') {
                // Component compiles as a base, like Base.
                const was = (snapshotBefore.props[edit.glyph] as any)?.category;
                const base = (value: unknown) =>
                    value === 'Mark' ? 3 : value === 'Ligature' ? 2 : 1;
                return base(was) === base(edit.value)
                    ? null
                    : need(
                          changed(before.gdef, after.gdef),
                          `${edit.glyph}’s GDEF class`
                      );
            }
            return need(
                changed(before.glyphSet, after.glyphSet),
                `${edit.glyph}’s ${edit.property === 'exported' ? 'presence' : 'binary name'}`
            );
        case 'feature-list':
            return edit.op === 'move'
                ? null
                : need(changed(before.gsub, after.gsub), 'the GSUB features');
        case 'kern':
        case 'kern-delete': {
            const was = snapshotBefore.kerning[edit.master]?.[edit.pair];
            const now = snapshotAfter.kerning[edit.master]?.[edit.pair];
            const rtlWas = snapshotBefore.kerningRtl[edit.master]?.[edit.pair];
            const rtlNow = snapshotAfter.kerningRtl[edit.master]?.[edit.pair];
            // An RTL pair overrides an LTR one; a pair a more specific pair
            // shadows, or a station left without any pair, shows nothing.
            const effective = (ltr: unknown, rtl: unknown) => rtl ?? ltr ?? 0;
            if (!changed(effective(was, rtlWas), effective(now, rtlNow)))
                return null;
            if (!Object.keys(snapshotAfter.kerning[edit.master] ?? {}).length)
                return null;
            if (!Object.keys(snapshotBefore.kerning[edit.master] ?? {}).length)
                return null;
            if (edit.pair.includes('@')) {
                // A group pair can be shadowed by a more specific pair: the
                // comparison with the model resolves which pair wins.
                return null;
            }
            return need(
                changed(before.kerning, after.kerning),
                `kerning ${edit.pair}`
            );
        }
        case 'station-metric': {
            if (edit.key === 'XHeight overshoot') return null;
            const metric = (snapshot: FuzzSnapshot) =>
                ((snapshot.font as any).stations ?? []).find(
                    (station: any) => station.id === edit.master
                )?.metrics?.[edit.key];
            return changed(metric(snapshotBefore), metric(snapshotAfter))
                ? need(
                      changed(before.metrics, after.metrics),
                      `${edit.key} at ${edit.master}`
                  )
                : null;
        }
        case 'instance':
            return changed(
                (snapshotBefore.font as any).instances,
                (snapshotAfter.font as any).instances
            )
                ? need(
                      changed(before.instances, after.instances),
                      'the named instances'
                  )
                : null;
        case 'font-info':
            return changed(
                (snapshotBefore.font as any).info,
                (snapshotAfter.font as any).info
            )
                ? need(changed(before.names, after.names), `the ${edit.field}`)
                : null;
        default:
            return null;
    }
}
