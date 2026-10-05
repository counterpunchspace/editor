import { Logger } from '../logger';
import { joinPathWithGlyphSeparator } from '../change-log';
import {
    deriveGlyphFilterChangesFromCommittedEntry,
    dedupeGlyphFilterChanges,
    type GlyphFilterCommittedEntry,
    type GlyphFilterLifecycleChange
} from '../glyph-filter-change-derivation';
import {
    GLYPH_FILTER_EVENT_TYPES,
    type GlyphFilterChange
} from '../glyph-filter-events';
import type { TransactionBufferedOperation } from '../patch-sync-engine';
import { withSuppressedModelRecording } from '../babelfont-model';
import {
    applyGeneratorBlocks,
    generatorStamp,
    type FeaturesDocument,
    type GeneratedBlock
} from './managed-features';
import { designerLanguageSystems } from './arabic-forms';
import { runHostPython, runHostPythonAsync } from './host-python';

const console = new Logger('FeatureGenerators');

const SKIP_LABELS = /^(Load font|Open font|Import font|Reload source)\b/;

export interface FeatureGeneratorInfo {
    generatorId: string;
    version: string;
    capability: string;
    eventTypes: string[];
    intentKeys: string[];
    entryPoint: string;
    regenerates: Record<string, boolean>;
    followsFeatures?: boolean;
    followRank?: number;
}

export interface FeatureBatch {
    changes: GlyphFilterChange[];
    lifecycle: GlyphFilterLifecycleChange[];
    intents: Record<string, unknown>;
    trigger: string;
    settingPluginId?: string;
    featureListChanged?: boolean;
}

interface DiagnosticEntry {
    trigger: string;
    ran: string[];
    skipped: string[];
    error?: string;
    durationMs: number;
}

const ENSURE_FEATURE_GENERATORS = `
import builtins
if not hasattr(builtins, "_cp_feature_generators"):
    from importlib.metadata import entry_points
    builtins._cp_feature_generators = {}
    for entry in entry_points(group="counterpunch_feature_plugins"):
        plugin = entry.load()()
        builtins._cp_feature_generators[plugin.generator_id] = plugin
`;

export function operationsToBatch(
    operations: readonly TransactionBufferedOperation[],
    intents: Record<string, unknown>
): FeatureBatch {
    const changes: GlyphFilterChange[] = [];
    const lifecycle: GlyphFilterLifecycleChange[] = [];
    for (const operation of operations) {
        const derived = deriveGlyphFilterChangesFromCommittedEntry({
            path: joinPathWithGlyphSeparator(operation.path),
            op: operation.op,
            oldValue: operation.oldValue,
            newValue: operation.newValue
        } satisfies GlyphFilterCommittedEntry);
        changes.push(...derived.changes);
        lifecycle.push(...derived.lifecycleChanges);
    }
    return {
        changes: dedupeGlyphFilterChanges(changes),
        lifecycle,
        intents,
        trigger: Object.keys(intents).length ? 'intent' : 'event',
        featureListChanged: featureTagsChanged(operations)
    };
}

function featureTags(value: unknown): string {
    const list = Array.isArray(value)
        ? value
        : (value as { features?: unknown } | null)?.features;
    if (!Array.isArray(list)) {
        return '';
    }
    return list
        .map((entry) => (Array.isArray(entry) ? String(entry[0] ?? '') : ''))
        .join('\0');
}

/** True when a commit adds, removes, or retags a feature block. */
export function featureTagsChanged(
    operations: readonly TransactionBufferedOperation[]
): boolean {
    for (const operation of operations) {
        if (operation.path[0] !== 'features') {
            continue;
        }
        if (operation.path.length === 1) {
            if (
                featureTags(operation.oldValue) !==
                featureTags(operation.newValue)
            ) {
                return true;
            }
            continue;
        }
        if (operation.path[1] !== 'features') {
            continue;
        }
        if (operation.path.length === 2) {
            if (
                featureTags(operation.oldValue) !==
                featureTags(operation.newValue)
            ) {
                return true;
            }
            continue;
        }
        if (operation.op === 'add' || operation.op === 'remove') {
            return true;
        }
        if (operation.path.length === 3 && operation.op === 'set') {
            const oldTag = Array.isArray(operation.oldValue)
                ? operation.oldValue[0]
                : undefined;
            const newTag = Array.isArray(operation.newValue)
                ? operation.newValue[0]
                : undefined;
            if (
                oldTag !== newTag ||
                operation.oldValue == null ||
                operation.newValue == null
            ) {
                return true;
            }
        }
    }
    return false;
}

