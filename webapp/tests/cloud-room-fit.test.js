const Y = require('yjs');
const {
    findRoomsThatDoNotFit,
    roomFitRefusalMessage
} = require('../js/filesystem-plugins/cloud-room-fit');

function docBytes(fill) {
    const doc = new Y.Doc();
    doc.transact(() => fill(doc));
    return Y.encodeStateAsUpdate(doc);
}

describe('cloud room fit', () => {
    const limits = { maxBytes: 4000, maxStructs: 300 };

    test('rooms within the limits pass', () => {
        const bytes = docBytes((doc) => doc.getMap('font').set('upm', 1000));
        expect(
            findRoomsThatDoNotFit([{ documentId: 'font-core', bytes }], { limits })
        ).toEqual([]);
    });

    test('a room over the byte or struct limit is named in plain words', () => {
        const bigGlyph = docBytes((doc) =>
            doc.getMap('glyph').set('note', 'x'.repeat(5000))
        );
        const busyKerning = docBytes((doc) => {
            const map = doc.getMap('kerning');
            for (let i = 0; i < 400; i += 1) map.set(`m|l|g${i}:v`, -i);
        });
        const problems = [
            ...findRoomsThatDoNotFit(
                [{ documentId: 'glyph:1a11e112-3388-4bbc-8378-89c34347bb71', bytes: bigGlyph }],
                {
                    limits,
                    glyphName: (id) => (id.startsWith('glyph:') ? 'Aring' : null)
                }
            ),
            ...findRoomsThatDoNotFit([{ documentId: 'kerning:3', bytes: busyKerning }], {
                limits: { maxBytes: 1_000_000, maxStructs: 300 }
            })
        ];
        expect(problems.map((problem) => problem.documentId)).toEqual([
            'glyph:1a11e112-3388-4bbc-8378-89c34347bb71',
            'kerning:3'
        ]);
        expect(problems[0].message).toMatch(/^The glyph “Aring” is too large for the cloud \(5 KB, the limit is 4 KB\)\. Simplify/);
        expect(problems[1].message).toMatch(/^Its kerning is too large for the cloud \(400 stored items, the limit is 300\)\. Kerning groups/);
        const message = roomFitRefusalMessage(problems);
        expect(message.startsWith('This font can’t be saved to the cloud. The glyph “Aring”')).toBe(true);
    });

    test('a long refusal lists five parts and counts the rest', () => {
        const problems = Array.from({ length: 7 }, (_, i) => ({
            documentId: `glyph:${i}`,
            bytes: 0,
            structs: 0,
            message: `Part ${i}.`
        }));
        expect(roomFitRefusalMessage(problems)).toBe(
            'This font can’t be saved to the cloud. Part 0. Part 1. Part 2. Part 3. Part 4. 2 more parts are too large as well.'
        );
    });
});
