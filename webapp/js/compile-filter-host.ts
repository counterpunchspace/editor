/**
 * CompileFilter host. Plugins are Python entry points. The JSON compile hooks
 * see Babelfont JSON. setup, takedown, and onGuideChange see the live font.
 */

const COMPILE_FILTERS_KEY = 'com.counterpunch.compile-filters';

export interface CompileFilterInfo {
    id: string;
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
    const next = { ...(font.format_specific || {}) };
    next[COMPILE_FILTERS_KEY] = ids;
    font.format_specific = next;
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
    discovered.splice(0, discovered.length, ...parsed);
    window.dispatchEvent(new CustomEvent('compilefiltersregistered'));
    return discoveredCompileFilters();
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
    let wrote = false;
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
    if (wrote) {
        invalidateCompileFilterCache();
        const host = window as unknown as {
            fontManager?: {
                recompileEditingFont?: () => Promise<unknown>;
                setEditingCompileContext?: (
                    changeSource: string,
                    editType: null
                ) => void;
            };
            currentFontModel?: {
                requestRecompileWithoutDataChange?: (options: {
                    compileContext: {
                        changeSource: string;
                        editType: null;
                        dataFreshnessMode: 'authoritative-worker-yjs';
                    };
                }) => void;
            };
        };
        host.fontManager?.setEditingCompileContext?.('compile-filter', null);
        host.currentFontModel?.requestRecompileWithoutDataChange?.({
            compileContext: {
                changeSource: 'compile-filter',
                editType: null,
                dataFreshnessMode: 'authoritative-worker-yjs'
            }
        });
        let pending = true;
        for (let attempt = 0; pending && attempt < 4; attempt += 1) {
            pending = Boolean(await host.fontManager?.recompileEditingFont?.());
        }
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
    const jobs: Array<{
        glyphName: string;
        depth: number;
        layer: LayerJob['layer'];
        inherited?: LayerJob['inherited'];
    }> = [];
    for (const glyph of font.glyphs || []) {
        if (glyph.exported === false) {
            continue;
        }
        if (selected.size > 0 && !selected.has(glyph.name)) {
            continue;
        }
        for (const layer of glyph.layers || []) {
            if (layer.is_background) {
                continue;
            }
            const record = layerRecord(layer);
            jobs.push({
                glyphName: glyph.name,
                depth: componentDepth(glyph.name, glyphs, new Set()),
                layer: record,
                inherited: wantsAnchors
                    ? layer.computedAnchors?.() || {}
                    : undefined
            });
        }
    }
    jobs.sort((left, right) => left.depth - right.depth);

    const fontJson = {
        upm: font.upm,
        masters: font.masters,
        axes: font.axes,
        features: font.features,
        format_specific: font.format_specific,
        glyphs: (font.glyphs || [])
            .filter((glyph) => selected.size === 0 || selected.has(glyph.name))
            .map((glyph) => ({
                name: glyph.name,
                exported: glyph.exported,
                category: glyph.category,
                codepoints: glyph.codepoints,
                layers: (glyph.layers || []).map((layer) => layerRecord(layer))
            }))
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
    const raw = await pyodide()!.runPythonAsync(
        `_cp_compile_filters_run(${pythonString(JSON.stringify(payload))})`
    );
    const parsed = JSON.parse(String(raw)) as {
        layers: Record<string, unknown>;
        features: string;
    };
    layerCache.set('last', JSON.stringify(parsed));

    const layerUpdates = Object.entries(parsed.layers || {}).map(
        ([key, layerData]) => {
            const separator = key.indexOf('\u001f');
            return {
                glyphName: key.slice(0, separator),
                layerId: key.slice(separator + 1),
                layerData
            };
        }
    );
    return { layerUpdates, features: parsed.features || '' };
}

declare global {
    interface Window {
        compileFilterHost?: {
            onGuideCommitted: (change: GuideChange) => Promise<boolean>;
            discover: () => Promise<CompileFilterInfo[]>;
            invalidate: () => void;
        };
    }
}

window.compileFilterHost = {
    onGuideCommitted: onCompileFilterGuideChange,
    discover: discoverCompileFilters,
    invalidate: invalidateCompileFilterCache
};