export function generatorMatches(
    generator: FeatureGeneratorInfo,
    batch: FeatureBatch
): boolean {
    if (generator.followsFeatures && batch.featureListChanged) {
        return true;
    }
    if (batch.lifecycle.length) {
        return true;
    }
    if (generator.intentKeys.some((key) => batch.intents[key] != null)) {
        return true;
    }
    if (
        batch.trigger === 'setting' &&
        batch.settingPluginId === generator.generatorId &&
        Object.values(generator.regenerates).some(Boolean)
    ) {
        return true;
    }
    return batch.changes.some((change) =>
        generator.eventTypes.includes(change.type)
    );
}

class FeatureGeneratorEngine {
    private generators: FeatureGeneratorInfo[] = [];
    private ready: Promise<void> | null = null;
    private pending: FeatureBatch[] = [];
    readonly diagnostics: { entries: DiagnosticEntry[] } = { entries: [] };

    ensureReady(): Promise<void> {
        if (!this.ready) {
            this.ready = this.load().catch((error) => {
                this.ready = null;
                throw error;
            });
        }
        return this.ready;
    }

    getGenerators(): readonly FeatureGeneratorInfo[] {
        return this.generators;
    }

    buildDerivedOperations(
        operations: readonly TransactionBufferedOperation[],
        context: { label: string | null; intents?: Record<string, unknown> }
    ): TransactionBufferedOperation[] {
        if (context.label && SKIP_LABELS.test(context.label)) {
            return [];
        }
        const batch = operationsToBatch(operations, context.intents || {});
        this.noteSettingTrigger(operations, batch);
        if (!window.pyodide || !this.generators.length) {
            if (batch.lifecycle.length || Object.keys(batch.intents).length) {
                this.pending.push(batch);
            }
            return [];
        }
        return this.runGenerators(batch);
    }

    regenerate(generatorId: string): void {
        const bridge = window.patchSyncEngine;
        const font = window.currentFontModel;
        if (!bridge || !font) {
            return;
        }
        bridge.beginTransaction('Regenerate feature', null, {
            compileChangeSource: 'feature-code',
            compileEditType: null
        });
        try {
            const batch: FeatureBatch = {
                changes: [],
                lifecycle: [{ kind: 'created', glyphName: '*' }],
                intents: {},
                trigger: 'manual'
            };
            const operations = this.runGenerators(batch, generatorId);
            if (operations[0]) {
                font.features = operations[0].newValue as typeof font.features;
            }
        } finally {
            bridge.endTransaction();
        }
    }

    async flushPending(): Promise<void> {
        if (
            !this.pending.length ||
            !window.currentFontModel ||
            !window.patchSyncEngine
        ) {
            return;
        }
        const batches = this.pending.splice(0);
        const bridge = window.patchSyncEngine;
        bridge.beginTransaction('Update generated features', null, {
            compileChangeSource: 'feature-code',
            compileEditType: null
        });
        try {
            for (const batch of batches) {
                const operations = this.runGenerators(batch);
                if (operations[0]) {
                    window.currentFontModel.features = operations[0]
                        .newValue as typeof window.currentFontModel.features;
                }
            }
        } finally {
            bridge.endTransaction();
        }
    }

