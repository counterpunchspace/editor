import type { HistoryStackItem } from './change-log';

export type SidebearingSide = 'left' | 'right';

type SidebearingDrawingSnapshot = {
    width: number;
};

type SidebearingVisualTarget = {
    textRunEditor?: {
        computePrecedingAdvanceDelta?(
            glyphAdvances: Record<string, number>
        ): number;
        refreshGlyphAdvanceDeltasLive(
            glyphAdvanceDeltas: Record<string, number>,
            options?: { render?: boolean }
        ): boolean;
    } | null;
    viewportManager?: {
        panX: number;
        scale: number;
    } | null;
    syncCurrentOutlineDrawingDataFromModel?(
        drawing: SidebearingDrawingSnapshot
    ): void;
};

export function getSidebearingTransactionLabel(side: SidebearingSide): string {
    return side === 'left' ? 'Set LSB' : 'Set RSB';
}

export function formatSidebearingHistoryValue(
    side: SidebearingSide,
    value: number
): string {
    return `${side.toUpperCase()} ${value}`;
}

export function inferSidebearingSideFromHistoryItem(
    historyItem: HistoryStackItem | null
): SidebearingSide | null {
    if (!historyItem) {
        return null;
    }

    if (historyItem.transactionLabel === 'Set LSB') {
        return 'left';
    }
    if (historyItem.transactionLabel === 'Set RSB') {
        return 'right';
    }

    for (const entry of historyItem.entries) {
        if (entry.visualAnchorSide === 'left') {
            return 'left';
        }
        if (entry.visualAnchorSide === 'right') {
            return 'right';
        }

        for (const value of [entry.oldValue, entry.newValue]) {
            if (typeof value !== 'string') {
                continue;
            }

            if (value.startsWith('LEFT ')) {
                return 'left';
            }
            if (value.startsWith('RIGHT ')) {
                return 'right';
            }
        }
    }

    return null;
}

export function refreshLiveGlyphAdvancesWithSelectedGlyphAnchor(
    target: SidebearingVisualTarget,
    glyphAdvanceDeltas: Record<string, number>,
    options: { render?: boolean } = {}
): boolean {
    const precedingDelta =
        target.textRunEditor?.computePrecedingAdvanceDelta?.(
            Object.fromEntries(
                Object.entries(glyphAdvanceDeltas).map(
                    ([glyphName, advanceDelta]) => {
                        const intrinsicAdvance = (
                            target.textRunEditor as {
                                intrinsicGlyphAdvances?: Map<string, number>;
                            }
                        ).intrinsicGlyphAdvances?.get(glyphName);
                        return [
                            glyphName,
                            typeof intrinsicAdvance === 'number'
                                ? intrinsicAdvance + advanceDelta
                                : NaN
                        ];
                    }
                )
            )
        ) ?? 0;
    const advancesRefreshed =
        target.textRunEditor?.refreshGlyphAdvanceDeltasLive(
            glyphAdvanceDeltas,
            options
        ) ?? false;

    const viewportManager = target.viewportManager;
    if (
        advancesRefreshed &&
        Number.isFinite(precedingDelta) &&
        Math.abs(precedingDelta) > 0.01 &&
        viewportManager &&
        Number.isFinite(viewportManager.scale)
    ) {
        viewportManager.panX -= precedingDelta * viewportManager.scale;
    }

    return advancesRefreshed;
}

export function applyLiveSidebearingVisualSync(
    target: SidebearingVisualTarget,
    options: {
        glyphName?: string | null;
        glyphAdvanceDeltas?: Record<string, number> | null;
        side?: SidebearingSide;
        previousWidth: number;
        nextWidth: number;
        render?: boolean;
    }
): {
    widthDelta: number;
    advancesRefreshed: boolean;
} {
    const previousWidth = Number(options.previousWidth);
    const nextWidth = Number(options.nextWidth);
    if (!Number.isFinite(previousWidth) || !Number.isFinite(nextWidth)) {
        return { widthDelta: 0, advancesRefreshed: false };
    }

    const widthDelta = nextWidth - previousWidth;
    const hasDependentAdvanceDeltas =
        !!options.glyphAdvanceDeltas &&
        Object.values(options.glyphAdvanceDeltas).some(
            (delta) => Number.isFinite(delta) && Math.abs(delta) > 0.01
        );
    if (Math.abs(widthDelta) <= 0.01 && !hasDependentAdvanceDeltas) {
        return { widthDelta, advancesRefreshed: false };
    }

    const liveGlyphAdvanceDeltas = hasDependentAdvanceDeltas
        ? options.glyphAdvanceDeltas!
        : Math.abs(widthDelta) > 0.01 && options.glyphName
          ? { [options.glyphName]: widthDelta }
          : null;

    const advancesRefreshed =
        !!liveGlyphAdvanceDeltas &&
        refreshLiveGlyphAdvancesWithSelectedGlyphAnchor(
            target,
            liveGlyphAdvanceDeltas,
            { render: options.render }
        );

    return { widthDelta, advancesRefreshed };
}

export function syncModelSidebearingEditToCanvas(
    target: SidebearingVisualTarget,
    options: {
        layer: SidebearingDrawingSnapshot;
        glyphName?: string | null;
        side?: SidebearingSide;
        previousWidth: number;
        render?: boolean;
    }
): {
    widthDelta: number;
    advancesRefreshed: boolean;
} {
    target.syncCurrentOutlineDrawingDataFromModel?.(options.layer);

    return applyLiveSidebearingVisualSync(target, {
        glyphName: options.glyphName,
        side: options.side,
        previousWidth: options.previousWidth,
        nextWidth: options.layer.width,
        render: options.render
    });
}
