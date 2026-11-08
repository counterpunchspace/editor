import type { Font, Glyph } from '../babelfont-model';
import {
    glyphsByNameMap,
    localNamesByIdentity,
    observeFont,
    observeGlyph,
    type QaGlyphObservation
} from './auto-qa-identity';
import {
    qaCorpusIndex,
    type QaCorpusTable,
    type QaIdentityRow
} from './auto-qa-corpus';
import {
    DEFAULT_QA_N_MIN,
    DEFAULT_QA_PEER_M,
    DEFAULT_QA_MARK_PEER_M,
    DEFAULT_QA_ROLE_SHARE,
    DEFAULT_QA_SOFT_X,
    DEFAULT_QA_THRESHOLD_X,
    DEFAULT_QA_WITHIN_FONT_RATE,
    isCombiningMarkCodepoint,
    isCombiningMarkIdentity,
    isMarkLikeIdentity,
    wilsonLowerBound
} from './auto-qa-stats';

export const AUTO_QA_SOURCE_ID = 'auto-qa';

export type GlyphQaSeverity = 'info' | 'warning' | 'error';

export type GlyphQaMessage = {
    sourceId: string;
    severity: GlyphQaSeverity;
    checkId: string;
    message: string;
    messageId: string;
};

export type QaLabelKind =
    'missing_component' | 'missing_anchor' | 'wrong_component_order';

export type QaLabel = {
    glyph_name: string;
    identity: string;
    kind: QaLabelKind;
    missing: string;
    displayName: string;
    relatedDisplayName?: string;
    n: number;
    k: number;
    confidence: number;
};

export type QaMatchOptions = {
    X?: number;
    softX?: number;
    nMin?: number;
    peerM?: number;
    markPeerM?: number;
    roleShare?: number;
    withinFontRate?: number;
};

type ResolvedMatchOptions = {
    X: number;
    softX: number;
    nMin: number;
    peerM: number;
    markPeerM: number;
    roleShare: number;
    withinFontRate: number;
};

type SlotKind = 'components' | 'anchors';

type CandidateSlot = {
    kind: QaLabelKind;
    slot: SlotKind;
    missing: string;
    k: number;
    n: number;
    confidence: number;
    markRelated: boolean;
};

type WithinFontStatus = {
    peerCount: number;
    rate: number;
};

type QaFontMatchContext = {
    font: Font;
    /** The glyph list the cached glyphs belong to (replaced on add, delete, rename). */
    glyphs: Glyph[];
    table: QaCorpusTable;
    options: ResolvedMatchOptions;
    glyphCount: number;
    glyphsByName: Map<string, Glyph>;
    observations: QaGlyphObservation[];
    observationByName: Map<string, QaGlyphObservation>;
    nameByIdentity: Map<string, string>;
    hasMarkSystem: boolean;
    markAnchorNames: Set<string>;
    peerStats: Map<string, WithinFontStatus>;
};

let cachedContext: QaFontMatchContext | null = null;

/**
 * Glyphs changed since the cached context observed them, or 'all' when a
 * change cannot be narrowed to glyphs. They are observed again before the
 * cached context is used, instead of observing the whole font.
 */
let pendingChangedGlyphs: Set<string> | 'all' = new Set();

/** Record glyphs whose components, anchors, name or codepoints changed. */
export function markQaGlyphsChanged(
    glyphNames: Iterable<string> | 'all'
): void {
    if (pendingChangedGlyphs === 'all') {
        return;
    }
    if (glyphNames === 'all') {
        pendingChangedGlyphs = 'all';
        return;
    }
    for (const glyphName of glyphNames) {
        pendingChangedGlyphs.add(glyphName);
    }
}

function takePendingChangedGlyphs(): Set<string> | 'all' {
    const changed = pendingChangedGlyphs;
    pendingChangedGlyphs = new Set();
    return changed;
}

/**
 * Match an open font against the Auto QA corpus table and return missing
 * component / missing anchor labels after Wilson, mark-system, role, and
 * within-font gates.
 */
