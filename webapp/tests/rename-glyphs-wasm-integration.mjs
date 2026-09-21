import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Y = require('yjs');
const wasmDir = new URL('../wasm-dist/', import.meta.url);
const tempDir = mkdtempSync(join(tmpdir(), 'counterpunch-rename-wasm-'));
const gluePath = join(tempDir, 'babelfont_fontc_web.mjs');
const wasmPath = join(tempDir, 'babelfont_fontc_web_bg.wasm');

function setRecord(target, record) {
    for (const [key, value] of Object.entries(record)) {
        if (Array.isArray(value)) {
            const array = new Y.Array();
            target.set(key, array);
            array.push(value);
        } else if (value && typeof value === 'object') {
            const map = new Y.Map();
            target.set(key, map);
            setRecord(map, value);
        } else {
            target.set(key, value);
        }
    }
}

function setGlyph(glyphs, name, reference) {
    const glyph = new Y.Map();
    glyphs.set(name, glyph);
    // Only encoded bases get codepoints. Locl variants must stay unencoded so
    // a rename like fourFarsi-ar.locl → fourFarsi-arabic.locl cannot collide.
    const codepoint =
        name === 'fourFarsi-ar'
            ? 0x06f4
            : name === 'sevenFarsi-ar'
              ? 0x06f7
              : undefined;
    setRecord(glyph, {
        category: 'Base',
        exported: true,
        codepoints: codepoint === undefined ? [] : [codepoint],
        format_specific: {}
    });

    const layers = new Y.Map();
    glyph.set('layers', layers);
    const layer = new Y.Map();
    layers.set('layer-1', layer);
    setRecord(layer, {
        id: 'layer-1',
        master: { type: 'DefaultForMaster', master: 'master-regular' },
        width: 600,
        shapes: reference ? [{ reference, transform: {} }] : [],
        anchors: [],
        guides: [],
        format_specific: {}
    });
}

function createFontDocument() {
    const doc = new Y.Doc();
    const font = doc.getMap('font');
    setRecord(font, {
        upm: 1000,
        version: [1, 0],
        note: '',
        date: '2026-01-01T00:00:00.000Z',
        names: { family_name: { dflt: 'Rename Test' } },
        first_kern_groups: {},
        second_kern_groups: {},
        format_specific: {},
        axes: [
            {
                name: { dflt: 'Weight' },
                tag: 'wght',
                min: 100,
                max: 900,
                default: 400
            }
        ],
        instances: [],
        masters: [
            {
                name: { dflt: 'Regular' },
                id: 'master-regular',
                location: { wght: 400 },
                guides: [],
                metrics: {},
                kerning: {},
                custom_ot_values: {},
                format_specific: {}
            }
        ]
    });

    const glyphs = new Y.Map();
    font.set('glyphs', glyphs);
    setGlyph(glyphs, 'fourFarsi-ar');
    setGlyph(glyphs, 'sevenFarsi-ar');
    setGlyph(glyphs, 'fourFarsi-ar.locl', 'fourFarsi-ar');
    setGlyph(glyphs, 'sevenFarsi-ar.locl', 'sevenFarsi-ar');

    const features = new Y.Map();
    font.set('features', features);
    features.set('classes', new Y.Map());
    features.set('prefixes', new Y.Map());
    const featureList = new Y.Array();
    featureList.push([
        [
            'locl',
            {
                code:
                    'script arab;\n' +
                    'language FAR;\n' +
                    'sub fourFarsi-ar by fourFarsi-ar.locl;\n' +
                    'sub sevenFarsi-ar by sevenFarsi-ar.locl;'
            }
        ]
    ]);
    features.set('features', featureList);

    return { doc, glyphs, featureList };
}

