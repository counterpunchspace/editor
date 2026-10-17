/**
 * CompileFilter host. Plugins are Python entry points. The JSON compile hooks
 * see Babelfont JSON. setup, takedown, and onGuideChange see the live font.
 */

import {
    DecomposedAffineTransform,
    writePluginSettingValue
} from './babelfont-model';

const COMPILE_FILTERS_KEY = 'com.counterpunch.compile-filters';

export interface CompileFilterInfo {
    id: string;
    name: string;
    description: string;
    hasLayer: boolean;
    hasPropagated: boolean;
    hasFont: boolean;
    hasSetup: boolean;
    hasTakedown: boolean;
    hasGuide: boolean;
}

export interface GuideChange {
    kind: 'position' | 'rename' | 'remove' | 'scope';
    scope: 'master' | 'layer';
    masterId?: string;
    name?: string;
    pos?: { x?: number; y?: number; angle?: number };
    previous?: { x?: number; y?: number; name?: string };
}

interface LayerJob {
    glyphName: string;
    layer: Record<string, unknown>;
    inherited?: Record<string, { x: number; y: number }>;
}

const discovered: CompileFilterInfo[] = [];
const layerCache = new Map<string, string>();
let cachedFeatureKey = '';
let cachedFeatures = '';

function pyodide(): { runPythonAsync(code: string): Promise<unknown> } | null {
    return (
        (
            window as unknown as {
                pyodide?: { runPythonAsync(code: string): Promise<unknown> };
            }
        ).pyodide ?? null
    );
}

function pythonString(value: string): string {
    return JSON.stringify(value);
}

export function linkedCompileFilterIds(
    font:
        | {
              format_specific?: Record<string, unknown>;
          }
        | null
        | undefined
): string[] {
    const stored = font?.format_specific?.[COMPILE_FILTERS_KEY];
    if (!Array.isArray(stored)) {
        return [];
    }
    return stored.filter(
        (id): id is string => typeof id === 'string' && id.length > 0
    );
}

export function setLinkedCompileFilterIds(
    font: { format_specific?: Record<string, unknown> },
    ids: string[]
): void {
    if (!font.format_specific || typeof font.format_specific !== 'object') {
        font.format_specific = {};
    }
    font.format_specific[COMPILE_FILTERS_KEY] = ids;
}

export function discoveredCompileFilters(): CompileFilterInfo[] {
    return discovered.slice();
}

export async function discoverCompileFilters(): Promise<CompileFilterInfo[]> {
    const python = pyodide();
    if (!python) {
        return discovered;
    }
    const raw = await python.runPythonAsync('_cp_compile_filters_discover()');
    const parsed = JSON.parse(String(raw)) as CompileFilterInfo[];
    if (!Array.isArray(parsed)) {
        return discoveredCompileFilters();
    }
    discovered.splice(
        0,
        discovered.length,
        ...parsed.map((item) => ({
            ...item,
            name:
                typeof item.name === 'string' && item.name.trim()
                    ? item.name.trim()
                    : item.id,
            description:
                typeof item.description === 'string'
                    ? item.description.trim()
                    : ''
        }))
    );
    window.dispatchEvent(new CustomEvent('compilefiltersregistered'));
    return discoveredCompileFilters();
}

let legacyGuidesRetiredFor: unknown = null;

function retireHarakatGuides(font: {
    masters?: Array<{
        guides?: Array<{ name?: string }>;
        removeGuide?: (index: number) => void;
    }>;
}): void {
    for (const master of font.masters || []) {
        const guides = master.guides || [];
        for (let index = guides.length - 1; index >= 0; index -= 1) {
            if (guides[index]?.name === 'min_top_harakat') {
                master.removeGuide?.(index);
            }
        }
    }
}