export function matchOpenFont(
    font: Font,
    table: QaCorpusTable | null = qaCorpusIndex.getTable(),
    options: QaMatchOptions = {}
): QaLabel[] {
    const context = getMatchContext(font, table, options);
    if (!context) {
        return [];
    }
    const labels: QaLabel[] = [];
    for (const observation of context.observations) {
        labels.push(...labelsForObservation(observation, context));
    }
    return sortLabels(labels);
}

export function labelsForGlyph(
    font: Font,
    glyphName: string,
    table: QaCorpusTable | null = qaCorpusIndex.getTable(),
    options: QaMatchOptions = {}
): QaLabel[] {
    const context = getMatchContext(font, table, options);
    if (!context) {
        return [];
    }
    const glyph = context.glyphsByName.get(glyphName);
    if (!glyph) {
        return [];
    }
    const observation = observeGlyph(glyph, context.glyphsByName);
    if (!observation) {
        return [];
    }
    if (
        !sameObservation(observation, context.observationByName.get(glyphName))
    ) {
        cachedContext =
            refreshObservations(context, new Set([glyphName])) ??
            buildFullContext(font, context.table, context.options);
        return sortLabels(labelsForObservation(observation, cachedContext));
    }
    return sortLabels(labelsForObservation(observation, context));
}

export function invalidateQaMatchCache(): void {
    cachedContext = null;
    pendingChangedGlyphs = new Set();
}

export function matchObservations(
    font: Font,
    observations: QaGlyphObservation[],
    table: QaCorpusTable,
    options: QaMatchOptions = {}
): QaLabel[] {
    const resolved = resolveOptions(options);
    const context = buildContextFromObservations(
        font,
        table,
        resolved,
        glyphsByNameMap(font),
        observations
    );
    const labels: QaLabel[] = [];
    for (const observation of observations) {
        labels.push(...labelsForObservation(observation, context));
    }
    return sortLabels(labels);
}

function getMatchContext(
    font: Font,
    table: QaCorpusTable | null,
    options: QaMatchOptions
): QaFontMatchContext | null {
    if (!table) {
        return null;
    }
    const resolved = resolveOptions(options);
    if (cachedContext && contextMatches(cachedContext, font, table, resolved)) {
        const changed = takePendingChangedGlyphs();
        if (changed !== 'all' && changed.size === 0) {
            return cachedContext;
        }
        cachedContext =
            (changed !== 'all' &&
                refreshObservations(cachedContext, changed)) ||
            buildFullContext(font, table, resolved);
        return cachedContext;
    }
    cachedContext = buildFullContext(font, table, resolved);
    return cachedContext;
}

function buildFullContext(
    font: Font,
    table: QaCorpusTable,
    options: ResolvedMatchOptions
): QaFontMatchContext {
    pendingChangedGlyphs = new Set();
    return buildContextFromObservations(
        font,
        table,
        options,
        glyphsByNameMap(font),
        observeFont(font)
    );
}

/**
 * The context with only `glyphNames` observed again. Every other glyph's
 * observation depends on its own data and on the names and codepoints of the
 * glyphs it uses, so it stays valid unless one of these glyphs changed its
 * identity. That, a glyph that is gone, or one that newly has or no longer
 * has an identity returns null, for a full rebuild.
 */
function refreshObservations(
    context: QaFontMatchContext,
    glyphNames: Set<string>
): QaFontMatchContext | null {
    const observations = [...context.observations];
    const indexByName = new Map<string, number>();
    observations.forEach((observation, index) =>
        indexByName.set(observation.glyphName, index)
    );
    for (const glyphName of glyphNames) {
        const glyph = context.glyphsByName.get(glyphName);
        const previous = context.observationByName.get(glyphName);
        if (!glyph) {
            if (previous) {
                return null;
            }
            continue;
        }
        const next = observeGlyph(glyph, context.glyphsByName);
        if (!previous && !next) {
            continue;
        }
        if (
            !previous ||
            !next ||
            previous.identity !== next.identity ||
            previous.unicode !== next.unicode
        ) {
            return null;
        }
        const index = indexByName.get(glyphName);
        if (index === undefined) {
            return null;
        }
        observations[index] = next;
    }
    return buildContextFromObservations(
        context.font,
        context.table,
        context.options,
        context.glyphsByName,
        observations,
        context.nameByIdentity
    );
}

