import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import {
    waitForCanvasReady,
    waitForFontLoaded,
    waitForOpenSessionReady
} from './helpers/snapshot-helper';
import {
    attachCloudCollabCookies,
    bootstrapCloudCollabSession,
    cleanupCloudCollabUsers
} from './helpers/cloud-collab-session';
import {
    collectPageErrors,
    editorHrefWithTestMode,
    gotoEditorPage,
    waitForCloudLiveIdle,
    LOCAL_EDITOR_ORIGIN
} from './helpers/cloud-collab-e2e';
import {
    openInviteeOnAsset,
    prepareOwnerCloudFont
} from './helpers/cloud-collab-bootstrap';

type FontParts = {
    layout: unknown;
    features: unknown;
    kerning: Array<Record<string, number>>;
};

async function fontParts(page: Page): Promise<FontParts> {
    return page.evaluate(() => {
        const engine = (window as any).patchSyncEngine;
        const json = engine.getFontJsonSnapshot();
        return {
            layout: engine.roomLayout,
            features: JSON.parse(JSON.stringify(json.features ?? null)),
            kerning: (json.masters ?? []).map((master: any) =>
                JSON.parse(JSON.stringify(master.kerning ?? {}))
            )
        };
    });
}

async function openAsOwner(
    browser: any,
    request: any,
    email: string,
    assetId: string,
    beforeOpen?: (context: BrowserContext) => Promise<unknown>
): Promise<{ context: BrowserContext; page: Page }> {
    const session = await bootstrapCloudCollabSession(request, email, 'owner');
    const context = await browser.newContext();
    await attachCloudCollabCookies(context, session);
    await beforeOpen?.(context);
    const page = await context.newPage();
    await collectPageErrors(page);
    await gotoEditorPage(
        page,
        editorHrefWithTestMode(
            `${LOCAL_EDITOR_ORIGIN}/?file=cloud:///${assetId}`
        )
    );
    await waitForCanvasReady(page);
    await waitForFontLoaded(page);
    await waitForOpenSessionReady(page, assetId);
    return { context, page };
}

test('a font saved before room layout 2 moves to its rooms when the owner opens it', async ({
    browser,
    request
}) => {
    test.setTimeout(480000);
    const runId = `layout-${Date.now().toString(36)}`;
    const { emails, ownerContext, ownerPage, assetId } =
        await prepareOwnerCloudFont(
            browser,
            request,
            runId,
            `Fustat-layout-${runId}`,
            {
                // Save the way editors before room layout 2 did.
                beforeSave: (page) =>
                    page.evaluate(() => {
                        (window as any).patchSyncEngine.adoptRoomLayout = () =>
                            false;
                    })
            }
        );
    const contexts: BrowserContext[] = [ownerContext];
    try {
        const saved = await fontParts(ownerPage);
        expect(saved.layout).toBeNull();
        expect(saved.kerning.some((pairs) => Object.keys(pairs).length)).toBe(
            true
        );

        const invitee = await openInviteeOnAsset(
            browser,
            request,
            ownerPage,
            emails,
            assetId
        );
        contexts.push(invitee.inviteeContext);
        const { inviteePage } = invitee;
        expect((await fontParts(inviteePage)).layout).toBeNull();

        await ownerContext.close();
        const reopened = await openAsOwner(
            browser,
            request,
            emails.owner,
            assetId
        );
        contexts.push(reopened.context);
        const ownerAgain = reopened.page;
        await ownerAgain.waitForFunction(
            () => !!(window as any).patchSyncEngine?.roomLayout,
            undefined,
            { timeout: 120000 }
        );
        await waitForCloudLiveIdle(ownerAgain);
        const upgraded = await fontParts(ownerAgain);
        expect(upgraded.layout).toMatchObject({ version: 2 });
        expect(upgraded.features).toEqual(saved.features);
        expect(upgraded.kerning).toEqual(saved.kerning);

        // The peer that had the font open follows font-core to the rooms.
        await inviteePage.waitForFunction(
            () => !!(window as any).patchSyncEngine?.roomLayout,
            undefined,
            { timeout: 120000 }
        );
        await expect
            .poll(async () => (await fontParts(inviteePage)).kerning, {
                timeout: 60000
            })
            .toEqual(saved.kerning);

        // A kerning edit after the upgrade lands in a kerning room.
        const masterIndex = saved.kerning.findIndex(
            (pairs) => Object.keys(pairs).length
        );
        const [pair, value] = Object.entries(saved.kerning[masterIndex])[0];
        const edited = { ...saved.kerning[masterIndex], [pair]: value + 7 };
        await ownerAgain.evaluate(
            ({ index, kerning }) => {
                const engine = (window as any).patchSyncEngine;
                engine.beginTransaction('Edit kerning pair', null, {
                    compileChangeSource: 'keyboard-kerning-value',
                    compileEditType: 'kerning-value'
                });
                try {
                    (window as any).currentFontModel.masters[index].kerning =
                        kerning;
                } finally {
                    engine.endTransaction();
                }
            },
            { index: masterIndex, kerning: edited }
        );
        await waitForCloudLiveIdle(ownerAgain);
        await expect
            .poll(
                async () => (await fontParts(inviteePage)).kerning[masterIndex],
                { timeout: 60000 }
            )
            .toEqual(edited);

        const late = await openAsOwner(browser, request, emails.owner, assetId);
        contexts.push(late.context);
        // A window that opens now follows font-core to the rooms too.
        await expect
            .poll(
                async () => {
                    const parts = await fontParts(late.page);
                    return {
                        layout: parts.layout,
                        features: parts.features,
                        kerning: parts.kerning[masterIndex]
                    };
                },
                { timeout: 60000 }
            )
            .toEqual({
                layout: upgraded.layout,
                features: saved.features,
                kerning: edited
            });
    } finally {
        for (const context of contexts) {
            await context.close().catch(() => undefined);
        }
        await cleanupCloudCollabUsers(request, [emails.owner, emails.invitee]);
    }
});

