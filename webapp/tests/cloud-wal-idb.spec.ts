import { test, expect } from '@playwright/test';

test('IndexedDB WAL round-trip survives a new connection', async ({ page }) => {
    await page.goto('about:blank');
    const roundTrip = await page.evaluate(async () => {
        const dbName = 'counterpunch-cloud-outbox-e2e';
        const storeName = 'pending-transactions';
        await new Promise<void>((resolve, reject) => {
            const request = indexedDB.deleteDatabase(dbName);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
            request.onblocked = () => resolve();
        });
        const bytes = new Uint8Array([11, 22, 33, 44]);
        await new Promise<void>((resolve, reject) => {
            const open = indexedDB.open(dbName, 1);
            open.onupgradeneeded = () => {
                open.result.createObjectStore(storeName, { keyPath: 'key' });
            };
            open.onerror = () => reject(open.error);
            open.onsuccess = () => {
                const db = open.result;
                const tx = db.transaction(storeName, 'readwrite');
                tx.objectStore(storeName).put({
                    key: 'asset-1:font-core:e2e',
                    assetId: 'asset-1',
                    documentId: 'font-core',
                    clientTransactionId: 'e2e',
                    updateBytes: bytes.slice()
                });
                tx.oncomplete = () => {
                    db.close();
                    resolve();
                };
                tx.onerror = () => reject(tx.error);
            };
        });
        return await new Promise<number[]>((resolve, reject) => {
            const open = indexedDB.open(dbName, 1);
            open.onerror = () => reject(open.error);
            open.onsuccess = () => {
                const db = open.result;
                const tx = db.transaction(storeName, 'readonly');
                const get = tx
                    .objectStore(storeName)
                    .get('asset-1:font-core:e2e');
                get.onerror = () => reject(get.error);
                get.onsuccess = () => {
                    const stored = get.result?.updateBytes as Uint8Array;
                    db.close();
                    resolve(Array.from(stored || []));
                };
            };
        });
    });
    expect(roundTrip).toEqual([11, 22, 33, 44]);
});
