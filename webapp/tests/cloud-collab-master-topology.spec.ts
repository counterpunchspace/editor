import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import {
    openFileFromFilesView,
    waitForCanvasReady,
    waitForFontLoaded,
    waitForOpenSessionReady
} from './helpers/snapshot-helper';
import {
    installCrossWindowTrackersOnContext,
    installEditingFontCompileTracker,
    installFontModelSyncTracker,
    installJsonCanonicalizer,
    waitForBridgeReady,
    waitForEditingCompile
} from './helpers/change-bridge-cross-window';
import {
    attachCloudCollabCookies,
    bootstrapCloudCollabSession,
    cleanupCloudCollabUsers,
    makeCloudCollabEmails,
    LOCAL_WEBSITE_ORIGIN
} from './helpers/cloud-collab-session';
import {
    assertServiceReachable,
    collectPageErrors,
    saveCurrentFontToCloud,
    waitForCloudLiveIdle,
    LOCAL_EDITOR_ORIGIN,
    LOCAL_ROOM_ORIGIN
} from './helpers/cloud-collab-e2e';
import { openInviteeOnAsset } from './helpers/cloud-collab-bootstrap';

type MasterCoverage = {
    sparse: boolean;
    masterIds: string[];
    glyphCount: number;
    missing: string[];
    present: string[];
};

async function settleCloudEdit(page: Page): Promise<void> {
    await waitForCloudLiveIdle(page, 20000).catch(() => undefined);
}

async function waitForCloudDurable(page: Page): Promise<void> {
    await expect
        .poll(
            () =>
                page.evaluate(async () => {
                    const durability = await (
                        window as any
                    ).cloudPlugin.waitForCloudGlyphDurability();
                    return durability?.durable === true;
                }),
            { timeout: 120000 }
        )
        .toBe(true);
}

async function assertCloudStackReachable(
    request: Parameters<typeof assertServiceReachable>[0]
): Promise<void> {
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
}

/** Which resident glyphs do and do not carry a master-bound layer. */
async function masterCoverage(
    page: Page,
    masterId: string
): Promise<MasterCoverage> {
    return page.evaluate((id) => {
        const font = (window as any).currentFontModel;
        const bridge = (window as any).patchSyncEngine;
        const glyphs: any[] = Array.isArray(font?._data?.glyphs)
            ? font._data.glyphs
            : [];
        const missing: string[] = [];
        const present: string[] = [];
        for (const glyph of glyphs) {
            const hasLayer = (glyph.layers || []).some(
                (layer: any) => layer?.master?.master === id
            );
            (hasLayer ? present : missing).push(String(glyph.name));
        }
        return {
            sparse: bridge?.hasSparseWorkingSet?.() === true,
            masterIds: (font?._data?.masters || []).map(
                (master: any) => master.id
            ),
            glyphCount: glyphs.length,
            missing,
            present
        };
    }, masterId);
}

async function catalogGlyphNames(page: Page): Promise<string[]> {
    return page.evaluate(() => {
        const bridge = (window as any).patchSyncEngine;
        bridge?.refreshOwnedCatalogFromYDoc?.();
        const json = bridge?.getFontJsonSnapshot?.() || {};
        const catalog =
            json.glyphCatalog ||
            json.format_specific?.['com.counterpunch.cloud']?.glyphCatalog ||
            {};
        return Object.values(catalog as Record<string, any>)
            .filter((entry) => entry && entry.deleted !== true)
            .map((entry) => String(entry.name))
            .sort();
    });
}

async function openOwnerOnCloudFont(
    browser: Parameters<typeof openInviteeOnAsset>[0],
    request: Parameters<typeof bootstrapCloudCollabSession>[0],
    emails: ReturnType<typeof makeCloudCollabEmails>,
    runId: string
): Promise<{ ownerContext: BrowserContext; ownerPage: Page; assetId: string }> {
    const ownerSession = await bootstrapCloudCollabSession(
        request,
        emails.owner,
        'owner'
    );
    const ownerContext = await browser.newContext();
    await installCrossWindowTrackersOnContext(ownerContext);
    await attachCloudCollabCookies(ownerContext, ownerSession);
    const ownerPage = await ownerContext.newPage();
    await collectPageErrors(ownerPage);
    await ownerPage.goto('/?test=true&examples=collab-fixtures');
    await waitForCanvasReady(ownerPage);
    await openFileFromFilesView(ownerPage, 'NestedComponents.glyphs');
    await waitForOpenSessionReady(ownerPage, 'NestedComponents.glyphs');
    await waitForBridgeReady(ownerPage);
    await installJsonCanonicalizer(ownerPage);
    await installFontModelSyncTracker(ownerPage);
    await installEditingFontCompileTracker(ownerPage);
    const assetId = await saveCurrentFontToCloud(
        ownerPage,
        `Master-topology-${runId}`
    );
    await waitForOpenSessionReady(ownerPage, assetId);
    await waitForEditingCompile(ownerPage);
    await waitForCloudLiveIdle(ownerPage);
    return { ownerContext, ownerPage, assetId };
}

