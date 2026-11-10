/**
 * @jest-environment node
 *
 * CloudDurableWal against a real IndexedDB implementation (fake-indexeddb),
 * so reopen, delete and upgrade go through actual IDB semantics rather than
 * the synchronous hand mock in cloud-durable-wal.test.js.
 */
const { IDBFactory } = require('fake-indexeddb');
const {
    CloudDurableWal,
    walUpdateBytes
} = require('../js/cloud-durable-wal.ts');

function record(clientTransactionId, overrides = {}) {
    return {
        assetId: 'asset-1',
        documentId: 'font-core',
        clientTransactionId,
        updateBytes: new Uint8Array([1, 2, 3]),
        collaborationMessage: null,
        state: 'applied',
        createdAt: 1,
        attempts: 0,
        ...overrides
    };
}

async function reopen(assetId = 'asset-1') {
    const wal = new CloudDurableWal();
    const loaded = await wal.load(assetId);
    return { wal, loaded };
}

describe('CloudDurableWal on IndexedDB', () => {
    const originalIndexedDb = global.indexedDB;
    let opened = [];

    beforeEach(() => {
        global.indexedDB = new IDBFactory();
        opened = [];
    });

    afterEach(() => {
        for (const wal of opened) {
            wal.close();
        }
        global.indexedDB = originalIndexedDb;
    });

    async function open(assetId) {
        const result = await reopen(assetId);
        opened.push(result.wal);
        return result;
    }

    test('an edit confirmed in one tab stops counting as unsent in another tab on the same font', async () => {
        const { wal: first } = await open();
        await first.append(record('shared'));
        const { wal: second } = await open();
        expect(second.pendingCount).toBe(1);
        const changed = new Promise((resolve) => second.onChange(resolve));

        await first.acknowledge(record('shared'));

        await changed;
        expect(second.pendingCount).toBe(0);
    });

    test('a newer editor in another tab can upgrade the database without losing unsent edits', async () => {
        const { wal: writer } = await open();
        await writer.append(record('unsent'));
        // The other tab opens a higher version while this log is still open.
        const upgraded = await new Promise((resolve, reject) => {
            const request = global.indexedDB.open(
                'counterpunch-cloud-outbox',
                99
            );
            request.onblocked = () => reject(new Error('upgrade was blocked'));
            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve(request.result);
        });
        const rows = await new Promise((resolve, reject) => {
            const request = upgraded
                .transaction(upgraded.objectStoreNames[0], 'readonly')
                .objectStore(upgraded.objectStoreNames[0])
                .getAll();
            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve(request.result);
        });
        upgraded.close();
        expect(rows.map((row) => row.clientTransactionId)).toEqual(['unsent']);
    });

    test('appended rows survive closing and reopening the log', async () => {
        const { wal: writer } = await open();
        await writer.append(
            record('t1', { updateBytes: new Uint8Array([9, 8, 7]) })
        );
        await writer.append(
            record('t2', { documentId: 'glyph:a', createdAt: 2 })
        );
        writer.close();

        const { wal: reader, loaded } = await open();
        expect(reader.health).toBe('ready');
        expect(loaded.map((row) => row.clientTransactionId).sort()).toEqual([
            't1',
            't2'
        ]);
        expect(reader.pendingCount).toBe(2);
        expect(reader.pendingCountFor('glyph:a')).toBe(1);
        const t1 = loaded.find((row) => row.clientTransactionId === 't1');
        expect(Array.from(walUpdateBytes(t1))).toEqual([9, 8, 7]);
    });

    test('only rows for the loaded asset come back', async () => {
        const { wal: writer } = await open('asset-1');
        await writer.append(record('mine'));
        await writer.append(record('theirs', { assetId: 'asset-2' }));
        writer.close();

        const { loaded } = await open('asset-1');
        expect(loaded.map((row) => row.clientTransactionId)).toEqual(['mine']);
    });

    test('acknowledged rows are gone after reopen', async () => {
        const { wal: writer } = await open();
        await writer.append(record('keep', { createdAt: 1 }));
        await writer.append(record('ack-one', { createdAt: 2 }));
        await writer.append(record('ack-many-1', { createdAt: 3 }));
        await writer.append(record('ack-many-2', { createdAt: 4 }));
        await writer.acknowledge(record('ack-one'));
        await writer.acknowledgeMany('asset-1', 'font-core', [
            'ack-many-1',
            'ack-many-2'
        ]);
        expect(writer.pendingCount).toBe(1);
        writer.close();

        const { wal: reader, loaded } = await open();
        expect(loaded.map((row) => row.clientTransactionId)).toEqual(['keep']);
        expect(reader.pendingCount).toBe(1);
    });

    test('acknowledging one document keeps the same transaction id on another', async () => {
        const { wal: writer } = await open();
        await writer.append(record('shared'));
        await writer.append(record('shared', { documentId: 'glyph:a' }));
        await writer.acknowledgeMany('asset-1', 'font-core', ['shared']);
        writer.close();

        const { loaded } = await open();
        expect(loaded.map((row) => row.documentId)).toEqual(['glyph:a']);
    });

    test('replay after reopen follows creation order and dependsOn', async () => {
        const { wal: writer } = await open();
        await writer.append(record('first', { createdAt: 10 }));
        await writer.append(
            record('core-rev', {
                createdAt: 20,
                dependsOn: ['glyph-edit']
            })
        );
        await writer.append(
            record('glyph-edit', { documentId: 'glyph:a', createdAt: 30 })
        );
        await writer.append(record('last', { createdAt: 40 }));
        writer.close();

        const { wal: reader } = await open();
        expect(
            reader.replayableRecords().map((row) => row.clientTransactionId)
        ).toEqual(['first', 'glyph-edit', 'core-rev', 'last']);
    });

    test('a sent row stays replayable after reopen', async () => {
        const { wal: writer } = await open();
        await writer.append(record('in-flight', { state: 'sent' }));
        writer.close();

        const { wal: reader, loaded } = await open();
        expect(loaded[0].state).toBe('sent');
        expect(
            reader.replayableRecords().map((row) => row.clientTransactionId)
        ).toEqual(['in-flight']);
    });
});
