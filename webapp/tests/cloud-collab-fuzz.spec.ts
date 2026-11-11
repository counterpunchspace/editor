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
 * that step, skip the later phases) repeat or narrow a run. A failure prints
 * the seed and every step before it.
 */
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
    extractYDocLayerKeys,
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
    waitForCloudLiveIdle
} from './helpers/cloud-collab-three-window';
import { acceptCloudInviteAndGetEditorHref } from './helpers/cloud-collab-e2e';
import { makeSeededRandom } from './helpers/seeded-random';
import {
    FUZZ_BASES_WITH_TOP,
    FUZZ_COMPARE_LOCATION,
    FUZZ_COMPOSITES,
    FUZZ_GLYPHS,
    FUZZ_KERN_PAIRS,
    FUZZ_MARKS,
    FUZZ_MASTERS,
    FUZZ_OUTLINE_GLYPHS,
    FUZZ_WIDTH_GLYPHS,
    type FuzzEdit,
    type FuzzMasterId,
    type FuzzSnapshot,
    applyFuzzEdit,
    describeFuzzEdit,
    diagnoseStaleCompile,
    loadFuzzFont,
    openFuzzGlyph,
    metricsKeyMismatches,
    readChangeLogTail,
    readCompiledOutlines,
    readCompositionMismatches,
    readFuzzSnapshot
} from './helpers/cloud-collab-fuzz';

const SEED =
    process.env.FUZZ_SEED === 'random'
        ? Math.floor(Math.random() * 0x7fffffff)
        : Number(process.env.FUZZ_SEED ?? 20261110);
const STEPS = Number(process.env.FUZZ_STEPS ?? 40);
const STOP_AT = process.env.FUZZ_STOP_AT
    ? Number(process.env.FUZZ_STOP_AT)
    : null;
const KEYED_GLYPHS = new Set(['n', 'm', 'idotless']);

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
    /** Glyph whose history holds the edit; null for font-wide (kerning). */
    historyGlyph: string | null;
    master: FuzzMasterId;
    description: string;
    changed: string[];
    before: Record<string, string>;
    after: Record<string, string>;
    /** Step of the edit. */
    step: number;
    undone: boolean;
};

/**
 * Every value the fuzz compares, keyed by `<glyph>/<master>` or
 * `kern:<master>`: per master, so an edit to one master never makes an
 * edit to another look touched.
 */