export function ensureHarakatMinimums(font: {
    upm?: number;
    masters?: Array<{ id?: string }>;
    getPluginSetting?: (pluginId: string, settingId: string) => unknown;
    format_specific?: Record<string, unknown>;
}): void {
    const stored = font.getPluginSetting?.('harakat', 'minimum_by_master');
    const settings =
        stored && typeof stored === 'object'
            ? { ...(stored as Record<string, number>) }
            : {};
    const fallback = Number(font.upm || 1000) / 2;
    let changed = false;
    for (const master of font.masters || []) {
        if (!master.id || settings[master.id] != null) {
            continue;
        }
        settings[master.id] = fallback;
        changed = true;
    }
    if (changed) {
        writePluginSettingValue(font, 'harakat', 'minimum_by_master', settings);
    }
}

export async function retireLegacyCompileFilterGuides(): Promise<void> {
    const font = (
        window as unknown as {
            currentFontModel?: {
                masters?: Array<{
                    guides?: Array<{ name?: string }>;
                    removeGuide?: (index: number) => void;
                }>;
            };
        }
    ).currentFontModel;
    if (!font || legacyGuidesRetiredFor === font) {
        return;
    }
    legacyGuidesRetiredFor = font;
    const bridge = (
        window as unknown as {
            patchSyncEngine?: {
                beginTransaction: (
                    label: string,
                    glyph: null,
                    meta: {
                        compileChangeSource: string;
                        compileEditType: null;
                    }
                ) => void;
                endTransaction: () => void;
            };
        }
    ).patchSyncEngine;
    bridge?.beginTransaction('Remove Harakat guides', null, {
        compileChangeSource: 'compile-filter',
        compileEditType: null
    });
    try {
        retireHarakatGuides(font);
    } finally {
        bridge?.endTransaction();
    }
}

export async function setupCompileFilter(pluginId: string): Promise<void> {
    const python = pyodide();
    if (!python) {
        return;
    }
    await python.runPythonAsync(
        `_cp_compile_filter_setup(${pythonString(pluginId)})`
    );
}

export async function takedownCompileFilter(pluginId: string): Promise<void> {
    const python = pyodide();
    if (!python) {
        return;
    }
    await python.runPythonAsync(
        `_cp_compile_filter_takedown(${pythonString(pluginId)})`
    );
}

export function invalidateCompileFilterCache(): void {
    layerCache.clear();
    cachedFeatureKey = '';
    cachedFeatures = '';
}

export async function onCompileFilterGuideChange(
    change: GuideChange
): Promise<boolean> {
    const font = (
        window as unknown as {
            currentFontModel?: { format_specific?: Record<string, unknown> };
        }
    ).currentFontModel;
    const ids = linkedCompileFilterIds(font);
    const python = pyodide();
    if (!python || ids.length === 0) {
        return false;
    }
    if (discovered.length === 0) {
        await discoverCompileFilters();
    }
    const bridge = (
        window as unknown as {
            patchSyncEngine?: {
                beginTransaction: (
                    label: string,
                    glyph: null,
                    meta: {
                        compileChangeSource: string;
                        compileEditType: string | null;
                    }
                ) => void;
                endTransaction: () => void;
            };
        }
    ).patchSyncEngine;
    // The setting write is nested in here. A guide stamp does not compile,
    // so this commit does not stack a second compile on the one below.
    bridge?.beginTransaction('Compile filter guide', null, {
        compileChangeSource: 'compile-filter',
        compileEditType: 'guide'
    });
    let wrote = false;
    try {
        for (const info of discovered) {
            if (!ids.includes(info.id) || !info.hasGuide) {
                continue;
            }
            const raw = await python.runPythonAsync(
                `_cp_compile_filter_guide(${pythonString(info.id)}, ${pythonString(JSON.stringify(change))})`
            );
            if (raw === true || String(raw) === 'True') {
                wrote = true;
            }
        }
    } finally {
        bridge?.endTransaction();
    }
    if (wrote) {
        invalidateCompileFilterCache();
        const opened = (
            window as unknown as {
                fontManager?: {
                    currentFont?: {
                        needsRecompile?: boolean;
                        requestRecompileWithoutDataChange?: (options: {
                            compileContext: {
                                changeSource: string;
                                editType: null;
                                dataFreshnessMode: 'authoritative-worker-yjs';
                            };
                        }) => void;
                    };
                    recompileEditingFont?: () => Promise<unknown>;
                };
            }
        ).fontManager;
        const font = opened?.currentFont;
        font?.requestRecompileWithoutDataChange?.({
            compileContext: {
                changeSource: 'compile-filter',
                editType: null,
                dataFreshnessMode: 'authoritative-worker-yjs'
            }
        });
        // The flag would also wake the auto-compile loop.
        if (font) {
            font.needsRecompile = false;
        }
        await opened?.recompileEditingFont?.();
    }
    return wrote;
}

