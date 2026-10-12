import type { CollaborationLogItem } from './patch-sync-engine';
import {
    deriveOriginatingLayerFromPaths,
    formatHistoryOriginLabel,
    getUndoReachabilityForContext
} from './change-log';
import { getUndoRedoContext } from './undo-redo-context';
import { Logger } from './logger';
import tippy, { type Instance as TippyInstance } from 'tippy.js';
import { getTheme } from './tippy-utils';
import {
    isHistoryUnreachableEnabled,
    setHistoryUnreachableEnabled
} from './window-ui-state';

const console = new Logger('HistoryView');

type HistoryScope =
    'layer' | 'glyph' | 'font' | 'feature' | 'overview' | 'automation';

type FeatureHistoryContext = {
    type: 'feature' | 'class' | 'prefix';
    key: string;
    label: string;
};

type GlyphSelectedListener = (
    index: number,
    previousIndex: number,
    fromKeyboard?: boolean
) => void;

type TextRunSelectionEmitter = {
    on(eventName: 'glyphselected', listener: GlyphSelectedListener): void;
};

type HistoryUndoContext = {
    scope: HistoryScope;
    glyphName: string | null;
    layerId: string | null;
    historyTargetKey: string | null;
};

type HistoryDisplayItem = CollaborationLogItem & {
    historyItemIds: string[];
};

type HistoryListNode =
    | { kind: 'item'; item: HistoryDisplayItem; reachable: boolean }
    | { kind: 'hidden-run'; count: number; firstHiddenIndex: number };

class HistoryViewController {
    private initialized = false;
    private rootEl: HTMLElement | null = null;
    private listEl: HTMLElement | null = null;
    private showUnreachableToggle: HTMLButtonElement | null = null;
    private currentGlyphName: string | null = null;
    private currentLayerId: string | null = null;
    private currentFeatureContext: FeatureHistoryContext | null = null;
    private unsubscribeBridge: (() => void) | null = null;
    private attachedTextRunEditor: TextRunSelectionEmitter | null = null;
    private metadataTooltips: TippyInstance[] = [];
    private pendingRenderHandle: number | null = null;
    private collaborationItems: CollaborationLogItem[] = [];
    private showUnreachable = false;
    private revealHiddenRunIndex: number | null = null;

