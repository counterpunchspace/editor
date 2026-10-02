// Snapshot of the last Cuts modal renderer, saved 2026-10-02.
// The editor working tree no longer has webapp/js/cuts/. This file is not
// imported by the app. It drew the live graph that followed
// cuts-branches-modal-v6.svg. It imports ./resolve, ./contract, ./layout,
// and ./types, which were deleted with it.
import { resolveEffectiveCut } from './resolve';
import { readCutsContract } from './contract';
import { packCutLanes, type PackedLane } from './layout';
import type { Cut } from './types';

export type TileStatus = 'changed' | 'added' | 'removed';

export type GlyphTile = {
    name: string;
    char: string;
    status: TileStatus;
};

export type CutSummary = {
    tiles: GlyphTile[];
    totalGlyphChanges: number;
    spacing: boolean;
    kerning: boolean;
    kerningRtl: boolean;
    names: boolean;
    features: boolean;
};

export const MAX_TILES = 4;

const NODE_OFFSET = 34;
const TILE = 32;
const TILE_PITCH = 38;
const LANE_COLORS = [
    'var(--view-fontinfo)',
    'var(--view-overview)',
    'var(--view-editor)'
] as const;

function same(a: unknown, b: unknown): boolean {
    return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function glyphChar(
    fontJson: Record<string, unknown>,
    storageName: string,
    fallback: string
): string {
    const glyphs = Array.isArray(fontJson.glyphs) ? fontJson.glyphs : [];
    const glyph = glyphs.find(
        (item) =>
            item &&
            typeof item === 'object' &&
            (item as { name?: unknown }).name === storageName
    ) as { codepoints?: unknown } | undefined;
    const codepoint = Array.isArray(glyph?.codepoints)
        ? Number(glyph.codepoints[0])
        : NaN;
    if (Number.isFinite(codepoint) && codepoint > 32) {
        try {
            return String.fromCodePoint(codepoint);
        } catch {
            // fall through to the name
        }
    }
    return fallback.length <= 2 ? fallback : fallback.slice(0, 1);
}

/** What this cut changed compared with its parent (Retail for top-level cuts). */
export function summarizeCut(
    fontJson: Record<string, unknown>,
    cut: Pick<Cut, 'id' | 'parentId'>
): CutSummary {
    const parent = resolveEffectiveCut(fontJson, cut.parentId);
    const own = resolveEffectiveCut(fontJson, cut.id);
    const tiles: GlyphTile[] = [];
    const seen = new Set<string>();
    for (const name of [...own.publicOrder, ...parent.publicOrder]) {
        if (seen.has(name)) {
            continue;
        }
        seen.add(name);
        const a = own.glyphs[name];
        const b = parent.glyphs[name];
        let status: TileStatus | null = null;
        if (a && !b) {
            status = 'added';
        } else if (!a && b) {
            status = 'removed';
        } else if (
            a &&
            b &&
            (a.storageName !== b.storageName ||
                a.origin !== b.origin ||
                !same(own.spacing[name], parent.spacing[name]))
        ) {
            status = 'changed';
        }
        if (status) {
            const shown = a || b;
            tiles.push({
                name,
                char: glyphChar(fontJson, shown.storageName, name),
                status
            });
        }
    }
    return {
        tiles,
        totalGlyphChanges: tiles.length,
        spacing: !same(own.spacing, parent.spacing),
        kerning: !same(own.kerning, parent.kerning),
        kerningRtl: !same(own.kerning_rtl, parent.kerning_rtl),
        names: !same(own.names, parent.names),
        features: !same(own.features, parent.features)
    };
}

export function formatCutDate(iso: string): string {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) {
        return '';
    }
    return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

function esc(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function pill(x: number, y: number, width: number, label: string): string {
    return `<g class="cuts-pill"><rect x="${x}" y="${y}" width="${width}" height="22" rx="11"/><text x="${x + width / 2}" y="${y + 15}" text-anchor="middle">${esc(label)}</text></g>`;
}

export type GraphInput = {
    fontJson: Record<string, unknown>;
    activeCutId: string | null;
    comparedLabel: string;
    selectedId: string;
};

export type GraphResult = {
    svg: string;
    lanes: PackedLane[];
    width: number;
    height: number;
};

export function buildBranchGraph(input: GraphInput): GraphResult {
    const { fontJson, activeCutId, comparedLabel, selectedId } = input;
    const cuts = readCutsContract(fontJson).cuts;
    const lanes = packCutLanes(
        cuts.map((cut) => ({
            id: cut.id,
            key: cut.key,
            parentId: cut.parentId,
            createdAt: cut.createdAt,
            colorSlot: cut.colorSlot,
            contentWidth: Math.max(140, cut.key.length * 10 + 120)
        }))
    );
    const cutById = new Map(cuts.map((cut) => [cut.id, cut]));
    const laneById = new Map(lanes.map((lane) => [lane.id, lane]));
    const retail = lanes[0];

    const rightmost = lanes.reduce(
        (max, lane) => Math.max(max, lane.x + NODE_OFFSET + lane.boxWidth),
        0
    );
    const width = Math.max(920, rightmost + 60);
    const lineEnd = width - 40;
    const height =
        lanes.reduce((max, lane) => Math.max(max, lane.boxBottom), 0) + 40;
    const parts: string[] = [];

    // Time axis
    parts.push(
        `<line class="cuts-axis" x1="60" y1="154" x2="${width - 50}" y2="154"/>`,
        `<path class="cuts-axis-arrow" d="M ${width - 50},149 L ${width - 40},154 L ${width - 50},159 Z"/>`,
        `<text class="cuts-axis-label" x="60" y="140" letter-spacing="1.5">TIME</text>`,
        `<text class="cuts-axis-label" x="${width - 40}" y="140" text-anchor="end">now</text>`
    );
    for (const lane of lanes) {
        if (lane.id == null) {
            continue;
        }
        parts.push(
            `<text class="cuts-tick-label" x="${lane.x}" y="140" text-anchor="middle">${esc(formatCutDate(lane.createdAt))}</text>`,
            `<line class="cuts-axis" x1="${lane.x}" y1="154" x2="${lane.x}" y2="164"/>`
        );
    }

    // Connectors first so lanes paint on top of them.
    for (const lane of lanes) {
        if (lane.id == null) {
            continue;
        }
        const color = LANE_COLORS[lane.colorSlot ?? 0];
        const parent = laneById.get(lane.parentId) || retail;
        const nodeX = lane.x + NODE_OFFSET;
        const active = lane.id === activeCutId;
        parts.push(
            `<path d="M ${lane.x},${parent.y} V ${lane.y - 22} Q ${lane.x},${lane.y} ${lane.x + 22},${lane.y} H ${nodeX}" fill="none" stroke="${color}" stroke-width="${active ? 5.5 : 3.5}" stroke-linecap="round"/>`,
            `<circle cx="${lane.x}" cy="${parent.y}" r="6" fill="${color}"/>`
        );
    }

    const drawLane = (lane: PackedLane) => {
        const isRetail = lane.id == null;
        const cut: Cut | undefined = lane.id ? cutById.get(lane.id) : undefined;
        const active = isRetail ? !activeCutId : lane.id === activeCutId;
        const selected = (lane.id || 'retail') === selectedId;
        const color = isRetail
            ? 'var(--text-primary)'
            : LANE_COLORS[lane.colorSlot ?? 0];
        const stroke = isRetail ? 5 : active ? 5.5 : 3.5;
        const nodeX = isRetail ? lane.x : lane.x + NODE_OFFSET;
        const textX = isRetail ? nodeX + 35 : nodeX - 6;
        const lineStart = isRetail ? 80 : nodeX;
        const compared = isRetail
            ? comparedLabel === 'Retail'
            : comparedLabel === lane.key;
        const date = cut ? formatCutDate(cut.createdAt) : '';
        const dateLabel = isRetail
            ? compared
                ? 'baseline · compared against'
                : 'baseline'
            : compared
              ? `${date} · compared against`
              : date;
        const keyWidth = lane.key.length * (isRetail ? 11.5 : 9.4);
        const out: string[] = [];
        out.push(
            `<g class="cuts-lane${selected ? ' selected' : ''}" data-cut-id="${lane.id || 'retail'}"${active ? ' data-active="true"' : ''}>`
        );
        const hitTop = lane.y - 40;
        const hitHeight = isRetail ? 62 : lane.boxBottom - hitTop + 6;
        out.push(
            `<rect class="cuts-lane-hit" x="${lineStart - 12}" y="${hitTop}" width="${Math.min(lane.boxWidth + 80, lineEnd - lineStart + 12)}" height="${hitHeight}" rx="10"/>`
        );
        out.push(
            `<line x1="${lineStart}" y1="${lane.y}" x2="${lineEnd}" y2="${lane.y}" stroke="${color}" stroke-width="${stroke}" stroke-linecap="round"/>`,
            `<path d="M ${lineEnd - 2},${lane.y - 8} L ${lineEnd + 14},${lane.y} L ${lineEnd - 2},${lane.y + 8} Z" fill="${color}"/>`
        );
        if (active && !isRetail) {
            out.push(
                `<circle class="cuts-node" cx="${nodeX}" cy="${lane.y}" r="15" stroke="${color}" stroke-width="5.5"/>`,
                `<circle cx="${nodeX}" cy="${lane.y}" r="5" fill="${color}"/>`
            );
        } else {
            out.push(
                `<circle class="cuts-node" cx="${nodeX}" cy="${lane.y}" r="10" stroke="${color}" stroke-width="${stroke}"/>`
            );
        }
        out.push(
            `<text class="cuts-lane-key${isRetail ? ' retail' : ''}" x="${textX}" y="${lane.y - 22}"${active && !isRetail ? ` fill="${color}"` : ''}>${esc(lane.key)}</text>`,
            `<text class="cuts-lane-date" x="${textX + keyWidth + 12}" y="${lane.y - 22}">${esc(dateLabel)}</text>`
        );
        if (active && !isRetail) {
            const badgeX = textX + keyWidth + 12 + dateLabel.length * 6.6 + 14;
            out.push(
                `<rect x="${badgeX}" y="${lane.y - 37}" width="52" height="19" rx="9.5" fill="${color}"/>`,
                `<text class="cuts-badge" x="${badgeX + 26}" y="${lane.y - 23}" text-anchor="middle">ACTIVE</text>`
            );
        }
        if (cut) {
            const summary = summarizeCut(fontJson, cut);
            const tileX = nodeX - 18;
            let rowY = lane.y + 16;
            const shown = summary.tiles.slice(0, MAX_TILES);
            shown.forEach((tile, index) => {
                const x = tileX + index * TILE_PITCH;
                out.push(
                    `<g class="cuts-tile ${tile.status}"><rect x="${x}" y="${rowY}" width="${TILE}" height="${TILE}" rx="6"/><text x="${x + TILE / 2}" y="${rowY + 23}" text-anchor="middle"${tile.status === 'removed' ? ' text-decoration="line-through"' : ''}>${esc(tile.char)}</text><title>${esc(tile.name)}</title></g>`
                );
            });
            if (summary.totalGlyphChanges > MAX_TILES) {
                out.push(
                    `<text class="cuts-more" x="${tileX + MAX_TILES * TILE_PITCH + 12}" y="${rowY + 22}" text-anchor="middle">+${summary.totalGlyphChanges - MAX_TILES}</text>`
                );
            }
            if (shown.length > 0) {
                rowY += TILE + 12;
            }
            const pills: Array<[number, string]> = [];
            if (summary.spacing) pills.push([24, '↔']);
            if (summary.kerning) pills.push([24, '⇄']);
            if (summary.kerningRtl) pills.push([56, '⇄ RTL']);
            if (summary.names) pills.push([32, 'Aa']);
            if (summary.features) pills.push([40, '{ }']);
            let px = tileX + 2;
            for (const [w, label] of pills) {
                out.push(pill(px, rowY, w, label));
                px += w + 6;
            }
            if (shown.length === 0 && pills.length === 0) {
                out.push(
                    `<text class="cuts-empty" x="${tileX + 2}" y="${lane.y + 34}">no changes yet</text>`
                );
            }
        }
        out.push('</g>');
        parts.push(out.join(''));
    };
    // Draw top-to-bottom so lines of lower lanes never hide tiles above.
    [...lanes].sort((a, b) => a.y - b.y).forEach(drawLane);

    const svg = `<svg class="cuts-graph" xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${parts.join('')}</svg>`;
    return { svg, lanes, width, height };
}