function componentDepth(
    glyphName: string,
    glyphs: Map<string, { layers?: Array<Record<string, unknown>> }>,
    seen: Set<string>
): number {
    if (seen.has(glyphName)) {
        return 0;
    }
    const glyph = glyphs.get(glyphName);
    if (!glyph) {
        return 0;
    }
    const next = new Set(seen);
    next.add(glyphName);
    let best = 0;
    for (const layer of glyph.layers || []) {
        const shapes = [
            ...((layer.shapes as Array<{ reference?: string }> | undefined) ||
                []),
            ...((layer.components as
                Array<{ reference?: string }> | undefined) || [])
        ];
        for (const shape of shapes) {
            if (shape.reference) {
                best = Math.max(
                    best,
                    1 + componentDepth(shape.reference, glyphs, next)
                );
            }
        }
    }
    return best;
}

function glyphNamesClosedBySubstitutions(
    features: { features?: Array<[string, { code?: string }]> } | undefined,
    roots: Set<string>,
    known: Set<string>
): Set<string> {
    const closed = new Set(roots);
    const rules: Array<{ input: string; outputs: string[] }> = [];
    const tags = new Set([
        'ccmp',
        'isol',
        'init',
        'medi',
        'fina',
        'locl',
        'rlig'
    ]);
    for (const feature of features?.features || []) {
        if (!Array.isArray(feature) || !tags.has(String(feature[0]))) {
            continue;
        }
        const code = feature[1]?.code || '';
        for (const line of code.split('\n')) {
            const stripped = line.trim();
            if (!stripped || stripped.startsWith('#')) {
                continue;
            }
            const match = stripped.match(/^sub\s+(\S+)\s+by\s+(.+?);?\s*$/);
            if (!match) {
                continue;
            }
            rules.push({
                input: match[1],
                outputs: match[2]
                    .replace(/;$/, '')
                    .split(/\s+/)
                    .filter((part) => part.length > 0)
            });
        }
    }
    let grew = true;
    while (grew) {
        grew = false;
        for (const rule of rules) {
            if (!closed.has(rule.input)) {
                continue;
            }
            for (const output of rule.outputs) {
                if (known.has(output) && !closed.has(output)) {
                    closed.add(output);
                    grew = true;
                }
            }
        }
    }
    return closed;
}

const VOWEL_CODEPOINTS = new Set<number>([
    ...Array.from({ length: 0x0656 - 0x064b }, (_, index) => 0x064b + index),
    0x065a,
    0x065b,
    0x0670
]);

type InkGlyph = {
    name: string;
    codepoints?: number[];
    layers?: Array<{
        anchors?: Array<{ name?: string }>;
        master?: { master?: string };
        data?: { shapes?: RawShape[] };
    }>;
};

type RawNode = { x?: number; y?: number };
type RawShape = {
    nodes?: RawNode[];
    reference?: string;
    transform?: unknown;
    Path?: { nodes?: RawNode[] };
    Component?: { reference?: string; transform?: unknown };
};

function isAboveVowel(glyph: InkGlyph): boolean {
    const codepoints = glyph.codepoints || [];
    if (
        !codepoints.some((codepoint) => VOWEL_CODEPOINTS.has(Number(codepoint)))
    ) {
        return false;
    }
    return (glyph.layers || []).some((layer) =>
        (layer.anchors || []).some((anchor) => anchor.name === '_top')
    );
}

