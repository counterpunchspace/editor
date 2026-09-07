import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from './fixtures';
import {
    openFileFromFilesView,
    waitForCanvasReady,
    waitForOpenSessionReady
} from './helpers/snapshot-helper';
import { waitForBridgeReady } from './helpers/change-bridge-cross-window';
import {
    attachCloudCollabCookies,
    bootstrapCloudCollabSession,
    cleanupCloudCollabUsers,
    makeCloudCollabEmails
} from './helpers/cloud-collab-session';
import {
    LOCAL_EDITOR_ORIGIN,
    LOCAL_ROOM_ORIGIN,
    LOCAL_WEBSITE_ORIGIN,
    assertServiceReachable
} from './helpers/cloud-collab-e2e';

/**
 * Opt-in Fustat shard I/O concurrency bench.
 *
 * Reuses CloudAdapter.seedDocumentSet / hydrateDocumentSet via
 * CloudPlugin.measureCloudSeedBatch / measureCloudHydrateBatch.
 * Not part of Jest or default Playwright (`*.spec.ts`) runs.
 *
 *   CLOUD_COLLAB_E2E=1 SHARD_IO_BENCH=1 npm run bench:cloud-shard-io
 *
 * Optional:
 *   SHARD_IO_BENCH_LEVELS=1,4,6,8,16,24,32
 *   SHARD_IO_BENCH_GET_ITERS=2
 */

const RESULTS_PATH = path.join(
    __dirname,
    'cloud-shard-concurrency.bench-last.json'
);

function parseLevels(): number[] {
    const raw = process.env.SHARD_IO_BENCH_LEVELS || '1,4,6,8,16,24,32';
    const levels = raw
        .split(',')
        .map((part) => Number(part.trim()))
        .filter((n) => Number.isFinite(n) && n >= 1)
        .map((n) => Math.floor(n));
    return [...new Set(levels)].sort((a, b) => a - b);
}

const GET_ITERS = Math.max(
    1,
    Number(process.env.SHARD_IO_BENCH_GET_ITERS || 2)
);

type SeedSample = {
    concurrency: number;
    seedMs: number;
    shardCount: number;
    byteLength: number;
    assetId: string;
};

type HydrateSample = {
    concurrency: number;
    hydrateMs: number;
    loaded: number;
    byteLength: number;
};

function pickOptimum(
    rows: Array<{ concurrency: number; ms: number }>,
    slack: number
): { concurrency: number; ms: number; reason: string } {
    if (!rows.length) {
        throw new Error('no samples');
    }
    const best = rows.reduce((a, b) => (a.ms <= b.ms ? a : b));
    const within = rows.filter((row) => row.ms <= best.ms * (1 + slack));
    const chosen = within.reduce((a, b) =>
        a.concurrency <= b.concurrency ? a : b
    );
    return {
        concurrency: chosen.concurrency,
        ms: chosen.ms,
        reason: `lowest concurrency within ${(slack * 100).toFixed(0)}% of fastest (${best.concurrency} @ ${best.ms.toFixed(0)}ms)`
    };
}

function formatRow(
    label: string,
    concurrency: number,
    ms: number,
    shards: number,
    bytes: number
): string {
    const perShard = shards ? ms / shards : 0;
    const mib = bytes / (1024 * 1024);
    return `${label.padEnd(6)} conc=${String(concurrency).padStart(2)}  ${ms.toFixed(0).padStart(7)}ms  ${mib.toFixed(2).padStart(6)} MiB  ${perShard.toFixed(1)} ms/shard`;
}

