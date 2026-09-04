import { getHarfBuzzRawModule } from './font-compilation';
import { Logger } from './logger';
import {
    evaluateLiveShardMemory,
    type LiveShardMemoryReport
} from './filesystem-plugins/cloud-shard-limits';

const console = new Logger('MemoryMonitor');

export type MemoryMethod = 'exact' | 'encoded' | 'est.';

export type MemoryRow = {
    id: string;
    label: string;
    bytes: number;
    method: MemoryMethod;
    inSum: boolean;
    note?: string;
};

export type MemoryDomainId = 'main-js' | 'worker-js' | 'worker-wasm';

export type MemoryDomain = {
    id: MemoryDomainId;
    label: string;
    usedBytes: number | null;
    usedLabel: string;
    rows: MemoryRow[];
    error?: string;
};

export type MemoryBreakdown = {
    domains: MemoryDomain[];
    otherRows: MemoryRow[];
    domRows: MemoryRow[];
    accountedBytes: number;
    browserUsedBytes: number | null;
    browserLimitBytes: number | null;
};

export type BrowserHeapSnapshot = {
    usedBytes: number | null;
    limitBytes: number | null;
};

export function liveShardMemoryFromEngine(
    bridge = typeof window !== 'undefined' ? window.patchSyncEngine : null
): LiveShardMemoryReport | null {
    const snapshot = bridge?.getMemoryInspectionSnapshot?.();
    if (!snapshot) {
        return null;
    }
    return evaluateLiveShardMemory({
        decodedStructs: snapshot.decodedStructs,
        undoStackItems: snapshot.undoStackItems
    });
}
function liveMemoryNote(bridgeSnapshot: {
    decodedStructs?: number;
    undoStackItems?: number;
}): string {
    const report = evaluateLiveShardMemory({
        decodedStructs: bridgeSnapshot.decodedStructs,
        undoStackItems: bridgeSnapshot.undoStackItems
    });
    const structs =
        typeof bridgeSnapshot.decodedStructs === 'number'
            ? `${bridgeSnapshot.decodedStructs} structs`
            : 'live CRDT';
    return report.status === 'warning'
        ? `${structs} · shard memory warning (gc:false; rebaseline keeps unsent)`
        : structs;
}

export function estimateJsValueBytes(
    value: unknown,
    seen: WeakSet<object> = new WeakSet()
): number {
    if (value === null || value === undefined) {
        return 8;
    }
    const valueType = typeof value;
    if (valueType === 'string') {
        return 24 + (value as string).length * 2;
    }
    if (valueType === 'number' || valueType === 'boolean') {
        return 8;
    }
    if (valueType === 'bigint') {
        return 16;
    }
    if (valueType !== 'object') {
        return 8;
    }

    const objectValue = value as object;
    if (seen.has(objectValue)) {
        return 0;
    }
    seen.add(objectValue);

    if (ArrayBuffer.isView(objectValue)) {
        return (objectValue as ArrayBufferView).byteLength + 32;
    }
    if (objectValue instanceof ArrayBuffer) {
        return objectValue.byteLength + 32;
    }
    if (objectValue instanceof Map) {
        let bytes = 56;
        for (const [key, entry] of objectValue) {
            bytes += estimateJsValueBytes(key, seen);
            bytes += estimateJsValueBytes(entry, seen);
        }
        return bytes;
    }
    if (objectValue instanceof Set) {
        let bytes = 56;
        for (const entry of objectValue) {
            bytes += estimateJsValueBytes(entry, seen);
        }
        return bytes;
    }
    if (Array.isArray(objectValue)) {
        let bytes = 48 + objectValue.length * 8;
        for (const item of objectValue) {
            bytes += estimateJsValueBytes(item, seen);
        }
        return bytes;
    }

    let bytes = 56;
    for (const key of Object.keys(objectValue)) {
        bytes += 24 + key.length * 2;
        bytes += estimateJsValueBytes(
            (objectValue as Record<string, unknown>)[key],
            seen
        );
    }
    return bytes;
}

export function jsStringHeapBytes(value: string | null | undefined): number {
    return value ? 24 + value.length * 2 : 0;
}

export function formatMemoryBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) {
        return '0 B';
    }
    if (bytes >= 1048576) {
        return `${(bytes / 1048576).toFixed(2)} MB`;
    }
    if (bytes >= 1024) {
        return `${(bytes / 1024).toFixed(1)} KB`;
    }
    return `${Math.round(bytes)} B`;
}