try {
    copyFileSync(new URL('babelfont_fontc_web.js', wasmDir), gluePath);
    copyFileSync(new URL('babelfont_fontc_web_bg.wasm', wasmDir), wasmPath);
    const wasm = await import(pathToFileURL(gluePath));
    wasm.initSync({ module: readFileSync(wasmPath) });

    const invalid = createFontDocument();
    wasm.init_ydoc_from_state(Y.encodeStateAsUpdate(invalid.doc));
    const invalidStateVector = Y.encodeStateVector(invalid.doc);
    invalid.doc.transact(() => {
        invalid.glyphs.delete('fourFarsi-ar.locl');
        invalid.glyphs.delete('sevenFarsi-ar.locl');
        setGlyph(invalid.glyphs, 'fourFarsi-arabic.locl', 'fourFarsi-ar');
        setGlyph(invalid.glyphs, 'sevenFarsi-arabic.locl', 'sevenFarsi-ar');
    });
    assert.throws(
        () =>
            wasm.apply_yjs_update(
                Y.encodeStateAsUpdate(invalid.doc, invalidStateVector),
                JSON.stringify({
                    changedGlyphs: [
                        'fourFarsi-ar.locl',
                        'fourFarsi-arabic.locl',
                        'sevenFarsi-ar.locl',
                        'sevenFarsi-arabic.locl'
                    ],
                    nonGlyphChangeHints: ['feature-code'],
                    glyphRenames: [
                        {
                            oldName: 'fourFarsi-ar.locl',
                            newName: 'fourFarsi-arabic.locl'
                        },
                        {
                            oldName: 'sevenFarsi-ar.locl',
                            newName: 'sevenFarsi-arabic.locl'
                        }
                    ],
                    invalidateLayoutClosure: true
                })
            ),
        /neither a known glyph|feature parsing failed|glyph rename transaction/
    );
    // Yrs cannot roll back the applied packet, so a rejected rename drops the
    // worker Y.Doc. The unpublished candidate cache must not compile.
    assert.throws(() => wasm.compile_cached_font({}), /No font loaded/);

    const { doc, glyphs, featureList } = createFontDocument();
    wasm.init_ydoc_from_state(Y.encodeStateAsUpdate(doc));

    const stateVector = Y.encodeStateVector(doc);
    doc.transact(() => {
        glyphs.delete('fourFarsi-ar.locl');
        glyphs.delete('sevenFarsi-ar.locl');
        setGlyph(glyphs, 'fourFarsi-arabic.locl', 'fourFarsi-ar');
        setGlyph(glyphs, 'sevenFarsi-arabic.locl', 'sevenFarsi-ar');
        featureList.delete(0, 1);
        featureList.push([
            [
                'locl',
                {
                    code:
                        'script arab;\n' +
                        'language FAR;\n' +
                        'sub fourFarsi-ar by fourFarsi-arabic.locl;\n' +
                        'sub sevenFarsi-ar by sevenFarsi-arabic.locl;'
                }
            ]
        ]);
    });

    const result = JSON.parse(
        wasm.apply_yjs_update(
            Y.encodeStateAsUpdate(doc, stateVector),
            JSON.stringify({
                changedGlyphs: [
                    'fourFarsi-ar.locl',
                    'fourFarsi-arabic.locl',
                    'sevenFarsi-ar.locl',
                    'sevenFarsi-arabic.locl'
                ],
                nonGlyphChangeHints: ['feature-code'],
                glyphRenames: [
                    {
                        oldName: 'fourFarsi-ar.locl',
                        newName: 'fourFarsi-arabic.locl'
                    },
                    {
                        oldName: 'sevenFarsi-ar.locl',
                        newName: 'sevenFarsi-arabic.locl'
                    }
                ],
                invalidateLayoutClosure: true
            })
        )
    );
    assert.equal(result.workerCacheStatus.coherent, true);
    assert.ok(
        wasm.compile_cached_font({}).length > 0,
        'cached compilation must parse features against the renamed dotted glyph'
    );

    // Fustat-shaped regression: component edits are recorded under the old
    // glyph name before identity remove/add, so the worker still receives a
    // layerTarget for sevenFarsi-ar.tf after that key no longer exists in Y.Doc.
    const composite = createFontDocument();
    setGlyph(composite.glyphs, 'seven-ar.tf');
    setGlyph(composite.glyphs, 'sevenFarsi-ar.tf', 'seven-ar.tf');
    const compositeLayerId = '3114FB65-9464-41A5-B67E-A8F9F43C0EF1';
    {
        const tfGlyph = composite.glyphs.get('sevenFarsi-ar.tf');
        const layers = tfGlyph.get('layers');
        layers.delete('layer-1');
        const layer = new Y.Map();
        layers.set(compositeLayerId, layer);
        setRecord(layer, {
            id: compositeLayerId,
            master: { type: 'DefaultForMaster', master: 'master-regular' },
            width: 600,
            shapes: [{ reference: 'seven-ar.tf', transform: {} }],
            anchors: [],
            guides: [],
            format_specific: {}
        });
    }
    wasm.init_ydoc_from_state(Y.encodeStateAsUpdate(composite.doc));
    const compositeStateVector = Y.encodeStateVector(composite.doc);
    composite.doc.transact(() => {
        composite.glyphs.delete('sevenFarsi-ar.tf');
        setGlyph(composite.glyphs, 'sevenFarsi-arabic.tf', 'seven-ar.tf');
        const renamed = composite.glyphs.get('sevenFarsi-arabic.tf');
        const layers = renamed.get('layers');
        layers.delete('layer-1');
        const layer = new Y.Map();
        layers.set(compositeLayerId, layer);
        setRecord(layer, {
            id: compositeLayerId,
            master: { type: 'DefaultForMaster', master: 'master-regular' },
            width: 600,
            shapes: [{ reference: 'seven-ar.tf', transform: {} }],
            anchors: [],
            guides: [],
            format_specific: {}
        });
    });

    const compositeResult = JSON.parse(
        wasm.apply_yjs_update(
            Y.encodeStateAsUpdate(composite.doc, compositeStateVector),
            JSON.stringify({
                changedGlyphs: ['sevenFarsi-ar.tf', 'sevenFarsi-arabic.tf'],
                layerTargets: [
                    {
                        glyphName: 'sevenFarsi-ar.tf',
                        layerId: compositeLayerId
                    }
                ],
                nonGlyphChangeHints: ['feature-code'],
                glyphRenames: [
                    {
                        oldName: 'sevenFarsi-ar.tf',
                        newName: 'sevenFarsi-arabic.tf'
                    }
                ],
                invalidateLayoutClosure: true
            })
        )
    );
    assert.equal(compositeResult.workerCacheStatus.coherent, true);
    assert.ok(
        wasm.compile_cached_font({}).length > 0,
        'rename must ignore stale layerTargets under the pre-rename glyph name'
    );
} finally {
    rmSync(tempDir, { force: true, recursive: true });
}