test.describe('Cloud shard GET/POST concurrency bench (Fustat)', () => {
    test.skip(
        process.env.SHARD_IO_BENCH !== '1',
        'Opt in with SHARD_IO_BENCH=1 npm run bench:cloud-shard-io'
    );

    test('sweep seed POST and full hydrate GET concurrency', async ({
        browser,
        request
    }) => {
        test.skip(
            process.env.SHARD_IO_BENCH_SWEEP !== '1',
            'Opt in with SHARD_IO_BENCH_SWEEP=1'
        );
        test.setTimeout(5_400_000);
        const levels = parseLevels();
        await assertServiceReachable(
            request,
            `${LOCAL_EDITOR_ORIGIN}/?test=true`,
            'Editor'
        );
        await assertServiceReachable(
            request,
            `${LOCAL_WEBSITE_ORIGIN}/`,
            'Website'
        );
        await assertServiceReachable(
            request,
            `${LOCAL_ROOM_ORIGIN}/`,
            'Collab room'
        );

        const runId = `shardio-${Date.now().toString(36)}`;
        const emails = makeCloudCollabEmails(runId);
        const ownerSession = await bootstrapCloudCollabSession(
            request,
            emails.owner,
            'owner'
        );
        const ownerContext = await browser.newContext();
        await attachCloudCollabCookies(ownerContext, ownerSession);
        const page = await ownerContext.newPage();
        const seedSamples: SeedSample[] = [];
        const hydrateSamples: HydrateSample[] = [];
        try {
            await page.goto('/?test=true');
            await waitForCanvasReady(page);
            await openFileFromFilesView(page, 'Fustat.glyphs');
            await waitForOpenSessionReady(page, 'Fustat.glyphs');
            await waitForBridgeReady(page);

            const fontMeta = await page.evaluate(() => {
                const plugin = (window as any).cloudPlugin;
                const shards =
                    window.patchSyncEngine?.encodeDocumentSet?.() ?? [];
                return {
                    hasPlugin:
                        typeof plugin?.measureCloudSeedBatch === 'function',
                    shardCount: shards.length,
                    byteLength: shards.reduce(
                        (sum: number, shard: { bytes?: Uint8Array }) =>
                            sum + (shard.bytes?.byteLength || 0),
                        0
                    )
                };
            });
            expect(fontMeta.hasPlugin).toBe(true);
            expect(fontMeta.shardCount).toBeGreaterThan(2);
            console.log(
                `[shard-io-bench] Fustat shards=${fontMeta.shardCount} bytes=${fontMeta.byteLength} levels=${levels.join(',')}`
            );

            let hydrateTarget: {
                assetId: string;
                documentIds: string[];
            } | null = null;

            for (const concurrency of levels) {
                const sample = await page.evaluate(
                    async ({ assetName, concurrency: conc }) => {
                        const plugin = (window as any).cloudPlugin;
                        return plugin.measureCloudSeedBatch(assetName, conc);
                    },
                    {
                        assetName: `Fustat-shardio-${runId}-p${concurrency}`,
                        concurrency
                    }
                );
                seedSamples.push({
                    concurrency,
                    seedMs: sample.seedMs,
                    shardCount: sample.shardCount,
                    byteLength: sample.byteLength,
                    assetId: sample.assetId
                });
                console.log(
                    formatRow(
                        'POST',
                        concurrency,
                        sample.seedMs,
                        sample.shardCount,
                        sample.byteLength
                    )
                );
                hydrateTarget = {
                    assetId: sample.assetId,
                    documentIds: sample.documentIds
                };
            }

            expect(hydrateTarget).toBeTruthy();
            const target = hydrateTarget!;

            console.log(
                `[shard-io-bench] GET warmup at conc=8 on ${target.assetId}`
            );
            await page.evaluate(async ({ assetId, documentIds }) => {
                const plugin = (window as any).cloudPlugin;
                return plugin.measureCloudHydrateBatch(assetId, documentIds, 8);
            }, target);

            for (const concurrency of levels) {
                const iters: number[] = [];
                let loaded = 0;
                let byteLength = 0;
                for (let i = 0; i < GET_ITERS; i += 1) {
                    const sample = await page.evaluate(
                        async ({ assetId, documentIds, concurrency: conc }) => {
                            const plugin = (window as any).cloudPlugin;
                            return plugin.measureCloudHydrateBatch(
                                assetId,
                                documentIds,
                                conc
                            );
                        },
                        { ...target, concurrency }
                    );
                    iters.push(sample.hydrateMs);
                    loaded = sample.loaded;
                    byteLength = sample.byteLength;
                }
                const hydrateMs = [...iters].sort((a, b) => a - b)[
                    Math.floor(iters.length / 2)
                ];
                hydrateSamples.push({
                    concurrency,
                    hydrateMs,
                    loaded,
                    byteLength
                });
                console.log(
                    formatRow(
                        'GET',
                        concurrency,
                        hydrateMs,
                        loaded,
                        byteLength
                    ) + (GET_ITERS > 1 ? `  (median of ${GET_ITERS})` : '')
                );
            }

            const postPick = pickOptimum(
                seedSamples.map((row) => ({
                    concurrency: row.concurrency,
                    ms: row.seedMs
                })),
                0.08
            );
            const getPick = pickOptimum(
                hydrateSamples.map((row) => ({
                    concurrency: row.concurrency,
                    ms: row.hydrateMs
                })),
                0.05
            );

            const report = {
                at: new Date().toISOString(),
                font: 'Fustat.glyphs',
                http2: true,
                shardCount: seedSamples[0]?.shardCount ?? null,
                seedBytes: seedSamples[0]?.byteLength ?? null,
                levels,
                seedSamples,
                hydrateSamples,
                recommended: {
                    SEED_SHARD_CONCURRENCY: postPick.concurrency,
                    HYDRATE_SHARD_CONCURRENCY: getPick.concurrency,
                    seedReason: postPick.reason,
                    hydrateReason: getPick.reason
                }
            };
            fs.writeFileSync(
                RESULTS_PATH,
                `${JSON.stringify(report, null, 2)}\n`
            );
            console.log(
                `[shard-io-bench] recommend POST=${postPick.concurrency} GET=${getPick.concurrency}`
            );
            console.log(`[shard-io-bench] wrote ${RESULTS_PATH}`);
            expect(postPick.concurrency).toBeGreaterThanOrEqual(1);
            expect(getPick.concurrency).toBeGreaterThanOrEqual(1);
        } finally {
            await ownerContext.close();
            await cleanupCloudCollabUsers(request, [emails.owner]);
        }
    });

    test('pack vs sequential seed and full hydrate', async ({
        browser,
        request
    }) => {
        test.setTimeout(5_400_000);
        await assertServiceReachable(
            request,
            `${LOCAL_EDITOR_ORIGIN}/?test=true`,
            'Editor'
        );
        await assertServiceReachable(
            request,
            `${LOCAL_WEBSITE_ORIGIN}/`,
            'Website'
        );
        await assertServiceReachable(
            request,
            `${LOCAL_ROOM_ORIGIN}/`,
            'Collab room'
        );

        const runId = `packio-${Date.now().toString(36)}`;
        const emails = makeCloudCollabEmails(runId);
        const ownerSession = await bootstrapCloudCollabSession(
            request,
            emails.owner,
            'owner'
        );
        const ownerContext = await browser.newContext();
        await attachCloudCollabCookies(ownerContext, ownerSession);
        const page = await ownerContext.newPage();
        try {
            await page.goto('/?test=true');
            await waitForCanvasReady(page);
            await openFileFromFilesView(page, 'Fustat.glyphs');
            await waitForOpenSessionReady(page, 'Fustat.glyphs');
            await waitForBridgeReady(page);

            const sequentialSeed = await page.evaluate(async (assetName) => {
                const plugin = (window as any).cloudPlugin;
                return plugin.measureCloudSeedBatch(assetName, 1, {
                    transport: 'per-shard'
                });
            }, `Fustat-seq-${runId}`);
            console.log(
                formatRow(
                    'POST-seq',
                    1,
                    sequentialSeed.seedMs,
                    sequentialSeed.shardCount,
                    sequentialSeed.byteLength
                )
            );

            const sequentialHydrate = await page.evaluate(
                async ({ assetId, documentIds }) => {
                    const plugin = (window as any).cloudPlugin;
                    return plugin.measureCloudHydrateBatch(
                        assetId,
                        documentIds,
                        1,
                        { transport: 'per-shard' }
                    );
                },
                {
                    assetId: sequentialSeed.assetId,
                    documentIds: sequentialSeed.documentIds
                }
            );
            console.log(
                formatRow(
                    'GET-seq',
                    1,
                    sequentialHydrate.hydrateMs,
                    sequentialHydrate.loaded,
                    sequentialHydrate.byteLength
                )
            );

            const packSeed = await page.evaluate(async (assetName) => {
                const plugin = (window as any).cloudPlugin;
                return plugin.measureCloudSeedBatch(assetName, 1, {
                    transport: 'pack'
                });
            }, `Fustat-pack-${runId}`);
            console.log(
                formatRow(
                    'POST-pack',
                    1,
                    packSeed.seedMs,
                    packSeed.shardCount,
                    packSeed.byteLength
                )
            );

            await page.evaluate(
                async ({ assetId, documentIds }) => {
                    const plugin = (window as any).cloudPlugin;
                    return plugin.measureCloudHydrateBatch(
                        assetId,
                        documentIds,
                        6,
                        { transport: 'pack' }
                    );
                },
                {
                    assetId: packSeed.assetId,
                    documentIds: packSeed.documentIds
                }
            );
            const packHydrate = await page.evaluate(
                async ({ assetId, documentIds }) => {
                    const plugin = (window as any).cloudPlugin;
                    return plugin.measureCloudHydrateBatch(
                        assetId,
                        documentIds,
                        6,
                        { transport: 'pack' }
                    );
                },
                {
                    assetId: packSeed.assetId,
                    documentIds: packSeed.documentIds
                }
            );
            console.log(
                formatRow(
                    'GET-pack',
                    6,
                    packHydrate.hydrateMs,
                    packHydrate.loaded,
                    packHydrate.byteLength
                )
            );

            const seedSpeedup = sequentialSeed.seedMs / packSeed.seedMs;
            const hydrateSpeedup =
                sequentialHydrate.hydrateMs / packHydrate.hydrateMs;
            const report = {
                at: new Date().toISOString(),
                font: 'Fustat.glyphs',
                sequentialSeedMs: sequentialSeed.seedMs,
                packSeedMs: packSeed.seedMs,
                seedSpeedup,
                sequentialHydrateMs: sequentialHydrate.hydrateMs,
                packHydrateMs: packHydrate.hydrateMs,
                hydrateSpeedup,
                shardCount: packSeed.shardCount,
                loaded: packHydrate.loaded
            };
            fs.writeFileSync(
                RESULTS_PATH,
                `${JSON.stringify(report, null, 2)}\n`
            );
            console.log(
                `[shard-io-bench] pack seed ${seedSpeedup.toFixed(2)}x vs sequential, pack hydrate ${hydrateSpeedup.toFixed(2)}x vs sequential`
            );
            expect(packSeed.shardCount).toBe(sequentialSeed.shardCount);
            expect(packHydrate.loaded).toBe(sequentialHydrate.loaded);
            expect(packSeed.seedMs).toBeGreaterThan(0);
            expect(packHydrate.hydrateMs).toBeGreaterThan(0);
        } finally {
            await ownerContext.close();
            await cleanupCloudCollabUsers(request, [emails.owner]);
        }
    });
});