export function domainMeasuredBytes(domain: MemoryDomain): number {
    return domain.rows.reduce(
        (sum, row) => (row.inSum ? sum + row.bytes : sum),
        0
    );
}

function isV8Domain(domain: MemoryDomain): boolean {
    return domain.id === 'main-js' || domain.id === 'worker-js';
}

export function breakdownMeasuredBytes(breakdown: MemoryBreakdown): number {
    return breakdown.domains.reduce(
        (sum, domain) =>
            isV8Domain(domain) ? sum + domainMeasuredBytes(domain) : sum,
        0
    );
}

export function breakdownUsedBytes(breakdown: MemoryBreakdown): number | null {
    return breakdown.browserUsedBytes;
}

export function breakdownCoveragePercent(
    breakdown: MemoryBreakdown
): number | null {
    const usedBytes = breakdownUsedBytes(breakdown);
    if (usedBytes == null || usedBytes <= 0) {
        return null;
    }
    return (breakdownMeasuredBytes(breakdown) / usedBytes) * 100;
}

export function readBrowserHeapSnapshot(): BrowserHeapSnapshot {
    const perfWithMemory = performance as Performance & {
        memory?: { usedJSHeapSize?: number; jsHeapSizeLimit?: number };
    };
    const usedBytes =
        typeof perfWithMemory.memory?.usedJSHeapSize === 'number'
            ? perfWithMemory.memory.usedJSHeapSize
            : null;
    const limitBytes =
        typeof perfWithMemory.memory?.jsHeapSizeLimit === 'number'
            ? perfWithMemory.memory.jsHeapSizeLimit
            : null;
    return { usedBytes, limitBytes };
}

function getMainHeapUsedBytes(): number | null {
    return readBrowserHeapSnapshot().usedBytes;
}

function getLinearMemoryBytes(value: unknown): number {
    if (!value || typeof value !== 'object') {
        return 0;
    }
    const record = value as Record<string, unknown>;
    const heap = record.HEAP8 ?? record.HEAPU8;
    if (heap && typeof heap === 'object' && 'buffer' in heap) {
        const buffer = (heap as { buffer?: ArrayBuffer }).buffer;
        return buffer?.byteLength ?? 0;
    }
    if (record.memory instanceof WebAssembly.Memory) {
        return record.memory.buffer.byteLength;
    }
    const nestedModule = record._module ?? record.asm;
    if (nestedModule && nestedModule !== value) {
        return getLinearMemoryBytes(nestedModule);
    }
    return 0;
}

function getPyodideLinearMemoryBytes(): number {
    return getLinearMemoryBytes(window.pyodide);
}

function getHarfBuzzLinearMemoryBytes(): number {
    return getLinearMemoryBytes(getHarfBuzzRawModule());
}

function estimateRowBytes(value: unknown): number {
    return estimateJsValueBytes(value, new WeakSet());
}

function estimateYjsStoreBytes(store: unknown): number {
    if (!store || typeof store !== 'object') {
        return 0;
    }
    const clients = (store as { clients?: unknown }).clients;
    if (!(clients instanceof Map)) {
        return 0;
    }
    const seenItems = new WeakSet<object>();
    let bytes = 56;
    for (const structs of clients.values()) {
        if (!Array.isArray(structs)) {
            continue;
        }
        bytes += 48 + structs.length * 8;
        for (const item of structs) {
            if (!item || typeof item !== 'object' || seenItems.has(item)) {
                continue;
            }
            seenItems.add(item);
            bytes += 96;
            const content = (item as { content?: Record<string, unknown> })
                .content;
            if (!content || typeof content !== 'object') {
                continue;
            }
            if (typeof content.str === 'string') {
                bytes += jsStringHeapBytes(content.str);
            } else if (Array.isArray(content.arr)) {
                bytes += estimateRowBytes(content.arr);
            } else if (content.content) {
                bytes += estimateRowBytes(content.content);
            }
        }
    }
    return bytes;
}

