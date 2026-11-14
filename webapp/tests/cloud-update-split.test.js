const { TextDecoder, TextEncoder } = require('util');
global.TextEncoder = global.TextEncoder || TextEncoder;
global.TextDecoder = global.TextDecoder || TextDecoder;

const Y = require('yjs');
const {
    splitYjsUpdate,
    cloudPacketBytesForLimit,
    CLOUD_UPDATE_PART_MAX_BYTES
} = require('../js/cloud-update-split.ts');
const {
    MAX_YJS_PACKET_BYTES
} = require('../js/generated/collab-protocol-limits.ts');

function randomText(length, seed) {
    let state = seed;
    let out = '';
    for (let i = 0; i < length; i += 1) {
        state = (state * 1103515245 + 12345) & 0x7fffffff;
        out += String.fromCharCode(97 + (state % 26));
    }
    return out;
}

function baseDoc() {
    const doc = new Y.Doc({ gc: false });
    doc.transact(() => {
        doc.getMap('glyph').set('name', 'A');
        doc.getText('features').insert(0, 'feature liga {} liga;');
        doc.getArray('shapes').insert(0, ['old-shape']);
    });
    return doc;
}

function applyAll(base, updates) {
    const doc = new Y.Doc({ gc: false });
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(base));
    for (const update of updates) {
        Y.applyUpdate(doc, update);
    }
    return doc;
}

function snapshot(doc) {
    return {
        glyph: doc.getMap('glyph').toJSON(),
        features: doc.getText('features').toString(),
        shapes: doc.getArray('shapes').toJSON()
    };
}

describe('splitYjsUpdate', () => {
    test('an update that fits is returned whole', () => {
        const doc = baseDoc();
        const before = Y.encodeStateVector(doc);
        doc.getMap('glyph').set('width', 500);
        const update = Y.encodeStateAsUpdate(doc, before);
        expect(splitYjsUpdate(update)).toEqual([update]);
    });

    test('a large edit splits into parts under the packet limit that rebuild the same state', () => {
        const doc = baseDoc();
        const base = applyAll(doc, []);
        const before = Y.encodeStateVector(doc);
        doc.transact(() => {
            // A long feature file: one big string insert.
            doc.getText('features').insert(5, randomText(1_400_000, 7));
            // Many shapes, each a nested map.
            const shapes = doc.getArray('shapes');
            for (let i = 0; i < 2_000; i += 1) {
                const shape = new Y.Map();
                shape.set('nodes', randomText(60, i));
                shape.set('closed', true);
                shapes.push([shape]);
            }
            // A deletion travels with it.
            shapes.delete(0, 1);
            doc.getMap('glyph').set('name', 'A.alt');
        });
        const update = Y.encodeStateAsUpdate(doc, before);
        expect(update.byteLength).toBeGreaterThan(MAX_YJS_PACKET_BYTES);

        const parts = splitYjsUpdate(update);
        expect(parts).not.toBeNull();
        expect(parts.length).toBeGreaterThan(2);
        for (const part of parts) {
            expect(part.byteLength).toBeLessThanOrEqual(
                CLOUD_UPDATE_PART_MAX_BYTES
            );
            // Each part is a valid update on its own.
            expect(() => Y.decodeUpdate(part)).not.toThrow();
        }
        const rebuilt = applyAll(base, parts);
        expect(snapshot(rebuilt)).toEqual(snapshot(doc));
        expect(Y.encodeStateVector(rebuilt)).toEqual(Y.encodeStateVector(doc));
        expect(cloudPacketBytesForLimit(update)).toBeLessThan(
            MAX_YJS_PACKET_BYTES
        );
    });

    test('a string is never cut between the halves of a surrogate pair', () => {
        const doc = baseDoc();
        const base = applyAll(doc, []);
        const before = Y.encodeStateVector(doc);
        const text = '𝔄'.repeat(400_000);
        doc.getText('features').insert(0, text);
        const update = Y.encodeStateAsUpdate(doc, before);
        const parts = splitYjsUpdate(update);
        expect(parts.length).toBeGreaterThan(1);
        const rebuilt = applyAll(base, parts);
        expect(rebuilt.getText('features').toString()).toBe(
            doc.getText('features').toString()
        );
    });

    test('a single value larger than a packet cannot be split', () => {
        const doc = baseDoc();
        const before = Y.encodeStateVector(doc);
        doc.getMap('glyph').set(
            'blob',
            randomText(MAX_YJS_PACKET_BYTES + 10, 3)
        );
        const update = Y.encodeStateAsUpdate(doc, before);
        expect(splitYjsUpdate(update)).toBeNull();
        expect(cloudPacketBytesForLimit(update)).toBe(update.byteLength);
    });
});