function flatten(snapshot: FuzzSnapshot): Record<string, string> {
    const values: Record<string, string> = {};
    for (const name of FUZZ_GLYPHS) {
        const layers = (snapshot.glyphs[name] ?? {}) as Record<string, unknown>;
        for (const { id } of FUZZ_MASTERS) {
            values[`${name}/${id}`] = JSON.stringify(layers[id] ?? null);
        }
    }
    for (const { id } of FUZZ_MASTERS) {
        values[`kern:${id}`] = JSON.stringify(snapshot.kerning[id] ?? {});
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
    const layer = JSON.parse(value);
    const shapes = layer?.shapes ?? [];
    if (
        !shapes.length ||
        !shapes.every((shape: any) => shape.reference && shape.automatic)
    ) {
        return value;
    }
    return JSON.stringify({
        ...layer,
        width: null,
        shapes: shapes.map((shape: any) => ({ ...shape, translation: null }))
    });
}

function changedKeys(
    before: Record<string, string>,
    after: Record<string, string>
): string[] {
    return Object.keys(after).filter((key) => before[key] !== after[key]);
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
        const newContext = async (session: typeof ownerSession) => {
            const context = await browser.newContext();
            await installCrossWindowTrackersOnContext(context);
            await attachCloudCollabCookies(context, session);
            contexts.push(context);
            return context;
        };
        const consoleTails = new Map<Page, string[]>();
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
            const assetId = await saveCurrentFontToCloud(mainPage, familyName);
            await waitForOpenSessionReady(mainPage, assetId);
            await waitForBridgeReady(mainPage);
            await installEditingFontCompileTracker(mainPage);
            await waitForEditingCompile(mainPage);
            await waitForCloudLiveIdle(mainPage);

            const openEditor = async (page: Page) => {
                await focusView(page, 'ControlOrMeta+Shift+E', 'view-editor');
                await alignEditorCanvas(page, 'a', {
                    wght: FUZZ_MASTERS[0].wght
                });
                // The editing font holds the glyphs of the window’s text:
                // every window shows all fuzz glyphs.
                await openFuzzGlyph(page, 'a', FUZZ_MASTERS[0].id);
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

            // ── Checks every step runs in every window ───────────────────
            const converge = async (label: string, timeout = 90000) => {
                const reference = windows[0];
                let snapshot = await readFuzzSnapshot(reference.page);
                const deadline = Date.now() + timeout;
                for (;;) {
                    snapshot = await readFuzzSnapshot(reference.page);
                    const expected = flatten(snapshot);
                    const differences: string[] = [];
                    for (const window of windows.slice(1)) {
                        const actual = flatten(
                            await readFuzzSnapshot(window.page)
                        );
                        for (const key of changedKeys(expected, actual)) {
                            differences.push(
                                `${window.name} ${key}: ${actual[key]} vs ${reference.name} ${expected[key]}`
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
                                            .replace(':', '')
                                            .split('/')[0]
                                )
                            )
                        ];
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
                                        return `${name} ${id} sv=${id ? toHex(bridge.encodeDocumentStateVector?.(id) ?? null) : '-'}`;
                                    })
                                };
                            }, differing);
                            logs.push(
                                `${window.name} sync: pending ${sync.pending}, ${sync.status}; ${sync.docs.join('; ')}`
                            );
                        }
                        for (const window of windows) {
                            logs.push(
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
                            for (const { id } of FUZZ_MASTERS) {
                                const keys = await extractYDocLayerKeys(
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
                            `${window.name} page errors; layers without width now: ${missing.join('; ') || 'none'}; console:\n  ${(consoleTails.get(window.page) ?? []).slice(-15).join('\n  ')}`
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
                    expect(
                        await readCompositionMismatches(window.page),
                        `${label}: automatic composites in ${window.name}`
                    ).toEqual([]);
                    // The binary: what this window compiled for editing
                    // must match a fresh compile of its current data.
                    await waitForEditingCompile(window.page);
                    let compiled = await readCompiledOutlines(window.page);
                    await expect
                        .poll(
                            async () => {
                                compiled = await readCompiledOutlines(
                                    window.page
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
                            const why = await diagnoseStaleCompile(window.page);
                            record(
                                `${label}: ${window.name} stale compile: ${why}`
                            );
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
                    const tiles = await overviewTileState(
                        window.page,
                        FUZZ_GLYPHS,
                        FUZZ_COMPARE_LOCATION
                    );
                    expect(
                        tiles
                            .filter((tile) => tile.tileStale)
                            .map((tile) => tile.name),
                        `${label}: stale overview tiles in ${window.name}`
                    ).toEqual([]);
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
                const master = pick(FUZZ_MASTERS).id;
                const shapes = (snapshot.glyphs[glyph] as any)[master].shapes;
                const shape = Math.floor(random() * shapes.length);
                return {
                    kind: 'outline',
                    glyph,
                    master,
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
                master: pick(FUZZ_MASTERS).id,
                anchor: FUZZ_MARKS.includes(glyph) ? '_top' : 'top',
                dx: delta(40),
                dy: delta(40)
            });
            const widthEdit = (glyph: string): FuzzEdit => ({
                kind: 'width',
                glyph,
                master: pick(FUZZ_MASTERS).id,
                dw: delta(40)
            });
            const kernEdit = (): FuzzEdit => {
                const master = pick(FUZZ_MASTERS).id;
                const pair = pick(FUZZ_KERN_PAIRS);
                const current = snapshot.kerning[master]?.[pair] ?? 0;
                return {
                    kind: 'kern',
                    master,
                    pair,
                    value: current + delta(8) * 10
                };
            };
            const alignEdit = (): FuzzEdit => {
                const glyph = pick(FUZZ_COMPOSITES);
                const master = pick(FUZZ_MASTERS).id;
                const shapes = (snapshot.glyphs[glyph] as any)[master].shapes;
                return {
                    kind: 'align',
                    glyph,
                    master,
                    automatic: !shapes.every((shape: any) => shape.automatic)
                };
            };
            const randomEdit = (): FuzzEdit => {
                const roll = random();
                if (roll < 0.35) {
                    return outlineEdit(pick(FUZZ_OUTLINE_GLYPHS));
                }
                if (roll < 0.6) {
                    return anchorEdit(
                        pick([...FUZZ_BASES_WITH_TOP, ...FUZZ_MARKS])
                    );
                }
                if (roll < 0.75) {
                    return widthEdit(pick(FUZZ_WIDTH_GLYPHS));
                }
                if (roll < 0.9) {
                    return kernEdit();
                }
                return alignEdit();
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
            // Kerning is font-wide: an undo in any glyph can reach it.
            const historyGlyphOf = (edit: FuzzEdit) =>
                edit.kind === 'kern' ? null : edit.glyph;
            const reachableFrom = (item: HistoryItem, glyph: string) =>
                item.historyGlyph === glyph || item.historyGlyph === null;
            // Undo in a glyph takes that glyph's latest edit, and a
            // font-wide edit only when the glyph has none.
            const undoTargetIn = (list: HistoryItem[], glyph: string) =>
                list.filter((item) => item.historyGlyph === glyph).at(-1) ??
                list.filter((item) => item.historyGlyph === null).at(-1) ??
                null;

            const runStep = async (step: number) => {
                const window = pick(windows);
                const group = window.group;
                const roll = random();
                const own = items.filter(
                    (item) => item.group === group && !item.undone
                );
                const redoStack = redoStacks.get(group) ?? [];
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
                } else if (roll < 0.28 && redoStack.length) {
                    target = redoStack.at(-1)!;
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
                            redoStack.some((mine) =>
                                reachableFrom(mine, item.historyGlyph!)
                            )
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
                await applyFuzzEdit(window.page, edit);
                snapshot = await checkAll(`step ${step} (${description})`);
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
                            : redoStack;
                    // Which own item, if any, this change reverts or restores.
                    const matched = changed.length
                        ? ownItems.find((item) => {
                              const goal =
                                  edit.kind === 'undo'
                                      ? item.before
                                      : item.after;
                              return (
                                  changed.every((key) =>
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
                        : changed.length > 0
                          ? [
                                ...(target ? [target] : []),
                                ...ownItems.slice().reverse()
                            ].find(
                                (item) =>
                                    !isClean(item) &&
                                    changed.every((key) =>
                                        item.changed.includes(key)
                                    )
                            )
                          : undefined;
                    if (changed.length && !matched && !selective) {
                        throw failure(
                            `${edit.kind} changed data that is not this history’s own edit`
                        );
                    }
                    if (crossUser && changed.length) {
                        throw failure(
                            `${edit.kind} on a glyph this history never edited changed the font`
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
                    items.push({
                        group,
                        historyGlyph: historyGlyphOf(edit),
                        master: edit.master,
                        description,
                        changed,
                        before,
                        after,
                        step,
                        undone: false
                    });
                    redoStacks.set(group, []);
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
                kernEdit
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

            // ── Phase 3: the second browser goes offline and catches up ──
            record('O2 offline');
            await ownerSecondContext.setOffline(true);
            const offlineEdits = [
                pick([outlineEdit, widthEdit])('o'),
                anchorEdit('o')
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

            // ── Phase 5: the cloud kept it all ───────────────────────────
            const freshContext = await newContext(ownerSession);
            const { page: freshPage, errors: freshErrors } =
                await openCloudWindow(freshContext, editorHref);
            await openEditor(freshPage);
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