function collectMainJsDomain(): MemoryDomain {
    const fontManager = window.fontManager;
    const bridge = window.patchSyncEngine;
    const fontSnapshot = fontManager?.getMemoryInspectionSnapshot?.();
    const bridgeSnapshot = bridge?.getMemoryInspectionSnapshot?.();
    const rows: MemoryRow[] = [];

    if (fontSnapshot) {
        for (const font of fontSnapshot.fonts) {
            rows.push({
                id: `babelfont-json:${font.id}`,
                label: `babelfont JSON string (${font.name})`,
                bytes: jsStringHeapBytes(font.babelfontJson),
                method: 'exact',
                inSum: true,
                note: 'UTF-16 string copy'
            });
            rows.push({
                id: `font-json:${font.id}`,
                label: `Font JSON graph (${font.name})`,
                bytes: estimateRowBytes(font.babelfontData),
                method: 'est.',
                inSum: true,
                note: 'shared with the Yjs bridge'
            });
        }

        const validatedBytes =
            jsStringHeapBytes(fontSnapshot.validatedCacheInput) +
            jsStringHeapBytes(fontSnapshot.validatedCacheOutput);
        rows.push({
            id: 'validated-json-cache',
            label: 'Validated JSON cache',
            bytes: validatedBytes,
            method: 'exact',
            inSum: true,
            note: validatedBytes === 0 ? 'empty' : 'input + output strings'
        });
        rows.push({
            id: 'editing-font',
            label: 'Compiled editing TTF',
            bytes: fontSnapshot.editingFontBytes,
            method: 'exact',
            inSum: true,
            note:
                fontSnapshot.editingFontBytes === 0
                    ? 'empty'
                    : 'may be external to V8 heap'
        });
        rows.push({
            id: 'closure-cache',
            label: 'Layout closure cache',
            bytes: estimateRowBytes(fontSnapshot.closureCache),
            method: 'est.',
            inSum: true
        });
        rows.push({
            id: 'glyph-order-cache',
            label: 'Glyph order cache',
            bytes: estimateRowBytes(fontSnapshot.glyphOrderCache),
            method: 'est.',
            inSum: true
        });
        rows.push({
            id: 'layer-fingerprints',
            label: 'Worker layer fingerprints',
            bytes: estimateRowBytes(fontSnapshot.fingerprintCache),
            method: 'est.',
            inSum: true
        });
    }

    if (bridgeSnapshot) {
        if (!fontSnapshot) {
            rows.push({
                id: 'bridge-font-json',
                label: 'Bridge font JSON graph',
                bytes: estimateRowBytes(bridgeSnapshot.fontJson),
                method: 'est.',
                inSum: true
            });
        }
        rows.push({
            id: 'ydoc',
            label: 'Y.Doc store',
            bytes: estimateYjsStoreBytes(bridgeSnapshot.yDocStore),
            method: 'est.',
            inSum: true,
            note: liveMemoryNote(bridgeSnapshot)
        });
        rows.push({
            id: 'undo-stacks',
            label: 'Y.UndoManager stacks',
            bytes: estimateRowBytes(bridgeSnapshot.undoStacks),
            method: 'est.',
            inSum: true,
            note: `${bridgeSnapshot.undoStackItems} stack items`
        });
        rows.push({
            id: 'change-log',
            label: 'Change log',
            bytes: estimateRowBytes(bridgeSnapshot.changeLog),
            method: 'est.',
            inSum: true,
            note: `${bridgeSnapshot.changeLog.length} entries`
        });
        rows.push({
            id: 'collaboration-log',
            label: 'Collaboration log',
            bytes: estimateRowBytes(bridgeSnapshot.collaborationLog),
            method: 'est.',
            inSum: true,
            note: `${bridgeSnapshot.collaborationLog.length} messages`
        });
    }

    const assistant = window.aiAssistant;
    if (assistant) {
        const assistantBytes =
            estimateRowBytes(assistant.messages) +
            estimateRowBytes(assistant.conversationMessages);
        rows.push({
            id: 'assistant-conversation',
            label: 'Assistant conversation',
            bytes: assistantBytes,
            method: 'est.',
            inSum: true,
            note: `${assistant.messages.length} visible / ${assistant.conversationMessages.length} model messages`
        });
    }

    const outlineCache =
        window.glyphCanvas?.textRunEditor?.explicitGlyphOutlineCache;
    if (outlineCache) {
        rows.push({
            id: 'explicit-outline-cache',
            label: 'Text-run outline cache',
            bytes: estimateRowBytes(outlineCache),
            method: 'est.',
            inSum: true,
            note: `${outlineCache.size} cached outlines`
        });
    }

    const overviewSnapshot =
        window.glyphOverviewInstance?.getMemoryInspectionSnapshot?.();
    if (overviewSnapshot) {
        const cachedOutlines = overviewSnapshot.cachedOutlines ?? [];
        const outlineSeen = new WeakSet<object>();
        const cachedOutlineBytes = cachedOutlines.reduce(
            (sum: number, value: unknown) =>
                sum + estimateJsValueBytes(value, outlineSeen),
            0
        );
        rows.push({
            id: 'overview-tile-outlines',
            label: 'Glyph overview outline JSON',
            bytes: cachedOutlineBytes,
            method: 'est.',
            inSum: true,
            note: `${cachedOutlines.length} tiles · kept for resize`
        });
    }

    const pythonSnapshot =
        window.pythonExecutionHistoryContext?.beforeFontDataJson;
    rows.push({
        id: 'python-before-snapshot',
        label: 'Python before-snapshot',
        bytes: jsStringHeapBytes(pythonSnapshot),
        method: 'exact',
        inSum: true,
        note: pythonSnapshot ? 'live during script commit' : 'empty'
    });

    if (rows.length === 0) {
        rows.push({
            id: 'main-empty',
            label: 'No open font',
            bytes: 0,
            method: 'exact',
            inSum: false,
            note: 'open a font to measure caches'
        });
    }

    return {
        id: 'main-js',
        label: 'Main JS',
        usedBytes: getMainHeapUsedBytes(),
        usedLabel: 'Used heap',
        rows
    };
}