    private runGenerators(
        batch: FeatureBatch,
        onlyGeneratorId?: string
    ): TransactionBufferedOperation[] {
        const started = performance.now();
        const font = window.currentFontModel;
        if (!font) {
            return [];
        }
        const ran: string[] = [];
        const skipped: string[] = [];
        const sourceFeatures = font.features || {
            classes: {},
            prefixes: {},
            features: []
        };
        let features = JSON.parse(
            JSON.stringify(sourceFeatures)
        ) as FeaturesDocument;
        let changed = false;
        const ordered = [...this.generators].sort(
            (left, right) =>
                Number(Boolean(left.followsFeatures)) -
                    Number(Boolean(right.followsFeatures)) ||
                (left.followRank || 0) - (right.followRank || 0)
        );
        const primaryWillRun = ordered.some(
            (generator) =>
                !generator.followsFeatures &&
                (!onlyGeneratorId ||
                    generator.generatorId === onlyGeneratorId) &&
                generatorMatches(generator, batch)
        );
        for (const generator of ordered) {
            if (onlyGeneratorId && generator.generatorId !== onlyGeneratorId) {
                continue;
            }
            const selected =
                generatorMatches(generator, batch) ||
                (generator.followsFeatures && primaryWillRun);
            if (!selected) {
                skipped.push(generator.generatorId);
                continue;
            }
            try {
                const outcome = this.callGenerator(generator, batch, features);
                if (!outcome || outcome.needsRebuild === false) {
                    skipped.push(generator.generatorId);
                    continue;
                }
                const next = applyGeneratorBlocks(
                    features,
                    generator.generatorId,
                    generator.version,
                    generator.capability,
                    outcome.blocks
                );
                ran.push(generator.generatorId);
                if (outcome.diagnostics.length) {
                    console.warn(
                        `${generator.generatorId} reported ${outcome.diagnostics.length} diagnostic${outcome.diagnostics.length === 1 ? '' : 's'}`,
                        outcome.diagnostics.slice(0, 3).join(' ')
                    );
                }
                if (next) {
                    features = next;
                    changed = true;
                }
            } catch (error) {
                const message =
                    error instanceof Error ? error.message : String(error);
                console.warn(
                    `Feature generator ${generator.generatorId} failed`,
                    message
                );
                this.record(batch.trigger, ran, skipped, message, started);
                return [];
            }
        }
        this.record(batch.trigger, ran, skipped, undefined, started);
        if (!changed) {
            return [];
        }
        const oldValue = font.features;
        // The returned operation updates the sync document. The Features panel
        // reads the live model, which the setters never touched.
        withSuppressedModelRecording(() => {
            font.features = features as typeof font.features;
        });
        // The Features list only reloads on fontModelSync, which local
        // commits do not send. Tell that panel the model changed.
        window.dispatchEvent(new CustomEvent('generatedFeaturesChanged'));
        return [
            {
                op: 'set',
                path: ['features'],
                oldValue,
                newValue: features
            }
        ];
    }

    private callGenerator(
        generator: FeatureGeneratorInfo,
        batch: FeatureBatch,
        features: FeaturesDocument
    ): {
        blocks: GeneratedBlock[];
        diagnostics: string[];
        needsRebuild: boolean;
    } | null {
        const font = window.currentFontModel;
        const managedBlocks: Record<string, string> = {};
        for (const [tag, code] of features.features || []) {
            const stamp = generatorStamp(code);
            if (stamp?.generator !== generator.generatorId) {
                continue;
            }
            managedBlocks[tag] = code.code || '';
        }
        const context = {
            managed_blocks: managedBlocks,
            languagesystem_text: designerLanguageSystems(features)
        };
        const liveFeatures = font?.features;
        if (font) {
            withSuppressedModelRecording(() => {
                font.features = features as typeof font.features;
            });
        }
        try {
            const result = runHostPython(`
import json, builtins, js
${ENSURE_FEATURE_GENERATORS}
batch = json.loads(${JSON.stringify(JSON.stringify(batch))})
context = json.loads(${JSON.stringify(JSON.stringify(context))})
font = js.window.currentFontModel
generator = builtins._cp_feature_generators.get(${JSON.stringify(generator.generatorId)})
if generator is None:
    raise RuntimeError('generator missing')
needs = True
intents = batch.get('intents') or {}
# An intent is enough. needs_rebuild used to require a glyph edit, so
# recomposing an already-empty shell never wrote the feature.
forced = False
for key in list(getattr(generator, 'INTENT_KEYS', []) or []):
    intent = intents.get(key) or {}
    added = intent.get('add') or []
    removed = intent.get('remove') or []
    if added or removed:
        forced = True
if not forced and hasattr(generator, 'needs_rebuild') and batch.get('trigger') != 'manual':
    needs = bool(generator.needs_rebuild(batch, font, context))
produced = generator.generate(batch, font, context) if needs else {'blocks': [], 'diagnostics': []}
json.dumps({'needsRebuild': needs, 'blocks': produced.get('blocks') or [], 'diagnostics': produced.get('diagnostics') or []})
`);
            return JSON.parse(String(result));
        } finally {
            if (font) {
                withSuppressedModelRecording(() => {
                    font.features = liveFeatures as typeof font.features;
                });
            }
        }
    }