async function showMastersTab(page: Page): Promise<void> {
    await page.evaluate(() => {
        const win = window as any;
        win.focusView?.('view-fontinfo', true);
        win.fontInfoManager?.switchTab?.('masters');
    });
    await expect(
        page.locator('[data-fontinfo-list-action="masters-add"]')
    ).toBeAttached();
}

test('adding and removing a master reaches every catalog glyph for every client', async ({
    browser,
    request
}) => {
    test.setTimeout(600000);
    await assertCloudStackReachable(request);
    const runId = `masters-${Date.now().toString(36)}`;
    const emails = makeCloudCollabEmails(runId);
    let ownerContext: BrowserContext | null = null;
    let inviteeContext: BrowserContext | null = null;
    try {
        const owner = await openOwnerOnCloudFont(
            browser,
            request,
            emails,
            runId
        );
        ownerContext = owner.ownerContext;
        const { ownerPage, assetId } = owner;
        const catalog = await catalogGlyphNames(ownerPage);
        expect(catalog.length).toBeGreaterThan(0);

        const masterId = await ownerPage.evaluate(async () => {
            const created = await (window as any).currentFontModel.addMaster(
                undefined,
                {
                    location: { wght: 100 }
                }
            );
            return created?.id as string;
        });
        expect(masterId).toBeTruthy();
        await settleCloudEdit(ownerPage);
        await waitForCloudDurable(ownerPage);

        const ownerAfterAdd = await masterCoverage(ownerPage, masterId);
        expect(ownerAfterAdd.sparse).toBe(false);
        expect(ownerAfterAdd.masterIds).toContain(masterId);
        expect(ownerAfterAdd.missing).toEqual([]);
        expect(ownerAfterAdd.present.sort()).toEqual(catalog);

        const invitee = await openInviteeOnAsset(
            browser,
            request,
            ownerPage,
            emails,
            assetId
        );
        inviteeContext = invitee.inviteeContext;
        const { inviteePage } = invitee;
        await expect
            .poll(async () => masterCoverage(inviteePage, masterId), {
                timeout: 120000
            })
            .toMatchObject({
                sparse: false,
                masterIds: expect.arrayContaining([masterId]),
                missing: [],
                glyphCount: catalog.length
            });

        await ownerPage.evaluate(async (id) => {
            await (window as any).currentFontModel.removeMastersByIds([id]);
        }, masterId);
        await settleCloudEdit(ownerPage);
        await waitForCloudDurable(ownerPage);

        const ownerAfterRemove = await masterCoverage(ownerPage, masterId);
        expect(ownerAfterRemove.masterIds).not.toContain(masterId);
        expect(ownerAfterRemove.present).toEqual([]);

        await expect
            .poll(
                async () => {
                    const coverage = await masterCoverage(
                        inviteePage,
                        masterId
                    );
                    return {
                        hasMaster: coverage.masterIds.includes(masterId),
                        present: coverage.present
                    };
                },
                { timeout: 120000 }
            )
            .toEqual({ hasMaster: false, present: [] });

        await inviteePage.reload();
        await waitForCanvasReady(inviteePage);
        await waitForFontLoaded(inviteePage);
        await waitForOpenSessionReady(inviteePage, assetId);
        await waitForBridgeReady(inviteePage);
        await expect
            .poll(async () => masterCoverage(inviteePage, masterId), {
                timeout: 120000
            })
            .toMatchObject({
                masterIds: expect.not.arrayContaining([masterId]),
                present: [],
                glyphCount: catalog.length
            });
    } finally {
        await ownerContext?.close();
        await inviteeContext?.close();
        await cleanupCloudCollabUsers(request, [emails.owner, emails.invitee]);
    }
});