function mapWorkerStats(stats: {
    workerUsedBytes: number | null;
    cachedBabelfontJsonChars: number;
    rust: {
        linearMemoryBytes: number;
        items: Array<{
            id: string;
            label: string;
            bytes: number;
            method: MemoryMethod;
            inSum: boolean;
            note?: string;
        }>;
    } | null;
    error?: string;
}): MemoryDomain[] {
    const workerJs: MemoryDomain = {
        id: 'worker-js',
        label: 'Worker JS',
        usedBytes: stats.workerUsedBytes,
        usedLabel: 'Used heap',
        rows: [
            {
                id: 'worker-cached-json',
                label: 'cachedBabelfontJson',
                bytes:
                    stats.cachedBabelfontJsonChars > 0
                        ? 24 + stats.cachedBabelfontJsonChars * 2
                        : 0,
                method: 'exact',
                inSum: true,
                note:
                    stats.cachedBabelfontJsonChars === 0
                        ? 'empty on incremental path'
                        : 'legacy full-JSON cache'
            }
        ]
    };

    const rustItems = (stats.rust?.items ?? []).map((item) => ({
        id: item.id,
        label: item.label,
        bytes: item.bytes,
        method: item.method,
        inSum: item.inSum,
        note: item.note
    }));

    const workerWasm: MemoryDomain = {
        id: 'worker-wasm',
        label: 'Worker WASM / Rust',
        usedBytes: stats.rust?.linearMemoryBytes ?? null,
        usedLabel: 'Linear memory',
        rows:
            rustItems.length > 0
                ? rustItems
                : [
                      {
                          id: 'wasm-unavailable',
                          label: 'Rust caches',
                          bytes: 0,
                          method: 'est.',
                          inSum: false,
                          note: stats.error || 'worker WASM not initialized'
                      }
                  ],
        error: stats.error
    };

    return [workerJs, workerWasm];
}

function collectDomRows(): MemoryRow[] {
    const overviewSnapshot =
        window.glyphOverviewInstance?.getMemoryInspectionSnapshot?.();
    if (!overviewSnapshot) {
        return [
            {
                id: 'overview-tiles',
                label: 'Glyph overview tiles',
                bytes: 0,
                method: 'exact',
                inSum: true,
                note: 'no overview'
            }
        ];
    }
    return [
        {
            id: 'overview-tiles',
            label: 'Glyph overview tiles',
            bytes: overviewSnapshot.canvasBytes,
            method: 'exact',
            inSum: true,
            note: `${overviewSnapshot.paintedCount} painted of ${overviewSnapshot.tileCount} · width × height × 4`
        }
    ];
}

function finishBreakdown(
    domains: MemoryDomain[],
    otherRows: MemoryRow[],
    heap: BrowserHeapSnapshot,
    domRows: MemoryRow[] = collectDomRows()
): MemoryBreakdown {
    return {
        domains,
        otherRows,
        domRows,
        accountedBytes: domains.reduce(
            (sum, domain) =>
                isV8Domain(domain) ? sum + domainMeasuredBytes(domain) : sum,
            0
        ),
        browserUsedBytes: heap.usedBytes,
        browserLimitBytes: heap.limitBytes
    };
}

