/**
 * Live cloud fuzz: five windows on one cloud font make seeded random edits,
 * undos and redos, and must agree after every step, down to the outlines and
 * advances of the compiled binary font.
 *
 * Windows: the owner’s main window (M) and its linked window (L1), the owner
 * in a second browser (O2), and the invitee’s main window (I) and its linked
 * window (L2). A main window and its linked windows share one history, so the
 * spec tracks three histories: M+L1, O2 and I+L2.
 *
 * Undo is author-only: a history may only undo or redo its own edits. An undo
 * that would revert anything else is a failure, as is a refused undo of an
 * own edit nobody has touched since.
 *
 * Run with:
 *   CLOUD_COLLAB_FUZZ=1 CLOUD_COLLAB_E2E=1 npx playwright test \
 *     --project=cloud-collab-fuzz
 * FUZZ_SEED (number, or `random`), FUZZ_STEPS and FUZZ_STOP_AT (stop after
 * that step, skip the later phases) repeat or narrow a run; FUZZ_KINDS
 * (comma-separated edit kinds, such as `node-insert,variation`) makes the
 * single steps only those. A failure prints the seed and every step before
 * it. `npm run fuzz:replay -- --seed <n>` runs it as the nightly does.
 */
import fs from 'node:fs';
import { test, expect } from './fixtures';
import { type BrowserContext, type Page } from '@playwright/test';
import {
    focusView,
    waitForCanvasReady,
    waitForFontLoaded,
    waitForOpenSessionReady
} from './helpers/snapshot-helper';
import {
    alignEditorCanvas,
    extractYDocDrawingKeys,
    installCrossWindowTrackersOnContext,
    installEditingFontCompileTracker,
    openLinkedEditorWindow,
    waitForBridgeReady,
    waitForEditingCompile,
    waitForFullStateSync,
    waitForWindowSyncPeers,
    waitForWindowSyncReady
} from './helpers/change-bridge-cross-window';
import {
    LOCAL_EDITOR_ORIGIN,
    LOCAL_ROOM_ORIGIN,
    LOCAL_WEBSITE_ORIGIN,
    attachCloudCollabCookies,
    bootstrapCloudCollabSession,
    cleanupCloudCollabUsers,
    makeCloudCollabEmails
} from './helpers/cloud-collab-session';
import {
    assertServiceReachable,
    collectPageErrors,
    editorHrefWithTestMode,
    gotoEditorPage,
    overviewTileState,
    paintOverviewTiles,
    saveCurrentFontToCloud,
    waitForCloudLiveIdle,
    recordCloudRoomTraffic,
    markCloudRoomTraffic,
    summarizeRoomTraffic,
    fontRoomDocumentIds,
    readRoomCounters,
    describeStaleTiles,
    diffRoomCounters,
    expectMinimalRoomTraffic,
    liveGlyphNames,
    type CloudRoomTraffic
} from './helpers/cloud-collab-three-window';
import { acceptCloudInviteAndGetEditorHref } from './helpers/cloud-collab-e2e';
import { makeSeededRandom } from './helpers/seeded-random';
import {
    FUZZ_BASES_WITH_TOP,
    FUZZ_COMPARE_LOCATION,
    FUZZ_COMPOSITES,
    FUZZ_EXTRA_CODEPOINT,
    FUZZ_GLYPHS,
    FUZZ_GROUP_GLYPHS,
    FUZZ_KERN_PAIRS,
    FUZZ_ROOM_LAYOUT,
    FUZZ_UNICODE_GLYPH,
    FUZZ_MARKS,
    FUZZ_STATIONS,
    FUZZ_OUTLINE_GLYPHS,
    FUZZ_WIDTH_GLYPHS,
    type FuzzEdit,
    type FuzzStationId,
    type FuzzSnapshot,
    applyFuzzEdit,
    describeFuzzEdit,
    fuzzEditOpenGlyph,
    diagnoseStaleCompile,
    loadFuzzFont,
    openFuzzGlyph,
    metricsKeyMismatches,
    readChangeLogTail,
    readCompiledOutlines,
    readCompositionMismatches,
    loadCatalogGlyphs,
    readFuzzSnapshot,
    readModelVsDocuments,
    readCollabTrace,
    formatCollabTrace,
    isExtendedFuzzEdit,
    FUZZ_STRUCTURE_GLYPH,
    FUZZ_COMPONENT_GLYPH,
    FUZZ_NEW_GLYPH_PREFIX,
    FUZZ_EXTRA_FEATURE
} from './helpers/cloud-collab-fuzz';

const SEED =
    process.env.FUZZ_SEED === 'random'
        ? Math.floor(Math.random() * 0x7fffffff)
        : Number(process.env.FUZZ_SEED ?? 20261110);
const STEPS = Number(process.env.FUZZ_STEPS ?? 100);
const STOP_AT = process.env.FUZZ_STOP_AT
    ? Number(process.env.FUZZ_STOP_AT)
    : null;
const FUZZ_KINDS = process.env.FUZZ_KINDS
    ? new Set(process.env.FUZZ_KINDS.split(',').map((kind) => kind.trim()))
    : null;
const KEYED_GLYPHS = new Set(['n', 'm', 'idotless']);
/** Glyphs the fuzz kerns besides the fixture's pairs. */
const FUZZ_PAIR_GLYPHS = ['a', 'o', 'l', 'n', 'm', 'idotless', 'i', 'p', 'q'];

type HistoryGroup = 'owner' | 'owner-second-browser' | 'invitee';
type FuzzWindow = {
    name: string;
    page: Page;
    group: HistoryGroup;
    errors: string[];
};
/** One edit as its history holds it, with the data it changed. */
type HistoryItem = {
    group: HistoryGroup;
    /**
     * Glyph whose history holds the edit; null for font-wide edits undo
     * reaches from any glyph (kerning, groups, Unicode). A name starting
     * with `#` is a surface of its own the fuzz never undoes from (`#feature`
     * for feature code, which has its own history target).
     */
    historyGlyph: string | null;
    /**
     * The glyph edit also changed font-wide data (an automatic alignment
     * toggle can write kerning groups): undo reaches it from any glyph.
     */
    fontWide?: boolean;
    master: FuzzStationId;
    description: string;
    changed: string[];
    before: Record<string, string>;
    after: Record<string, string>;
    /** Step of the edit. */
    step: number;
    undone: boolean;
    /** Step of its latest undo, while undone. */
    undoneAt?: number;
};

/**
 * Every value the fuzz compares, keyed by `<glyph>/<layer>` (every layer:
 * station, free, background and variation drawings), `props:<glyph>`,
 * `kern:<station>`, `kernrtl:<station>`, `cp:<glyph>`, `groups`,
 * `features`, `featureset` and `font:<part>`: one value per glyph layer,
 * station or font part, so an edit to one never makes another look touched.
 */
function flatten(snapshot: FuzzSnapshot): Record<string, string> {
    const values: Record<string, string> = {};
    for (const [name, layers] of Object.entries(snapshot.glyphs)) {
        values[`glyph:${name}`] = JSON.stringify(layers !== null);
        for (const [id, drawing] of Object.entries(
            (layers ?? {}) as Record<string, unknown>
        )) {
            values[`${name}/${id}`] = JSON.stringify(drawing);
        }
        // Layers as a set: windows that built the glyph in a different order
        // (a reopened one, say) list the same layers in another order.
        const props = snapshot.props[name] as
            { layers?: Record<string, unknown> } | null | undefined;
        values[`props:${name}`] = JSON.stringify(
            props
                ? {
                      ...props,
                      layers: Object.fromEntries(
                          Object.entries(props.layers ?? {}).sort(
                              ([left], [right]) => left.localeCompare(right)
                          )
                      )
                  }
                : null
        );
    }
    for (const id of Object.keys(snapshot.kerning)) {
        values[`kern:${id}`] = JSON.stringify(snapshot.kerning[id] ?? {});
        values[`kernrtl:${id}`] = JSON.stringify(snapshot.kerningRtl[id] ?? {});
    }
    for (const [name, codepoints] of Object.entries(snapshot.catalog)) {
        values[`cp:${name}`] = JSON.stringify(codepoints ?? []);
    }
    values.groups = JSON.stringify(snapshot.groups);
    values.features = JSON.stringify(snapshot.features);
    values.featureset = JSON.stringify(snapshot.featureSet);
    for (const [part, value] of Object.entries(snapshot.font)) {
        values[`font:${part}`] = JSON.stringify(value);
    }
    return values;
}

/**
 * A layer value without what automatic alignment derives (component
 * positions and width), so a replay that recomposes compares equal to the
 * stored state it restores. The composite check covers those values.
 */
function withoutDerived(value: string | undefined): string | undefined {
    if (!value) {
        return value;
    }
    const drawing = JSON.parse(value);
    const shapes = drawing?.shapes ?? [];
    if (
        !shapes.length ||
        !shapes.every((shape: any) => shape.reference && shape.automatic)
    ) {
        return value;
    }
    return JSON.stringify({
        ...drawing,
        width: null,
        shapes: shapes.map((shape: any) => ({ ...shape, translation: null }))
    });
}

/** Keys whose value changed, appeared or disappeared. */
function changedKeys(
    before: Record<string, string>,
    after: Record<string, string>
): string[] {
    return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
        (key) => before[key] !== after[key]
    );
}

/**
 * Fails with a named error when an in-page check never returns, so a hang
 * reaches the failure report (and its traces) instead of the test timeout.
 */
function withinTime<T>(
    promise: Promise<T>,
    ms: number,
    what: string
): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    return Promise.race([
        promise,
        new Promise<never>((_, reject) => {
            timer = setTimeout(
                () =>
                    reject(new Error(`${what} did not return within ${ms} ms`)),
                ms
            );
        })
    ]).finally(() => clearTimeout(timer));
}

test.describe.configure({ mode: 'serial' });

