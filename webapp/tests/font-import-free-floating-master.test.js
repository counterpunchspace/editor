/**
 * Babelfont leaves a drawing’s `master` out for its default, FreeFloating.
 * A designspace whose UFO has a `public.background` layer comes in that
 * way, and documents uploaded before every import wrote the link hold
 * their free drawings so. Both read as `{ type: 'FreeFloating' }`; a link
 * that is present but malformed is still refused.
 */

const fs = require('fs');
const path = require('path');
const Y = require('yjs');
const { open_font_file } = require('../wasm-dist/babelfont_fontc_web');
const {
    canonicalizeImportedFontData,
    canonicalizeImportedFontJson
} = require('../js/font-import-canonicalization');
const { PatchSyncEngine } = require('../js/patch-sync-engine');
const { drawingToYMap, fromYType } = require('../js/change-bridge-ydoc');

const EXAMPLES_DIR = path.join(__dirname, '..', 'examples');
const BOLD_UFO = 'YanoneKaffeesatz-Bold.ufo';

function readDirectoryEntries(dirPath) {
    const entries = {};
    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(full);
            } else {
                entries[path.relative(dirPath, full).replace(/\\/g, '/')] =
                    fs.readFileSync(full, 'utf-8');
            }
        }
    };
    walk(dirPath);
    return entries;
}

/**
 * The example designspace with a `public.background` layer holding “A”
 * added to its Bold UFO.
 */
function designspaceWithBackgroundLayer() {
    const designspace = 'YanoneKaffeesatz.designspace';
    const entries = {
        [designspace]: fs.readFileSync(
            path.join(EXAMPLES_DIR, designspace),
            'utf-8'
        )
    };
    for (const ufo of ['YanoneKaffeesatz-ExtraLight.ufo', BOLD_UFO]) {
        for (const [relPath, contents] of Object.entries(
            readDirectoryEntries(path.join(EXAMPLES_DIR, ufo))
        )) {
            entries[`${ufo}/${relPath}`] = contents;
        }
    }
    const layerContents = `${BOLD_UFO}/layercontents.plist`;
    entries[layerContents] = entries[layerContents].replace(
        /<\/array>\s*<\/plist>\s*$/,
        `  <array>
      <string>public.background</string>
      <string>glyphs.public.background</string>
    </array>
  </array>
</plist>
`
    );
    entries[`${BOLD_UFO}/glyphs.public.background/contents.plist`] =
        `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>A</key>
    <string>A_.glif</string>
  </dict>
</plist>
`;
    entries[`${BOLD_UFO}/glyphs.public.background/A_.glif`] =
        entries[`${BOLD_UFO}/glyphs/A_.glif`];
    return { designspace, entries };
}

function backgroundDrawingsOf(glyph) {
    return glyph.layers.filter((drawing) =>
        String(drawing.id).endsWith('public.background')
    );
}

describe('an absent master is Babelfont’s FreeFloating', () => {
    test('a designspace with a UFO public.background layer opens through the engine', () => {
        const { designspace, entries } = designspaceWithBackgroundLayer();
        const sourceJson = open_font_file(designspace, JSON.stringify(entries));
        const source = JSON.parse(sourceJson);
        const sourceA = source.glyphs.find((glyph) => glyph.name === 'A');
        const [sourceBackground] = backgroundDrawingsOf(sourceA);
        // Babelfont writes the free drawing without a `master`.
        expect(sourceBackground).toBeDefined();
        expect('master' in sourceBackground).toBe(false);

        const { fontData } = canonicalizeImportedFontJson(sourceJson);
        const glyphA = fontData.glyphs.find((glyph) => glyph.name === 'A');
        const [background] = backgroundDrawingsOf(glyphA);
        expect(background.master).toEqual({ type: 'FreeFloating' });
        // Every other drawing keeps the link Babelfont wrote.
        for (const drawing of glyphA.layers) {
            const sourceDrawing = sourceA.layers.find(
                (candidate) => candidate.id === drawing.id
            );
            if (sourceDrawing !== sourceBackground) {
                expect(drawing.master).toEqual(sourceDrawing.master);
            }
        }

        const engine = new PatchSyncEngine('free-floating-import');
        expect(() => engine.initFromJson(fontData)).not.toThrow();
        const shard = engine.encodeDocumentSet().find((candidate) => {
            const doc = new Y.Doc({ gc: false });
            Y.applyUpdate(doc, candidate.bytes);
            return doc.getMap('glyph').get('name') === 'A';
        });
        expect(shard).toBeDefined();
        const doc = new Y.Doc({ gc: false });
        Y.applyUpdate(doc, shard.bytes);
        const stored = doc.getMap('glyph').get('layers').get(background.id);
        expect(fromYType(stored).master).toEqual({ type: 'FreeFloating' });
    });

    test('a present but malformed master is not taken for FreeFloating', () => {
        for (const master of [null, { type: 'Nonsense' }, 42]) {
            const source = {
                masters: [{ id: 'm1', location: {} }],
                glyphs: [
                    {
                        name: 'A',
                        layers: [{ id: 'free', width: 500, shapes: [], master }]
                    }
                ]
            };
            let fontData;
            try {
                ({ fontData } = canonicalizeImportedFontData(source));
            } catch (error) {
                // The model refuses it in development mode.
                expect(String(error)).toMatch(/Non-tagged drawing\.station/);
                continue;
            }
            const drawing = fontData.glyphs[0].layers[0];
            expect(drawing.master).toEqual(master);
            expect(() => drawingToYMap({ ...drawing })).toThrow(
                /Refused Y\.Doc write: drawing master/
            );
        }
    });
});

describe('a stored drawing without a master', () => {
    function storedDrawing(build) {
        const doc = new Y.Doc({ gc: false });
        doc.transact(() => {
            const glyph = doc.getMap('glyph');
            glyph.set('name', 'A');
            const drawings = new Y.Map();
            glyph.set('layers', drawings);
            glyph.set('layerOrder', Y.Array.from(['bg']));
            drawings.set('bg', build());
        });
        return doc.getMap('glyph').get('layers').get('bg');
    }

    test('an older document’s free drawing reads as FreeFloating', () => {
        const drawing = storedDrawing(() => {
            const map = drawingToYMap({
                id: 'bg',
                width: 500,
                is_background: true,
                master: { type: 'FreeFloating' },
                shapes: []
            });
            // Uploaded before the import wrote the link.
            map.delete('master');
            return map;
        });
        expect(fromYType(drawing).master).toEqual({ type: 'FreeFloating' });
    });

    test('a drawing map without keyed storage reads as FreeFloating too', () => {
        const drawing = storedDrawing(() => {
            const map = new Y.Map();
            map.set('id', 'bg');
            map.set('width', 500);
            return map;
        });
        expect(fromYType(drawing)).toEqual({
            id: 'bg',
            width: 500,
            master: { type: 'FreeFloating' }
        });
    });

    test('a stored master that is present stays as it is', () => {
        const drawing = storedDrawing(() => {
            const map = drawingToYMap({
                id: 'bg',
                width: 500,
                master: { type: 'FreeFloating' },
                shapes: []
            });
            map.set('master', 'garbage');
            return map;
        });
        expect(fromYType(drawing).master).toBe('garbage');
    });
});
