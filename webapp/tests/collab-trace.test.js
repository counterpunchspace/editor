const fs = require('fs');
const path = require('path');

const {
    recordCollabTrace,
    drawingFingerprint,
    isCollabTraceOn
} = require('../js/collab-trace');
const { PatchSyncEngine } = require('../js/patch-sync-engine');
const { Font, withSuppressedModelRecording } = require('../js/babelfont-model');
const { open_font_file } = require('../wasm-dist/babelfont_fontc_web');

afterEach(() => {
    delete window.__collabTrace;
});

describe('collaboration trace', () => {
    it('records nothing unless a spec turned it on', () => {
        recordCollabTrace('remote', ['a'], { document: 'glyph:1' });
        expect(isCollabTraceOn()).toBe(false);
        expect(window.__collabTrace).toBeUndefined();
    });

    it('records events in order with the glyphs they touched', () => {
        window.__collabTrace = { enabled: true, entries: [] };

        recordCollabTrace('remote', ['a', 'a', 'aacute'], { paths: ['x'] });
        recordCollabTrace('local-undo', ['o'], {});

        expect(
            window.__collabTrace.entries.map(({ sequence, kind, glyphs }) => ({
                sequence,
                kind,
                glyphs
            }))
        ).toEqual([
            { sequence: 1, kind: 'remote', glyphs: ['a', 'aacute'] },
            { sequence: 2, kind: 'local-undo', glyphs: ['o'] }
        ]);
    });
});

describe('stored drawing drift', () => {
    function setUp() {
        const raw = JSON.parse(
            open_font_file(
                'Fustat.glyphs',
                fs.readFileSync(
                    path.join(__dirname, '..', 'examples', 'Fustat.glyphs'),
                    'utf-8'
                )
            )
        );
        const bridge = new PatchSyncEngine();
        bridge.initFromJson(JSON.parse(JSON.stringify(raw)));
        // A separate model: changing it leaves the documents alone.
        return { bridge, font: Font.fromData(raw) };
    }

    it('matches the documents for outlines and components alike', () => {
        const { bridge, font } = setUp();
        for (const name of ['o', 'oacute']) {
            const drawing = font.findGlyph(name).drawings[0];
            const drift = bridge.describeStoredDrawingDrift(
                name,
                drawing.id,
                drawing
            );
            expect(drift.difference).toBeNull();
            expect(drift.model).toBe(drift.stored);
            expect(drift.model).toBe(drawingFingerprint(drawing));
        }
    });

    it('names where the model departs from the documents', () => {
        const { bridge, font } = setUp();
        const oacute = font.findGlyph('oacute').drawings[0];
        const o = font.findGlyph('o').drawings[0];
        withSuppressedModelRecording(() => {
            oacute.shapes[1].asComponent().transform.translation[1] += 30;
            o.paths[0].nodes[0].x += 5;
        });

        expect(
            bridge.describeStoredDrawingDrift('oacute', oacute.id, oacute)
                .difference
        ).toMatch(/^shape 1: .*"acutecomb".* vs /);
        expect(
            bridge.describeStoredDrawingDrift('o', o.id, o).difference
        ).toMatch(/^shape 0: /);
        expect(
            bridge.describeStoredDrawingDrift('o', 'no-such-drawing', o)
                .difference
        ).toBe('only left exists');
    });
});