function contextMatches(
    context: QaFontMatchContext,
    font: Font,
    table: QaCorpusTable,
    options: ResolvedMatchOptions
): boolean {
    return (
        context.font === font &&
        context.glyphs === font.glyphs &&
        context.table === table &&
        context.glyphCount === font.glyphs.length &&
        context.options.X === options.X &&
        context.options.softX === options.softX &&
        context.options.nMin === options.nMin &&
        context.options.peerM === options.peerM &&
        context.options.markPeerM === options.markPeerM &&
        context.options.roleShare === options.roleShare &&
        context.options.withinFontRate === options.withinFontRate
    );
}

function buildContextFromObservations(
    font: Font,
    table: QaCorpusTable,
    options: ResolvedMatchOptions,
    glyphsByName: Map<string, Glyph>,
    observations: QaGlyphObservation[],
    nameByIdentity: Map<string, string> = localNamesByIdentity(glyphsByName)
): QaFontMatchContext {
    const markAnchorNames = new Set(table.mark_anchor_names || []);
    const hasMarkSystem = fontHasMarkSystem(font, observations);
    const observationByName = new Map<string, QaGlyphObservation>();
    for (const observation of observations) {
        observationByName.set(observation.glyphName, observation);
    }
    return {
        font,
        glyphs: font.glyphs,
        table,
        options,
        glyphCount: font.glyphs.length,
        glyphsByName,
        observations,
        observationByName,
        nameByIdentity,
        hasMarkSystem,
        markAnchorNames,
        peerStats: buildPeerStats(
            observations,
            table,
            options,
            markAnchorNames,
            hasMarkSystem
        )
    };
}

function labelsForObservation(
    observation: QaGlyphObservation,
    context: QaFontMatchContext
): QaLabel[] {
    const { table, options, hasMarkSystem, markAnchorNames, peerStats } =
        context;
    const row = table.identities[observation.identity];
    if (!row || row.n < options.nMin) {
        return [];
    }
    const labels: QaLabel[] = [];
    const observedComponents = new Set(observation.components);
    const observedAnchors = new Set(observation.anchors);

    for (const candidate of candidateSlots(
        row,
        options,
        markAnchorNames,
        hasMarkSystem
    )) {
        const observed =
            candidate.slot === 'components'
                ? observedComponents
                : observedAnchors;
        if (observed.has(candidate.missing)) {
            continue;
        }
        if (
            !shouldEmitSlot(
                candidate.confidence,
                options,
                peerStats.get(peerKey(candidate.slot, candidate.missing)) || {
                    peerCount: 0,
                    rate: 0
                },
                candidate.markRelated
            )
        ) {
            continue;
        }
        labels.push({
            glyph_name: observation.glyphName,
            identity: observation.identity,
            kind: candidate.kind,
            missing: candidate.missing,
            displayName: displayNameForSlot(candidate, context),
            n: candidate.n,
            k: candidate.k,
            confidence: candidate.confidence
        });
    }
    const orderLabel = wrongComponentOrderLabel(observation, context);
    if (orderLabel) {
        labels.push(orderLabel);
    }
    return labels;
}

function candidateSlots(
    row: QaIdentityRow,
    options: ResolvedMatchOptions,
    markAnchorNames: Set<string>,
    hasMarkSystem: boolean
): CandidateSlot[] {
    const slots: CandidateSlot[] = [];
    if (usuallyHas(row.k_has_any_component, row.n, options.roleShare)) {
        for (const [missing, k] of Object.entries(row.components || {})) {
            const markRelated = isCombiningMarkIdentity(missing);
            if (markRelated && !hasMarkSystem) {
                continue;
            }
            const candidate = slotIfViable(
                row,
                'missing_component',
                'components',
                missing,
                k,
                markRelated,
                options.softX
            );
            if (candidate) {
                slots.push(candidate);
            }
        }
    }
    if (usuallyHas(row.k_has_any_anchor, row.n, options.roleShare)) {
        for (const [missing, k] of Object.entries(row.anchors || {})) {
            const markRelated = markAnchorNames.has(missing);
            if (markRelated && !hasMarkSystem) {
                continue;
            }
            const candidate = slotIfViable(
                row,
                'missing_anchor',
                'anchors',
                missing,
                k,
                markRelated,
                options.softX
            );
            if (candidate) {
                slots.push(candidate);
            }
        }
    }
    return slots;
}

