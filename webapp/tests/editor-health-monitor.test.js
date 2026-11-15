const {
    evaluateEditorHealth,
    UI_BLOCK_REVEAL_MS,
    STACK_STALL_REVEAL_MS,
    INTERPOLATE_SILENCE_REVEAL_MS
} = require('../js/editor-health-monitor');

function snapshot(overrides = {}) {
    return {
        now: 10_000,
        propertiesUpdateStartedAt: null,
        propertiesUpdateSkipCount: 0,
        editMode: true,
        selectedGlyphName: 'H',
        glyphStack: 'H@layer',
        drawingDataPresent: true,
        glyphSelectedAt: 9_000,
        pendingInterpolateCount: 0,
        oldestPendingInterpolateAt: null,
        pendingCompileCount: 0,
        lastWorkerMessageAt: 9_900,
        unmatchedInterpolateCount: 0,
        unmatchedInterpolateAt: null,
        pageLoadedAt: 0,
        priorSessionWasUnhealthy: false,
        ...overrides
    };
}

describe('evaluateEditorHealth', () => {
    test('stays quiet during a short properties update', () => {
        expect(
            evaluateEditorHealth(
                snapshot({
                    propertiesUpdateStartedAt:
                        10_000 - (UI_BLOCK_REVEAL_MS - 1),
                    glyphStack: '',
                    drawingDataPresent: false
                })
            )
        ).toEqual([]);
    });

    test('reports a properties update held past the reveal delay', () => {
        const issues = evaluateEditorHealth(
            snapshot({
                propertiesUpdateStartedAt: 10_000 - UI_BLOCK_REVEAL_MS,
                propertiesUpdateSkipCount: 2,
                glyphStack: '',
                drawingDataPresent: false
            })
        );
        expect(issues.map((issue) => issue.id)).toContain('ui-blocked');
        expect(issues[0].explanation).toContain('2 later glyph switch(es)');
    });

    test('does not treat an empty stack as stuck while a compile is in flight', () => {
        expect(
            evaluateEditorHealth(
                snapshot({
                    glyphStack: '',
                    drawingDataPresent: false,
                    pendingCompileCount: 1,
                    glyphSelectedAt: 0
                })
            )
        ).toEqual([]);
    });

    test('reports a stack stall only after delay with no explained work', () => {
        const issues = evaluateEditorHealth(
            snapshot({
                glyphStack: '',
                drawingDataPresent: false,
                glyphSelectedAt: 10_000 - STACK_STALL_REVEAL_MS
            })
        );
        expect(issues.map((issue) => issue.id)).toEqual(['stack-stall']);
    });

    test('does not flag a long interpolate while a compile is still running', () => {
        expect(
            evaluateEditorHealth(
                snapshot({
                    pendingInterpolateCount: 1,
                    oldestPendingInterpolateAt: 0,
                    pendingCompileCount: 1,
                    lastWorkerMessageAt: 0
                })
            )
        ).toEqual([]);
    });

    test('reports interpolate silence when no compile is running', () => {
        const issues = evaluateEditorHealth(
            snapshot({
                pendingInterpolateCount: 1,
                oldestPendingInterpolateAt:
                    10_000 - INTERPOLATE_SILENCE_REVEAL_MS,
                lastWorkerMessageAt: 10_000 - INTERPOLATE_SILENCE_REVEAL_MS
            })
        );
        expect(issues.map((issue) => issue.id)).toEqual(['worker-silent']);
    });

    test('adds process suspicion only when another issue appears after an unhealthy reload', () => {
        const healthy = evaluateEditorHealth(
            snapshot({
                priorSessionWasUnhealthy: true,
                pageLoadedAt: 9_000
            })
        );
        expect(healthy).toEqual([]);

        const issues = evaluateEditorHealth(
            snapshot({
                priorSessionWasUnhealthy: true,
                pageLoadedAt: 9_000,
                glyphStack: '',
                drawingDataPresent: false,
                glyphSelectedAt: 10_000 - STACK_STALL_REVEAL_MS
            })
        );
        expect(issues.map((issue) => issue.id)).toEqual([
            'stack-stall',
            'process-suspicion'
        ]);
    });
});
