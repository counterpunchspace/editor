/**
 * A collaborator's revision token released after a newer one of the same
 * glyph (held for its commit's siblings) is not dropped: the feed keeps its
 * newest token, and the glyph waits for a catch-up of the log rows after its
 * cursor, which brings the late write.
 */
const {
    GLYPH_REVISION_COMMIT_HOLD_MS,
    PatchSyncEngine
} = require('../js/patch-sync-engine');

function makeFont() {
    return {
        upm: 1000,
        names: { familyName: 'LateRevision' },
        masters: [
            {
                name: 'Regular',
                id: 'master-regular',
                location: {},
                metrics: {},
                kerning: {}
            }
        ],
        glyphs: [
            {
                name: 'B',
                id: 'id-b',
                category: 'Base',
                exported: true,
                layers: [
                    {
                        id: 'layer-1',
                        width: 600,
                        master: {
                            type: 'DefaultForMaster',
                            master: 'master-regular'
                        },
                        shapes: []
                    }
                ]
            }
        ]
    };
}

function revisionFor(bridge, glyphId) {
    return bridge
        .listGlyphRevisionTokens()
        .find((entry) => entry.glyphId === glyphId)?.revision;
}

describe('a late older collaborator revision', () => {
    afterEach(() => {
        jest.useRealTimers();
    });

    test('keeps the newest token but leaves the glyph awaiting a catch-up', () => {
        jest.useFakeTimers();
        const receiver = new PatchSyncEngine('receiver');
        receiver.initFromJson(makeFont());
        const events = [];
        receiver.onGlyphRevisionFeed((glyphIds) => events.push(glyphIds));

        // A two-glyph commit's token for B, held for its sibling.
        receiver.applyGlyphRevisionFeed([
            { glyphId: 'id-b', revision: 'writer:8/7-8' }
        ]);
        // A newer write of B arrives and applies at once.
        receiver.applyGlyphRevisionFeed([
            { glyphId: 'id-b', revision: 'other:3' }
        ]);
        expect(revisionFor(receiver, 'id-b')).toBe('other:3');
        expect(events).toEqual([['id-b']]);
        // Pretend the newer write was fetched: B's stamp names it.
        receiver
            .getDocumentInstance('glyph:id-b')
            .getMap('sync')
            .set('revision', 'other:3');
        receiver.noteGlyphRevisionFetched('id-b', 'other:3');
        expect(receiver.glyphHasCatchUpRevision('glyph:id-b', 'other:3')).toBe(
            true
        );

        // The held token is released after the newer one.
        jest.advanceTimersByTime(GLYPH_REVISION_COMMIT_HOLD_MS);

        // The feed's newest token does not move backwards ...
        expect(revisionFor(receiver, 'id-b')).toBe('other:3');
        // ... but the glyph is reported changed and is not caught up: the
        // late write is still to be fetched.
        expect(events).toEqual([['id-b'], ['id-b']]);
        expect(receiver.glyphHasCatchUpRevision('glyph:id-b', 'other:3')).toBe(
            false
        );

        // A catch-up to the room's tail brings it.
        receiver.noteGlyphRevisionFetched('id-b', 'other:3');
        expect(receiver.glyphHasCatchUpRevision('glyph:id-b', 'other:3')).toBe(
            true
        );
    });

    test('an older token released late for a glyph with that token changes nothing', () => {
        jest.useFakeTimers();
        const receiver = new PatchSyncEngine('receiver');
        receiver.initFromJson(makeFont());
        receiver.applyGlyphRevisionFeed([
            { glyphId: 'id-b', revision: 'writer:8/7-8' }
        ]);
        receiver.applyGlyphRevisionFeed([
            { glyphId: 'id-b', revision: 'writer:8/7-8' }
        ]);
        jest.advanceTimersByTime(GLYPH_REVISION_COMMIT_HOLD_MS);
        expect(revisionFor(receiver, 'id-b')).toBe('writer:8/7-8');
    });
});
