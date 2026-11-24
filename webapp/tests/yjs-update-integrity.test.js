const Y = require('yjs');
const {
    assertUpdateIntegrates,
    applyUpdateWithIntegrity,
    ClockGapError,
    isDocumentBroken,
    assertDocumentWritable,
    BrokenDocumentError,
    isCompleteDocumentState
} = require('../js/yjs-update-integrity');

function docWithClient(clientID) {
    const doc = new Y.Doc();
    doc.clientID = clientID;
    return doc;
}

function captureUpdates(doc) {
    const updates = [];
    doc.on('update', (update) => updates.push(update));
    return updates;
}

function seedDrawing(sender, receivers) {
    sender.transact(() => {
        const drawing = new Y.Map();
        sender.getMap('layers').set('M1', drawing);
        drawing.set('id', 'M1');
        drawing.set('width', 500);
    });
    const seed = Y.encodeStateAsUpdate(sender);
    for (const receiver of receivers) Y.applyUpdate(receiver, seed);
}

describe('assertUpdateIntegrates', () => {
    test('accepts updates in order and duplicates', () => {
        const sender = docWithClient(1);
        const receiver = docWithClient(2);
        seedDrawing(sender, [receiver]);
        const updates = captureUpdates(sender);
        sender.getMap('layers').get('M1').set('width', 600);
        sender.getMap('layers').get('M1').set('width', 700);
        for (const update of [updates[0], updates[0], updates[1]]) {
            applyUpdateWithIntegrity(receiver, update, 'glyph:a');
        }
        expect(receiver.getMap('layers').get('M1').get('width')).toBe(700);
    });

    test('refuses an update whose earlier update from the same client is missing, and applies nothing', () => {
        const sender = docWithClient(1);
        const receiver = docWithClient(2);
        seedDrawing(sender, [receiver]);
        const updates = captureUpdates(sender);
        sender.getMap('layers').get('M1').set('width', 600);
        sender.getMap('layers').get('M1').set('anchors', 'x');
        const before = Y.encodeStateAsUpdate(receiver);
        expect(() =>
            applyUpdateWithIntegrity(receiver, updates[1], 'glyph:a')
        ).toThrow(ClockGapError);
        expect(receiver.getMap('layers').get('M1').get('width')).toBe(500);
        expect(Y.encodeStateAsUpdate(receiver)).toEqual(before);
        expect(receiver.store.pendingStructs).toBeNull();
        expect(isDocumentBroken(receiver)).toBe(true);
        expect(() => assertDocumentWritable(receiver, 'glyph:a')).toThrow(
            BrokenDocumentError
        );
    });

    test('refuses a baseline diff that would delete the old width while the new one is missing', () => {
        const sender = docWithClient(1);
        const receiver = docWithClient(2);
        seedDrawing(sender, [receiver]);
        const missed = Y.encodeStateVector(sender);
        sender.getMap('layers').get('M1').set('width', 600);
        const baseline = Y.encodeStateVector(sender);
        sender.getMap('layers').get('M1').set('anchors', 'x');
        const packet = Y.encodeStateAsUpdate(sender, baseline);
        expect(missed).not.toEqual(baseline);
        expect(() =>
            assertUpdateIntegrates(receiver, packet, 'glyph:a')
        ).toThrow(ClockGapError);
    });

    test('refuses an update that depends on another client’s missing item', () => {
        const first = docWithClient(1);
        const second = docWithClient(2);
        const receiver = docWithClient(3);
        seedDrawing(first, [second, receiver]);
        const firstUpdates = captureUpdates(first);
        first.getMap('layers').get('M1').set('width', 600);
        Y.applyUpdate(second, firstUpdates[0]);
        const secondUpdates = captureUpdates(second);
        second.getMap('layers').get('M1').set('width', 650);
        expect(() =>
            assertUpdateIntegrates(receiver, secondUpdates[0], 'glyph:a')
        ).toThrow(ClockGapError);
        Y.applyUpdate(receiver, firstUpdates[0]);
        applyUpdateWithIntegrity(receiver, secondUpdates[0], 'glyph:a');
        expect(receiver.getMap('layers').get('M1').get('width')).toBe(650);
    });

    test('refuses a deletion of something the copy never received', () => {
        const sender = docWithClient(1);
        const receiver = docWithClient(2);
        seedDrawing(sender, [receiver]);
        const updates = captureUpdates(sender);
        sender.getMap('layers').get('M1').set('note', 'a');
        sender.getMap('layers').get('M1').delete('note');
        expect(() =>
            assertUpdateIntegrates(receiver, updates[1], 'glyph:a')
        ).toThrow(ClockGapError);
    });

    test('accepts full state into an empty document', () => {
        const sender = docWithClient(1);
        seedDrawing(sender, []);
        sender.getMap('layers').get('M1').set('width', 600);
        const receiver = docWithClient(2);
        applyUpdateWithIntegrity(
            receiver,
            Y.encodeStateAsUpdate(sender),
            'glyph:a'
        );
        expect(receiver.getMap('layers').get('M1').toJSON()).toEqual({
            id: 'M1',
            width: 600
        });
    });
});