    private noteSettingTrigger(
        operations: readonly TransactionBufferedOperation[],
        batch: FeatureBatch
    ): void {
        for (const operation of operations) {
            if (operation.path[0] !== 'format_specific') {
                continue;
            }
            const pairs =
                operation.path.length === 1
                    ? changedPluginSettings(
                          operation.oldValue,
                          operation.newValue
                      )
                    : [
                          [
                              String(operation.path[2] || ''),
                              String(operation.path[4] || '')
                          ]
                      ];
            for (const [pluginId, settingId] of pairs) {
                const generator = this.generators.find(
                    (item) => item.generatorId === pluginId
                );
                if (generator?.regenerates[settingId]) {
                    batch.trigger = 'setting';
                    batch.settingPluginId = pluginId;
                }
            }
        }
    }

    private record(
        trigger: string,
        ran: string[],
        skipped: string[],
        error: string | undefined,
        started: number
    ): void {
        this.diagnostics.entries.push({
            trigger,
            ran,
            skipped,
            error,
            durationMs: performance.now() - started
        });
        if (this.diagnostics.entries.length > 200) {
            this.diagnostics.entries.shift();
        }
    }

    private async load(): Promise<void> {
        const started = performance.now();
        while (!window.pyodide) {
            if (performance.now() - started > 30_000) {
                throw new Error('Timed out waiting for Python.');
            }
            await new Promise((resolve) => window.setTimeout(resolve, 50));
        }
        const result = await runHostPythonAsync(`
import json, builtins
${ENSURE_FEATURE_GENERATORS}
found = []
for plugin in builtins._cp_feature_generators.values():
    found.append({
        'generatorId': plugin.generator_id,
        'version': plugin.version,
        'capability': plugin.capability,
        'eventTypes': list(getattr(plugin, 'EVENT_TYPES', [])),
        'intentKeys': list(getattr(plugin, 'INTENT_KEYS', [])),
        'entryPoint': plugin.generator_id,
        'settings': list(getattr(plugin, 'SETTINGS', [])),
        'followsFeatures': bool(getattr(plugin, 'follows_features', False)),
        'followRank': int(getattr(plugin, 'follow_rank', 0) or 0),
    })
json.dumps(found)
`);
        const parsed = JSON.parse(String(result)) as Array<
            FeatureGeneratorInfo & { settings?: Array<Record<string, unknown>> }
        >;
        this.generators = [];
        for (const item of parsed) {
            const unknown = item.eventTypes.filter(
                (eventType) =>
                    !GLYPH_FILTER_EVENT_TYPES.includes(
                        eventType as (typeof GLYPH_FILTER_EVENT_TYPES)[number]
                    )
            );
            if (unknown.length) {
                console.warn(
                    `Ignoring ${item.generatorId}; unknown events ${unknown.join(', ')}`
                );
                continue;
            }
            const regenerates: Record<string, boolean> = {};
            for (const setting of item.settings || []) {
                if (typeof setting.id === 'string') {
                    regenerates[setting.id] = setting.regenerates !== false;
                }
            }
            this.generators.push({ ...item, regenerates });
            const { pluginSettingsRegistry } =
                await import('../plugin-settings/plugin-settings-registry');
            pluginSettingsRegistry.register(
                item.generatorId,
                item.version,
                item.settings || []
            );
        }
        if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('pluginSettingsRegistered'));
        }
        if (typeof window !== 'undefined') {
            window.__featureGeneratorDiagnostics = this.diagnostics;
        }
        await this.flushPending();
    }
}

function changedPluginSettings(
    oldValue: unknown,
    newValue: unknown
): Array<[string, string]> {
    const key = 'com.counterpunch.plugin-settings';
    const before = ((oldValue as Record<string, unknown> | undefined)?.[key] ||
        {}) as Record<string, { values?: Record<string, unknown> }>;
    const after = ((newValue as Record<string, unknown> | undefined)?.[key] ||
        {}) as Record<string, { values?: Record<string, unknown> }>;
    const pairs: Array<[string, string]> = [];
    for (const pluginId of new Set([
        ...Object.keys(before),
        ...Object.keys(after)
    ])) {
        const oldValues = before[pluginId]?.values || {};
        const newValues = after[pluginId]?.values || {};
        for (const settingId of new Set([
            ...Object.keys(oldValues),
            ...Object.keys(newValues)
        ])) {
            if (oldValues[settingId] !== newValues[settingId]) {
                pairs.push([pluginId, settingId]);
            }
        }
    }
    return pairs;
}

export const featureGeneratorEngine = new FeatureGeneratorEngine();