/** The cloud's live packet limit (MAX_YJS_PACKET_BYTES). */
const MAX_LIVE_PACKET_BYTES = 1024 * 1024;

/** The forced layout: several catalog and kerning rooms in a small font. */
const FORCED_LAYOUT = { catalogBuckets: 3, kerningBuckets: 3 };

/** FNV-1a, as cloud-room-layout.ts `layoutHash`: which room a key lives in. */
function layoutBucket(key: string, buckets: number): number {
    let hash = 0x811c9dc5;
    for (const byte of new TextEncoder().encode(key)) {
        hash ^= byte;
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return (hash >>> 0) % buckets;
}

const firstSide = (pair: string) => pair.slice(0, pair.indexOf(':'));

/**
 * Everything the layout 2 rooms hold, as one window sees it: features,
 * kerning, kerning groups, the catalog (names, order, codepoints) and font
 * info. Long feature code is reduced to its length and a hash.
 */
async function layoutState(page: Page) {
    return page.evaluate(() => {
        const engine = (window as any).patchSyncEngine;
        const json = engine.getFontJsonSnapshot();
        const digest = (text: string) => {
            let hash = 0x811c9dc5;
            for (let i = 0; i < text.length; i++) {
                hash ^= text.charCodeAt(i);
                hash = Math.imul(hash, 0x01000193) >>> 0;
            }
            return `${text.length}:${hash}`;
        };
        const features = (json.features?.features ?? []).map(
            ([tag, code]: [string, any]) => [
                tag,
                (code?.code ?? '').length > 10000
                    ? digest(code.code)
                    : (code?.code ?? '')
            ]
        );
        const sortedGroups = (groups: Record<string, string[]> | undefined) =>
            Object.fromEntries(
                Object.entries(groups ?? {})
                    .sort(([a], [b]) => a.localeCompare(b))
                    .map(([name, members]) => [name, [...members].sort()])
            );
        return {
            layout: engine.roomLayout,
            features,
            classes: digest(JSON.stringify(json.features?.classes ?? {})),
            kerning: (json.masters ?? []).map((master: any) =>
                Object.fromEntries(
                    Object.entries(master.kerning ?? {}).sort(([a], [b]) =>
                        a.localeCompare(b)
                    )
                )
            ),
            groups: {
                first: sortedGroups(json.first_kern_groups),
                second: sortedGroups(json.second_kern_groups)
            },
            // From the catalog rooms, not the JSON: a sparse window holds
            // only the glyphs it has opened.
            glyphs: Object.values(
                (engine._readCatalogJson?.() ?? {}) as Record<string, any>
            )
                .filter((entry) => entry && !entry.deleted)
                .map((entry): [string, number[]] => [
                    String(entry.name),
                    (Array.isArray(entry.codepoints)
                        ? [...entry.codepoints]
                        : entry.codepoints &&
                            typeof entry.codepoints === 'object'
                          ? Object.keys(entry.codepoints).map(Number)
                          : entry.codepoints != null
                            ? [Number(entry.codepoints)]
                            : []
                    ).sort((a: number, b: number) => a - b)
                ])
                .sort(([a], [b]) => a.localeCompare(b)),
            glyphOrder:
                engine.yDoc?.getMap('font')?.get('glyphOrder')?.toJSON?.() ??
                null,
            version: json.version ?? null
        };
    });
}

type LayoutState = Awaited<ReturnType<typeof layoutState>>;

async function expectSameLayoutState(
    pages: Page[],
    label: string,
    timeout = 90000
): Promise<LayoutState> {
    const [reference, ...others] = pages;
    let expected = await layoutState(reference);
    await expect
        .poll(
            async () => {
                expected = await layoutState(reference);
                for (const page of others) {
                    const actual = await layoutState(page);
                    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
                        return false;
                    }
                }
                return true;
            },
            { timeout, intervals: [500, 1000, 2000], message: label }
        )
        .toBe(true)
        .catch(async (error) => {
            const rooms = await Promise.all(
                pages.map((page) =>
                    page.evaluate(() => {
                        const w = window as any;
                        const engine = w.patchSyncEngine;
                        const session = w.cloudPlugin?._liveSession;
                        return {
                            catalog: engine
                                ._catalogBucketMaps?.()
                                .map((map: any) => map.size),
                            jsonGlyphs:
                                engine.getFontJsonSnapshot().glyphs?.length,
                            modelGlyphs: w.currentFontModel?.glyphs?.length,
                            glyphOrder: engine.yDoc
                                ?.getMap('font')
                                ?.get('glyphOrder')?.length,
                            sparse: engine.hasSparseWorkingSet?.(),
                            missing: (() => {
                                const inJson = new Set(
                                    (
                                        engine.getFontJsonSnapshot().glyphs ??
                                        []
                                    ).map((glyph: any) => glyph.name)
                                );
                                const out: string[] = [];
                                for (const map of engine._catalogBucketMaps?.() ??
                                    []) {
                                    for (const [id, entry] of map.entries()) {
                                        const name =
                                            entry?.get?.('name') ?? entry?.name;
                                        if (inJson.has(name)) continue;
                                        const doc = engine._glyphDocs?.get(id);
                                        out.push(
                                            `${name}:doc=${!!doc}:size=${doc?.getMap('glyph')?.size}:byName=${engine._glyphIdByName?.get(name) === id}`
                                        );
                                    }
                                }
                                return out.slice(0, 8);
                            })(),
                            layoutRooms: (
                                engine.layoutDocumentIds?.() ?? []
                            ).map(
                                (id: string) =>
                                    `${id}:${session?.hasSyncedLiveDocument?.(id)}`
                            )
                        };
                    })
                )
            );
            const states = await Promise.all(pages.map(layoutState));
            const names = states.map((state) =>
                state.glyphs.map(([name]: [string, number[]]) => name)
            );
            const glyphDiff = names.map((list, index) => ({
                window: index,
                only: list.filter(
                    (name: string) =>
                        !names.every((other) => other.includes(name))
                ),
                firstOrderDifference: list.findIndex(
                    (name: string, at: number) => name !== names[0][at]
                )
            }));
            const keys = Object.keys(states[0]) as Array<keyof LayoutState>;
            const differing = keys.filter(
                (key) =>
                    new Set(states.map((state) => JSON.stringify(state[key])))
                        .size > 1
            );
            throw new Error(
                `${error instanceof Error ? error.message : String(error)}\nrooms: ${JSON.stringify(rooms)}\nglyphs: ${JSON.stringify(glyphDiff)}\ndiffering: ${differing
                    .map(
                        (key) =>
                            `${key}: ${states
                                .map((state) =>
                                    JSON.stringify(state[key]).slice(0, 600)
                                )
                                .join(' | ')}`
                    )
                    .join('\n')}`
            );
        });
    return expected;
}

