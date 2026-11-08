import { test } from './fixtures';
import fs from 'node:fs';
import {
    openFileFromFilesView,
    waitForCanvasReady,
    waitForFontLoaded,
    waitForOpenSessionReady
} from './helpers/snapshot-helper';

/**
 * Opt-in boot and font-open benchmark. Prints per-stage `cp:*` timings
 * (median over iterations) and the open timeline of the last run.
 *
 * Measure a production build, not the dev server:
 *   NODE_ENV=production npx webpack --output-path /tmp/cp-build
 *   npx http-server /tmp/cp-build -p 9102 -s
 *   PERF_BENCH=1 PERF_BENCH_URL='http://localhost:9102/?test=true&production' \
 *     npx playwright test tests/perf-pipeline-benchmark.spec.ts
 *
 * Options:
 *   PERF_BENCH_FONT=Fustat.glyphs           example font in /user
 *   PERF_BENCH_FILE=/abs/path/Font.glyphs   upload a font first
 *   PERF_BENCH_ITERS=3
 *   PERF_BENCH_PROFILE=/abs/out.cpuprofile  CPU profile of the last open
 */

const BENCH_URL = process.env.PERF_BENCH_URL || '/?test=true';
const FONT_FILE = process.env.PERF_BENCH_FILE || '';
const FONT =
    (FONT_FILE && FONT_FILE.split('/').pop()) ||
    process.env.PERF_BENCH_FONT ||
    'Fustat.glyphs';
const ITERS = Math.max(1, Number(process.env.PERF_BENCH_ITERS || 3));

test.describe('Boot and open benchmark', () => {
    test.skip(process.env.PERF_BENCH !== '1', 'Opt in with PERF_BENCH=1');

    test('boot and open timings', async ({ page }) => {
        test.setTimeout(ITERS * 300000);
        const runs: Record<string, number>[] = [];
        for (let i = 0; i < ITERS; i++) {
            const t0 = Date.now();
            await page.goto(BENCH_URL);
            await waitForCanvasReady(page);
            const tBoot = Date.now();

            if (FONT_FILE) {
                const base64 = fs.readFileSync(FONT_FILE).toString('base64');
                await page.evaluate(
                    async ({ name, data }) => {
                        const raw = atob(data);
                        const bytes = new Uint8Array(raw.length);
                        for (let k = 0; k < raw.length; k++) {
                            bytes[k] = raw.charCodeAt(k);
                        }
                        await window.uploadFiles(
                            [new File([bytes], `/user/${name}`)],
                            { directory: '/', pluginId: 'memory' }
                        );
                    },
                    { name: FONT, data: base64 }
                );
            }

            const profile = process.env.PERF_BENCH_PROFILE && i === ITERS - 1;
            const cdp = profile
                ? await page.context().newCDPSession(page)
                : null;
            if (cdp) {
                await cdp.send('Profiler.enable');
                await cdp.send('Profiler.setSamplingInterval', {
                    interval: 1000
                });
                await cdp.send('Profiler.start');
            }

            const tOpen0 = Date.now();
            const perfOpen0 = await page.evaluate(() => performance.now());
            await openFileFromFilesView(page, FONT);
            await waitForFontLoaded(page);
            const tModel = Date.now();
            await waitForOpenSessionReady(page, FONT, 180000);
            // Settled: no new timing span for 1 s after the open session.
            await page
                .waitForFunction(
                    (since) => {
                        const entries = performance
                            .getEntriesByType('measure')
                            .filter(
                                (e) =>
                                    e.startTime > since &&
                                    !e.name.startsWith('cp:python')
                            );
                        if (
                            !entries.some((e) =>
                                e.name.startsWith('cp:font.openSession')
                            )
                        ) {
                            return false;
                        }
                        const lastEnd = Math.max(
                            ...entries.map((e) => e.startTime + e.duration)
                        );
                        return performance.now() - lastEnd > 1000;
                    },
                    perfOpen0,
                    { timeout: 240000, polling: 200 }
                )
                .catch(() => console.log('[perf-bench] settle wait timed out'));
            const tReady = Date.now();

            if (cdp) {
                const { profile: p } = await cdp.send('Profiler.stop');
                fs.writeFileSync(
                    process.env.PERF_BENCH_PROFILE as string,
                    JSON.stringify(p)
                );
            }

            const result = await page.evaluate((since) => {
                const measures: Record<string, number> = {};
                const lines: string[] = [];
                let settled = since;
                for (const e of performance.getEntriesByType('measure')) {
                    const key = e.name.split('|')[0];
                    if (key.startsWith('cp:python')) {
                        measures[key] = Math.round(e.duration);
                        continue;
                    }
                    if (e.startTime < since) continue;
                    measures[key] =
                        Math.round(((measures[key] || 0) + e.duration) * 10) /
                        10;
                    settled = Math.max(settled, e.startTime + e.duration);
                    if (e.duration >= 20) {
                        lines.push(
                            `${(e.startTime - since).toFixed(0).padStart(7)} +${e.duration.toFixed(0).padStart(6)}  ${key}`
                        );
                    }
                }
                const all = performance
                    .getEntriesByType('measure')
                    .filter((e) => e.startTime > since);
                const sessionStart = Math.min(
                    ...all
                        .filter((e) => e.name.startsWith('cp:font.openSession'))
                        .map((e) => e.startTime)
                );
                const endOf = (prefix: string, pick: 'first' | 'last') => {
                    const ends = all
                        .filter(
                            (e) =>
                                e.name.split('|')[0] === prefix &&
                                e.startTime >= sessionStart
                        )
                        .map((e) => e.startTime + e.duration);
                    if (!ends.length) return -1;
                    return Math.round(
                        (pick === 'first'
                            ? Math.min(...ends)
                            : Math.max(...ends)) - since
                    );
                };
                return {
                    measures,
                    timeline: lines.join('\n'),
                    settled: Math.round(settled - since),
                    compiled: endOf('cp:font.compileEditing', 'first'),
                    overview: endOf('cp:overview.fontReadyHandler', 'last')
                };
            }, perfOpen0);

            if (i === ITERS - 1) {
                console.log('[perf-bench] open timeline\n' + result.timeline);
            }
            runs.push({
                'wall:boot': tBoot - t0,
                'wall:openToModel': tModel - tOpen0,
                'wall:openToReady': tReady - tOpen0,
                'wall:openToSettled': result.settled,
                'wall:openToCompiled': result.compiled,
                'wall:openToOverview': result.overview,
                ...result.measures
            });
        }

        const keys = Array.from(new Set(runs.flatMap((r) => Object.keys(r))));
        const lines = keys
            .map((k) => {
                const vals = runs
                    .map((r) => r[k])
                    .filter((v) => v !== undefined)
                    .sort((a, b) => a - b);
                return `${k.padEnd(64)} median=${vals[Math.floor(vals.length / 2)]} all=${vals.join(',')}`;
            })
            .sort();
        console.log(`[perf-bench] ${FONT}\n` + lines.join('\n'));
    });
});
