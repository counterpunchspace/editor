/**
 * Rooms keep the documents an earlier release wrote. Each fixture in
 * tests/fixtures/legacy-rooms is the document set a released version wrote
 * for font.babelfont.json; the current build must load it, read every
 * drawing, accept edits to it and hand it on. When the stored format
 * changes, add a fixture written by the last release; never delete one.
 * To write one, check the release tag out in a worktree and, there, save
 * `encodeDocumentSet()` of a `PatchSyncEngine` after `initFromJson` of
 * `canonicalizeImportedFontData(font.babelfont.json)`, as base64 shards.
 *
 * v0.4.4 stored a drawing without shapes (a space, an empty background
 * drawing, an empty free drawing) as its plain keys alone.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const Y = require('yjs');
const { PatchSyncEngine } = require('../js/patch-sync-engine');
const {
    canonicalizeImportedFontData
} = require('../js/font-import-canonicalization');
const {
    ensureCoreUpdateHasGlyphsMap,
    fromYType
} = require('../js/change-bridge-ydoc');

const FIXTURES = path.join(__dirname, 'fixtures', 'legacy-rooms');
// Jest cannot load the compiler WASM: the real worker runs in a child.
const COMPILE_RUNNER = path.join(__dirname, 'helpers/compile-worker-seed.mjs');
const WRITERS = fs
    .readdirSync(FIXTURES)
    .filter((name) => name.endsWith('.documentset.json'))
    .map((name) => name.replace('.documentset.json', ''));

function readDocumentSet(writer) {
    const file = JSON.parse(
        fs.readFileSync(
            path.join(FIXTURES, `${writer}.documentset.json`),
            'utf8'
        )
    );
    return file.documents.map((document) => ({
        documentId: document.documentId,
        bytes: new Uint8Array(Buffer.from(document.bytes, 'base64'))
    }));
}

function sourceFont() {
    const source = JSON.parse(
        fs.readFileSync(path.join(FIXTURES, 'font.babelfont.json'), 'utf8')
    );
    return canonicalizeImportedFontData(source).fontData;
}

function openRoom(writer, label) {
    const engine = new PatchSyncEngine(label);
    engine.setFontJson(sourceFont());
    engine.applyDocumentSetState(readDocumentSet(writer));
    return engine;
}

function glyph(engine, name) {
    return engine
        .getFontJsonSnapshot()
        .glyphs.find((entry) => entry.name === name);
}

function drawing(engine, glyphName, drawingId) {
    return glyph(engine, glyphName).layers.find(
        (entry) => entry.id === drawingId
    );
}

test('there is a fixture written by v0.4.4', () => {
    expect(WRITERS).toContain('v0.4.4');
});

test('the v0.4.4 fixture stores the space drawing as its plain keys', () => {
    // Keeps the fixture honest: it must exercise the legacy encoding.
    const space = readDocumentSet('v0.4.4').find((document) => {
        const doc = new Y.Doc({ gc: false });
        Y.applyUpdate(doc, document.bytes);
        const isSpace = doc.getMap('glyph').get('name') === 'space';
        doc.destroy();
        return isSpace;
    });
    const doc = new Y.Doc({ gc: false });
    Y.applyUpdate(doc, space.bytes);
    const stored = doc.getMap('glyph').get('layers').get('m-thin');
    expect([...stored.keys()].sort()).not.toContain('geometryTopology');
    expect([...stored.keys()]).not.toContain('shapes');
    doc.destroy();
});

describe.each(WRITERS)('a room written by %s', (writer) => {
    test('loads and reads every drawing', () => {
        const engine = openRoom(writer, `backcompat-load-${writer}`);

        expect(
            engine
                .getFontJsonSnapshot()
                .glyphs.map((entry) => entry.name)
                .sort()
        ).toEqual(['A', 'B', 'space']);
        expect(drawing(engine, 'space', 'm-thin')).toMatchObject({
            width: 220,
            shapes: []
        });
        expect(drawing(engine, 'space', 'm-black')).toMatchObject({
            width: 260,
            shapes: []
        });
        expect(drawing(engine, 'A', 'm-thin').shapes).toHaveLength(1);
        expect(drawing(engine, 'A', 'm-thin').anchors).toEqual([
            expect.objectContaining({ name: 'top', x: 300, y: 700 })
        ]);
        expect(drawing(engine, 'space', 'space-free')).toMatchObject({
            width: 240,
            shapes: []
        });
        expect(drawing(engine, 'B', 'B-thin-bg')).toMatchObject({
            is_background: true,
            shapes: []
        });
    });

    test('takes an edit to a drawing without shapes', () => {
        const engine = openRoom(writer, `backcompat-edit-${writer}`);

        engine.beginTransaction('Change width', null, {
            compileChangeSource: 'test-sync',
            compileEditType: null
        });
        engine.recordChange(
            ['glyphs', 'space', 'layers', 'm-thin'],
            'width',
            220,
            230
        );
        engine.endTransaction();

        expect(drawing(engine, 'space', 'm-thin')).toMatchObject({
            width: 230,
            shapes: []
        });
    });

    test('reads its free drawing without shapes wherever it is read by path', () => {
        const engine = openRoom(writer, `backcompat-free-${writer}`);

        engine.beginTransaction('Change width', null, {
            compileChangeSource: 'test-sync',
            compileEditType: null
        });
        engine.recordChange(
            ['glyphs', 'space', 'layers', 'space-free'],
            'width',
            240,
            245
        );
        engine.endTransaction();

        expect(
            engine._readReplaySnapshot('glyphs.space.layers.space-free')
        ).toMatchObject({
            width: 245,
            master: { type: 'FreeFloating' },
            shapes: []
        });
        expect(
            fromYType(
                engine.getYValue(['glyphs', 'space', 'layers', 'space-free'])
            )
        ).toMatchObject({ shapes: [] });
    });

    test('hands its documents on to another window', () => {
        const engine = openRoom(writer, `backcompat-source-${writer}`);
        const next = new PatchSyncEngine(`backcompat-next-${writer}`);
        next.setFontJson(sourceFont());

        expect(() =>
            next.applyDocumentSetState(engine.encodeDocumentSet())
        ).not.toThrow();
        expect(next.getFontJsonSnapshot()).toEqual(
            engine.getFontJsonSnapshot()
        );
    });

    test('seeds the real compile worker, which compiles it', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-room-'));
        try {
            const documents = readDocumentSet(writer).map((document, index) => {
                const file = `shard-${index}.bin`;
                fs.writeFileSync(
                    path.join(dir, file),
                    document.documentId === 'font-core'
                        ? ensureCoreUpdateHasGlyphsMap(document.bytes)
                        : document.bytes
                );
                return { documentId: document.documentId, file };
            });
            fs.writeFileSync(
                path.join(dir, 'seed.json'),
                JSON.stringify({ documents, options: {} })
            );
            const output = path.join(dir, 'font.ttf');
            try {
                execFileSync(process.execPath, [COMPILE_RUNNER, dir, output], {
                    stdio: 'pipe'
                });
            } catch (error) {
                throw new Error(String(error.stderr || error.message).trim());
            }
            expect(fs.statSync(output).size).toBeGreaterThan(0);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
