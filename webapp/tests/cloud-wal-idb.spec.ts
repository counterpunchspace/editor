import { test, expect } from '@playwright/test';

async function openWalOrigin(
    page: import('@playwright/test').Page
): Promise<void> {
    await page.route('https://wal.test/**', async (route) => {
        await route.fulfill({
            status: 200,
            contentType: 'text/html',
            body: '<!doctype html><title>wal</title>'
        });
    });
    await page.goto('https://wal.test/integrity');
}

test('IndexedDB WAL v1 keys survive a version 2 upgrade', async ({ page }) => {
    await openWalOrigin(page);
    const result = await page.evaluate(async () => {
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
                    updateBytes: bytes.slice(),
                    state: 'prepared'
                });
                tx.oncomplete = () => {
                    db.close();
                    resolve();
                };
                tx.onerror = () => reject(tx.error);
            };
        });
        const upgraded = await new Promise<{
            bytes: number[];
            state: string;
        }>((resolve, reject) => {
            const open = indexedDB.open(dbName, 2);
            open.onupgradeneeded = () => {
                if (!open.result.objectStoreNames.contains(storeName)) {
                    open.result.createObjectStore(storeName, {
                        keyPath: 'key'
                    });
                }
            };
            open.onerror = () => reject(open.error);
            open.onsuccess = () => {
                const db = open.result;
                const tx = db.transaction(storeName, 'readonly');
                const get = tx
                    .objectStore(storeName)
                    .get('asset-1:font-core:e2e');
                get.onerror = () => reject(get.error);
                get.onsuccess = () => {
                    const stored = get.result;
                    db.close();
                    resolve({
                        bytes: Array.from(
                            (stored?.updateBytes as Uint8Array) || []
                        ),
                        state: String(stored?.state || '')
                    });
                };
            };
        });
        return upgraded;
    });
    expect(result.bytes).toEqual([11, 22, 33, 44]);
    expect(result.state).toBe('prepared');
});

test('WAL crash checkpoints persist prepared/applied/sent before prune', async ({
    page
}) => {
    await openWalOrigin(page);
    const states = await page.evaluate(async () => {
        const dbName = 'counterpunch-cloud-outbox-crash';
        const storeName = 'pending-transactions';
        await new Promise<void>((resolve, reject) => {
            const request = indexedDB.deleteDatabase(dbName);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
            request.onblocked = () => resolve();
        });
        const putState = (state: string) =>
            new Promise<void>((resolve, reject) => {
                const open = indexedDB.open(dbName, 2);
                open.onupgradeneeded = () => {
                    if (!open.result.objectStoreNames.contains(storeName)) {
                        open.result.createObjectStore(storeName, {
                            keyPath: 'key'
                        });
                    }
                };
                open.onerror = () => reject(open.error);
                open.onsuccess = () => {
                    const db = open.result;
                    const tx = db.transaction(storeName, 'readwrite');
                    tx.objectStore(storeName).put({
                        key: 'asset-1:font-core:crash',
                        assetId: 'asset-1',
                        documentId: 'font-core',
                        clientTransactionId: 'crash',
                        schemaVersion: 2,
                        state,
                        operations: [
                            { op: 'set', path: ['width'], newValue: 1 }
                        ]
                    });
                    tx.oncomplete = () => {
                        db.close();
                        resolve();
                    };
                    tx.onerror = () => reject(tx.error);
                };
            });
        const readState = () =>
            new Promise<string>((resolve, reject) => {
                const open = indexedDB.open(dbName, 2);
                open.onerror = () => reject(open.error);
                open.onsuccess = () => {
                    const db = open.result;
                    const tx = db.transaction(storeName, 'readonly');
                    const get = tx
                        .objectStore(storeName)
                        .get('asset-1:font-core:crash');
                    get.onerror = () => reject(get.error);
                    get.onsuccess = () => {
                        const state = String(get.result?.state || '');
                        db.close();
                        resolve(state);
                    };
                };
            });
        const observed: string[] = [];
        for (const state of ['prepared', 'applied', 'sent']) {
            await putState(state);
            observed.push(await readState());
        }
        await new Promise<void>((resolve, reject) => {
            const open = indexedDB.open(dbName, 2);
            open.onerror = () => reject(open.error);
            open.onsuccess = () => {
                const db = open.result;
                const tx = db.transaction(storeName, 'readwrite');
                tx.objectStore(storeName).delete('asset-1:font-core:crash');
                tx.oncomplete = () => {
                    db.close();
                    resolve();
                };
                tx.onerror = () => reject(tx.error);
            };
        });
        observed.push(await readState());
        return observed;
    });
    expect(states).toEqual(['prepared', 'applied', 'sent', '']);
});