/** A model edit in one transaction, the way the editor's own commands make it. */
async function transact(
    page: Page,
    label: string,
    source: string,
    editType: string | null,
    mutate: string,
    arg: unknown = null
) {
    await page.evaluate(
        async ({ label, source, editType, mutate, arg }) => {
            const w = window as any;
            const engine = w.patchSyncEngine;
            const font = w.currentFontModel;
            // eslint-disable-next-line no-new-func
            const run = new Function('font', 'arg', mutate);
            engine.beginTransaction(label, null, {
                compileChangeSource: source,
                compileEditType: editType
            });
            try {
                run(font, arg);
            } finally {
                engine.endTransaction();
            }
            await engine.waitForPendingCloudCommits?.();
        },
        { label, source, editType, mutate, arg }
    );
}

/** Font Info's feature-code commit: a synthetic change on the feature's history. */
async function editFeatureCode(page: Page, tag: string, code: string) {
    await page.evaluate(
        async ({ tag, code }) => {
            const w = window as any;
            const engine = w.patchSyncEngine;
            const features = w.currentFontModel.features.features;
            const index = features.findIndex((entry: any) => entry[0] === tag);
            const codeData = features[index][1];
            const previous = codeData.code || '';
            const options = {
                compileChangeSource: 'feature-code',
                compileEditType: 'feature'
            };
            engine.beginTransaction(
                'Edit feature code',
                { type: 'feature', key: `feature:${tag}:1`, label: tag },
                options
            );
            try {
                codeData.code = code;
                engine.applySyntheticChangeSet(
                    'Edit feature code',
                    [
                        {
                            op: 'set',
                            path: ['features', 'features', index, 1, 'code'],
                            oldValue: previous,
                            newValue: code
                        }
                    ],
                    options
                );
            } finally {
                engine.endTransaction();
            }
            await engine.waitForPendingCloudCommits?.();
        },
        { tag, code }
    );
}

