// A linked window has no cloud session: the main window projects the
// catalog (deletes, adds, renames, Unicode values) for the edits it relays
// from it, as for its own. A collaborator's edit is still left alone.

const Y = require('yjs');
const { PatchSyncEngine } = require('../js/patch-sync-engine');
const {
    CloudPlugin
} = require('../js/filesystem-plugins/plugins/cloud-plugin');

test('main tells its listeners that a relayed packet is its linked window’s edit', () => {
    const linked = new PatchSyncEngine('linked');
    const main = new PatchSyncEngine('main');
    const font = {
        upm: 1000,
        masters: [{ id: 'm1', name: { dflt: 'Regular' }, location: {} }],
        glyphs: [{ name: 'A', category: 'Base', layers: [] }]
    };
    linked.initFromJson(JSON.parse(JSON.stringify(font)));
    main.initFromJson({});
    main.applyDocumentSetState(linked.encodeDocumentSet());
    const packets = [];
    linked.onLocalUpdate((update, message, entries, documentId) =>
        packets.push({ update, message, entries, documentId })
    );
    const contexts = [];
    main.onCommittedChange((_entries, context) => contexts.push(context));
    linked.recordChange([], 'note', '', 'from the linked window');
    for (const packet of packets) {
        main.applyRemoteUpdate(
            packet.update,
            packet.entries,
            packet.message ? [packet.message] : undefined,
            packet.documentId,
            { fromLinkedWindow: true }
        );
    }
    expect(contexts.some((context) => context.fromLinkedWindow === true)).toBe(
        true
    );
    void Y;
});

test('the catalog follows a linked window’s edit, not a collaborator’s', () => {
    const plugin = new CloudPlugin();
    plugin._currentFontJson = () => ({ glyphs: [{ name: 'A', layers: [] }] });
    const projected = [];
    plugin._enqueueCatalogProjection = (update) => projected.push(update);
    const entries = [
        { op: 'set', path: 'glyphs.A:codepoints', newValue: [65] }
    ];
    plugin._syncCatalogFromCommittedChange(entries, {
        origin: 'remote',
        update: new Uint8Array()
    });
    expect(projected).toHaveLength(0);
    plugin._syncCatalogFromCommittedChange(entries, {
        origin: 'remote',
        update: new Uint8Array(),
        fromLinkedWindow: true
    });
    expect(projected).toHaveLength(1);
    expect(projected[0].catalogDirty).toBe(true);
});
