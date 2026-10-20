const {
    rebasePythonExecutionBaseline
} = require('../js/python-execution-baseline.ts');

describe('python execution baseline', () => {
    test('folds a remote glyph change into the pre-Python snapshot', () => {
        const before = {
            glyphs: [{ name: 'a', layers: [{ id: 'regular', width: 500 }] }]
        };
        const live = {
            glyphs: [{ name: 'a', layers: [{ id: 'regular', width: 640 }] }]
        };
        const next = JSON.parse(
            rebasePythonExecutionBaseline(JSON.stringify(before), live, [
                '/glyphs/0/layers/0/width'
            ])
        );
        expect(next.glyphs[0].layers[0].width).toBe(640);
    });

    test('leaves the snapshot alone when the remote path is absent', () => {
        const before = JSON.stringify({ upm: 1000 });
        expect(
            rebasePythonExecutionBaseline(before, { upm: 1000 }, [
                '/missing/path'
            ])
        ).toBe(before);
    });
});