function slotIfViable(
    row: QaIdentityRow,
    kind: QaLabelKind,
    slot: SlotKind,
    missing: string,
    k: number,
    markRelated: boolean,
    softX: number
): CandidateSlot | null {
    const n = effectiveN(row, markRelated);
    if (!couldReachSoftX(k, n, softX)) {
        return null;
    }
    const confidence = wilsonLowerBound(k, n);
    if (confidence < softX) {
        return null;
    }
    return { kind, slot, missing, k, n, confidence, markRelated };
}

function buildPeerStats(
    observations: QaGlyphObservation[],
    table: QaCorpusTable,
    options: ResolvedMatchOptions,
    markAnchorNames: Set<string>,
    hasMarkSystem: boolean
): Map<string, WithinFontStatus> {
    const tallies = new Map<string, { peerCount: number; have: number }>();
    for (const observation of observations) {
        const row = table.identities[observation.identity];
        if (!row || row.n < options.nMin) {
            continue;
        }
        const observedComponents = new Set(observation.components);
        const observedAnchors = new Set(observation.anchors);
        for (const candidate of candidateSlots(
            row,
            options,
            markAnchorNames,
            hasMarkSystem
        )) {
            const key = peerKey(candidate.slot, candidate.missing);
            const tally = tallies.get(key) || { peerCount: 0, have: 0 };
            tally.peerCount += 1;
            const observed =
                candidate.slot === 'components'
                    ? observedComponents
                    : observedAnchors;
            if (observed.has(candidate.missing)) {
                tally.have += 1;
            }
            tallies.set(key, tally);
        }
    }
    const stats = new Map<string, WithinFontStatus>();
    for (const [key, tally] of tallies) {
        stats.set(key, {
            peerCount: tally.peerCount,
            rate: tally.peerCount === 0 ? 0 : tally.have / tally.peerCount
        });
    }
    return stats;
}

function peerKey(slot: SlotKind, missing: string): string {
    return `${slot}:${missing}`;
}

function resolveOptions(options: QaMatchOptions): ResolvedMatchOptions {
    return {
        X: options.X ?? DEFAULT_QA_THRESHOLD_X,
        softX: options.softX ?? DEFAULT_QA_SOFT_X,
        nMin: options.nMin ?? DEFAULT_QA_N_MIN,
        peerM: options.peerM ?? DEFAULT_QA_PEER_M,
        markPeerM: options.markPeerM ?? DEFAULT_QA_MARK_PEER_M,
        roleShare: options.roleShare ?? DEFAULT_QA_ROLE_SHARE,
        withinFontRate: options.withinFontRate ?? DEFAULT_QA_WITHIN_FONT_RATE
    };
}

function sameObservation(
    left: QaGlyphObservation,
    right: QaGlyphObservation | undefined
): boolean {
    if (!right) {
        return false;
    }
    return (
        left.identity === right.identity &&
        left.components.join('\0') === right.components.join('\0') &&
        left.componentSequences
            .map((sequence) => sequence.join(','))
            .join('|') ===
            right.componentSequences
                .map((sequence) => sequence.join(','))
                .join('|') &&
        left.anchors.join('\0') === right.anchors.join('\0')
    );
}

function usuallyHas(k: number, n: number, roleShare: number): boolean {
    if (n <= 0) {
        return false;
    }
    return k / n >= roleShare;
}

function couldReachSoftX(k: number, n: number, softX: number): boolean {
    return n > 0 && k / n >= softX;
}

function effectiveN(row: QaIdentityRow, markRelated: boolean): number {
    if (markRelated && (row.n_mark_system || 0) > 0) {
        return row.n_mark_system as number;
    }
    return row.n;
}