function shapeNodes(shape: RawShape): RawNode[] | null {
    if (Array.isArray(shape.nodes)) {
        return shape.nodes;
    }
    if (Array.isArray(shape.Path?.nodes)) {
        return shape.Path.nodes;
    }
    return null;
}

function shapeComponent(
    shape: RawShape
): { reference: string; transform?: unknown } | null {
    if (typeof shape.reference === 'string') {
        return { reference: shape.reference, transform: shape.transform };
    }
    if (typeof shape.Component?.reference === 'string') {
        return {
            reference: shape.Component.reference,
            transform: shape.Component.transform
        };
    }
    return null;
}

function shapeMatrix(transform: unknown): number[] | null {
    if (!transform) {
        return null;
    }
    if (Array.isArray(transform)) {
        return transform.length >= 6 ? transform : null;
    }
    try {
        return DecomposedAffineTransform.toAffine(
            transform as Parameters<
                typeof DecomposedAffineTransform.toAffine
            >[0]
        );
    } catch {
        return null;
    }
}

function layerInkBounds(
    layer: InkGlyph['layers'] extends Array<infer T> | undefined ? T : never,
    glyphName: string,
    glyphs: Map<string, InkGlyph>,
    seen: Set<string>,
    apply: (x: number, y: number) => number = (_x, y) => y
): { yMin: number; yMax: number } | undefined {
    if (seen.has(glyphName)) {
        return undefined;
    }
    const next = new Set(seen);
    next.add(glyphName);
    let yMin: number | undefined;
    let yMax: number | undefined;
    const consider = (x: number, y: number) => {
        const transformed = apply(x, y);
        if (!Number.isFinite(transformed)) {
            return;
        }
        if (yMin === undefined || transformed < yMin) {
            yMin = transformed;
        }
        if (yMax === undefined || transformed > yMax) {
            yMax = transformed;
        }
    };
    const masterId = layer.master?.master;
    for (const shape of layer.data?.shapes || []) {
        const nodes = shapeNodes(shape);
        if (nodes) {
            for (const node of nodes) {
                if (typeof node?.y === 'number') {
                    consider(node.x || 0, node.y);
                }
            }
            continue;
        }
        const component = shapeComponent(shape);
        if (!component || next.has(component.reference)) {
            continue;
        }
        const referenced = glyphs.get(component.reference);
        const referencedLayer =
            (referenced?.layers || []).find(
                (item) => item.master?.master === masterId
            ) || referenced?.layers?.[0];
        if (!referencedLayer) {
            continue;
        }
        const matrix = shapeMatrix(component.transform);
        const nestedApply = matrix
            ? (x: number, y: number) =>
                  apply(
                      matrix[0] * x + matrix[2] * y + (matrix[4] || 0),
                      matrix[1] * x + matrix[3] * y + (matrix[5] || 0)
                  )
            : apply;
        const nested = layerInkBounds(
            referencedLayer,
            component.reference,
            glyphs,
            next,
            nestedApply
        );
        if (!nested) {
            continue;
        }
        if (yMin === undefined || nested.yMin < yMin) {
            yMin = nested.yMin;
        }
        if (yMax === undefined || nested.yMax > yMax) {
            yMax = nested.yMax;
        }
    }
    if (yMin === undefined || yMax === undefined) {
        return undefined;
    }
    return { yMin, yMax };
}

function pluginSettingsRecord(layer: {
    format_specific?: Record<string, unknown>;
}): { format_specific?: Record<string, unknown> } {
    const bag = layer.format_specific?.['com.counterpunch.plugin-settings'];
    if (!bag || typeof bag !== 'object') {
        return {};
    }
    return {
        format_specific: {
            'com.counterpunch.plugin-settings': bag
        }
    };
}

function componentRecords(layer: { data?: { shapes?: RawShape[] } }): {
    components?: Array<{ reference: string; matrix: number[] }>;
} {
    const components: Array<{ reference: string; matrix: number[] }> = [];
    for (const shape of layer.data?.shapes || []) {
        const component = shapeComponent(shape);
        if (!component) {
            continue;
        }
        components.push({
            reference: component.reference,
            matrix: shapeMatrix(component.transform) || [1, 0, 0, 1, 0, 0]
        });
    }
    return components.length > 0 ? { components } : {};
}