test('a partly downloaded font refuses master changes until reopened with all glyphs', async ({
    browser,
    request
}) => {
    test.setTimeout(600000);
    await assertCloudStackReachable(request);
    const runId = `masters-sparse-${Date.now().toString(36)}`;
    const emails = makeCloudCollabEmails(runId);
    let ownerContext: BrowserContext | null = null;
    let inviteeContext: BrowserContext | null = null;
    try {
        const owner = await openOwnerOnCloudFont(
            browser,
            request,
            emails,
            runId
        );
        ownerContext = owner.ownerContext;
        const { ownerPage, assetId } = owner;
        // No codepoint and no dependents: a sparse open leaves it on the server.
        await ownerPage.evaluate(() => {
            (window as any).currentFontModel.addGlyph('zzremote', 'Base');
        });
        await settleCloudEdit(ownerPage);

        const invitee = await openInviteeOnAsset(
            browser,
            request,
            ownerPage,
            emails,
            assetId,
            { sparse: true }
        );
        inviteeContext = invitee.inviteeContext;
        const { inviteePage } = invitee;
        await settleCloudEdit(inviteePage);

        const sparseState = await inviteePage.evaluate(() => {
            const win = window as any;
            return {
                sparse: win.patchSyncEngine?.hasSparseWorkingSet?.() === true,
                remoteResident: !!win.currentFontModel?.findGlyph?.('zzremote'),
                gate: win.currentFontModel?.getMasterTopologyGate?.(),
                masterCount: win.currentFontModel?._data?.masters?.length ?? 0
            };
        });
        expect(sparseState.sparse).toBe(true);
        expect(sparseState.remoteResident).toBe(false);
        expect(sparseState.gate).toMatchObject({
            allowed: false,
            canReopenWithAllGlyphs: true
        });

        const refusal = await inviteePage.evaluate(async () => {
            const font = (window as any).currentFontModel;
            const messages: string[] = [];
            for (const attempt of [
                () => font.addMaster(undefined, { location: { wght: 100 } }),
                () => font.removeMastersByIds([font._data.masters[0].id]),
                () => font.masters[0].reinterpolateLayers()
            ]) {
                try {
                    await attempt();
                    messages.push('allowed');
                } catch (error) {
                    messages.push(
                        error instanceof Error ? error.message : String(error)
                    );
                }
            }
            return {
                messages,
                masterCount: font._data.masters.length
            };
        });
        for (const message of refusal.messages) {
            expect(message).toMatch(/only partly downloaded/);
        }
        expect(refusal.masterCount).toBe(sparseState.masterCount);

        await inviteePage.waitForFunction(
            () => {
                const win = window as any;
                return (
                    typeof win.pyodide?.runPythonAsync === 'function' &&
                    win.pyodide
                        ?.__counterpunchPythonExecutionWrapperInstalled === true
                );
            },
            undefined,
            { timeout: 180000 }
        );
        // The Python proxy wraps the returned Promise, so await the JS object.
        const pythonRefusal = await inviteePage.evaluate(async () => {
            const result = await (window as any).pyodide.runPythonAsync(`
try:
    await Font().addMaster()._js_obj
    result = "allowed"
except Exception as error:
    result = str(error)
result
`);
            return String(result);
        });
        expect(pythonRefusal).toMatch(/only partly downloaded/);

        await showMastersTab(inviteePage);
        await expect(
            inviteePage.locator('[data-fontinfo-list-action="masters-add"]')
        ).toBeDisabled();
        await expect(
            inviteePage.locator('[data-fontinfo-list-action="masters-remove"]')
        ).toBeDisabled();
        const reopenButton = inviteePage.locator(
            '[data-fontinfo-list-action="masters-reopen-all-glyphs"]'
        );
        await expect(reopenButton).toBeAttached();
        await reopenButton.dispatchEvent('click');

        await inviteePage.waitForFunction(
            () => {
                const win = window as any;
                return (
                    win.patchSyncEngine?.hasSparseWorkingSet?.() === false &&
                    !!win.currentFontModel?.findGlyph?.('zzremote')
                );
            },
            undefined,
            { timeout: 180000 }
        );
        await waitForOpenSessionReady(inviteePage, assetId);
        await waitForBridgeReady(inviteePage);
        expect(new URL(inviteePage.url()).searchParams.has('sparse')).toBe(
            false
        );
        expect(
            await inviteePage.evaluate(
                () =>
                    (window as any).currentFontModel?.getMasterTopologyGate?.()
                        ?.allowed
            )
        ).toBe(true);

        await showMastersTab(inviteePage);
        await expect(
            inviteePage.locator('[data-fontinfo-list-action="masters-add"]')
        ).toBeEnabled();
        await expect(
            inviteePage.locator('[data-fontinfo-masters-blocked="true"]')
        ).toHaveCount(0);
    } finally {
        await ownerContext?.close();
        await inviteeContext?.close();
        await cleanupCloudCollabUsers(request, [emails.owner, emails.invitee]);
    }
});