test.describe('cloud collaboration fuzz', () => {
    // The seed stays out of the title: with FUZZ_SEED=random the runner and
    // its worker each draw one, and the title must match. It is logged.
    test('five windows converge under seeded random edits', async ({
        browser,
        request
    }) => {
        test.setTimeout(3600000);
        console.log(
            `[fuzz] seed ${SEED}, ${STEPS} steps${STOP_AT ? `, stop at ${STOP_AT}` : ''}`
        );

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

        const random = makeSeededRandom(SEED);
        const pick = <T>(items: readonly T[]): T =>
            items[Math.floor(random() * items.length)];
        const delta = (size: number) =>
            (Math.floor(random() * size) + 1) * (random() < 0.5 ? -1 : 1);

        const runId = `${Date.now().toString(36)}-fuzz-${test.info().workerIndex}`;
        const emails = makeCloudCollabEmails(runId);
        const ownerSession = await bootstrapCloudCollabSession(
            request,
            emails.owner,
            'owner'
        );
        const inviteeSession = await bootstrapCloudCollabSession(
            request,
            emails.invitee,
            'invitee'
        );
        const contexts: BrowserContext[] = [];
        // Room traffic of every browser, recorded before any page opens.
        const roomTraffic: CloudRoomTraffic[] = [];
        const newContext = async (session: typeof ownerSession) => {
            const context = await browser.newContext();
            // The fixture is far smaller than FUZZ_ROOM_LAYOUT's rooms; keep
            // them when the owner opens the font instead of shrinking.
            // Every window records how collaboration changed it
            // (js/collab-trace.ts); a failure attaches each window's trace.
            await context.addInitScript(() => {
                (window as any).__collabTrace = { enabled: true, entries: [] };
                // Which glyphs each window was told changed, for stale tiles.
                const changed: Array<{ at: number; glyphs: string[] }> = [];
                (window as any).__glyphChangedLog = changed;
                window.addEventListener('glyphChanged', (event) => {
                    const detail = (event as CustomEvent).detail ?? {};
                    changed.push({
                        at: Math.round(performance.now()),
                        glyphs: Array.isArray(detail.glyphNames)
                            ? detail.glyphNames
                            : [detail.glyphName].filter(Boolean)
                    });
                    if (changed.length > 500) {
                        changed.shift();
                    }
                });
            });
            await context.addInitScript(() => {
                let engine: any;
                Object.defineProperty(window, 'patchSyncEngine', {
                    configurable: true,
                    get: () => engine,
                    set: (value) => {
                        engine = value;
                        if (value?.roomLayoutFill) {
                            value.roomLayoutFill = () => null;
                        }
                    }
                });
            });
            roomTraffic.push(recordCloudRoomTraffic(context));
            await installCrossWindowTrackersOnContext(context);
            await attachCloudCollabCookies(context, session);
            contexts.push(context);
            return context;
        };
        const consoleTails = new Map<Page, string[]>();
        /** Window names for the failure report. */
        const trafficNames = new Map<Page, string>();
        const captureConsole = (page: Page) => {
            const lines: string[] = [];
            consoleTails.set(page, lines);
            page.on('console', (message) => {
                if (
                    message.type() !== 'warning' &&
                    message.type() !== 'error'
                ) {
                    return;
                }
                lines.push(
                    `${message.type()}: ${message.text().slice(0, 400)}`
                );
                if (lines.length > 40) {
                    lines.shift();
                }
            });
        };
        const log: string[] = [];
        const record = (line: string) => {
            log.push(line);
            console.log(`[fuzz] ${line}`);
        };
        let failed = false;

        try {
            // ── Setup: owner saves the fixture font, invitee joins ───────
            const ownerContext = await newContext(ownerSession);
            const ownerSecondContext = await newContext(ownerSession);
            const inviteeContext = await newContext(inviteeSession);

            const mainPage = await ownerContext.newPage();
            captureConsole(mainPage);
            const mainErrors = await collectPageErrors(mainPage);
            record('setup: open M');
            await gotoEditorPage(mainPage, `${LOCAL_EDITOR_ORIGIN}/?test=true`);
            await waitForCanvasReady(mainPage);
            await waitForBridgeReady(mainPage);
            const familyName = `Fuzz-${runId}`;
            record('setup: load fixture font');
            await loadFuzzFont(mainPage, familyName);
            await waitForEditingCompile(mainPage);
            record('setup: save to cloud');
            // Save with several catalog and kerning rooms, so edits cross
            // rooms as they do in large fonts.
            await mainPage.evaluate((layout) => {
                const engine = (window as any).patchSyncEngine;
                const adopt = engine.adoptRoomLayout.bind(engine);
                engine.adoptRoomLayout = (chosen: any, options: any) =>
                    adopt({ ...chosen, ...layout }, options);
            }, FUZZ_ROOM_LAYOUT);
            const assetId = await saveCurrentFontToCloud(mainPage, familyName);
            expect(
                await mainPage.evaluate(
                    () => (window as any).patchSyncEngine.roomLayout
                )
            ).toMatchObject(FUZZ_ROOM_LAYOUT);
            await waitForOpenSessionReady(mainPage, assetId);
            await waitForBridgeReady(mainPage);
            await installEditingFontCompileTracker(mainPage);
            await waitForEditingCompile(mainPage);
            await waitForCloudLiveIdle(mainPage);

            const openEditor = async (page: Page) => {
                await focusView(page, 'ControlOrMeta+Shift+E', 'view-editor');
                await alignEditorCanvas(page, 'a', {
                    wght: FUZZ_STATIONS[0].wght
                });
                // The editing font holds the glyphs of the window’s text:
                // every window shows all fuzz glyphs.
                await openFuzzGlyph(page, 'a', FUZZ_STATIONS[0].id);
                await waitForEditingCompile(page);
            };
            const openLinked = async (main: Page) => {
                const linked = await openLinkedEditorWindow(main);
                captureConsole(linked);
                const errors = await collectPageErrors(linked);
                await waitForCanvasReady(linked);
                await waitForFontLoaded(linked);
                await waitForFullStateSync(linked);
                await waitForBridgeReady(linked);
                await waitForWindowSyncReady(linked);
                await installEditingFontCompileTracker(linked);
                await waitForWindowSyncPeers(main, linked);
                await openEditor(linked);
                return { linked, errors };
            };
            const openCloudWindow = async (
                context: BrowserContext,
                href: string
            ) => {
                const page = await context.newPage();
                captureConsole(page);
                const errors = await collectPageErrors(page);
                await gotoEditorPage(page, editorHrefWithTestMode(href));
                await waitForCanvasReady(page);
                await waitForFontLoaded(page);
                await waitForOpenSessionReady(page, assetId);
                await waitForBridgeReady(page);
                await installEditingFontCompileTracker(page);
                await waitForEditingCompile(page);
                return { page, errors };
            };

            record('setup: M editor');
            await openEditor(mainPage);
            record('setup: open L1');
            const { linked: linkedPage, errors: linkedErrors } =
                await openLinked(mainPage);
            await waitForCloudLiveIdle(mainPage);

            record('setup: invite');
            const inviteResult = await mainPage.evaluate(
                (email) =>
                    (window as any).cloudPlugin.inviteUser(email, 'editor'),
                emails.invitee
            );
            expect(inviteResult?.inviteUrl).toContain('/invite?token=');
            const inviteeWebsite = await inviteeContext.newPage();
            const editorHref = await acceptCloudInviteAndGetEditorHref(
                inviteeWebsite,
                inviteResult.inviteUrl
            );
            expect(decodeURIComponent(editorHref)).toContain(assetId);
            await inviteeWebsite.close();

            record('setup: open I');
            const { page: inviteePage, errors: inviteeErrors } =
                await openCloudWindow(inviteeContext, editorHref);
            await openEditor(inviteePage);
            const { linked: inviteeLinkedPage, errors: inviteeLinkedErrors } =
                await openLinked(inviteePage);
            record('setup: open O2');
            const { page: ownerSecondPage, errors: ownerSecondErrors } =
                await openCloudWindow(ownerSecondContext, editorHref);
            await openEditor(ownerSecondPage);

            const windows: FuzzWindow[] = [
                {
                    name: 'M',
                    page: mainPage,
                    group: 'owner',
                    errors: mainErrors
                },
                {
                    name: 'L1',
                    page: linkedPage,
                    group: 'owner',
                    errors: linkedErrors
                },
                {
                    name: 'O2',
                    page: ownerSecondPage,
                    group: 'owner-second-browser',
                    errors: ownerSecondErrors
                },
                {
                    name: 'I',
                    page: inviteePage,
                    group: 'invitee',
                    errors: inviteeErrors
                },
                {
                    name: 'L2',
                    page: inviteeLinkedPage,
                    group: 'invitee',
                    errors: inviteeLinkedErrors
                }
            ];
            for (const fuzzWindow of windows) {
                trafficNames.set(fuzzWindow.page, fuzzWindow.name);
            }

            // ── Checks every step runs in every window ───────────────────
            const converge = async (label: string, timeout = 90000) => {
                const reference = windows[0];
                let snapshot = await withinTime(
                    readFuzzSnapshot(reference.page),
                    60000,
                    `${reference.name}: reading its font`
                );
                const deadline = Date.now() + timeout;
                for (;;) {
                    snapshot = await withinTime(
                        readFuzzSnapshot(reference.page),
                        60000,
                        `${reference.name}: reading its font`
                    );
                    const expected = flatten(snapshot);
                    const differences: string[] = [];
                    for (const window of windows.slice(1)) {
                        const actual = flatten(
                            await withinTime(
                                readFuzzSnapshot(window.page),
                                60000,
                                `${window.name}: reading its font`
                            )
                        );
                        for (const key of changedKeys(expected, actual)) {
                            differences.push(
                                `${window.name} ${key}: ${actual[key]} vs ${reference.name} ${expected[key]}`
                            );
                        }
                    }
                    // A collaborator cascade this window still shows as a
                    // preview: its model may agree while its documents lag.
                    for (const window of windows) {
                        const pending = await window.page.evaluate(() =>
                            (
                                (window as any).remoteCascadePreview
                                    ?.pendingTargets ?? []
                            ).map(
                                (target: {
                                    glyphName: string;
                                    layerId: string;
                                }) => `${target.glyphName}/${target.layerId}`
                            )
                        );
                        for (const target of pending) {
                            differences.push(
                                `${window.name} preview:${target}: still a preview, not stored`
                            );
                        }
                    }
                    if (!differences.length) {
                        return snapshot;
                    }
                    if (Date.now() > deadline) {
                        const logs: string[] = [];
                        const differing = [
                            ...new Set(
                                differences.map(
                                    (line) =>
                                        line
                                            .split(' ')[1]
                                            .replace(
                                                /^(glyph|props|cp|preview):/,
                                                ''
                                            )
                                            .replace(/:$/, '')
                                            .split('/')[0]
                                )
                            )
                        ];
                        // A window whose model differs from documents that
                        // match everyone else’s drifted; one whose documents
                        // differ is still waiting for an update.
                        const differingDrawings = [
                            ...new Set(
                                differences
                                    .map((line) =>
                                        line
                                            .split(' ')[1]
                                            .replace(/^preview:/, '')
                                            .replace(/:$/, '')
                                    )
                                    .filter((key) => key.includes('/'))
                            )
                        ].map((key) => key.split('/') as [string, string]);
                        for (const window of windows) {
                            const sync = await window.page.evaluate((names) => {
                                const w = window as any;
                                const bridge = w.patchSyncEngine;
                                const plugin = w.cloudPlugin;
                                const toHex = (bytes: Uint8Array | null) =>
                                    bytes
                                        ? Array.from(bytes)
                                              .map((b) =>
                                                  b
                                                      .toString(16)
                                                      .padStart(2, '0')
                                              )
                                              .join('')
                                        : null;
                                return {
                                    pending:
                                        plugin?._liveSession
                                            ?.pendingSyncCount ?? null,
                                    status: plugin?.connectionStatus,
                                    docs: names.map((name: string) => {
                                        const id =
                                            bridge?.glyphDocumentIdForName?.(
                                                name
                                            ) ?? null;
                                        // Every catalog entry under this
                                        // name, deleted ones too, and
                                        // whether glyphOrder lists it.
                                        const fontJson = bridge?._fontJson;
                                        const catalog =
                                            fontJson?.glyphCatalog ??
                                            fontJson?.format_specific?.[
                                                'com.counterpunch.cloud'
                                            ]?.glyphCatalog ??
                                            {};
                                        const entries = Object.values(
                                            catalog as Record<string, any>
                                        )
                                            .filter(
                                                (entry: any) =>
                                                    entry?.name === name
                                            )
                                            .map(
                                                (entry: any) =>
                                                    `${entry.glyphId}${entry.deleted ? ' deleted' : ''} gen ${entry.generation ?? 0}`
                                            );
                                        const order =
                                            bridge?.fontMap
                                                ?.get?.('glyphOrder')
                                                ?.toArray?.() ?? [];
                                        const liveId = Object.values(
                                            catalog as Record<string, any>
                                        ).find(
                                            (entry: any) =>
                                                entry?.name === name &&
                                                !entry.deleted
                                        )?.glyphId;
                                        const liveResident = liveId
                                            ? bridge?.hasResidentGlyphDocument?.(
                                                  `glyph:${liveId}`
                                              )
                                            : null;
                                        return `${name} ${id} sv=${id ? toHex(bridge.encodeDocumentStateVector?.(id) ?? null) : '-'} catalog [${entries.join(', ')}] ${order.includes(name) ? 'in' : 'not in'} glyphOrder; live id ${liveResident ? 'resident' : 'not resident'}`;
                                    }),
                                    // Which glyph documents this window
                                    // holds of those the catalog lists.
                                    residency: `${bridge?.hasSparseWorkingSet?.() ? 'sparse' : 'full'}, ${bridge?.listLiveGlyphDocumentIds?.()?.length ?? '?'} glyph documents resident, ${bridge?.listLiveCatalogGlyphIds?.()?.length ?? '?'} live in the catalog`
                                };
                            }, differing);
                            logs.push(
                                `${window.name} sync: pending ${sync.pending}, ${sync.status}, ${sync.residency}; ${sync.docs.join('; ')}`
                            );
                        }
                        for (const window of windows) {
                            logs.push(
                                `${window.name} model vs its documents:\n  ${(await readModelVsDocuments(window.page, differingDrawings)).join('\n  ')}`,
                                `${window.name} change log:\n  ${(await readChangeLogTail(window.page, 12)).join('\n  ')}`,
                                `${window.name} console:\n  ${(consoleTails.get(window.page) ?? []).join('\n  ')}`
                            );
                        }
                        throw new Error(
                            `${label}: windows did not converge\n${differences.join('\n')}\n${logs.join('\n')}`
                        );
                    }
                    await mainPage.waitForTimeout(500);
                }
            };
            const checkAll = async (label: string) => {
                const snapshot = await converge(label);
                for (const window of windows) {
                    if (window.errors.length) {
                        // Is a layer without a width still in the shared
                        // document, or was it only an in-between state?
                        const missing: string[] = [];
                        for (const name of FUZZ_GLYPHS) {
                            for (const { id } of FUZZ_STATIONS) {
                                const keys = await extractYDocDrawingKeys(
                                    window.page,
                                    name,
                                    id
                                );
                                if (!keys.includes('width')) {
                                    missing.push(
                                        `${name}/${id}: ${keys.join(',')}`
                                    );
                                }
                            }
                        }
                        record(
                            `${window.name} page errors; drawings without width now: ${missing.join('; ') || 'none'}; console:\n  ${(consoleTails.get(window.page) ?? []).slice(-15).join('\n  ')}`
                        );
                    }
                    expect(
                        window.errors,
                        `${label}: page errors in ${window.name}`
                    ).toEqual([]);
                }
                expect(
                    metricsKeyMismatches(snapshot),
                    `${label}: metrics keys`
                ).toEqual([]);
                let referenceRun: string | null = null;
                let referenceTiles: string | null = null;
                for (const window of windows) {
                    const compositeMismatches = await withinTime(
                        readCompositionMismatches(window.page),
                        60000,
                        `${window.name}: checking composites`
                    );
                    if (compositeMismatches.length) {
                        // Stale in the model only, or in this window's
                        // documents too (a missed update)?
                        const drawings = [
                            ...new Set(
                                compositeMismatches.map(
                                    (line) => line.split(' ')[0]
                                )
                            )
                        ].map((key) => key.split('/') as [string, string]);
                        record(
                            `${label}: ${window.name} composites:\n  ${(
                                await readModelVsDocuments(
                                    window.page,
                                    drawings
                                )
                            ).join('\n  ')}`
                        );
                    }
                    expect(
                        compositeMismatches,
                        `${label}: automatic composites in ${window.name}`
                    ).toEqual([]);
                    // The binary: what this window compiled for editing
                    // must match a fresh compile of its current data.
                    await withinTime(
                        waitForEditingCompile(window.page),
                        180000,
                        `${window.name}: its editing compile`
                    );
                    let compiled = await withinTime(
                        readCompiledOutlines(window.page),
                        180000,
                        `${window.name}: compiling its font fresh`
                    );
                    await expect
                        .poll(
                            async () => {
                                compiled = await withinTime(
                                    readCompiledOutlines(window.page),
                                    180000,
                                    `${window.name}: compiling its font fresh`
                                );
                                return (
                                    !compiled.error &&
                                    JSON.stringify(compiled.editing) ===
                                        JSON.stringify(compiled.fresh)
                                );
                            },
                            {
                                timeout: 60000,
                                intervals: [500, 1000, 2000],
                                message: `${label}: compiled outlines in ${window.name} are stale`
                            }
                        )
                        .toBe(true)
                        .catch(async (error) => {
                            // A preview overlay compiles what no document
                            // holds; name any still pending.
                            const previews = await window.page
                                .evaluate(() =>
                                    (
                                        (window as any).remoteCascadePreview
                                            ?.pendingTargets ?? []
                                    ).map(
                                        (target: {
                                            glyphName: string;
                                            layerId: string;
                                        }) =>
                                            `${target.glyphName}/${target.layerId}`
                                    )
                                )
                                .catch(() => []);
                            const why = `${await diagnoseStaleCompile(window.page)}; cascade previews: ${previews.join(', ') || 'none'}`;
                            record(
                                `${label}: ${window.name} stale compile: ${why}`
                            );
                            // The font this window compiles, to compile it
                            // again outside the browser.
                            const fontJson = await window.page
                                .evaluate(() =>
                                    JSON.stringify(
                                        (
                                            window as any
                                        ).patchSyncEngine?.getFontJsonSnapshot?.() ??
                                            null
                                    )
                                )
                                .catch(() => null);
                            if (fontJson) {
                                fs.writeFileSync(
                                    test
                                        .info()
                                        .outputPath(`font-${window.name}.json`),
                                    fontJson
                                );
                            }
                            throw new Error(
                                `${error instanceof Error ? error.message : String(error)}\n${why}\n${compiled.error ?? ''}\nediting ${JSON.stringify(compiled.editing)}\nfresh   ${JSON.stringify(compiled.fresh)}`
                            );
                        });
                    const run = JSON.stringify(compiled.editing);
                    referenceRun ??= run;
                    expect(
                        run,
                        `${label}: compiled font in ${window.name} differs from M`
                    ).toBe(referenceRun);
                    // Tiles repaint asynchronously after the worker takes
                    // an update, like the compile above.
                    let tiles = await withinTime(
                        overviewTileState(
                            window.page,
                            FUZZ_GLYPHS,
                            FUZZ_COMPARE_LOCATION
                        ),
                        60000,
                        `${window.name}: reading its overview tiles`
                    );
                    await expect
                        .poll(
                            async () => {
                                tiles = await overviewTileState(
                                    window.page,
                                    FUZZ_GLYPHS,
                                    FUZZ_COMPARE_LOCATION
                                );
                                return tiles
                                    .filter((tile) => tile.tileStale)
                                    .map((tile) => tile.name);
                            },
                            {
                                timeout: 30000,
                                intervals: [500, 1000, 2000],
                                message: `${label}: stale overview tiles in ${window.name}`
                            }
                        )
                        .toEqual([])
                        .catch(async (error) => {
                            const stale = tiles
                                .filter((tile) => tile.tileStale)
                                .map((tile) => tile.name);
                            throw new Error(
                                `${error instanceof Error ? error.message : String(error)}\n${(
                                    await describeStaleTiles(window.page, stale)
                                ).join('\n')}`
                            );
                        });
                    const outlines = JSON.stringify(
                        tiles.map(({ name, outline }) => ({ name, outline }))
                    );
                    referenceTiles ??= outlines;
                    expect(
                        outlines,
                        `${label}: overview outlines in ${window.name} differ from M`
                    ).toBe(referenceTiles);
                }
                return snapshot;
            };
            const paintTiles = async () => {
                for (const window of windows) {
                    await paintOverviewTiles(window.page, FUZZ_GLYPHS);
                }
            };

            record('setup: baseline');
            let snapshot = await checkAll('baseline');

            // ── Edit generators ──────────────────────────────────────────
            const outlineEdit = (glyph: string): FuzzEdit => {
                const station = pick(FUZZ_STATIONS).id;
                const shapes = (snapshot.glyphs[glyph] as any)[station].shapes;
                const shape = Math.floor(random() * shapes.length);
                return {
                    kind: 'outline',
                    glyph,
                    master: station,
                    shape,
                    node: Math.floor(random() * shapes[shape].nodes.length),
                    // A keyed glyph’s sidebearings follow its key, so its
                    // points move only vertically.
                    dx: KEYED_GLYPHS.has(glyph) ? 0 : delta(30),
                    dy: delta(30)
                };
            };
            const anchorEdit = (glyph: string): FuzzEdit => ({
                kind: 'anchor',
                glyph,
                master: pick(FUZZ_STATIONS).id,
                anchor: FUZZ_MARKS.includes(glyph) ? '_top' : 'top',
                dx: delta(40),
                dy: delta(40)
            });
            const widthEdit = (glyph: string): FuzzEdit => ({
                kind: 'width',
                glyph,
                master: pick(FUZZ_STATIONS).id,
                dw: delta(40)
            });
            const kernPairKey = () =>
                random() < 0.5
                    ? pick(FUZZ_KERN_PAIRS)
                    : `${random() < 0.2 ? '@L' : pick(FUZZ_PAIR_GLYPHS)}:${random() < 0.2 ? '@A' : pick(FUZZ_PAIR_GLYPHS)}`;
            const kernEdit = (): FuzzEdit => {
                const station = pick(FUZZ_STATIONS).id;
                const rtl = random() < 0.2;
                const pair = kernPairKey();
                const current =
                    (rtl ? snapshot.kerningRtl : snapshot.kerning)[station]?.[
                        pair
                    ] ?? 0;
                return {
                    kind: 'kern',
                    master: station,
                    pair,
                    value: current + delta(8) * 10,
                    ...(rtl ? { rtl } : {})
                };
            };
            const kernDeleteEdit = (): FuzzEdit => {
                const station = pick(FUZZ_STATIONS).id;
                const rtl = random() < 0.2;
                const pairs = Object.keys(
                    (rtl ? snapshot.kerningRtl : snapshot.kerning)[station] ??
                        {}
                );
                if (!pairs.length) {
                    return kernEdit();
                }
                return {
                    kind: 'kern-delete',
                    master: station,
                    pair: pick(pairs),
                    ...(rtl ? { rtl } : {})
                };
            };
            const kernGroupEdit = (): FuzzEdit => {
                const side = pick(['first', 'second'] as const);
                // `L` and `A` are kerned; the fuzz's own groups are not, so
                // deleting them leaves no pair without its group.
                const group = pick(
                    side === 'first' ? ['L', 'L', 'N'] : ['A', 'A', 'B']
                );
                const glyph = pick([...FUZZ_GROUP_GLYPHS, 'o', 'p', 'q']);
                const members = snapshot.groups[side]?.[group] ?? [];
                return {
                    kind: 'kern-group',
                    master: FUZZ_STATIONS[0].id,
                    glyph,
                    group,
                    include: !members.includes(glyph),
                    side
                };
            };
            const kernGroupDeleteEdit = (): FuzzEdit => {
                const own = (['first', 'second'] as const).flatMap((side) =>
                    Object.keys(snapshot.groups[side] ?? {})
                        .filter((group) => group === 'N' || group === 'B')
                        .map((group) => ({ side, group }))
                );
                if (!own.length) {
                    return kernGroupEdit();
                }
                const { side, group } = pick(own);
                return {
                    kind: 'kern-group-delete',
                    master: FUZZ_STATIONS[0].id,
                    side,
                    group
                };
            };
            const featureEdit = (): FuzzEdit => ({
                kind: 'feature',
                master: FUZZ_STATIONS[0].id,
                value: Math.floor(random() * 1_000_000)
            });
            const unicodeEdit = (): FuzzEdit => ({
                kind: 'unicode',
                master: FUZZ_STATIONS[0].id,
                glyph: FUZZ_UNICODE_GLYPH,
                add: !(snapshot.catalog[FUZZ_UNICODE_GLYPH] ?? []).includes(
                    FUZZ_EXTRA_CODEPOINT
                )
            });
            const alignEdit = (): FuzzEdit => {
                const glyph = pick(FUZZ_COMPOSITES);
                const station = pick(FUZZ_STATIONS).id;
                const shapes = (snapshot.glyphs[glyph] as any)[station].shapes;
                return {
                    kind: 'align',
                    glyph,
                    master: station,
                    automatic: !shapes.every((shape: any) => shape.automatic)
                };
            };

            // ── Extended edits: structure, components, drawings, font ────
            const shapesOf = (glyph: string, station: string): any[] =>
                (snapshot.glyphs[glyph] as any)?.[station]?.shapes ?? [];
            const indexesWhere = (
                glyph: string,
                test: (shape: any) => boolean
            ) =>
                shapesOf(glyph, 'M1')
                    .map((shape, index) => (test(shape) ? index : -1))
                    .filter((index) => index >= 0);
            const contoursOf = (glyph: string) =>
                indexesWhere(glyph, (shape) => !!shape.nodes);
            const componentsOf = (glyph: string) =>
                indexesWhere(glyph, (shape) => !!shape.reference);
            const anchorNamesOf = (glyph: string): string[] =>
                ((snapshot.glyphs[glyph] as any)?.M1?.anchors ?? []).map(
                    (anchor: any) => anchor[0]
                );
            const layersOf = (glyph: string): Record<string, any[]> =>
                (snapshot.props[glyph] as any)?.layers ?? {};
            const P = FUZZ_STRUCTURE_GLYPH;
            const Q = FUZZ_COMPONENT_GLYPH;
            const contourAddEdit = (): FuzzEdit => {
                const x = 140 + Math.floor(random() * 160);
                const y = 540 + Math.floor(random() * 80);
                return {
                    kind: 'contour-add',
                    glyph: P,
                    master: pick(FUZZ_STATIONS).id,
                    rect: [
                        x,
                        y,
                        x + 30 + Math.floor(random() * 50),
                        y + 30 + Math.floor(random() * 40)
                    ]
                };
            };
            const nodeEdit = (
                kind: 'node-insert' | 'node-remove' | 'smooth'
            ): FuzzEdit => {
                const contours = contoursOf(P).filter(
                    (index) =>
                        kind !== 'node-remove' ||
                        shapesOf(P, 'M1')[index].nodes.length > 3
                );
                if (!contours.length) {
                    return contourAddEdit();
                }
                const shape = pick(contours);
                return {
                    kind,
                    glyph: P,
                    master: pick(FUZZ_STATIONS).id,
                    shape,
                    node: Math.floor(
                        random() * shapesOf(P, 'M1')[shape].nodes.length
                    )
                };
            };
            const contourEdit = (
                kind: 'contour-remove' | 'contour-reverse' | 'contour-open'
            ): FuzzEdit => {
                const contours = contoursOf(P);
                if (
                    !contours.length ||
                    (kind === 'contour-remove' && contours.length < 2)
                ) {
                    return contourAddEdit();
                }
                const shape = pick(contours);
                const master = pick(FUZZ_STATIONS).id;
                return kind === 'contour-open'
                    ? {
                          kind,
                          glyph: P,
                          master,
                          shape,
                          closed: shapesOf(P, 'M1')[shape].closed === false
                      }
                    : { kind, glyph: P, master, shape };
            };
            const transformEdit = (): FuzzEdit => ({
                kind: 'transform',
                glyph: pick([P, 'a', 'o']),
                master: pick(FUZZ_STATIONS).id,
                op: pick(['scale', 'rotate', 'flip'] as const)
            });
            const nudgeEdit = (): FuzzEdit => {
                const target = pick([
                    'point',
                    'point',
                    'anchor',
                    'component'
                ] as const);
                const key = pick([
                    'ArrowLeft',
                    'ArrowRight',
                    'ArrowUp',
                    'ArrowDown'
                ] as const);
                const master = pick(FUZZ_STATIONS).id;
                const shift = random() < 0.3;
                if (target === 'component' && componentsOf(Q).length) {
                    return {
                        kind: 'nudge',
                        glyph: Q,
                        master,
                        target,
                        shape: pick(componentsOf(Q)),
                        index: 0,
                        key,
                        shift
                    };
                }
                const withAnchors = [P, 'a', 'o', ...FUZZ_MARKS].filter(
                    (glyph) => anchorNamesOf(glyph).length
                );
                if (target === 'anchor' && withAnchors.length) {
                    return {
                        kind: 'nudge',
                        glyph: pick(withAnchors),
                        master,
                        target,
                        shape: 0,
                        index: 0,
                        key,
                        shift
                    };
                }
                const glyph = pick(
                    [P, 'a', 'o', ...FUZZ_MARKS].filter(
                        (name) => contoursOf(name).length
                    )
                );
                const shape = pick(contoursOf(glyph));
                return {
                    kind: 'nudge',
                    glyph,
                    master,
                    target: 'point',
                    shape,
                    index: Math.floor(
                        random() * shapesOf(glyph, 'M1')[shape].nodes.length
                    ),
                    key,
                    shift
                };
            };
            const componentAddEdit = (): FuzzEdit => ({
                kind: 'component-add',
                glyph: Q,
                master: pick(FUZZ_STATIONS).id,
                reference: pick(['a', 'o', 'l', 'dotaccentcomb', 'acutecomb']),
                x: Math.floor(random() * 400),
                y: Math.floor(random() * 200) - 100
            });
            const componentEdit = (
                kind:
                    | 'component-remove'
                    | 'component-swap'
                    | 'component-decompose'
                    | 'component-transform'
            ): FuzzEdit => {
                const components = componentsOf(Q);
                if (
                    !components.length ||
                    (kind === 'component-remove' && components.length < 2)
                ) {
                    return componentAddEdit();
                }
                const shape = pick(components);
                const master = pick(FUZZ_STATIONS).id;
                if (kind === 'component-swap') {
                    const current = shapesOf(Q, 'M1')[shape].reference;
                    return {
                        kind,
                        glyph: Q,
                        master,
                        shape,
                        reference: pick(
                            ['a', 'o', 'l', 'n'].filter(
                                (name) => name !== current
                            )
                        )
                    };
                }
                if (kind === 'component-transform') {
                    return {
                        kind,
                        glyph: Q,
                        master,
                        shape,
                        dx: delta(30),
                        dy: delta(30),
                        scale: pick([0.9, 1, 1.1])
                    };
                }
                return { kind, glyph: Q, master, shape };
            };
            // Anchors the composites do not depend on.
            const ownAnchors = (glyph: string) =>
                anchorNamesOf(glyph).filter(
                    (name) => name !== 'top' && name !== '_top'
                );
            const anchorAddEdit = (): FuzzEdit => {
                const glyph = pick([P, 'o']);
                const free = ['bottom', 'ogonek', 'center'].filter(
                    (name) => !anchorNamesOf(glyph).includes(name)
                );
                if (!free.length) {
                    return anchorEdit(glyph);
                }
                return {
                    kind: 'anchor-add',
                    glyph,
                    master: pick(FUZZ_STATIONS).id,
                    name: pick(free),
                    x: 100 + Math.floor(random() * 200),
                    y: Math.floor(random() * 100) - 50
                };
            };
            const anchorChangeEdit = (
                kind: 'anchor-remove' | 'anchor-rename'
            ): FuzzEdit => {
                const candidates = [P, 'o'].filter(
                    (glyph) => ownAnchors(glyph).length
                );
                if (!candidates.length) {
                    return anchorAddEdit();
                }
                const glyph = pick(candidates);
                const name = pick(ownAnchors(glyph));
                const master = pick(FUZZ_STATIONS).id;
                if (kind === 'anchor-remove') {
                    return { kind, glyph, master, name };
                }
                const to = ['bottom', 'ogonek', 'center'].find(
                    (candidate) => !anchorNamesOf(glyph).includes(candidate)
                );
                return to
                    ? { kind, glyph, master, name, to }
                    : { kind: 'anchor-remove', glyph, master, name };
            };
            const glyphPropertyEdit = (): FuzzEdit => {
                const glyph = pick([P, Q, 'o', 'l']);
                const props = (snapshot.props[glyph] ?? {}) as any;
                const property = pick(
                    glyph === P || glyph === Q
                        ? (['category', 'production_name', 'exported'] as const)
                        : (['category', 'production_name'] as const)
                );
                const value =
                    property === 'exported'
                        ? !props.exported
                        : property === 'category'
                          ? pick(
                                ['Base', 'Ligature', 'Component'].filter(
                                    (category) => category !== props.category
                                )
                            )
                          : props.production_name
                            ? null
                            : `fuzz${glyph}${Math.floor(random() * 100)}`;
                return {
                    kind: 'glyph-property',
                    glyph,
                    master: FUZZ_STATIONS[0].id,
                    property,
                    value
                };
            };
            const metricsKeyEdit = (): FuzzEdit => ({
                kind: 'metrics-key',
                glyph: P,
                master: FUZZ_STATIONS[0].id,
                side: 'right',
                value: (snapshot.props[P] as any)?.rightMetricsKey ? null : '=o'
            });
            const freeDrawingEdit = (): FuzzEdit => {
                const free = Object.entries(layersOf(P))
                    .filter(([, layer]) => layer[0] === 'FreeFloating')
                    .map(([id, layer]) => ({ id, wght: layer[2]?.wght }));
                const used = new Set(free.map((layer) => layer.wght));
                const open = [300, 500, 700].filter((wght) => !used.has(wght));
                const op = !free.length
                    ? 'add'
                    : pick(
                          open.length
                              ? (['add', 'remove', 'edit', 'edit'] as const)
                              : (['remove', 'edit', 'edit'] as const)
                      );
                const chosen = op === 'add' ? null : pick(free);
                return {
                    kind: 'free-drawing',
                    glyph: P,
                    master: FUZZ_STATIONS[0].id,
                    op,
                    wght: op === 'add' ? pick(open) : chosen!.wght,
                    drawing: chosen?.id ?? null,
                    dx: delta(30),
                    dy: delta(30)
                };
            };
            const backgroundEdit = (): FuzzEdit => {
                const master = pick(FUZZ_STATIONS).id;
                const backgroundId = layersOf(P)[master]?.[3];
                const filled =
                    !!backgroundId &&
                    shapesOf(P, backgroundId).some(
                        (shape) => (shape.nodes ?? []).length
                    );
                return {
                    kind: 'background',
                    glyph: P,
                    master,
                    op: filled
                        ? pick(['add', 'edit', 'edit', 'clear'] as const)
                        : 'add',
                    dx: delta(30),
                    dy: delta(30)
                };
            };
            const variationEdit = (): FuzzEdit => {
                const has = ((snapshot.props[P] as any)?.variations ?? [])
                    .length;
                return {
                    kind: 'variation',
                    glyph: P,
                    master: pick(FUZZ_STATIONS).id,
                    op: has ? pick(['remove', 'edit', 'edit'] as const) : 'add',
                    min: pick([500, 600, 700]),
                    dx: delta(30),
                    dy: delta(30)
                };
            };
            const newGlyphs = () =>
                Object.entries(snapshot.glyphs)
                    .filter(
                        ([name, layers]) =>
                            name.startsWith(FUZZ_NEW_GLYPH_PREFIX) &&
                            layers !== null
                    )
                    .map(([name]) => name);
            const freshGlyphName = () =>
                `${FUZZ_NEW_GLYPH_PREFIX}g${Math.floor(random() * 1_000_000)}`;
            const glyphLifecycleEdit = (): FuzzEdit => {
                const existing = newGlyphs();
                const op = !existing.length
                    ? 'glyph-add'
                    : pick([
                          'glyph-add',
                          'glyph-rename',
                          'glyph-delete'
                      ] as const);
                const master = FUZZ_STATIONS[0].id;
                if (op === 'glyph-add') {
                    return { kind: op, master, name: freshGlyphName() };
                }
                const name = pick(existing);
                return op === 'glyph-rename'
                    ? { kind: op, master, name, to: freshGlyphName() }
                    : { kind: op, master, name };
            };
            const featureListEdit = (): FuzzEdit => ({
                kind: 'feature-list',
                master: FUZZ_STATIONS[0].id,
                op: (snapshot.featureSet as any)?.tags?.includes(
                    FUZZ_EXTRA_FEATURE[0]
                )
                    ? pick(['remove', 'move'] as const)
                    : 'add'
            });
            const featurePrefixEdit = (): FuzzEdit => ({
                kind: 'feature-prefix',
                master: FUZZ_STATIONS[0].id,
                value: Math.floor(random() * 1_000_000)
            });
            const featureClassEdit = (): FuzzEdit => {
                const members = ['a', 'o', 'l', P, Q].filter(
                    () => random() < 0.5
                );
                return {
                    kind: 'feature-class',
                    master: FUZZ_STATIONS[0].id,
                    members: members.length ? members : ['a']
                };
            };
            const stationMetricEdit = (): FuzzEdit => {
                const master = pick(FUZZ_STATIONS).id;
                const key = pick([
                    'XHeight',
                    'CapHeight',
                    'Ascender',
                    'XHeight overshoot'
                ]);
                const station = ((snapshot.font as any).stations ?? []).find(
                    (item: any) => item.id === master
                );
                return {
                    kind: 'station-metric',
                    master,
                    key,
                    value: (station?.metrics?.[key] ?? 0) + delta(20)
                };
            };
            const instanceEdit = (): FuzzEdit => {
                const instances = ((snapshot.font as any).instances ??
                    []) as any[];
                const op = !instances.length
                    ? 'add'
                    : pick(['add', 'edit', 'edit', 'remove'] as const);
                return {
                    kind: 'instance',
                    master: FUZZ_STATIONS[0].id,
                    op,
                    id:
                        op === 'add'
                            ? `fuzz-${Math.floor(random() * 1_000_000)}`
                            : pick(instances).id,
                    wght: 100 + Math.floor(random() * 8) * 100
                };
            };
            const fontInfoEdit = (): FuzzEdit => ({
                kind: 'font-info',
                master: FUZZ_STATIONS[0].id,
                field: pick(['designer', 'version', 'vendor'] as const),
                value: 1 + Math.floor(random() * 999)
            });

            // Weight of each kind of edit; the first ten keep about half.
            const EDIT_TABLE: Array<{
                kinds: string[];
                weight: number;
                make: () => FuzzEdit;
            }> = [
                {
                    kinds: ['outline'],
                    weight: 15,
                    make: () => outlineEdit(pick(FUZZ_OUTLINE_GLYPHS))
                },
                {
                    kinds: ['anchor'],
                    weight: 10,
                    make: () =>
                        anchorEdit(
                            pick([...FUZZ_BASES_WITH_TOP, ...FUZZ_MARKS])
                        )
                },
                {
                    kinds: ['width'],
                    weight: 6,
                    make: () => widthEdit(pick(FUZZ_WIDTH_GLYPHS))
                },
                { kinds: ['kern'], weight: 6, make: kernEdit },
                { kinds: ['kern-delete'], weight: 2, make: kernDeleteEdit },
                { kinds: ['kern-group'], weight: 3, make: kernGroupEdit },
                { kinds: ['feature'], weight: 2, make: featureEdit },
                { kinds: ['unicode'], weight: 2, make: unicodeEdit },
                { kinds: ['align'], weight: 4, make: alignEdit },
                {
                    kinds: ['node-insert'],
                    weight: 2,
                    make: () => nodeEdit('node-insert')
                },
                {
                    kinds: ['node-remove'],
                    weight: 2,
                    make: () => nodeEdit('node-remove')
                },
                {
                    kinds: ['smooth'],
                    weight: 1,
                    make: () => nodeEdit('smooth')
                },
                { kinds: ['contour-add'], weight: 2, make: contourAddEdit },
                {
                    kinds: ['contour-remove'],
                    weight: 1,
                    make: () => contourEdit('contour-remove')
                },
                {
                    kinds: ['contour-reverse'],
                    weight: 1,
                    make: () => contourEdit('contour-reverse')
                },
                {
                    kinds: ['contour-open'],
                    weight: 1,
                    make: () => contourEdit('contour-open')
                },
                { kinds: ['transform'], weight: 2, make: transformEdit },
                { kinds: ['nudge'], weight: 3, make: nudgeEdit },
                { kinds: ['component-add'], weight: 2, make: componentAddEdit },
                {
                    kinds: ['component-remove'],
                    weight: 1,
                    make: () => componentEdit('component-remove')
                },
                {
                    kinds: ['component-swap'],
                    weight: 1,
                    make: () => componentEdit('component-swap')
                },
                {
                    kinds: ['component-decompose'],
                    weight: 1,
                    make: () => componentEdit('component-decompose')
                },
                {
                    kinds: ['component-transform'],
                    weight: 1,
                    make: () => componentEdit('component-transform')
                },
                { kinds: ['anchor-add'], weight: 1, make: anchorAddEdit },
                {
                    kinds: ['anchor-remove'],
                    weight: 1,
                    make: () => anchorChangeEdit('anchor-remove')
                },
                {
                    kinds: ['anchor-rename'],
                    weight: 1,
                    make: () => anchorChangeEdit('anchor-rename')
                },
                {
                    kinds: ['glyph-property'],
                    weight: 2,
                    make: glyphPropertyEdit
                },
                { kinds: ['metrics-key'], weight: 1, make: metricsKeyEdit },
                { kinds: ['free-drawing'], weight: 2, make: freeDrawingEdit },
                { kinds: ['background'], weight: 2, make: backgroundEdit },
                { kinds: ['variation'], weight: 2, make: variationEdit },
                {
                    kinds: ['glyph-add', 'glyph-rename', 'glyph-delete'],
                    weight: 2,
                    make: glyphLifecycleEdit
                },
                {
                    kinds: ['kern-group-delete'],
                    weight: 1,
                    make: kernGroupDeleteEdit
                },
                { kinds: ['feature-list'], weight: 1, make: featureListEdit },
                {
                    kinds: ['feature-prefix'],
                    weight: 1,
                    make: featurePrefixEdit
                },
                { kinds: ['feature-class'], weight: 1, make: featureClassEdit },
                {
                    kinds: ['station-metric'],
                    weight: 2,
                    make: stationMetricEdit
                },
                { kinds: ['instance'], weight: 1, make: instanceEdit },
                { kinds: ['font-info'], weight: 1, make: fontInfoEdit }
            ];
            const editTable = FUZZ_KINDS
                ? EDIT_TABLE.filter((entry) =>
                      entry.kinds.some((kind) => FUZZ_KINDS!.has(kind))
                  )
                : EDIT_TABLE;
            if (!editTable.length) {
                throw new Error(
                    `FUZZ_KINDS matches no edit: ${[...FUZZ_KINDS!].join(', ')}`
                );
            }
            const totalWeight = editTable.reduce(
                (sum, entry) => sum + entry.weight,
                0
            );
            const randomEdit = (): FuzzEdit => {
                let roll = random() * totalWeight;
                for (const entry of editTable) {
                    roll -= entry.weight;
                    if (roll < 0) {
                        return entry.make();
                    }
                }
                return editTable.at(-1)!.make();
            };

            // ── History model: what each history may undo and redo ───────
            const items: HistoryItem[] = [];
            const redoStacks = new Map<HistoryGroup, HistoryItem[]>();
            // Every change after the edits, and which history item made it
            // (its own undo or redo), or null for any other step.
            const changeLog: Array<{
                step: number;
                keys: string[];
                by: HistoryItem | null;
            }> = [];
            // Clean: since the edit, only its own undo and redo changed its data.
            const isClean = (item: HistoryItem) =>
                changeLog.every(
                    (change) =>
                        change.step <= item.step ||
                        change.by === item ||
                        !change.keys.some((key) => item.changed.includes(key))
                );
            // Kerning, groups and Unicode are font-wide: an undo in any
            // glyph can reach them. Feature code has its own history target.
            const historyGlyphOf = (edit: FuzzEdit): string | null =>
                edit.kind === 'feature'
                    ? '#feature'
                    : edit.kind === 'kern' ||
                        edit.kind === 'kern-delete' ||
                        edit.kind === 'kern-group' ||
                        edit.kind === 'unicode'
                      ? null
                      : (edit as { glyph: string }).glyph;
            /** Undo and redo from a glyph never target a surface of its own. */
            const undoableFromGlyphs = (item: HistoryItem) =>
                !item.historyGlyph?.startsWith('#');
            const reachableFrom = (item: HistoryItem, glyph: string) =>
                item.historyGlyph === glyph ||
                item.historyGlyph === null ||
                item.fontWide === true;
            // Undo in a glyph takes that glyph's latest edit, and an edit
            // that changed font-wide data only when the glyph has none.
            const undoTargetIn = (list: HistoryItem[], glyph: string) =>
                list.filter((item) => item.historyGlyph === glyph).at(-1) ??
                list
                    .filter(
                        (item) =>
                            item.historyGlyph === null || item.fontWide === true
                    )
                    .at(-1) ??
                null;
            // Redo follows one stack per surface (glyph and master; font-wide
            // edits belong to every surface): an undone edit stays redoable
            // until a newer edit of that history lands on the same surface.
            const onSurface = (
                item: HistoryItem,
                glyph: string,
                station: FuzzStationId
            ) =>
                (item.historyGlyph === glyph && item.master === station) ||
                item.historyGlyph === null ||
                item.fontWide === true;
            const redoableFrom = (
                group: HistoryGroup,
                glyph: string,
                station: FuzzStationId
            ) =>
                (redoStacks.get(group) ?? [])
                    .filter(
                        (undone) =>
                            onSurface(undone, glyph, station) &&
                            !items.some(
                                (other) =>
                                    other.group === group &&
                                    other.step > (undone.undoneAt ?? -1) &&
                                    onSurface(other, glyph, station)
                            )
                    )
                    .sort((a, b) => (a.undoneAt ?? 0) - (b.undoneAt ?? 0));
            /** Did this window’s latest edit also change data outside glyphs? */
            const latestEditIsFontWide = (page: Page) =>
                page.evaluate(() => {
                    const log: any[] =
                        (window as any).patchSyncEngine?._changeLog ?? [];
                    const own = log.filter(
                        (entry) =>
                            entry.historyAction === 'change' &&
                            entry.transactionLabel !== 'Glyph revision'
                    );
                    const last = own.at(-1);
                    if (!last) {
                        return false;
                    }
                    return own
                        .filter(
                            (entry) =>
                                entry.historyItemId === last.historyItemId
                        )
                        .some(
                            (entry) =>
                                !String(entry.path || '').startsWith('glyphs.')
                        );
                });

            /**
             * Where this window filed its latest edit, read from the history
             * the app recorded (extended edits; the first ten are modelled
             * above): null for font scope, which undo in any glyph reaches,
             * otherwise the glyph, whichever of its drawings it changed.
             */
            const observedHistoryGlyph = (page: Page, edit: FuzzEdit) =>
                page.evaluate(
                    (glyph) => {
                        const log: any[] =
                            (window as any).patchSyncEngine?._changeLog ?? [];
                        const own = log.filter(
                            (entry) =>
                                entry.historyAction === 'change' &&
                                entry.transactionLabel !== 'Glyph revision'
                        );
                        const last = own.at(-1);
                        if (!last || !glyph) {
                            return null;
                        }
                        const fontScoped = own
                            .filter(
                                (entry) =>
                                    entry.historyItemId === last.historyItemId
                            )
                            .some(
                                (entry) =>
                                    entry.undoScope === 'font' ||
                                    !String(entry.path || '').startsWith(
                                        'glyphs.'
                                    )
                            );
                        return fontScoped ? null : glyph;
                    },
                    'glyph' in edit ? edit.glyph : null
                );

            // ── Traffic: each step costs the minimum the rooms prove ─────
            // One update per changed room; the sender’s main window posts
            // each changed glyph once (or sends it on the socket it holds
            // live), every other main window fetches it once (or receives it
            // on its socket), and linked windows touch no room.
            const mainOf = (fuzzWindow: FuzzWindow) =>
                fuzzWindow.name === 'L1'
                    ? 'M'
                    : fuzzWindow.name === 'L2'
                      ? 'I'
                      : fuzzWindow.name;
            const trafficLabels = () =>
                new Map<Page, string>(
                    windows.map((fuzzWindow) => [
                        fuzzWindow.page,
                        fuzzWindow.name
                    ])
                );
            const glyphNamesById = async () =>
                new Map<string, string>(
                    await mainPage.evaluate(() => [
                        ...((window as any).changeBridge?._glyphNameById ??
                            new Map())
                    ])
                );
            const beginTrafficMeasure = async () => {
                for (const fuzzWindow of windows) {
                    await waitForCloudLiveIdle(fuzzWindow.page).catch(() => {});
                    // A glyph opened for this step connects its live socket,
                    // and asks for the room’s status once connected. A room
                    // that joins or reconnects late also loads its state.
                    // None of it is the step’s traffic, so wait until every
                    // room the window wants has a synced socket.
                    await expect
                        .poll(
                            () =>
                                fuzzWindow.page.evaluate(async () => {
                                    const session = (window as any).cloudPlugin
                                        ?._liveSession;
                                    return (
                                        (await session?.settleLiveDocuments?.()) ??
                                        []
                                    );
                                }),
                            {
                                timeout: 30000,
                                message: `${fuzzWindow.name}: live sockets connected`
                            }
                        )
                        .toEqual([]);
                }
                await mainPage.waitForTimeout(1500);
                const names = await glyphNamesById();
                const roomDocs = await fontRoomDocumentIds(mainPage, [
                    ...names.keys()
                ]);
                const live: Record<string, string[]> = {};
                for (const name of ['M', 'O2', 'I']) {
                    live[name] = await liveGlyphNames(
                        windows.find((w) => w.name === name)!.page
                    );
                }
                return {
                    names,
                    roomDocs,
                    live,
                    rooms: await readRoomCounters(mainPage, roomDocs),
                    mark: markCloudRoomTraffic(...roomTraffic)
                };
            };
            const expectMinimalStepTraffic = async (
                label: string,
                sender: FuzzWindow,
                measured: Awaited<ReturnType<typeof beginTrafficMeasure>>
            ) => {
                // Late catch-ups or retries would land in this window.
                await mainPage.waitForTimeout(2500);
                // Rooms that exist after the step: a glyph the step added
                // has a new room, one it deleted may be purged already.
                const namesAfter = await glyphNamesById();
                for (const [id, name] of namesAfter) {
                    if (!measured.names.has(id)) {
                        measured.names.set(id, name);
                    }
                }
                const roomDocsAfter = await fontRoomDocumentIds(mainPage, [
                    ...namesAfter.keys()
                ]);
                const traffic = summarizeRoomTraffic(
                    roomTraffic,
                    measured.mark,
                    trafficLabels(),
                    measured.names
                );
                const named = (id: string) =>
                    id.startsWith('glyph:')
                        ? `glyph/${measured.names.get(id.slice(6)) ?? id}`
                        : id;
                const roomDelta = diffRoomCounters(
                    measured.rooms,
                    await readRoomCounters(mainPage, roomDocsAfter)
                );
                const rooms = Object.fromEntries(
                    Object.entries(roomDelta).map(([id, delta]) => [
                        named(id),
                        delta
                    ])
                );
                const uploader = mainOf(sender);
                try {
                    expectMinimalRoomTraffic({
                        label,
                        traffic,
                        rooms,
                        uploader: {
                            name: uploader,
                            live: measured.live[uploader]
                        },
                        downloaders: ['M', 'O2', 'I']
                            .filter((name) => name !== uploader)
                            .map((name) => ({
                                name,
                                live: measured.live[name]
                            })),
                        quiet: ['L1', 'L2']
                    });
                } catch (error) {
                    console.log(
                        `[fuzz] traffic ${label} ${JSON.stringify({
                            live: measured.live,
                            detail: traffic.detail,
                            frames: traffic.frames,
                            rooms
                        })}`
                    );
                    throw error;
                }
            };

            const runStep = async (step: number) => {
                const window = pick(windows);
                const group = window.group;
                const roll = random();
                const own = items.filter(
                    (item) =>
                        item.group === group &&
                        !item.undone &&
                        undoableFromGlyphs(item)
                );
                // Undone edits redoable from their own surface.
                const redoable = (redoStacks.get(group) ?? []).filter(
                    (undone) =>
                        undoableFromGlyphs(undone) &&
                        redoableFrom(
                            group,
                            undone.historyGlyph ?? 'a',
                            undone.master
                        ).includes(undone)
                );
                let edit: FuzzEdit;
                let target: HistoryItem | null = null;
                let crossUser = false;
                if (roll < 0.2 && own.length) {
                    // Undo this history’s latest edit on a glyph, or its
                    // latest font-wide edit, whichever came last.
                    const picked = pick(own);
                    const glyph = picked.historyGlyph ?? 'a';
                    target = undoTargetIn(own, glyph)!;
                    edit = { kind: 'undo', glyph, master: target.master };
                } else if (roll < 0.28 && redoable.length) {
                    target = redoable.reduce((latest, item) =>
                        (item.undoneAt ?? 0) > (latest.undoneAt ?? 0)
                            ? item
                            : latest
                    );
                    edit = {
                        kind: 'redo',
                        glyph: target.historyGlyph ?? 'a',
                        master: target.master
                    };
                } else if (roll < 0.36) {
                    // Undo on a glyph whose history this window does not own:
                    // the collaborators’ edits there must stay.
                    const others = items.filter(
                        (item) =>
                            item.group !== group &&
                            !item.undone &&
                            item.historyGlyph !== null &&
                            undoableFromGlyphs(item) &&
                            !own.some((mine) =>
                                reachableFrom(mine, item.historyGlyph!)
                            )
                    );
                    if (others.length) {
                        const item = pick(others);
                        crossUser = true;
                        edit = {
                            kind: pick(['undo', 'redo'] as const),
                            glyph: item.historyGlyph!,
                            master: item.master
                        };
                        if (
                            edit.kind === 'redo' &&
                            redoableFrom(group, item.historyGlyph!, item.master)
                                .length
                        ) {
                            edit = { ...edit, kind: 'undo' };
                        }
                    } else {
                        edit = randomEdit();
                    }
                } else {
                    edit = randomEdit();
                }
                const description = `${window.name} ${describeFuzzEdit(edit)}${crossUser ? ' (not this history’s edit)' : ''}`;
                record(`step ${step}: ${description}`);

                const before = flatten(snapshot);
                await paintTiles();
                // Open the glyph first: moving the live socket to it is not
                // part of the edit’s cost.
                await openFuzzGlyph(
                    window.page,
                    fuzzEditOpenGlyph(edit),
                    edit.master
                );
                const measured = await beginTrafficMeasure();
                await applyFuzzEdit(window.page, edit);
                snapshot = await checkAll(`step ${step} (${description})`);
                await expectMinimalStepTraffic(
                    `step ${step} (${description})`,
                    window,
                    measured
                );
                const after = flatten(snapshot);
                const changed = changedKeys(before, after);
                const diagnostics = async () => {
                    const engine = await window.page.evaluate(() => {
                        const bridge = (window as any).patchSyncEngine;
                        return {
                            touches: (bridge?._collaboratorTouches ?? [])
                                .slice(-12)
                                .map(
                                    (touch: any) => `${touch.seq} ${touch.path}`
                                ),
                            log: bridge?._changeLog?.length ?? null
                        };
                    });
                    const historyTail = await readChangeLogTail(
                        window.page,
                        10
                    );
                    return `change log:\n  ${historyTail.join('\n  ')}\nconsole:\n  ${(
                        consoleTails.get(window.page) ?? []
                    )
                        .filter((line) => !line.includes('409'))
                        .slice(-10)
                        .join(
                            '\n  '
                        )}\ncollaborator touches (log ${engine.log}):\n  ${engine.touches.join('\n  ')}`;
                };
                const failureText = async (reason: string) =>
                    `step ${step} (${description}): ${reason}\nchanged: ${changed.join(', ') || 'nothing'}\n${await diagnostics()}`;
                const failure = (reason: string) =>
                    new Error(
                        `step ${step} (${description}): ${reason}\nchanged: ${changed.join(', ') || 'nothing'}`
                    );

                if (edit.kind === 'undo' || edit.kind === 'redo') {
                    const ownItems =
                        edit.kind === 'undo'
                            ? items.filter(
                                  (item) => item.group === group && !item.undone
                              )
                            : redoableFrom(group, edit.glyph, edit.master);
                    // A replay also recomposes automatic composites built on
                    // the glyph it restores, even ones its edit did not
                    // touch: keys that changed only in what alignment
                    // derives are not the edit itself (the composite check
                    // covers them).
                    const ownChanged = changed.filter(
                        (key) =>
                            withoutDerived(before[key]) !==
                            withoutDerived(after[key])
                    );
                    // Which own item, if any, this change reverts or restores.
                    const matched = ownChanged.length
                        ? ownItems.find((item) => {
                              const goal =
                                  edit.kind === 'undo'
                                      ? item.before
                                      : item.after;
                              return (
                                  ownChanged.every((key) =>
                                      item.changed.includes(key)
                                  ) &&
                                  item.changed.every(
                                      (key) =>
                                          withoutDerived(after[key]) ===
                                          withoutDerived(goal[key])
                                  )
                              );
                          })
                        : undefined;
                    // When a collaborator edited the same glyph since, the
                    // undo reverts only this history’s part (a selective
                    // undo): it may touch no data its own edit did not.
                    const selective = matched
                        ? undefined
                        : ownChanged.length > 0
                          ? [
                                ...(target ? [target] : []),
                                ...ownItems.slice().reverse()
                            ].find(
                                (item) =>
                                    !isClean(item) &&
                                    ownChanged.every((key) =>
                                        item.changed.includes(key)
                                    )
                            )
                          : undefined;
                    if (ownChanged.length && !matched && !selective) {
                        throw failure(
                            `${edit.kind} changed data that is not this history’s own edit`
                        );
                    }
                    if (crossUser && ownChanged.length) {
                        throw new Error(
                            await failureText(
                                `${edit.kind} on a glyph this history never edited changed the font`
                            )
                        );
                    }
                    // Undo must not be refused where its target is certain:
                    // this history’s most recent edit, made on this glyph,
                    // untouched since. Other targets depend on the layer
                    // and font-wide scopes; there only the author rule holds.
                    const certain =
                        !!target &&
                        target.historyGlyph === edit.glyph &&
                        ownItems.at(-1) === target;
                    if (
                        target &&
                        certain &&
                        isClean(target) &&
                        matched !== target
                    ) {
                        record(
                            await failureText(
                                `${target.description} entries: ${target.changed.join(', ')}`
                            )
                        );
                        throw failure(
                            `${edit.kind} of “${target.description}” was refused or reverted something else, though nobody has touched its data since`
                        );
                    }
                    const reverted = matched ?? selective;
                    changeLog.push({
                        step,
                        keys: changed,
                        by: reverted ?? null
                    });
                    if (reverted) {
                        reverted.undone = edit.kind === 'undo';
                        reverted.undoneAt =
                            edit.kind === 'undo' ? step : undefined;
                        const stack = redoStacks.get(group) ?? [];
                        redoStacks.set(
                            group,
                            edit.kind === 'undo'
                                ? [...stack, reverted]
                                : stack.filter((item) => item !== reverted)
                        );
                    }
                } else {
                    if (!changed.length) {
                        throw failure('the edit changed nothing');
                    }
                    const historyGlyph = isExtendedFuzzEdit(edit)
                        ? await observedHistoryGlyph(window.page, edit)
                        : historyGlyphOf(edit);
                    items.push({
                        group,
                        historyGlyph,
                        fontWide:
                            historyGlyph !== null &&
                            (await latestEditIsFontWide(window.page)),
                        master: edit.master,
                        description,
                        changed,
                        before,
                        after,
                        step,
                        undone: false
                    });
                    // A new edit discards redo only on its own surface; see
                    // `redoableFrom`.
                    changeLog.push({ step, keys: changed, by: null });
                }
            };

            // ── Phase 1: one window at a time ────────────────────────────
            let step = 0;
            for (; step < STEPS; step++) {
                await runStep(step);
                if (STOP_AT !== null && step >= STOP_AT) {
                    record(`stopped at step ${step}`);
                    return;
                }
            }

            // ── Phase 2: all windows edit at once, each on its own glyphs ─
            // Concurrent edits to one glyph may leave a composite where its
            // other author put it; separate families keep the expected
            // result defined.
            const families: Array<() => FuzzEdit> = [
                () => (random() < 0.5 ? outlineEdit('l') : widthEdit('l')),
                () => pick([outlineEdit, anchorEdit, widthEdit])('a'),
                () => pick([outlineEdit, anchorEdit, widthEdit])('o'),
                () => outlineEdit(pick(FUZZ_MARKS)),
                () => pick([kernEdit, kernDeleteEdit])(),
                // Feature code, the catalog and kerning groups: font-wide
                // data in rooms of their own.
                () => pick([featureEdit, unicodeEdit, kernGroupEdit])()
            ];
            for (let round = 0; round < 3; round++) {
                const order = [...families].sort(() => random() - 0.5);
                const plan = windows.map((window, index) => ({
                    window,
                    edits: [order[index](), order[index]()]
                }));
                for (const { window, edits } of plan) {
                    for (const edit of edits) {
                        record(
                            `burst ${round}: ${window.name} ${describeFuzzEdit(edit)}`
                        );
                    }
                }
                await paintTiles();
                await Promise.all(
                    plan.map(async ({ window, edits }) => {
                        for (const edit of edits) {
                            await applyFuzzEdit(window.page, edit);
                        }
                    })
                );
                snapshot = await checkAll(`burst ${round}`);
                step++;
            }

            // ── Phase 2b: two windows write one kerning pair at once ─────
            // Both values are legal; every window must end with the same one.
            // Meanwhile another window deletes a pair, and the linked
            // windows edit feature code and the catalog.
            {
                const station = pick(FUZZ_STATIONS).id;
                const pair = pick(FUZZ_KERN_PAIRS);
                const current = snapshot.kerning[station]?.[pair] ?? 0;
                // A third window deletes (or sets) a different pair.
                const otherPair = pick(
                    FUZZ_KERN_PAIRS.filter((other) => other !== pair)
                );
                const otherPairEdit: FuzzEdit =
                    snapshot.kerning[station]?.[otherPair] !== undefined
                        ? {
                              kind: 'kern-delete',
                              master: station,
                              pair: otherPair
                          }
                        : {
                              kind: 'kern',
                              master: station,
                              pair: otherPair,
                              value: delta(8) * 10
                          };
                const plan: Array<[FuzzWindow, FuzzEdit]> = [
                    [
                        windows[0],
                        {
                            kind: 'kern',
                            master: station,
                            pair,
                            value: current + 30
                        }
                    ],
                    [
                        windows[3],
                        {
                            kind: 'kern',
                            master: station,
                            pair,
                            value: current - 30
                        }
                    ],
                    [windows[2], otherPairEdit],
                    [windows[1], featureEdit()],
                    [windows[4], unicodeEdit()]
                ];
                for (const [window, edit] of plan) {
                    record(
                        `same pair: ${window.name} ${describeFuzzEdit(edit)}`
                    );
                }
                await paintTiles();
                await Promise.all(
                    plan.map(([window, edit]) =>
                        applyFuzzEdit(window.page, edit)
                    )
                );
                snapshot = await checkAll('same kerning pair at once');
                const settled = snapshot.kerning[station]?.[pair] ?? 0;
                expect(
                    [current + 30, current - 30],
                    `same pair: ${pair}/${station} settles on one of the two values`
                ).toContain(settled);
                step++;
            }

            // ── Phase 2c: a glyph is added, renamed, edited and deleted ──
            // Each step in another window; every window must follow.
            {
                const added = 'fuzz.new';
                const renamed = 'fuzz.renamed';
                const presence = async (names: string[]) =>
                    JSON.stringify(
                        await Promise.all(
                            windows.map((window) =>
                                window.page.evaluate(
                                    (list) =>
                                        list.map(
                                            (name: string) =>
                                                !!(
                                                    window as any
                                                ).currentFontModel?.findGlyph?.(
                                                    name
                                                )
                                        ),
                                    names
                                )
                            )
                        )
                    );
                const expectPresence = async (
                    label: string,
                    expected: boolean[]
                ) => {
                    await expect
                        .poll(() => presence([added, renamed]), {
                            timeout: 90000,
                            message: `glyph lifecycle: ${label}`
                        })
                        .toBe(JSON.stringify(windows.map(() => expected)));
                };
                // The invited editor adds it: its room is created on an
                // editor's write too.
                record(`glyph lifecycle: I adds ${added}`);
                await inviteePage.evaluate((name) => {
                    (window as any).currentFontModel.addGlyph(name, 'Base');
                }, added);
                await expectPresence('added', [true, false]);
                // Another browser renames it while the adding window has it.
                record(`glyph lifecycle: O2 renames ${added} to ${renamed}`);
                await ownerSecondPage.evaluate(
                    ({ from, to }) => {
                        (window as any).currentFontModel.renameGlyphs(
                            new Map([[from, to]])
                        );
                    },
                    { from: added, to: renamed }
                );
                await expectPresence('renamed', [false, true]);
                const width = 400 + delta(50);
                const station = pick(FUZZ_STATIONS).id;
                record(
                    `glyph lifecycle: O2 sets ${renamed}/${station} width ${width}`
                );
                await ownerSecondPage.evaluate(
                    ({ name, layerId: drawingId, value }) => {
                        const w = window as any;
                        const bridge = w.patchSyncEngine;
                        bridge.beginTransaction('Set width', null, {
                            compileChangeSource: 'keyboard-sidebearing',
                            compileEditType: null
                        });
                        try {
                            w.currentFontModel
                                .findGlyph(name)
                                .findDrawingById(drawingId).width = value;
                        } finally {
                            bridge.endTransaction();
                        }
                    },
                    { name: renamed, layerId: station, value: width }
                );
                await expect
                    .poll(
                        async () =>
                            JSON.stringify(
                                await Promise.all(
                                    windows.map((window) =>
                                        window.page.evaluate(
                                            ({ name, layerId: drawingId }) =>
                                                (window as any).currentFontModel
                                                    ?.findGlyph?.(name)
                                                    ?.findDrawingById?.(
                                                        drawingId
                                                    )?.width ?? null,
                                            { name: renamed, layerId: station }
                                        )
                                    )
                                )
                            ),
                        {
                            timeout: 90000,
                            message:
                                'glyph lifecycle: the width reaches every window'
                        }
                    )
                    .toBe(JSON.stringify(windows.map(() => width)));
                record(`glyph lifecycle: L2 deletes ${renamed}`);
                await inviteeLinkedPage.evaluate((name) => {
                    (window as any).currentFontModel.deleteGlyphs([name]);
                }, renamed);
                await expectPresence('deleted', [false, false]);
                record(`glyph lifecycle: O2 adds ${renamed} again`);
                await ownerSecondPage.evaluate((name) => {
                    (window as any).currentFontModel.addGlyph(name, 'Base');
                }, renamed);
                await expectPresence('added again', [false, true]);
                snapshot = await checkAll('glyph lifecycle');
                step++;
            }

            // ── Phase 2d: a station is added, edited and removed ─────────
            // Font Info's Add station, which interpolates every glyph's
            // drawing at the new location; another browser edits its
            // metrics; a third window removes it.
            {
                record('station lifecycle: M adds a station at wght 500');
                const stationId = await mainPage.evaluate(async () => {
                    const w = window as any;
                    const gate = w.currentFontModel.getStationTopologyGate?.();
                    if (gate && gate.allowed === false) {
                        throw new Error(
                            `Add station is blocked: ${gate.reason ?? 'no reason'}`
                        );
                    }
                    let station: any;
                    try {
                        station = await w.currentFontModel.addStation(
                            undefined,
                            {
                                location: { wght: 500 },
                                metricTemplateStationId: 'M1'
                            }
                        );
                    } catch (error) {
                        // Which glyphs no longer interpolate, and how each
                        // of their drawings differs.
                        // `p` takes the structure edits: always listed.
                        const report = (w.currentFontModel.glyphs ?? [])
                            .filter(
                                (glyph: any) =>
                                    glyph.name === 'p' ||
                                    glyph.calculateOutlineCompatibility?.()
                                        ?.compatible === false
                            )
                            .map((glyph: any) => {
                                const layers =
                                    (glyph.toJSON?.() ?? glyph.data)?.layers ??
                                    [];
                                return `${glyph.name}:\n${layers
                                    .map(
                                        (layer: any) =>
                                            `  ${layer.id} ${layer.master?.type ?? ''}: ${(
                                                layer.shapes ?? []
                                            )
                                                .map((shape: any) =>
                                                    shape.reference
                                                        ? `[${shape.reference}]`
                                                        : (shape.nodes ?? [])
                                                              .map(
                                                                  (node: any) =>
                                                                      `${String(node.nodetype ?? '').charAt(0)}${node.smooth ? 's' : ''}`
                                                              )
                                                              .join('')
                                                )
                                                .join(' | ')} anchors ${(
                                                layer.anchors ?? []
                                            )
                                                .map(
                                                    (anchor: any) => anchor.name
                                                )
                                                .join(',')}`
                                    )
                                    .join('\n')}`;
                            });
                        throw new Error(
                            `${error instanceof Error ? error.message : String(error)}\np and any glyph the model finds incompatible:\n${report.join('\n')}`
                        );
                    }
                    await w.patchSyncEngine.waitForPendingCloudCommits?.();
                    return (station?.id as string | undefined) ?? null;
                });
                expect(stationId, 'Add station made a station').toBeTruthy();
                snapshot = await checkAll('station lifecycle: added');
                const withoutDrawing = FUZZ_GLYPHS.filter(
                    (name) =>
                        snapshot.glyphs[name] &&
                        !(snapshot.glyphs[name] as any)[stationId!]
                );
                expect(
                    withoutDrawing,
                    'every glyph has a drawing at the new station'
                ).toEqual([]);
                record('station lifecycle: I edits its x-height');
                await inviteePage.evaluate(async (id) => {
                    const w = window as any;
                    const station = w.currentFontModel.stations.find(
                        (item: any) => item.id === id
                    );
                    w.patchSyncEngine.beginTransaction(
                        'Edit station metrics',
                        null,
                        {
                            compileChangeSource: 'font-info',
                            compileEditType: null
                        }
                    );
                    try {
                        station.metrics = {
                            ...JSON.parse(
                                JSON.stringify(station.metrics ?? {})
                            ),
                            XHeight: 520
                        };
                    } finally {
                        w.patchSyncEngine.endTransaction();
                    }
                    await w.patchSyncEngine.waitForPendingCloudCommits?.();
                }, stationId);
                snapshot = await checkAll('station lifecycle: edited');
                record('station lifecycle: O2 removes it');
                await ownerSecondPage.evaluate(async (id) => {
                    const w = window as any;
                    await w.currentFontModel.removeStationsByIds([id]);
                    await w.patchSyncEngine.waitForPendingCloudCommits?.();
                }, stationId);
                snapshot = await checkAll('station lifecycle: removed');
                expect(
                    ((snapshot.font as any).stations ?? []).map(
                        (station: any) => station.id
                    ),
                    'only the fixture stations are left'
                ).toEqual(FUZZ_STATIONS.map((station) => station.id));
            }

            // ── Phase 3: the second browser goes offline and catches up ──
            record('O2 offline');
            await ownerSecondContext.setOffline(true);
            const offlineEdits = [
                pick([outlineEdit, widthEdit])('o'),
                anchorEdit('o'),
                featureEdit()
            ];
            for (const edit of offlineEdits) {
                record(`offline: O2 ${describeFuzzEdit(edit)}`);
                await applyFuzzEdit(ownerSecondPage, edit, {
                    awaitCloud: false
                });
            }
            const onlineEdits: Array<[Page, string, FuzzEdit]> = [
                [mainPage, 'M', widthEdit('l')],
                [inviteePage, 'I', kernEdit()],
                [inviteeLinkedPage, 'L2', anchorEdit('a')]
            ];
            for (const [page, name, edit] of onlineEdits) {
                record(
                    `while O2 is offline: ${name} ${describeFuzzEdit(edit)}`
                );
                await applyFuzzEdit(page, edit);
            }
            await ownerSecondContext.setOffline(false);
            record('O2 online');
            await converge('after O2 reconnects', 180000);
            snapshot = await checkAll('after O2 reconnects');

            // ── Phase 3b: the network drops while an edit is on its way ──
            {
                const station = pick(FUZZ_STATIONS).id;
                const pair = pick(FUZZ_KERN_PAIRS);
                const value = delta(8) * 10 + 3;
                record(
                    `network cut: O2 sets ${pair}/${station} ${value}, then goes offline`
                );
                await applyFuzzEdit(
                    ownerSecondPage,
                    { kind: 'kern', master: station, pair, value },
                    { awaitCloud: false }
                );
                await ownerSecondContext.setOffline(true);
                const whileCut = [outlineEdit('l'), unicodeEdit()];
                for (const edit of whileCut) {
                    record(`network cut: O2 ${describeFuzzEdit(edit)}`);
                    await applyFuzzEdit(ownerSecondPage, edit, {
                        awaitCloud: false
                    });
                }
                await ownerSecondContext.setOffline(false);
                record('network cut: O2 online');
                await converge('after the network came back', 180000);
                snapshot = await checkAll('after a network cut mid-send');
                expect(
                    snapshot.kerning[station]?.[pair],
                    'network cut: the edit on its way survived'
                ).toBe(value);
                step++;
            }

            // ── Phase 3c: a window closes with unsent edits, then reopens ─
            // Offline, so the edits are only in this browser's outbox on
            // disk when the tab closes; the reopened tab must send them.
            {
                const station = pick(FUZZ_STATIONS).id;
                const pair = pick(FUZZ_KERN_PAIRS);
                const value = delta(8) * 10 + 7;
                record('tab close: O2 offline');
                await ownerSecondContext.setOffline(true);
                record(`tab close: O2 sets ${pair}/${station} ${value}`);
                await applyFuzzEdit(
                    windows[2].page,
                    { kind: 'kern', master: station, pair, value },
                    { awaitCloud: false }
                );
                await expect
                    .poll(
                        () =>
                            windows[2].page.evaluate(
                                () =>
                                    (window as any).cloudPlugin?._liveSession
                                        ?.pendingSyncCount ?? 0
                            ),
                        {
                            timeout: 30000,
                            message: 'tab close: the edit waits to be sent'
                        }
                    )
                    .toBeGreaterThan(0);
                // The outbox write to IndexedDB finishes on its own.
                await windows[2].page.waitForTimeout(1500);
                record('tab close: O2 closes');
                await windows[2].page.close();
                await ownerSecondContext.setOffline(false);
                const reopened = await openCloudWindow(
                    ownerSecondContext,
                    editorHref
                );
                await openEditor(reopened.page);
                windows[2].page = reopened.page;
                windows[2].errors = reopened.errors;
                trafficNames.set(reopened.page, 'O2');
                record('tab close: O2 reopened');
                // Glyphs the text does not show load as the overview shows
                // them, the re-added one among them.
                const loaded = await loadCatalogGlyphs(reopened.page);
                if (loaded.length) {
                    record(`tab close: O2 loads ${loaded.join(', ')}`);
                }
                await converge('after O2 reopened', 180000);
                snapshot = await checkAll('after O2 reopened');
                expect(
                    snapshot.kerning[station]?.[pair],
                    'tab close: the unsent edit was sent by the reopened tab'
                ).toBe(value);
                step++;
            }

            // ── Phase 4: the invitee’s linked window reloads ─────────────
            record('L2 reload');
            inviteeLinkedErrors.length = 0;
            await inviteeLinkedPage.reload();
            await waitForCanvasReady(inviteeLinkedPage);
            await waitForFontLoaded(inviteeLinkedPage);
            await waitForFullStateSync(inviteeLinkedPage);
            await waitForBridgeReady(inviteeLinkedPage);
            await waitForWindowSyncReady(inviteeLinkedPage);
            await installEditingFontCompileTracker(inviteeLinkedPage);
            await waitForWindowSyncPeers(inviteePage, inviteeLinkedPage);
            await openEditor(inviteeLinkedPage);
            snapshot = await checkAll('after L2 reload');
            // A linked window learns from main whether it may edit; after a
            // reload that takes a moment, and it must not stay read-only.
            const reloadedAt = Date.now();
            await expect
                .poll(
                    () =>
                        inviteeLinkedPage.evaluate(
                            () =>
                                (
                                    window as any
                                ).cloudPlugin?.canMutateCurrentAsset?.() ===
                                true
                        ),
                    {
                        timeout: 30000,
                        message: 'reloaded L2 becomes editable'
                    }
                )
                .toBe(true)
                .catch(async (error) => {
                    const why = await inviteeLinkedPage.evaluate(() => {
                        const w = window as any;
                        const plugin = w.cloudPlugin;
                        return {
                            relayedCanMutate: plugin?._relayedCanMutate,
                            relayedStatus: plugin?._relayedConnectionStatus,
                            relayedAssetId: plugin?._relayedAssetId,
                            connectionStatus: plugin?.connectionStatus,
                            linkedReadOnly: w.windowSync?.linkedReadOnly,
                            role: plugin?.getCurrentAssetRole?.(),
                            assetId: plugin?.getCurrentAssetIdForSharing?.(),
                            liveSession: !!plugin?._liveSession,
                            eligibility: plugin?._eligibility ?? null,
                            cloudBacked:
                                w.fontManager?.currentFont?.isCloudBacked?.()
                        };
                    });
                    const mainWhy = await inviteePage.evaluate(() => {
                        const plugin = (window as any).cloudPlugin;
                        return {
                            canMutate: plugin?.canMutateCurrentAsset?.(),
                            session: plugin?._sessionAllowsMutation?.(),
                            status: plugin?.connectionStatus
                        };
                    });
                    throw new Error(
                        `${error instanceof Error ? error.message : String(error)}\nL2: ${JSON.stringify(why)}\nI: ${JSON.stringify(mainWhy)}`
                    );
                });
            record(`L2 editable ${Date.now() - reloadedAt} ms after the check`);
            const afterReload = outlineEdit('a');
            record(`after reload: L2 ${describeFuzzEdit(afterReload)}`);
            await paintTiles();
            await applyFuzzEdit(inviteeLinkedPage, afterReload);
            snapshot = await checkAll('edit after L2 reload');

            // ── Phase 4b: an axis is added ───────────────────────────────
            // Font Info's Add axis without station copies: every station and
            // instance sits at the new axis's default, so no glyph changes.
            record('axis: O2 adds a width axis');
            // O2's tab was closed and reopened above: use its current page.
            const reopenedSecond = windows.find(
                (window) => window.name === 'O2'
            )!.page;
            await reopenedSecond.evaluate(async () => {
                const w = window as any;
                w.fontInfoManager.commitNewAxis(
                    {
                        name: { dflt: 'Width' },
                        tag: 'wdth',
                        min: 75,
                        default: 100,
                        max: 125
                    },
                    100
                );
                await w.patchSyncEngine.waitForPendingCloudCommits?.();
            });
            snapshot = await checkAll('axis added');
            expect(
                ((snapshot.font as any).axes ?? []).map((axis: any) => axis[0]),
                'the font has both axes'
            ).toEqual(['wght', 'wdth']);

            // ── Phase 5: the cloud kept it all ───────────────────────────
            const freshContext = await newContext(ownerSession);
            const { page: freshPage, errors: freshErrors } =
                await openCloudWindow(freshContext, editorHref);
            await openEditor(freshPage);
            await loadCatalogGlyphs(freshPage);
            await expect
                .poll(async () => flatten(await readFuzzSnapshot(freshPage)), {
                    timeout: 90000,
                    message: 'a new owner window loads what the windows show'
                })
                .toEqual(flatten(snapshot));
            const freshCompiled = await readCompiledOutlines(freshPage);
            expect(freshCompiled.error).toBeUndefined();
            expect(freshCompiled.editing).toEqual(freshCompiled.fresh);
            expect(
                JSON.stringify(freshCompiled.editing),
                'a new window compiles the same font'
            ).toBe(
                JSON.stringify((await readCompiledOutlines(mainPage)).editing)
            );
            expect(freshErrors).toEqual([]);
            record(`done: ${items.length} edits, seed ${SEED}`);
        } catch (error) {
            failed = true;
            console.log(
                `[fuzz] FAILED with seed ${SEED}. Steps:\n${log.join('\n')}`
            );
            for (const [page, lines] of consoleTails) {
                const name =
                    [...trafficNames].find(
                        ([candidate]) => candidate === page
                    )?.[1] ?? '?';
                console.log(
                    `[fuzz] console of ${name}:\n  ${lines.slice(-15).join('\n  ')}`
                );
            }
            // Each window's trace: the events that touched the glyphs the
            // error names in the log, all of it as an attachment (the
            // nightly uploads test-results).
            const message = error instanceof Error ? error.message : '';
            const words = new Set(message.split(/[^\w.]+/));
            const focus = FUZZ_GLYPHS.filter((name) => words.has(name));
            for (const [page, name] of trafficNames) {
                const entries = await readCollabTrace(page);
                console.log(
                    `[fuzz] trace of ${name}${focus.length ? ` for ${focus.join(', ')}` : ''} (${entries.length} events):\n  ${formatCollabTrace(entries, focus).join('\n  ')}`
                );
                const tracePath = test
                    .info()
                    .outputPath(`collab-trace-${name}.json`);
                fs.writeFileSync(tracePath, JSON.stringify(entries, null, 1));
                await test
                    .info()
                    .attach(`collab-trace-${name}.json`, {
                        path: tracePath,
                        contentType: 'application/json'
                    })
                    .catch(() => {});
            }
            fs.writeFileSync(
                test.info().outputPath('fuzz-steps.txt'),
                `seed ${SEED}\n${log.join('\n')}\n`
            );
            throw error;
        } finally {
            for (const context of contexts) {
                await context.close().catch(() => {});
            }
            // Deletes both accounts, the font, every glyph and every room.
            // A failed cleanup fails a passing run; after a failure it must
            // not hide the original error.
            try {
                await cleanupCloudCollabUsers(request, [
                    emails.owner,
                    emails.invitee
                ]);
            } catch (cleanupError) {
                console.log(`[fuzz] cleanup failed: ${cleanupError}`);
                if (!failed) throw cleanupError;
            }
        }
    });
});