export interface TransientAnchor {
    pluginId?: string;
    name: string;
    x: number;
    y: number;
    defaultX?: number;
}

export async function queryTransientAnchors(
    glyphName: string,
    layerId: string
): Promise<TransientAnchor[]> {
    const python = pyodide();
    if (!python || !glyphName || !layerId) {
        return [];
    }
    await retireLegacyCompileFilterGuides();
    if (discovered.length === 0) {
        await discoverCompileFilters();
    }
    const raw = await python.runPythonAsync(
        `_cp_compile_filter_transient_anchors(${pythonString(glyphName)}, ${pythonString(layerId)})`
    );
    const parsed = JSON.parse(String(raw)) as TransientAnchor[];
    return Array.isArray(parsed) ? parsed : [];
}

function applyTransientAnchorDecision(
    change: {
        glyphName: string;
        layerId: string;
        masterId: string;
    },
    decision: {
        y?: number;
        x?: number;
        clearX?: boolean;
        masterId?: string;
    }
): void {
    const font = (
        window as unknown as {
            currentFontModel?: {
                glyphs?: Array<{
                    name?: string;
                    layers?: Array<{
                        id?: string;
                        format_specific?: Record<string, unknown>;
                        setPluginSetting?: (
                            pluginId: string,
                            settingId: string,
                            value: unknown
                        ) => void;
                    }>;
                }>;
                getPluginSetting?: (
                    pluginId: string,
                    settingId: string
                ) => unknown;
                format_specific?: Record<string, unknown>;
            };
        }
    ).currentFontModel;
    if (!font) {
        return;
    }
    if (typeof decision.y === 'number') {
        const masterId = decision.masterId || change.masterId;
        const stored = font.getPluginSetting?.('harakat', 'minimum_by_master');
        if (stored && typeof stored === 'object') {
            (stored as Record<string, number>)[masterId] = decision.y;
        } else {
            writePluginSettingValue(font, 'harakat', 'minimum_by_master', {
                [masterId]: decision.y
            });
        }
    }
    if (decision.clearX !== true && typeof decision.x !== 'number') {
        return;
    }
    const glyph = font.glyphs?.find((item) => item.name === change.glyphName);
    const layer = glyph?.layers?.find((item) => item.id === change.layerId);
    if (!layer) {
        return;
    }
    writePluginSettingValue(
        layer,
        'harakat',
        'anchor_x',
        decision.clearX ? null : decision.x
    );
}

export async function commitTransientAnchor(change: {
    pluginId: string;
    name: string;
    glyphName: string;
    layerId: string;
    masterId: string;
    x: number;
    y: number;
    defaultX: number;
}): Promise<boolean> {
    const python = pyodide();
    if (!python) {
        return false;
    }
    const wrote = await python.runPythonAsync(
        `_cp_compile_filter_transient_anchor(${pythonString(JSON.stringify(change))})`
    );
    const decision = JSON.parse(String(wrote)) as {
        ok?: boolean;
        y?: number;
        x?: number;
        clearX?: boolean;
        masterId?: string;
    };
    const bridge = (
        window as unknown as {
            patchSyncEngine?: {
                beginTransaction: (
                    label: string,
                    glyph: null,
                    meta: {
                        compileChangeSource: string;
                        compileEditType: null;
                    }
                ) => void;
                endTransaction: () => void;
                setRecordingSuppressed?: (suppressed: boolean) => void;
                inTransaction?: boolean;
            };
        }
    ).patchSyncEngine;
    bridge?.setRecordingSuppressed?.(false);
    let leaked = 0;
    while (bridge?.inTransaction && leaked < 4) {
        bridge.endTransaction();
        leaked += 1;
    }
    bridge?.beginTransaction('Move Harakat anchor', null, {
        compileChangeSource: 'compile-filter',
        compileEditType: null
    });
    let wroteResult = false;
    try {
        wroteResult = decision.ok !== false;
        applyTransientAnchorDecision(change, decision);
    } finally {
        bridge?.endTransaction();
    }
    invalidateCompileFilterCache();
    const opened = (
        window as unknown as {
            fontManager?: {
                currentFont?: {
                    needsRecompile?: boolean;
                    requestRecompileWithoutDataChange?: (options: {
                        compileContext: {
                            changeSource: string;
                            editType: null;
                            dataFreshnessMode: 'authoritative-worker-yjs';
                        };
                    }) => void;
                };
                recompileEditingFont?: () => Promise<unknown>;
            };
        }
    ).fontManager;
    const current = opened?.currentFont;
    current?.requestRecompileWithoutDataChange?.({
        compileContext: {
            changeSource: 'compile-filter',
            editType: null,
            dataFreshnessMode: 'authoritative-worker-yjs'
        }
    });
    if (current) {
        current.needsRecompile = false;
    }
    await opened?.recompileEditingFont?.();
    return wroteResult;
}