describe('isCompleteDocumentState', () => {
    function newGlyph(clientID) {
        const doc = docWithClient(clientID);
        doc.transact(() => {
            const glyph = doc.getMap('glyph');
            glyph.set('name', 'g');
            const layers = new Y.Map();
            glyph.set('layers', layers);
        });
        return doc;
    }

    test('a new glyph’s first packet is its complete state', () => {
        const doc = newGlyph(1);
        expect(
            isCompleteDocumentState(Y.encodeStateAsUpdate(doc), 'glyph:g')
        ).toBe(true);
    });

    test('a later edit to a glyph is not, even from a client’s clock 0', () => {
        const doc = newGlyph(1);
        const other = docWithClient(2);
        Y.applyUpdate(other, Y.encodeStateAsUpdate(doc));
        const updates = captureUpdates(other);
        other.getMap('glyph').set('category', 'Mark');
        expect(isCompleteDocumentState(updates[0], 'glyph:g')).toBe(false);
    });

    test('bytes that do not decode are not a complete state', () => {
        expect(
            isCompleteDocumentState(new Uint8Array([1, 2, 3]), 'glyph:g')
        ).toBe(false);
    });
});

// A struct the gate can’t classify (for example one made by a second copy of
// Yjs) is refused, never skipped with its origin unchecked.
test('refuses an update holding a struct of no known kind', () => {
    const sender = docWithClient(1);
    const receiver = docWithClient(2);
    const updates = captureUpdates(sender);
    sender.getMap('layers').set('x', 1);
    // As if the structs came from another copy of Yjs: no `instanceof`
    // against this copy’s classes holds.
    const classes = [Y.Item, Y.GC, Y.Skip];
    classes.forEach((cls) =>
        Object.defineProperty(cls, Symbol.hasInstance, {
            value: () => false,
            configurable: true
        })
    );
    try {
        expect(() =>
            assertUpdateIntegrates(receiver, updates[0], 'glyph:a')
        ).toThrow(/a change of a kind this window can’t check/);
    } finally {
        classes.forEach((cls) => delete cls[Symbol.hasInstance]);
    }
    expect(receiver.getMap('layers').size).toBe(0);
    expect(() =>
        assertUpdateIntegrates(receiver, updates[0], 'glyph:a')
    ).not.toThrow();
});