function fontHasMarkSystem(
    font: Font,
    observations: QaGlyphObservation[]
): boolean {
    for (const observation of observations) {
        if (isCombiningMarkIdentity(observation.identity)) {
            return true;
        }
        if (observation.components.some(isCombiningMarkIdentity)) {
            return true;
        }
    }
    for (const glyph of font.glyphs) {
        for (const codepoint of glyph.codepoints || []) {
            if (
                typeof codepoint === 'number' &&
                isCombiningMarkCodepoint(codepoint)
            ) {
                return true;
            }
        }
    }
    return false;
}

function shouldEmitSlot(
    confidence: number,
    options: ResolvedMatchOptions,
    withinFont: WithinFontStatus,
    markRelated: boolean
): boolean {
    if (confidence < options.softX) {
        return false;
    }
    const minPeers = markRelated ? options.markPeerM : options.peerM;
    const corroborated =
        withinFont.peerCount >= minPeers &&
        withinFont.rate >= options.withinFontRate;
    const contradicted =
        withinFont.peerCount >= minPeers &&
        withinFont.rate < options.withinFontRate;
    if (confidence >= options.X) {
        return !contradicted;
    }
    return corroborated;
}

function sortLabels(labels: QaLabel[]): QaLabel[] {
    return labels.sort((left, right) => {
        if (right.confidence !== left.confidence) {
            return right.confidence - left.confidence;
        }
        if (left.glyph_name !== right.glyph_name) {
            return left.glyph_name.localeCompare(right.glyph_name);
        }
        if (left.kind !== right.kind) {
            return left.kind.localeCompare(right.kind);
        }
        return left.missing.localeCompare(right.missing);
    });
}

export function formatQaLabel(label: QaLabel): string {
    return formatQaMessageText(label, true);
}

export function formatQaPlainMessage(label: QaLabel): string {
    return formatQaMessageText(label, false);
}

export function toGlyphQaMessages(labels: QaLabel[]): GlyphQaMessage[] {
    return labels.map((label) => ({
        sourceId: AUTO_QA_SOURCE_ID,
        severity: 'warning',
        checkId: label.kind,
        message: formatQaPlainMessage(label),
        messageId: `${label.kind}:${label.missing}`
    }));
}

function formatQaMessageText(label: QaLabel, markdownNames: boolean): string {
    const wrap = (value: string) => (markdownNames ? `\`${value}\`` : value);
    const name = wrap(label.displayName || label.missing);
    if (label.kind === 'wrong_component_order') {
        const base = wrap(label.relatedDisplayName || 'the base');
        return `The mark ${name} usually comes after ${base}, not before.`;
    }
    if (label.kind === 'missing_component') {
        return `Similar fonts usually include the component ${name}. This glyph does not.`;
    }
    return `Similar fonts usually have an anchor named ${name}. This glyph does not.`;
}

function displayNameForIdentity(
    identity: string,
    context: QaFontMatchContext
): string {
    return context.nameByIdentity.get(identity) || identity;
}

function firstMarkBeforeBase(
    sequence: string[]
): { mark: string; base: string } | null {
    let mark: string | null = null;
    for (const identity of sequence) {
        if (isMarkLikeIdentity(identity)) {
            if (!mark) {
                mark = identity;
            }
            continue;
        }
        if (mark) {
            return { mark, base: identity };
        }
    }
    return null;
}

function wrongComponentOrderLabel(
    observation: QaGlyphObservation,
    context: QaFontMatchContext
): QaLabel | null {
    for (const sequence of observation.componentSequences) {
        const pair = firstMarkBeforeBase(sequence);
        if (!pair) {
            continue;
        }
        return {
            glyph_name: observation.glyphName,
            identity: observation.identity,
            kind: 'wrong_component_order',
            missing: `${pair.mark}>${pair.base}`,
            displayName: displayNameForIdentity(pair.mark, context),
            relatedDisplayName: displayNameForIdentity(pair.base, context),
            n: 0,
            k: 0,
            confidence: 0.5
        };
    }
    return null;
}

function displayNameForSlot(
    candidate: CandidateSlot,
    context: QaFontMatchContext
): string {
    if (candidate.kind === 'missing_anchor') {
        return candidate.missing;
    }
    return context.nameByIdentity.get(candidate.missing) || candidate.missing;
}