function collectOtherRows(): MemoryRow[] {
    const harfbuzzBytes = getHarfBuzzLinearMemoryBytes();
    return [
        {
            id: 'pyodide',
            label: 'Pyodide linear memory',
            bytes: getPyodideLinearMemoryBytes(),
            method: 'exact',
            inSum: false,
            note: 'not part of Used JS heap'
        },
        {
            id: 'harfbuzz',
            label: 'HarfBuzz linear memory',
            bytes: harfbuzzBytes,
            method: 'exact',
            inSum: false,
            note:
                harfbuzzBytes === 0
                    ? 'not initialized or not exposed'
                    : 'main-thread shaping WASM'
        }
    ];
}

const unavailableWorkerDomains: MemoryDomain[] = [
    {
        id: 'worker-js',
        label: 'Worker JS',
        usedBytes: null,
        usedLabel: 'Used heap',
        rows: [
            {
                id: 'worker-js-unavailable',
                label: 'Worker JS caches',
                bytes: 0,
                method: 'exact',
                inSum: false,
                note: 'compilation worker not ready'
            }
        ]
    },
    {
        id: 'worker-wasm',
        label: 'Worker WASM / Rust',
        usedBytes: null,
        usedLabel: 'Linear memory',
        rows: [
            {
                id: 'worker-wasm-unavailable',
                label: 'Rust caches',
                bytes: 0,
                method: 'est.',
                inSum: false,
                note: 'compilation worker not ready'
            }
        ]
    }
];

let lastWorkerDomains: MemoryDomain[] = unavailableWorkerDomains;
let workerStatsInFlight: Promise<MemoryDomain[]> | null = null;

export function collectLocalMemoryBreakdown(
    heap: BrowserHeapSnapshot = readBrowserHeapSnapshot()
): MemoryBreakdown {
    return finishBreakdown(
        [collectMainJsDomain(), ...lastWorkerDomains],
        collectOtherRows(),
        heap
    );
}

export async function refreshWorkerMemoryDomains(): Promise<MemoryDomain[]> {
    if (workerStatsInFlight) {
        return workerStatsInFlight;
    }
    workerStatsInFlight = (async () => {
        try {
            if (!window.fontCompilation?.getWorkerMemoryStats) {
                lastWorkerDomains = unavailableWorkerDomains;
                return lastWorkerDomains;
            }
            const workerStats =
                await window.fontCompilation.getWorkerMemoryStats();
            lastWorkerDomains = mapWorkerStats(workerStats);
            return lastWorkerDomains;
        } catch (error) {
            console.warn('Failed to read worker memory stats:', error);
            lastWorkerDomains = [
                {
                    id: 'worker-js',
                    label: 'Worker JS',
                    usedBytes: null,
                    usedLabel: 'Used heap',
                    rows: [
                        {
                            id: 'worker-js-error',
                            label: 'Worker JS caches',
                            bytes: 0,
                            method: 'exact',
                            inSum: false,
                            note: String(error)
                        }
                    ],
                    error: String(error)
                },
                {
                    id: 'worker-wasm',
                    label: 'Worker WASM / Rust',
                    usedBytes: null,
                    usedLabel: 'Linear memory',
                    rows: [
                        {
                            id: 'worker-wasm-error',
                            label: 'Rust caches',
                            bytes: 0,
                            method: 'est.',
                            inSum: false,
                            note: String(error)
                        }
                    ],
                    error: String(error)
                }
            ];
            return lastWorkerDomains;
        } finally {
            workerStatsInFlight = null;
        }
    })();
    return workerStatsInFlight;
}

export async function collectMemoryBreakdown(): Promise<MemoryBreakdown> {
    await refreshWorkerMemoryDomains();
    return collectLocalMemoryBreakdown();
}

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function renderSizeCell(bytes: number): string {
    return `<td class="memory-breakdown-num" title="${escapeHtml(
        `${Math.round(bytes)} B`
    )}">${escapeHtml(formatMemoryBytes(bytes))}</td>`;
}