const FEATURES = (ss02: string) => ({
    classes: {},
    prefixes: {},
    features: [
        ['ss01', { code: '# ss01' }],
        ['ss02', { code: ss02 }]
    ]
});

test('collaborators converge on every layout 2 room, across rooms and through a rebase', async ({
    browser,
    request
}) => {
    test.setTimeout(720000);
    const runId = `layout-rooms-${Date.now().toString(36)}`;
    const { emails, ownerContext, ownerPage, assetId } =
        await prepareOwnerCloudFont(
            browser,
            request,
            runId,
            `Fustat-layout-rooms-${runId}`,
            {
                beforeSave: async (page) => {
                    // Several catalog and kerning rooms, as large fonts get.
                    // The refused save below already moves this window to
                    // the layout; the later save keeps it.
                    // A layout this large for Fustat would shrink when the
                    // owner opens the font; this window keeps it.
                    await page.evaluate((layout) => {
                        const engine = (window as any).patchSyncEngine;
                        const adopt = engine.adoptRoomLayout.bind(engine);
                        engine.adoptRoomLayout = (chosen: any, options: any) =>
                            adopt({ ...chosen, ...layout }, options);
                        engine.roomLayoutFill = () => null;
                    }, FORCED_LAYOUT);
                    // A part over the cloud's 5 MiB room limit: the upload
                    // is refused before it starts, with a message that says
                    // which part, shown by the Save As dialog.
                    await transact(
                        page,
                        'Edit features',
                        'feature-code',
                        'feature',
                        'font.features = arg;',
                        FEATURES(`# ${'x'.repeat(6 * 1024 * 1024)}`)
                    );
                    await page.evaluate(() =>
                        (window as any).saveFontAs({ destination: 'cloud' })
                    );
                    const dialog = page.locator('.font-window-save-as');
                    const cloud = dialog.locator('[data-dest="cloud"]');
                    await expect(cloud).toBeEnabled({ timeout: 30000 });
                    await cloud.click();
                    await dialog
                        .locator('[data-name]')
                        .fill(`Fustat-too-large-${runId}`);
                    await dialog.locator('[data-go]').click();
                    const notice = page.locator('.font-window-notice').last();
                    await expect(notice).toContainText(
                        'This font can’t be saved to the cloud.',
                        { timeout: 60000 }
                    );
                    await expect(notice).toContainText(
                        'Its OpenType feature code is too large for the cloud'
                    );
                    await dialog
                        .getByRole('button', { name: 'Cancel' })
                        .click();
                    // The same window then saves the font once it fits.
                    await transact(
                        page,
                        'Edit features',
                        'feature-code',
                        'feature',
                        'font.features = arg;',
                        FEATURES('# ss02')
                    );
                }
            }
        );
    const contexts: BrowserContext[] = [ownerContext];
    try {
        const saved = await layoutState(ownerPage);
        expect(saved.layout).toMatchObject({ version: 2, ...FORCED_LAYOUT });

        const invitee = await openInviteeOnAsset(
            browser,
            request,
            ownerPage,
            emails,
            assetId
        );
        contexts.push(invitee.inviteeContext);
        const { inviteePage } = invitee;
        await expectSameLayoutState([ownerPage, inviteePage], 'invitee opens');

        // Pairs in two different kerning rooms, one pair both write, and one
        // the invitee deletes.
        const masterKerning = saved.kerning[0] as Record<string, number>;
        const pairs = Object.keys(masterKerning);
        const bucketOf = (pair: string) =>
            layoutBucket(firstSide(pair), FORCED_LAYOUT.kerningBuckets);
        const ownerPair = pairs[0];
        const inviteePair = pairs.find(
            (pair) => bucketOf(pair) !== bucketOf(ownerPair)
        )!;
        expect(inviteePair, 'pairs in two kerning rooms').toBeTruthy();
        const rest = pairs.filter(
            (pair) => pair !== ownerPair && pair !== inviteePair
        );
        const sharedPair = rest[0];
        const deletedPair = rest[1];
        // A glyph that joins a first-side kerning group.
        const groupName = Object.keys(saved.groups.first)[0];
        const grouped = new Set(Object.values(saved.groups.first).flat());
        const joiner = saved.glyphs
            .map(([name]: [string, number[]]) => name)
            .find(
                (name: string) => !grouped.has(name) && /^[a-z]+$/.test(name)
            )!;
        expect(groupName && joiner, 'a group and a glyph to add').toBeTruthy();
        const masterId = await ownerPage.evaluate(
            () => (window as any).currentFontModel.masters[0].id
        );
        const setPair = `
            const master = font.masters.find((m) => m.id === arg.master);
            master.kerning = { ...master.kerning, [arg.pair]: arg.value };`;

        // ── Both collaborators edit every kind of room at once ──────────
        await Promise.all([
            (async () => {
                await transact(
                    ownerPage,
                    'Edit kerning pair',
                    'keyboard-kerning-value',
                    'kerning-value',
                    setPair,
                    { master: masterId, pair: ownerPair, value: -111 }
                );
                await transact(
                    ownerPage,
                    'Edit kerning pair',
                    'keyboard-kerning-value',
                    'kerning-value',
                    setPair,
                    { master: masterId, pair: sharedPair, value: 11 }
                );
                await editFeatureCode(ownerPage, 'ss01', '# owner');
                // The overview's Add Glyphs command: one transaction.
                await ownerPage.evaluate(() => {
                    (window as any).currentFontModel.addGlyphs([
                        {
                            name: 'layout.test',
                            codepoints: [0xe100],
                            category: 'Base'
                        }
                    ]);
                });
                // The add is committed asynchronously; rename once it is.
                await ownerPage.waitForFunction(
                    () =>
                        (window as any).patchSyncEngine.hasGlyphInYDoc(
                            'layout.test'
                        ),
                    undefined,
                    { timeout: 30000 }
                );
                await ownerPage.evaluate(() => {
                    (window as any).currentFontModel.renameGlyphs(
                        new Map([['layout.test', 'layout.renamed']])
                    );
                });
            })(),
            (async () => {
                await transact(
                    inviteePage,
                    'Edit kerning pair',
                    'keyboard-kerning-value',
                    'kerning-value',
                    setPair,
                    { master: masterId, pair: inviteePair, value: -222 }
                );
                await transact(
                    inviteePage,
                    'Edit kerning pair',
                    'keyboard-kerning-value',
                    'kerning-value',
                    setPair,
                    { master: masterId, pair: sharedPair, value: 22 }
                );
                await transact(
                    inviteePage,
                    'Delete kerning pair',
                    'keyboard-kerning-value',
                    'kerning-value',
                    `const master = font.masters.find((m) => m.id === arg.master);
                     const next = { ...master.kerning };
                     delete next[arg.pair];
                     master.kerning = next;`,
                    { master: masterId, pair: deletedPair }
                );
                await transact(
                    inviteePage,
                    'Add kern group membership',
                    'keyboard-kerning-groups',
                    'kerning-groups',
                    `const groups = {};
                     for (const [name, members] of Object.entries(font.first_kern_groups ?? {})) {
                         groups[name] = [...members];
                     }
                     groups[arg.group] = [...(groups[arg.group] ?? []), arg.glyph];
                     font.first_kern_groups = groups;`,
                    { group: groupName, glyph: joiner }
                );
                await transact(
                    inviteePage,
                    'Set glyph Unicode',
                    'font-info',
                    null,
                    `const glyph = font.findGlyph('a');
                     glyph.codepoints = [...(glyph.codepoints ?? []), 0xe200];`
                );
                await transact(
                    inviteePage,
                    'Edit font info',
                    'font-info',
                    null,
                    'font.version = [7, 42];'
                );
            })()
        ]);
        await waitForCloudLiveIdle(ownerPage);
        await waitForCloudLiveIdle(inviteePage);
        const together = await expectSameLayoutState(
            [ownerPage, inviteePage],
            'edits at once'
        );
        const kerning = together.kerning[0] as Record<string, number>;
        expect(kerning[ownerPair]).toBe(-111);
        expect(kerning[inviteePair]).toBe(-222);
        expect([11, 22]).toContain(kerning[sharedPair]);
        expect(kerning[deletedPair]).toBeUndefined();
        expect(together.groups.first[groupName]).toContain(joiner);
        expect(together.features[0]).toEqual(['ss01', '# owner']);
        const names = together.glyphs.map(([name]: [string, number[]]) => name);
        expect(names).toContain('layout.renamed');
        expect(names).not.toContain('layout.test');
        expect(
            together.glyphs.find(
                ([name]: [string, number[]]) => name === 'a'
            )![1]
        ).toContain(0xe200);
        expect(together.version).toEqual([7, 42]);

        // ── Undo: each author undoes a font-wide edit of their own ──────
        await transact(
            ownerPage,
            'Edit kerning pair',
            'keyboard-kerning-value',
            'kerning-value',
            setPair,
            { master: masterId, pair: ownerPair, value: -150 }
        );
        await expectSameLayoutState([ownerPage, inviteePage], 'kerning edit');
        await ownerPage.evaluate(async (layerId) => {
            await (window as any).runBridgeUndoRedo(
                'undo',
                'a',
                'a',
                layerId,
                null
            );
            await (
                window as any
            ).patchSyncEngine.waitForPendingCloudCommits?.();
        }, masterId);
        const kerningUndone = await expectSameLayoutState(
            [ownerPage, inviteePage],
            'kerning undo'
        );
        expect(
            (kerningUndone.kerning[0] as Record<string, number>)[ownerPair]
        ).toBe(-111);

        await editFeatureCode(inviteePage, 'ss01', '# invitee');
        await expectSameLayoutState([ownerPage, inviteePage], 'feature edit');
        await inviteePage.evaluate(async () => {
            await (window as any).runBridgeUndoRedo(
                'undo',
                undefined,
                'a',
                null,
                'feature:ss01:1',
                'feature'
            );
            await (
                window as any
            ).patchSyncEngine.waitForPendingCloudCommits?.();
        });
        const featureUndone = await expectSameLayoutState(
            [ownerPage, inviteePage],
            'feature undo'
        );
        expect(featureUndone.features[0]).toEqual(['ss01', '# owner']);

        // ── One edit larger than a live packet (1 MiB) ──────────────────
        // Many values in one transaction travel as several room writes.
        await transact(
            inviteePage,
            'Edit feature classes',
            'feature-code',
            'feature',
            `const classes = {};
             for (let i = 0; i < 10000; i++) {
                 classes['c' + i] = { code: 'a b c d e f g h i j k l m n o p q r s t u v w x y z '.repeat(3) + i };
             }
             font.features = { ...font.features, classes };`
        );
        const large = await expectSameLayoutState(
            [ownerPage, inviteePage],
            'edit over 1 MiB',
            180000
        );
        expect(Number(String(large.classes).split(':')[0])).toBeGreaterThan(
            MAX_LIVE_PACKET_BYTES
        );

        // ── A rebase moves the kerning to more rooms ────────────────────
        // The owner reopens the font with its kerning room reported over
        // budget; the invitee, still connected, follows to the new rooms.
        await ownerContext.close();
        const rebased = await openAsOwner(
            browser,
            request,
            emails.owner,
            assetId,
            (context) =>
                context.addInitScript(() => {
                    let engine: any;
                    let reported = false;
                    Object.defineProperty(window, 'patchSyncEngine', {
                        configurable: true,
                        get: () => engine,
                        set: (value) => {
                            engine = value;
                            if (!value?.roomLayoutFill || value.__fillHooked) {
                                return;
                            }
                            value.__fillHooked = true;
                            const fill = value.roomLayoutFill.bind(value);
                            value.roomLayoutFill = () => {
                                const real = fill();
                                // Report once; then hold the new layout, so
                                // only the window opened later shrinks it.
                                if (!real || reported) return null;
                                reported = true;
                                return {
                                    ...real,
                                    largestKerningBucket: 40001,
                                    kerningPairs: Math.max(
                                        real.kerningPairs,
                                        40001
                                    )
                                };
                            };
                        }
                    });
                })
        );
        contexts.push(rebased.context);
        const ownerAgain = rebased.page;
        await ownerAgain.waitForFunction(
            () =>
                (window as any).patchSyncEngine?.roomLayout?.kerningBuckets ===
                6,
            undefined,
            { timeout: 120000 }
        );
        await waitForCloudLiveIdle(ownerAgain);
        await inviteePage.waitForFunction(
            () =>
                (window as any).patchSyncEngine?.roomLayout?.kerningBuckets ===
                6,
            undefined,
            { timeout: 120000 }
        );
        const afterRebase = await expectSameLayoutState(
            [ownerAgain, inviteePage],
            'after the rebase'
        );
        expect(afterRebase.kerning).toEqual(kerningUndone.kerning);
        await transact(
            inviteePage,
            'Edit kerning pair',
            'keyboard-kerning-value',
            'kerning-value',
            setPair,
            { master: masterId, pair: sharedPair, value: 33 }
        );
        const edited = await expectSameLayoutState(
            [ownerAgain, inviteePage],
            'kerning edit in the new rooms'
        );
        expect((edited.kerning[0] as Record<string, number>)[sharedPair]).toBe(
            33
        );

        // ── The font is smaller than its rooms: the next open shrinks ───
        // Fustat's catalog and kerning fit in far fewer rooms than the six
        // kerning and three catalog rooms; the owner window that opens now
        // moves them back to fewer rooms, under fresh ids, and the windows
        // already open follow. It loads everything from the cloud first.
        // The move is held after the copy, and the invitee, not yet told,
        // edits a pair in its old room: that edit must not be lost.
        let resolveLatePage: (page: Page) => void = () => undefined;
        const latePageOpened = new Promise<Page>((resolve) => {
            resolveLatePage = resolve;
        });
        const lateOpening = openAsOwner(
            browser,
            request,
            emails.owner,
            assetId,
            (context) => {
                context.on('page', (page) => resolveLatePage(page));
                return context.addInitScript(() => {
                    const w = window as any;
                    let engine: any;
                    w.__moveHeld = false;
                    w.__newRooms = [];
                    Object.defineProperty(window, 'patchSyncEngine', {
                        configurable: true,
                        get: () => engine,
                        set: (value) => {
                            engine = value;
                            if (
                                !value?.rebaseRoomLayout ||
                                value.__moveHooked
                            ) {
                                return;
                            }
                            value.__moveHooked = true;
                            const rebase = value.rebaseRoomLayout.bind(value);
                            value.rebaseRoomLayout = (next: unknown) => {
                                const before = new Set(
                                    value.layoutDocumentIds()
                                );
                                const moved = rebase(next);
                                if (moved) {
                                    w.__newRooms = value
                                        .layoutDocumentIds()
                                        .filter(
                                            (id: string) => !before.has(id)
                                        );
                                    w.__moveHeld = true;
                                }
                                return moved;
                            };
                        }
                    });
                    // Hold the check that the new rooms are stored: the
                    // move is not announced until it passes.
                    const realFetch = window.fetch.bind(window);
                    window.fetch = async (input: any, init?: any) => {
                        const url = String(
                            typeof input === 'string' ? input : input?.url
                        );
                        const held = (w.__newRooms as string[]).some((id) =>
                            url.includes(
                                `/shards/${id.replace(/:/g, '/')}/state`
                            )
                        );
                        while (held && w.__moveHeld) {
                            await new Promise((r) => setTimeout(r, 100));
                        }
                        return realFetch(input, init);
                    };
                });
            }
        );
        const latePage = await latePageOpened;
        await latePage.waitForFunction(
            () => (window as any).__moveHeld === true,
            undefined,
            { timeout: 120000 }
        );
        expect(
            await inviteePage.evaluate(
                () => (window as any).patchSyncEngine.roomLayout.kerningBuckets
            )
        ).toBe(6);
        await transact(
            inviteePage,
            'Edit kerning pair',
            'keyboard-kerning-value',
            'kerning-value',
            setPair,
            { master: masterId, pair: inviteePair, value: -555 }
        );
        await waitForCloudLiveIdle(inviteePage);
        await latePage.evaluate(() => {
            (window as any).__moveHeld = false;
        });
        const late = await lateOpening;
        contexts.push(late.context);
        const shrunk = (page: Page) =>
            page.waitForFunction(
                () => {
                    const layout = (window as any).patchSyncEngine?.roomLayout;
                    return (
                        layout?.catalogBuckets === 1 &&
                        layout?.kerningBuckets < 6 &&
                        layout?.kerningBase > 0
                    );
                },
                undefined,
                { timeout: 120000 }
            );
        await shrunk(late.page);
        await waitForCloudLiveIdle(late.page);
        await shrunk(ownerAgain);
        await shrunk(inviteePage);
        const afterShrink = await expectSameLayoutState(
            [ownerAgain, inviteePage, late.page],
            'after the font shrank to fewer rooms'
        );
        // Everything from before the move, plus the edit made during it.
        const expectedKerning = JSON.parse(JSON.stringify(edited.kerning));
        expectedKerning[0][inviteePair] = -555;
        expect(afterShrink.kerning).toEqual(expectedKerning);
        expect(afterShrink.glyphs).toEqual(edited.glyphs);
        await transact(
            inviteePage,
            'Edit kerning pair',
            'keyboard-kerning-value',
            'kerning-value',
            setPair,
            { master: masterId, pair: sharedPair, value: 44 }
        );
        const editedAfterShrink = await expectSameLayoutState(
            [ownerAgain, inviteePage, late.page],
            'kerning edit in the shrunk rooms'
        );
        expect(
            (editedAfterShrink.kerning[0] as Record<string, number>)[sharedPair]
        ).toBe(44);
    } finally {
        for (const context of contexts) {
            await context.close().catch(() => undefined);
        }
        await cleanupCloudCollabUsers(request, [emails.owner, emails.invitee]);
    }
});