    constructor() {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => this.init(), {
                once: true
            });
            return;
        }
        this.init();
    }

    private init(): void {
        if (this.initialized) {
            return;
        }

        const rootEl = document.getElementById('history-view-content');
        if (!rootEl) {
            console.warn('History view container not found');
            return;
        }

        this.initialized = true;
        this.rootEl = rootEl;
        this.showUnreachable = this.readShowUnreachablePref();
        window.getHistoryUndoContext = () => this.getUndoContext();
        this.bindTitleBarToggle();
        this.renderShell();
        this.bindWindowEvents();
        this.connectToBridge();
        this.attachTextRunListener();
        this.syncEditingContext();
        this.render();
    }

    private readShowUnreachablePref(): boolean {
        return isHistoryUnreachableEnabled();
    }

    private writeShowUnreachablePref(value: boolean): void {
        setHistoryUnreachableEnabled(value);
    }

    private bindTitleBarToggle(): void {
        const toggle = document.getElementById(
            'history-show-unreachable-toggle'
        ) as HTMLButtonElement | null;
        this.showUnreachableToggle = toggle;
        if (!toggle) {
            return;
        }
        this.syncToggleButton();
        toggle.addEventListener('click', () => {
            this.setShowUnreachable(!this.showUnreachable);
        });
    }

    private setShowUnreachable(value: boolean): void {
        this.showUnreachable = value;
        this.writeShowUnreachablePref(value);
        this.syncToggleButton();
        // Toggle must refresh immediately (tests + UX); cancel any pending rAF.
        if (this.pendingRenderHandle !== null) {
            cancelAnimationFrame(this.pendingRenderHandle);
            this.pendingRenderHandle = null;
        }
        this.render();
    }

    private syncToggleButton(): void {
        const toggle = this.showUnreachableToggle;
        if (!toggle) {
            return;
        }
        const icon = toggle.querySelector('.material-symbols-outlined');
        if (icon) {
            icon.textContent = this.showUnreachable
                ? 'visibility'
                : 'visibility_off';
        }
        toggle.classList.toggle('active', this.showUnreachable);
        const label = this.showUnreachable
            ? 'Hide edits outside this undo surface'
            : 'Show edits outside this undo surface';
        toggle.title = label;
        toggle.setAttribute('aria-label', label);
        toggle.setAttribute(
            'aria-pressed',
            this.showUnreachable ? 'true' : 'false'
        );
    }

    private renderShell(): void {
        if (!this.rootEl) {
            return;
        }

        this.rootEl.innerHTML = `
            <div class="history-panel history-panel-flat">
                <div class="history-change-list" data-role="history-list"></div>
            </div>
        `;

        this.listEl = this.rootEl.querySelector('[data-role="history-list"]');
    }

    private bindWindowEvents(): void {
        window.addEventListener('fontModelReady', () => {
            this.connectToBridge();
            this.attachTextRunListener();
            this.syncEditingContext();
        });

        window.addEventListener('glyphStackChanged', () => {
            this.syncEditingContext();
        });

        window.addEventListener('glyphChanged', () => {
            this.syncEditingContext();
        });

        window.addEventListener('editorModeChanged', () => {
            this.syncEditingContext();
        });

        window.addEventListener('featureHistoryContextChanged', () => {
            this.syncEditingContext();
        });

        window.addEventListener('viewFocused', () => {
            this.syncEditingContext();
        });
    }

    private connectToBridge(): void {
        const bridge = window.patchSyncEngine;
        this.unsubscribeBridge?.();
        this.unsubscribeBridge = null;

        if (!bridge) {
            this.collaborationItems = [];
            this.render();
            return;
        }

        this.unsubscribeBridge = bridge.onCollaborationLogUpdate((items) => {
            this.collaborationItems = items;
            this.scheduleRender();
        });
    }

    private scheduleRender(): void {
        if (this.pendingRenderHandle !== null) {
            return;
        }
        this.pendingRenderHandle = requestAnimationFrame(() => {
            this.pendingRenderHandle = null;
            this.render();
        });
    }

    private attachTextRunListener(): void {
        const textRunEditor = window.glyphCanvas
            ?.textRunEditor as TextRunSelectionEmitter | null;
        if (!textRunEditor || this.attachedTextRunEditor === textRunEditor) {
            return;
        }

        this.attachedTextRunEditor = textRunEditor;
        textRunEditor.on('glyphselected', () => {
            this.syncEditingContext();
        });
    }

    private syncEditingContext(): void {
        this.currentFeatureContext = this.resolveFeatureHistoryContext();
        this.currentGlyphName = this.resolveCurrentGlyphName();
        this.currentLayerId = this.resolveCurrentLayerId();
        this.scheduleRender();
    }

    private resolveFeatureHistoryContext(): FeatureHistoryContext | null {
        const target = window.fontInfoManager?.getHistoryScopeTarget?.();
        if (!target) {
            return null;
        }

        return {
            type: target.type,
            key: target.key,
            label: target.label
        };
    }

    private resolveCurrentGlyphName(): string | null {
        const outlineEditor = window.glyphCanvas?.outlineEditor;
        if (outlineEditor?.active) {
            const parsedStack = outlineEditor.parseGlyphStack();
            const glyphName =
                parsedStack[parsedStack.length - 1]?.glyphName ??
                outlineEditor.currentGlyphName;
            if (glyphName && glyphName !== 'undefined') {
                return glyphName;
            }
        }

        const glyphName = window.glyphCanvas?.getCurrentGlyphName?.();
        if (glyphName && glyphName !== 'undefined') {
            return glyphName;
        }

        return null;
    }

    private resolveCurrentLayerId(): string | null {
        const outlineEditor = window.glyphCanvas?.outlineEditor;
        if (!outlineEditor?.active) {
            return null;
        }
        return outlineEditor.selectedLayerId ?? null;
    }

    private render(): void {
        if (!this.initialized || !this.listEl) {
            return;
        }

        this.destroyMetadataTooltips();

        if (!window.patchSyncEngine) {
            this.listEl.innerHTML =
                '<div class="history-empty-state">Waiting for font data...</div>';
            return;
        }

        if (!this.collaborationItems.length) {
            this.listEl.innerHTML =
                '<div class="history-empty-state">No collaboration messages yet</div>';
            return;
        }

        const groupedItems = new Map<string, HistoryDisplayItem>();
        for (const item of this.collaborationItems) {
            const groupKey =
                item.promptGroupId || item.historyItemId || item.id;
            const existing = groupedItems.get(groupKey);
            if (!existing) {
                groupedItems.set(groupKey, {
                    ...item,
                    historyItemIds: [item.historyItemId],
                    groupedMessageCount: 1
                });
                continue;
            }

            groupedItems.set(groupKey, {
                ...item,
                historyItemIds: [
                    ...new Set([...existing.historyItemIds, item.historyItemId])
                ],
                changedGlyphNames: [
                    ...new Set([
                        ...existing.changedGlyphNames,
                        ...item.changedGlyphNames
                    ])
                ],
                changedLayerIds: [
                    ...new Set([
                        ...existing.changedLayerIds,
                        ...item.changedLayerIds
                    ])
                ],
                changes: [...existing.changes, ...item.changes],
                derivedForwardChanges: [
                    ...existing.derivedForwardChanges,
                    ...item.derivedForwardChanges
                ],
                groupedMessageCount: (existing.groupedMessageCount ?? 1) + 1
            });
        }

        const displayItems = [...groupedItems.values()].sort(
            (left, right) => left.timestamp - right.timestamp
        );
        const undoContext = getUndoRedoContext();
        const changeLog = window.patchSyncEngine.getChangeLog?.() ?? [];
        const { reachableHistoryItemIds } = getUndoReachabilityForContext(
            changeLog,
            {
                glyphName: undoContext.undoGlyphName,
                layerId: undoContext.undoLayerId,
                historyTargetKey: undoContext.historyTargetKey,
                surface: undoContext.surface
            }
        );

        const newestFirst = [...displayItems].reverse();
        const listNodes = this.buildListNodes(
            newestFirst,
            reachableHistoryItemIds
        );
        const fragment = document.createDocumentFragment();
        let revealElement: HTMLElement | null = null;

        for (const node of listNodes) {
            if (node.kind === 'hidden-run') {
                const marker = this.createHiddenRunMarker(
                    node.count,
                    node.firstHiddenIndex
                );
                fragment.appendChild(marker);
                continue;
            }

            const row = this.createHistoryRow(node.item, node.reachable);
            if (
                this.revealHiddenRunIndex !== null &&
                !node.reachable &&
                newestFirst.indexOf(node.item) === this.revealHiddenRunIndex
            ) {
                revealElement = row;
            }
            fragment.appendChild(row);
        }

        this.listEl.innerHTML = '';
        this.listEl.appendChild(fragment);

        if (revealElement) {
            revealElement.scrollIntoView?.({ block: 'nearest' });
            this.revealHiddenRunIndex = null;
        }
    }

    private buildListNodes(
        newestFirst: HistoryDisplayItem[],
        reachableHistoryItemIds: Set<string>
    ): HistoryListNode[] {
        const nodes: HistoryListNode[] = [];
        let hiddenRun = 0;
        let hiddenRunStart = -1;

        const flushHidden = () => {
            if (hiddenRun <= 0) {
                return;
            }
            nodes.push({
                kind: 'hidden-run',
                count: hiddenRun,
                firstHiddenIndex: hiddenRunStart
            });
            hiddenRun = 0;
            hiddenRunStart = -1;
        };

        for (let index = 0; index < newestFirst.length; index++) {
            const item = newestFirst[index];
            const reachable = this.isHistoryItemInUndoRedoStack(
                item,
                reachableHistoryItemIds
            );
            if (reachable || this.showUnreachable) {
                flushHidden();
                nodes.push({ kind: 'item', item, reachable });
                continue;
            }
            if (hiddenRun === 0) {
                hiddenRunStart = index;
            }
            hiddenRun += 1;
        }
        flushHidden();
        return nodes;
    }

    /**
     * Bright = on this surface’s undo/redo stack (active or undone).
     * Undo/redo collaboration rows key off targetHistoryItemId.
     */
    private isHistoryItemInUndoRedoStack(
        item: HistoryDisplayItem,
        reachableHistoryItemIds: Set<string>
    ): boolean {
        if (
            item.historyItemIds.some((historyItemId) =>
                reachableHistoryItemIds.has(historyItemId)
            )
        ) {
            return true;
        }
        if (
            item.targetHistoryItemId &&
            reachableHistoryItemIds.has(item.targetHistoryItemId)
        ) {
            return true;
        }
        return false;
    }

    private createHiddenRunMarker(
        count: number,
        firstHiddenIndex: number
    ): HTMLButtonElement {
        const marker = document.createElement('button');
        marker.type = 'button';
        marker.className = 'history-hidden-run';
        const label =
            count === 1
                ? '1 hidden · other undo surface'
                : `${count} hidden · other undo surface`;
        marker.innerHTML = `<span class="history-hidden-run-dots">· · ·</span><span class="history-hidden-run-label">${this.escapeHtml(label)}</span>`;
        marker.title = 'Show edits outside this undo surface';
        marker.addEventListener('click', () => {
            this.revealHiddenRunIndex = firstHiddenIndex;
            this.setShowUnreachable(true);
        });
        return marker;
    }

    private createHistoryRow(
        item: HistoryDisplayItem,
        isReachable: boolean
    ): HTMLElement {
        const row = document.createElement('div');
        row.className = [
            'history-entry',
            'history-entry-flat',
            isReachable ? '' : 'history-entry-cmdz-unreachable'
        ]
            .filter(Boolean)
            .join(' ');
        if (!isReachable) {
            row.title =
                'Outside this undo surface — switch to its origin undo surface to undo or redo';
        }

        const actionChip = this.buildActionChip(item.historyAction);
        const originLabel = this.buildOriginLabel(item);
        const cascadeCount = this.countDownstreamRecompositions(item);
        const isDev = window.isDevelopment?.() ?? false;

        row.innerHTML = `
            <div class="history-entry-main">
                <div class="history-entry-title-row">
                    <div class="history-entry-summary">${this.escapeHtml(item.summary)}</div>
                    <div class="history-entry-trailing">
                        ${
                            cascadeCount > 0
                                ? `<span class="history-cascade-icon material-symbols-outlined" title="Also updated ${cascadeCount} dependent layer${cascadeCount === 1 ? '' : 's'}" aria-label="Also updated ${cascadeCount} dependent layers">account_tree</span>`
                                : ''
                        }
                        <button
                            type="button"
                            class="history-info-button material-symbols-outlined"
                            data-role="history-info-button"
                            aria-label="Show message details"
                        >info</button>
                    </div>
                </div>
                <div class="history-entry-meta-row">
                    ${actionChip}
                    <span class="history-origin-label">${this.escapeHtml(originLabel)}</span>
                </div>
                ${
                    isDev
                        ? `<div class="history-entry-devmeta">${this.escapeHtml(this.buildDevMeta(item))}</div>`
                        : ''
                }
            </div>
        `;

        const infoButton = row.querySelector(
            '[data-role="history-info-button"]'
        ) as HTMLButtonElement | null;
        if (infoButton) {
            this.attachMetadataTooltip(infoButton, item);
        }

        return row;
    }

    private buildActionChip(
        action: CollaborationLogItem['historyAction']
    ): string {
        if (action === 'undo') {
            return '<span class="history-action-chip history-action-undo">undo</span>';
        }
        if (action === 'redo') {
            return '<span class="history-action-chip history-action-redo">redo</span>';
        }
        return '<span class="history-action-chip history-action-edit">edit</span>';
    }

    private buildOriginLabel(item: HistoryDisplayItem): string {
        return formatHistoryOriginLabel({
            undoScope: item.undoScope,
            undoSurfaceAffinity: item.undoSurfaceAffinity,
            historyTargetKey: item.historyTargetKey,
            historyTargetLabel: item.historyTargetLabel,
            originatingGlyphName: item.originatingGlyphName,
            originatingLayerId: item.originatingLayerId,
            changePaths: item.changes.map((change) => change.path),
            resolveLayerMasterDisplayName: (glyphName, layerOrMasterId) =>
                this.resolveLayerMasterDisplayName(glyphName, layerOrMasterId)
        });
    }

    /**
     * Prefer the Master display name for a layer id (or master id).
     * Falls back to the layer's own name, then the raw id.
     */
    private resolveLayerMasterDisplayName(
        glyphName: string,
        layerOrMasterId: string
    ): string {
        const fontModel =
            window.currentFontModel ??
            window.fontManager?.currentFont?.fontModel ??
            null;
        if (!fontModel) {
            return layerOrMasterId;
        }

        const masters = Array.isArray(fontModel.masters)
            ? fontModel.masters
            : [];
        const masterById = (id: string) =>
            (typeof fontModel.findMaster === 'function'
                ? fontModel.findMaster(id)
                : null) ??
            masters.find((master: { id?: string }) => master?.id === id) ??
            null;

        const formatMasterName = (name: unknown): string | null => {
            if (typeof name === 'string' && name.trim()) {
                return name.trim();
            }
            if (name && typeof name === 'object') {
                const dict = name as Record<string, string>;
                const value = dict.dflt ?? dict.en ?? Object.values(dict)[0];
                if (typeof value === 'string' && value.trim()) {
                    return value.trim();
                }
            }
            return null;
        };

        const directMaster = masterById(layerOrMasterId);
        if (directMaster) {
            return formatMasterName(directMaster.name) || layerOrMasterId;
        }

        const glyph =
            typeof fontModel.getGlyph === 'function'
                ? fontModel.getGlyph(glyphName)
                : fontModel.glyphs?.find?.(
                      (candidate: { name?: string }) =>
                          candidate?.name === glyphName
                  );
        const layer = glyph?.layers?.find?.(
            (candidate: { id?: string }) => candidate?.id === layerOrMasterId
        );
        if (!layer) {
            return layerOrMasterId;
        }

        const masterRef =
            layer.master && typeof layer.master === 'object'
                ? (layer.master as { master?: string; type?: string })
                : null;
        const masterId =
            typeof masterRef?.master === 'string' ? masterRef.master : null;
        if (masterId) {
            const master = masterById(masterId);
            const masterName = master ? formatMasterName(master.name) : null;
            if (masterName) {
                return masterName;
            }
        }

        if (typeof layer.name === 'string' && layer.name.trim()) {
            return layer.name.trim();
        }

        return layerOrMasterId;
    }

    private countDownstreamRecompositions(item: HistoryDisplayItem): number {
        // Cascade markers are for layer-origin edits that also refreshed
        // dependents. Font/glyph structural packets often list every touched
        // layer as a replay target without being a cascade from one origin.
        if (item.undoScope !== 'layer') {
            return 0;
        }

        const originGlyph =
            item.originatingGlyphName ??
            deriveOriginatingLayerFromPaths(
                item.changes.map((change) => change.path)
            ).glyphName;
        const originLayer =
            item.originatingLayerId ??
            deriveOriginatingLayerFromPaths(
                item.changes.map((change) => change.path)
            ).layerId;

        const targets = item.workerReplayTargets ?? [];
        if (!originGlyph || !originLayer) {
            return targets.length > 1 ? targets.length - 1 : 0;
        }

        return targets.filter(
            (target) =>
                !(
                    target.glyphName === originGlyph &&
                    target.layerId === originLayer
                )
        ).length;
    }

    private buildDevMeta(item: CollaborationLogItem): string {
        return [
            this.formatTime(item.timestamp),
            this.formatDuration(item.transactionDurationMs),
            `${item.updateByteLength} B`
        ]
            .filter((part): part is string => !!part)
            .join(' · ');
    }

    private getUndoContext(): HistoryUndoContext {
        // Mirror the focused undo surface (sticky main view across History).
        const context = getUndoRedoContext();
        switch (context.surface) {
            case 'feature':
                return {
                    scope: 'feature',
                    glyphName: null,
                    layerId: null,
                    historyTargetKey: context.historyTargetKey
                };
            case 'overview':
                return {
                    scope: 'overview',
                    glyphName: null,
                    layerId: null,
                    historyTargetKey: null
                };
            case 'font':
                return {
                    scope: 'font',
                    glyphName: null,
                    layerId: null,
                    historyTargetKey: null
                };
            case 'automation':
                return {
                    scope: 'automation',
                    glyphName: null,
                    layerId: null,
                    historyTargetKey: null
                };
            case 'canvas':
            default:
                return {
                    scope: 'layer',
                    glyphName: context.undoGlyphName ?? null,
                    layerId: context.undoLayerId,
                    historyTargetKey: null
                };
        }
    }

    private formatTime(timestamp: number): string {
        const date = new Date(timestamp);
        return date.toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        });
    }

    private formatDuration(
        durationMs: number | null | undefined
    ): string | null {
        if (durationMs == null || Number.isNaN(durationMs)) {
            return null;
        }

        const measuredDurationMs: number = durationMs;

        if (measuredDurationMs >= 1000) {
            return `${(measuredDurationMs / 1000).toFixed(2)} s`;
        }

        return `${measuredDurationMs.toFixed(1)} ms`;
    }

    private destroyMetadataTooltips(): void {
        for (const tooltip of this.metadataTooltips) {
            tooltip.destroy();
        }
        this.metadataTooltips = [];
    }

    private attachMetadataTooltip(
        button: HTMLButtonElement,
        item: CollaborationLogItem
    ): void {
        const tooltip = tippy(button, {
            content: this.buildMetadataTooltip(item),
            allowHTML: true,
            interactive: true,
            trigger: 'click',
            appendTo: () => document.body,
            maxWidth: 520,
            placement: 'left-start',
            theme: getTheme()
        });
        this.metadataTooltips.push(tooltip);
    }

    private buildMetadataTooltip(item: CollaborationLogItem): string {
        const summaryRows = [
            this.buildMetadataRow('Summary', item.summary),
            this.buildMetadataRow('Label', item.label),
            this.buildMetadataRow('Direction', item.direction),
            this.buildMetadataRow('Source', item.source),
            this.buildMetadataRow('Edit source', item.editSource),
            this.buildMetadataRow(
                'Timestamp',
                this.formatTimestamp(item.timestamp)
            ),
            this.buildMetadataRow(
                'Transaction duration',
                this.formatDuration(item.transactionDurationMs)
            ),
            this.buildMetadataRow('Window', item.windowRoleLabel),
            this.buildMetadataRow('History action', item.historyAction),
            this.buildMetadataRow('Undo scope', item.undoScope),
            this.buildMetadataRow(
                'Undo surface affinity',
                item.undoSurfaceAffinity
            ),
            this.buildMetadataRow(
                'Originating layer',
                item.originatingGlyphName && item.originatingLayerId
                    ? `${item.originatingGlyphName} / ${item.originatingLayerId}`
                    : null
            ),
            this.buildMetadataRow('History item', item.historyItemId),
            this.buildMetadataRow(
                'Prompt calls',
                item.groupedMessageCount && item.groupedMessageCount > 1
                    ? String(item.groupedMessageCount)
                    : null
            ),
            this.buildMetadataRow('Target item', item.targetHistoryItemId),
            this.buildMetadataRow(
                'Changed glyphs',
                this.formatList(item.changedGlyphNames)
            ),
            this.buildMetadataRow(
                'Changed layers',
                this.formatList(item.changedLayerIds)
            ),
            this.buildMetadataRow(
                'Replay targets',
                this.formatReplayTargets(item)
            ),
            this.buildMetadataRow('Yjs bytes', String(item.updateByteLength)),
            this.buildMetadataRow(
                'Yjs preview',
                item.updateBase64Preview || '—'
            )
        ].join('');

        const changeRows = item.derivedForwardChanges
            .map(
                (change, index) => `
                    <section class="history-metadata-section">
                        <h4 class="history-metadata-section-title">Forward change ${index + 1}</h4>
                        <dl class="history-metadata-grid">
                            ${this.buildMetadataRow('Path', change.path)}
                            ${this.buildMetadataRow('Operation', change.op)}
                            ${this.buildMetadataRow('Object type', change.objectType)}
                            ${this.buildMetadataRow('Old value', this.formatFullValue(change.oldValue))}
                            ${this.buildMetadataRow('New value', this.formatFullValue(change.newValue))}
                        </dl>
                    </section>
                `
            )
            .join('');

        const messageRows = item.changes
            .map(
                (change, index) => `
                    <section class="history-metadata-section">
                        <h4 class="history-metadata-section-title">Message path ${index + 1}</h4>
                        <dl class="history-metadata-grid">
                            ${this.buildMetadataRow('Path', change.path)}
                            ${this.buildMetadataRow('Operation', change.op)}
                            ${this.buildMetadataRow(
                                'Replay targets',
                                this.formatReplayTargetList(
                                    change.workerReplayTargets
                                )
                            )}
                        </dl>
                    </section>
                `
            )
            .join('');

        return `
            <div class="history-metadata-tooltip">
                <section class="history-metadata-section">
                    <h4 class="history-metadata-section-title">Message</h4>
                    <dl class="history-metadata-grid">${summaryRows}</dl>
                </section>
                ${messageRows}
                ${changeRows}
            </div>
        `;
    }

    private buildMetadataRow(label: string, value: string | null): string {
        return `
            <div class="history-metadata-row">
                <dt>${this.escapeHtml(label)}</dt>
                <dd>${this.escapeHtml(value ?? '—')}</dd>
            </div>
        `;
    }

    private formatList(values: string[]): string {
        return values.length ? values.join(', ') : '—';
    }

    private formatReplayTargets(item: CollaborationLogItem): string {
        return this.formatReplayTargetList(item.workerReplayTargets);
    }

    private formatReplayTargetList(
        targets: Array<{ glyphName: string; layerId: string }> | undefined
    ): string {
        if (!targets?.length) {
            return '—';
        }

        return targets
            .map((target) => `${target.glyphName}/${target.layerId}`)
            .join(', ');
    }

    private formatFullValue(value: unknown): string {
        if (value === undefined) {
            return '—';
        }
        if (typeof value === 'string') {
            return value;
        }
        const json = JSON.stringify(value, null, 2);
        return json ?? String(value);
    }

    private formatTimestamp(timestamp: number): string {
        return new Date(timestamp).toLocaleString([], {
            year: 'numeric',
            month: 'short',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        });
    }

    private escapeHtml(value: string): string {
        return value
            .replaceAll('&', '&amp;')
            .replaceAll('<', '&lt;')
            .replaceAll('>', '&gt;')
            .replaceAll('"', '&quot;')
            .replaceAll("'", '&#39;');
    }
}

new HistoryViewController();