function renderRow(row: MemoryRow): string {
    return `
                <tr>
                    <td>${escapeHtml(row.label)}</td>
                    ${renderSizeCell(row.bytes)}
                    <td>${escapeHtml(row.method)}</td>
                    <td class="memory-breakdown-note">${escapeHtml(
                        row.note || ''
                    )}</td>
                </tr>`;
}

function renderSectionRows(label: string, rows: MemoryRow[]): string {
    if (rows.length === 0) {
        return '';
    }
    return `
                <tr class="memory-breakdown-section">
                    <th colspan="4">${escapeHtml(label)}</th>
                </tr>
                ${rows.map(renderRow).join('')}`;
}

function renderMemoryTable(
    title: string,
    body: string,
    footer: string
): string {
    return `
        <section class="memory-breakdown-block">
            <h4>${escapeHtml(title)}</h4>
            <table class="memory-breakdown-table">
                <thead>
                    <tr>
                        <th>Item</th>
                        <th>Size</th>
                        <th>Method</th>
                        <th>Notes</th>
                    </tr>
                </thead>
                <tbody>${body}</tbody>
                <tfoot>${footer}</tfoot>
            </table>
        </section>`;
}

export function renderMemoryBreakdown(breakdown: MemoryBreakdown): string {
    const measured = breakdownMeasuredBytes(breakdown);
    const usedBytes = breakdownUsedBytes(breakdown);
    const coverage = breakdownCoveragePercent(breakdown);
    const usedText = usedBytes == null ? 'n/a' : formatMemoryBytes(usedBytes);
    const coverageText =
        coverage == null ? 'n/a' : `${Math.min(coverage, 999).toFixed(0)}%`;

    const v8Domains = breakdown.domains.filter(isV8Domain);
    const wasmDomains = breakdown.domains.filter(
        (domain) => !isV8Domain(domain)
    );
    const v8Body = v8Domains
        .map((domain) => renderSectionRows(domain.label, domain.rows))
        .join('');
    const wasmBody = [
        ...wasmDomains.map((domain) =>
            renderSectionRows(domain.label, domain.rows)
        ),
        renderSectionRows('Other (not in Used)', breakdown.otherRows)
    ].join('');
    const domBytes = breakdown.domRows.reduce(
        (sum, row) => (row.inSum ? sum + row.bytes : sum),
        0
    );
    const domBody = renderSectionRows('Overview', breakdown.domRows);

    const v8Footer = `
                <tr>
                    <td>Accounted in table</td>
                    ${renderSizeCell(measured)}
                    <td></td>
                    <td class="memory-breakdown-note">V8 cache rows only</td>
                </tr>
                <tr>
                    <td>Browser used</td>
                    ${
                        usedBytes == null
                            ? `<td class="memory-breakdown-num">${escapeHtml(usedText)}</td>`
                            : renderSizeCell(usedBytes)
                    }
                    <td></td>
                    <td class="memory-breakdown-note">${escapeHtml(
                        usedBytes == null
                            ? 'not available in this browser'
                            : breakdown.browserLimitBytes == null
                              ? 'same as Preferences Used'
                              : `${formatMemoryBytes(usedBytes)} used of ${formatMemoryBytes(breakdown.browserLimitBytes)}`
                    )}</td>
                </tr>
                <tr>
                    <td>Table / browser used</td>
                    <td class="memory-breakdown-num">${escapeHtml(coverageText)}</td>
                    <td></td>
                    <td class="memory-breakdown-note">Worker JS is a separate V8 isolate</td>
                </tr>`;

    const wasmFooter = `
                <tr>
                    <td>WASM / other</td>
                    ${renderSizeCell(
                        wasmDomains.reduce(
                            (sum, domain) => sum + domainMeasuredBytes(domain),
                            0
                        ) +
                            breakdown.otherRows.reduce(
                                (sum, row) => sum + row.bytes,
                                0
                            )
                    )}
                    <td></td>
                    <td class="memory-breakdown-note">not part of the V8 heap</td>
                </tr>`;

    const domFooter = `
                <tr>
                    <td>DOM / renderer</td>
                    ${renderSizeCell(domBytes)}
                    <td></td>
                    <td class="memory-breakdown-note">canvas backing stores, not V8</td>
                </tr>`;

    return [
        renderMemoryTable('V8 heap', v8Body, v8Footer),
        renderMemoryTable('WASM', wasmBody, wasmFooter),
        renderMemoryTable('DOM', domBody, domFooter)
    ].join('');
}