// The bundle is minified, so Yjs’s classes carry mangled names there. The
// gate must tell structs apart by class, never by name.
describe('assertUpdateIntegrates with mangled class names', () => {
    const renamed = [Y.Item, Y.Skip, Y.GC];
    let originals;
    beforeEach(() => {
        originals = renamed.map((cls) =>
            Object.getOwnPropertyDescriptor(cls, 'name')
        );
        renamed.forEach((cls, index) =>
            Object.defineProperty(cls, 'name', { value: `m${index}` })
        );
    });
    afterEach(() => {
        renamed.forEach((cls, index) =>
            Object.defineProperty(cls, 'name', originals[index])
        );
    });

    test('the names really are mangled for the test', () => {
        expect(Y.Item.name).not.toBe('Item');
        expect(Y.Skip.name).not.toBe('Skip');
    });

    test('refuses a merged update that skips a missing update', () => {
        const sender = docWithClient(1);
        const receiver = docWithClient(2);
        seedDrawing(sender, [receiver]);
        const updates = captureUpdates(sender);
        const drawing = sender.getMap('layers').get('M1');
        drawing.set('width', 600);
        drawing.set('note', 'a');
        drawing.set('anchors', 'x');
        const merged = Y.mergeUpdates([updates[0], updates[2]]);
        const structs = Y.decodeUpdate(merged).structs;
        expect(structs.some((struct) => struct instanceof Y.Skip)).toBe(true);
        const before = Y.encodeStateAsUpdate(receiver);
        expect(() =>
            applyUpdateWithIntegrity(receiver, merged, 'glyph:skip')
        ).toThrow(ClockGapError);
        expect(Y.encodeStateAsUpdate(receiver)).toEqual(before);
        expect(receiver.getMap('layers').get('M1').get('width')).toBe(500);
    });

    test('refuses an update whose origin is another client’s missing item, before anything is applied', () => {
        const first = docWithClient(1);
        const second = docWithClient(2);
        const receiver = docWithClient(3);
        seedDrawing(first, [second, receiver]);
        const firstUpdates = captureUpdates(first);
        first.getMap('layers').get('M1').set('width', 600);
        Y.applyUpdate(second, firstUpdates[0]);
        const secondUpdates = captureUpdates(second);
        second.getMap('layers').get('M1').set('width', 650);
        const seen = [];
        receiver.on('update', (update) => seen.push(update));
        expect(() =>
            applyUpdateWithIntegrity(receiver, secondUpdates[0], 'glyph:origin')
        ).toThrow('a change it builds on is missing');
        expect(seen).toEqual([]);
        expect(receiver.getMap('layers').get('M1').get('width')).toBe(500);
    });
});

describe('broken records by document id', () => {
    const {
        createBrokenDocumentScope,
        clearBrokenDocumentScope,
        markDocumentBroken,
        getBrokenDocuments,
        isDocumentIdBroken
    } = require('../js/yjs-update-integrity');

    const listed = (documentId) =>
        getBrokenDocuments().some((entry) => entry.documentId === documentId);

    test('a document marked while not held is refused when it loads, and is listed', () => {
        const scope = createBrokenDocumentScope();
        markDocumentBroken(null, 'glyph:absent', new Error('lost'), scope);
        expect(isDocumentIdBroken(scope, 'glyph:absent')).toBe(true);
        expect(listed('glyph:absent')).toBe(true);
        const loaded = new Y.Doc();
        const source = docWithClient(9);
        source.getMap('glyph').set('name', 'absent');
        expect(() =>
            applyUpdateWithIntegrity(
                loaded,
                Y.encodeStateAsUpdate(source),
                'glyph:absent',
                undefined,
                scope
            )
        ).toThrow(BrokenDocumentError);
        expect(loaded.getMap('glyph').get('name')).toBeUndefined();
        expect(() =>
            assertDocumentWritable(loaded, 'glyph:absent', scope)
        ).toThrow(BrokenDocumentError);
        clearBrokenDocumentScope(scope);
    });

    test('the record outlives its document object and ends with its scope', () => {
        const scope = createBrokenDocumentScope();
        const doc = new Y.Doc();
        markDocumentBroken(doc, 'glyph:held', new Error('lost'), scope);
        doc.destroy();
        expect(isDocumentBroken(doc)).toBe(false);
        expect(isDocumentIdBroken(scope, 'glyph:held')).toBe(true);
        expect(
            getBrokenDocuments().filter((e) => e.documentId === 'glyph:held')
        ).toHaveLength(1);
        clearBrokenDocumentScope(scope);
        expect(listed('glyph:held')).toBe(false);
    });

    test('another scope with the same document id is not affected', () => {
        const broken = createBrokenDocumentScope();
        const other = createBrokenDocumentScope();
        markDocumentBroken(null, 'glyph:shared', new Error('lost'), broken);
        expect(() =>
            assertDocumentWritable(new Y.Doc(), 'glyph:shared', other)
        ).not.toThrow();
        clearBrokenDocumentScope(broken);
        clearBrokenDocumentScope(other);
    });
});