function shiftCompileLayerX(
    data: {
        anchors?: Array<{ name?: string; x?: number }>;
        shapes?: Array<{
            reference?: string;
            transform?: number[] | { translation?: number[] };
        }>;
    },
    dx: number
): void {
    let shiftedAnchor = false;
    for (const anchor of data.anchors || []) {
        if (anchor?.name === 'top') {
            anchor.x = Number(anchor.x || 0) + dx;
            shiftedAnchor = true;
        }
    }
    if (shiftedAnchor) {
        return;
    }
    for (const shape of data.shapes || []) {
        if (!shape?.reference) {
            continue;
        }
        const transform = shape.transform;
        if (Array.isArray(transform) && transform.length >= 6) {
            transform[4] = Number(transform[4] || 0) + dx;
            continue;
        }
        if (transform && !Array.isArray(transform)) {
            if (!Array.isArray(transform.translation)) {
                transform.translation = [0, 0];
            }
            transform.translation[0] =
                Number(transform.translation[0] || 0) + dx;
        }
    }
}

function anchorShiftLayerUpdates(
    font: {
        glyphs?: Array<{
            name: string;
            layers?: Array<{
                id?: string;
                toJSON?: () => {
                    anchors?: Array<{ name?: string; x?: number }>;
                    shapes?: Array<{
                        reference?: string;
                        transform?: number[] | { translation?: number[] };
                    }>;
                };
            }>;
        }>;
    },
    shifts: Array<{ glyph: string; layerId: string; dx: number }> | undefined
): Array<{ glyphName: string; layerId: string; layerData: unknown }> {
    const updates = [];
    for (const shift of shifts || []) {
        if (!shift.dx) {
            continue;
        }
        const glyph = font.glyphs?.find((item) => item.name === shift.glyph);
        const layer = glyph?.layers?.find((item) => item.id === shift.layerId);
        if (!layer || typeof layer.toJSON !== 'function') {
            continue;
        }
        const data = JSON.parse(JSON.stringify(layer.toJSON())) as {
            anchors?: Array<{ name?: string; x?: number }>;
            shapes?: Array<{
                reference?: string;
                transform?: number[] | { translation?: number[] };
            }>;
        };
        shiftCompileLayerX(data, shift.dx);
        updates.push({
            glyphName: shift.glyph,
            layerId: shift.layerId,
            layerData: data
        });
    }
    return updates;
}

function anchorOnlyLayerRecord(layer: {
    id?: string;
    is_background?: boolean;
    master?: { type?: string; master?: string };
    location?: Record<string, number>;
    anchors?: Array<{ name?: string; x?: number; y?: number }>;
}): Record<string, unknown> {
    return {
        id: layer.id,
        is_background: layer.is_background === true,
        master: layer.master
            ? { type: layer.master.type, master: layer.master.master }
            : undefined,
        location: layer.location ? { ...layer.location } : undefined,
        anchors: (layer.anchors || [])
            .filter((anchor) => Boolean(anchor.name))
            .map((anchor) => ({
                name: anchor.name,
                x: Number(anchor.x) || 0,
                y: Number(anchor.y) || 0
            })),
        ...pluginSettingsRecord(
            layer as {
                format_specific?: Record<string, unknown>;
            }
        ),
        ...componentRecords(layer as { data?: { shapes?: RawShape[] } })
    };
}

