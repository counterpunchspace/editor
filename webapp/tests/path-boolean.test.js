const {
    booleanResultSignature,
    booleanResultsMatch,
    shouldShowPathBooleanButtons
} = require('../js/path-boolean');

function linePath(nodeCount) {
    return {
        closed: true,
        nodes: Array.from({ length: nodeCount }, (_, index) => ({
            x: index,
            y: 0,
            nodetype: 'Line'
        }))
    };
}

describe('path boolean panel and preflight', () => {
    test('buttons require two or more closed paths', () => {
        expect(
            shouldShowPathBooleanButtons({
                selectedPathCount: 1,
                allSelectedPathsClosed: true,
                isInterpolated: false
            })
        ).toBe(false);
        expect(
            shouldShowPathBooleanButtons({
                selectedPathCount: 2,
                allSelectedPathsClosed: true,
                isInterpolated: false
            })
        ).toBe(true);
        expect(
            shouldShowPathBooleanButtons({
                selectedPathCount: 2,
                allSelectedPathsClosed: false,
                isInterpolated: false
            })
        ).toBe(false);
        expect(
            shouldShowPathBooleanButtons({
                selectedPathCount: 3,
                allSelectedPathsClosed: true,
                isInterpolated: true
            })
        ).toBe(false);
    });

    test('matching result signatures apply without a confirm', () => {
        const result = [linePath(4)];
        expect(booleanResultsMatch([result, result])).toBe(true);
        expect(booleanResultsMatch([result])).toBe(true);
    });

    test('different contour structure needs a confirm', () => {
        expect(booleanResultsMatch([[linePath(4)], [linePath(6)]])).toBe(false);
        expect(
            booleanResultsMatch([[linePath(4)], [linePath(4), linePath(4)]])
        ).toBe(false);
    });

    test('signature ignores coordinates and normalizes node types', () => {
        const left = booleanResultSignature([
            {
                closed: true,
                nodes: [{ x: 1, y: 2, nodetype: 'line' }]
            }
        ]);
        const right = booleanResultSignature([
            {
                closed: true,
                nodes: [{ x: 9, y: 8, nodetype: 'Line' }]
            }
        ]);
        expect(left).toBe(right);
        expect(left).toBe('P:1:1:Line');
    });
});