function layerRecord(layer: {
    toJSON?: () => Record<string, unknown>;
    id?: string;
    computedAnchors?: () => Record<string, { x: number; y: number }>;
}): Record<string, unknown> {
    if (typeof layer.toJSON === 'function') {
        return layer.toJSON();
    }
    return JSON.parse(JSON.stringify(layer)) as Record<string, unknown>;
}

export async function prepareCompileFilters(
    glyphNames: string[] | null
): Promise<{
    layerUpdates: Array<{
        glyphName: string;
        layerId: string;
        layerData: unknown;
    }>;
    features: string;
}> {
    const font = (
        window as unknown as {
            currentFontModel?: {
                format_specific?: Record<string, unknown>;
                glyphs?: Array<{
                    name: string;
                    exported?: boolean;
                    category?: string;
                    codepoints?: number[];
                    layers?: Array<{
                        id?: string;
                        is_background?: boolean;
                        toJSON?: () => Record<string, unknown>;
                        computedAnchors?: () => Record<
                            string,
                            { x: number; y: number }
                        >;
                    }>;
                }>;
                masters?: unknown[];
                axes?: unknown[];
                features?: unknown;
                upm?: number;
                toJSON?: () => Record<string, unknown>;
            };
        }
    ).currentFontModel;
    const ids = linkedCompileFilterIds(font);
    if (!font || ids.length === 0 || !pyodide()) {
        return { layerUpdates: [], features: '' };
    }
    if (discovered.length === 0) {
        await discoverCompileFilters();
    }
    const active = discovered.filter((info) => ids.includes(info.id));
    if (active.length === 0) {
        return { layerUpdates: [], features: '' };
    }
    // Layer hooks need outlines. Font-only hooks (Harakat) need anchors,
    // names, and codepoints, and serializing every outline on each edit
    // dominated compile time.
    const needsLayerData = active.some(
        (info) => info.hasLayer || info.hasPropagated
    );
    const wantsAnchors = active.some((info) => info.hasPropagated);
    const selected = new Set(glyphNames || []);
    const glyphs = new Map(
        (font.glyphs || []).map((glyph) => [glyph.name, glyph])
    );
    if (selected.size > 0) {
        for (const name of glyphNamesClosedBySubstitutions(
            font.features as {
                features?: Array<[string, { code?: string }]>;
            },
            selected,
            new Set(glyphs.keys())
        )) {
            selected.add(name);
        }
    }
    const included = (font.glyphs || []).filter((glyph) => {
        if (glyph.exported === false) {
            return false;
        }
        return selected.size === 0 || selected.has(glyph.name);
    });
    const jobs: Array<{
        glyphName: string;
        depth: number;
        layer: LayerJob['layer'];
        inherited?: LayerJob['inherited'];
    }> = [];
    if (needsLayerData) {
        for (const glyph of included) {
            for (const layer of glyph.layers || []) {
                if (layer.is_background) {
                    continue;
                }
                jobs.push({
                    glyphName: glyph.name,
                    depth: componentDepth(glyph.name, glyphs, new Set()),
                    layer: layerRecord(layer),
                    inherited: wantsAnchors
                        ? layer.computedAnchors?.() || {}
                        : undefined
                });
            }
        }
        jobs.sort((left, right) => left.depth - right.depth);
    }

    const inkGlyphs = glyphs as Map<string, InkGlyph>;
    const includedNames = new Set(included.map((glyph) => glyph.name));
    const boundsOnly = (font.glyphs || []).filter(
        (glyph) =>
            glyph.exported !== false &&
            isAboveVowel(glyph as InkGlyph) &&
            !includedNames.has(glyph.name)
    );
    const layerJson = (
        glyph: (typeof included)[number],
        boundsOnlyGlyph: boolean
    ) => ({
        name: glyph.name,
        exported: glyph.exported,
        category: glyph.category,
        codepoints: glyph.codepoints,
        ...(boundsOnlyGlyph ? { boundsOnly: true } : {}),
        layers: (glyph.layers || []).map((layer) => {
            const record = needsLayerData
                ? layerRecord(layer)
                : anchorOnlyLayerRecord(
                      layer as {
                          id?: string;
                          is_background?: boolean;
                          master?: { type?: string; master?: string };
                          location?: Record<string, number>;
                          anchors?: Array<{
                              name?: string;
                              x?: number;
                              y?: number;
                          }>;
                      }
                  );
            if (!isAboveVowel(glyph as InkGlyph)) {
                return record;
            }
            const bounds = layerInkBounds(
                layer as InkGlyph['layers'] extends Array<infer T> | undefined
                    ? T
                    : never,
                glyph.name,
                inkGlyphs,
                new Set()
            );
            return bounds === undefined
                ? record
                : { ...record, yMin: bounds.yMin, yMax: bounds.yMax };
        })
    });

    const fontJson = {
        upm: font.upm,
        masters: font.masters,
        axes: font.axes,
        features: font.features,
        format_specific: font.format_specific,
        glyphs: [
            ...included.map((glyph) => layerJson(glyph, false)),
            ...boundsOnly.map((glyph) => layerJson(glyph, true))
        ]
    };
    const payload = {
        ids: active.map((info) => info.id),
        font: fontJson,
        layers: jobs.map((job) => ({
            glyphName: job.glyphName,
            layer: job.layer,
            inherited: job.inherited
        }))
    };
    if (!needsLayerData) {
        const featureKey = JSON.stringify(fontJson);
        if (featureKey === cachedFeatureKey) {
            return { layerUpdates: [], features: cachedFeatures };
        }
        const raw = await pyodide()!.runPythonAsync(
            `_cp_compile_filters_run(${pythonString(JSON.stringify(payload))})`
        );
        const parsed = JSON.parse(String(raw)) as {
            layers: Record<string, unknown>;
            features: string;
            anchorShifts?: Array<{
                glyph: string;
                layerId: string;
                dx: number;
            }>;
        };
        cachedFeatureKey = featureKey;
        cachedFeatures = parsed.features || '';
        return {
            layerUpdates: anchorShiftLayerUpdates(font, parsed.anchorShifts),
            features: cachedFeatures
        };
    }
    const raw = await pyodide()!.runPythonAsync(
        `_cp_compile_filters_run(${pythonString(JSON.stringify(payload))})`
    );
    const parsed = JSON.parse(String(raw)) as {
        layers: Record<string, unknown>;
        features: string;
        anchorShifts?: Array<{
            glyph: string;
            layerId: string;
            dx: number;
        }>;
    };
    layerCache.set('last', JSON.stringify(parsed));

    const layerUpdates = [
        ...Object.entries(parsed.layers || {}).map(([key, layerData]) => {
            const separator = key.indexOf('\u001f');
            return {
                glyphName: key.slice(0, separator),
                layerId: key.slice(separator + 1),
                layerData
            };
        }),
        ...anchorShiftLayerUpdates(font, parsed.anchorShifts)
    ];
    return { layerUpdates, features: parsed.features || '' };
}

declare global {
    interface Window {
        compileFilterHost?: {
            onGuideCommitted: (change: GuideChange) => Promise<boolean>;
            commitTransientAnchor: (change: {
                pluginId: string;
                name: string;
                glyphName: string;
                layerId: string;
                masterId: string;
                x: number;
                y: number;
                defaultX: number;
            }) => Promise<boolean>;
            queryTransientAnchors: (
                glyphName: string,
                layerId: string
            ) => Promise<TransientAnchor[]>;
            discover: () => Promise<CompileFilterInfo[]>;
            invalidate: () => void;
        };
    }
}

window.compileFilterHost = {
    onGuideCommitted: onCompileFilterGuideChange,
    commitTransientAnchor,
    queryTransientAnchors,
    discover: discoverCompileFilters,
    invalidate: invalidateCompileFilterCache
};
