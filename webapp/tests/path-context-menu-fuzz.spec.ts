import { test, expect } from './fixtures';
import { type Page, type TestInfo } from '@playwright/test';
import {
    waitForCanvasReady,
    waitForFontLoaded,
    waitForOpenSessionReady,
    focusView
} from './helpers/snapshot-helper';

async function openFustatFont(page: Page): Promise<void> {
    await page.evaluate(async () => {
        await (window as any).showFontFileDialog?.({ mode: 'open' });
    });
    await page.locator('#font-file-dialog').waitFor({ state: 'visible' });
    await page.getByText('Fustat.glyphs').first().dblclick();

    await waitForFontLoaded(page);
    await waitForOpenSessionReady(page, 'Fustat.glyphs');
}

async function waitForBridgeReady(page: Page): Promise<void> {
    await page.waitForFunction(
        () =>
            !!(window as any).changeBridge &&
            !!(window as any).currentFontModel,
        { timeout: 15000 }
    );
    await page.waitForTimeout(400);
}

async function navigateToGlyphN(page: Page): Promise<void> {
    await focusView(page, 'ControlOrMeta+Shift+E', 'view-editor');

    // Font open can async-load display_string ("Hamburgevons") after model
    // ready and overwrite an early setTextBuffer('n'). Retry until it sticks.
    for (let attempt = 0; attempt < 8; attempt++) {
        await page.evaluate(() => {
            return new Promise<void>((resolve) => {
                const gc = (window as any).glyphCanvas;
                const tre = gc?.textRunEditor;
                if (!gc || !tre) {
                    resolve();
                    return;
                }
                if (gc.outlineEditor?.active) {
                    gc.exitGlyphEditMode();
                }

                let done = false;
                const finish = () => {
                    if (done) return;
                    done = true;
                    resolve();
                };
                window.addEventListener('editingFontCompiled', finish, {
                    once: true
                });
                tre.setTextBuffer('n');
                tre.cursorPosition = 0;
                setTimeout(finish, 5000);
            });
        });

        const stuck = await page.evaluate(() => {
            const tre = (window as any).glyphCanvas?.textRunEditor;
            return (
                tre?.textBuffer === 'n' &&
                Array.isArray(tre?.shapedGlyphs) &&
                tre.shapedGlyphs.length >= 1
            );
        });
        if (stuck) {
            // Confirm a late display_string restore does not clobber us.
            await page.waitForTimeout(300);
            const still = await page.evaluate(
                () =>
                    (window as any).glyphCanvas?.textRunEditor?.textBuffer ===
                    'n'
            );
            if (still) {
                break;
            }
        }
        await page.waitForTimeout(200);
    }

    await page.waitForFunction(
        () => {
            const tre = (window as any).glyphCanvas?.textRunEditor;
            return (
                tre?.textBuffer === 'n' &&
                Array.isArray(tre?.shapedGlyphs) &&
                tre.shapedGlyphs.length >= 1
            );
        },
        undefined,
        { timeout: 20000 }
    );

    await page.evaluate(async () => {
        const tre = (window as any).glyphCanvas?.textRunEditor;
        if (!tre) {
            throw new Error('textRunEditor missing');
        }
        await tre.selectGlyphByIndex(0, true);
    });

    await page.waitForFunction(
        () => {
            const gc = (window as any).glyphCanvas;
            const oe = gc?.outlineEditor;
            const tre = gc?.textRunEditor;
            return (
                !!oe?.active &&
                (tre?.selectedGlyphIndex ?? -1) === 0 &&
                tre?.textBuffer === 'n' &&
                oe?.getCurrentGlyphModel?.()?.name === 'n'
            );
        },
        undefined,
        { timeout: 20000 }
    );

    await page.evaluate(() => {
        (window as any).glyphCanvas?.frameCurrentGlyph?.();
    });
    await page.waitForFunction(
        () => {
            const vm = (window as any).glyphCanvas?.viewportManager;
            if (!vm) {
                return false;
            }
            const signature = [vm.scale, vm.panX, vm.panY]
                .map((value: number) => Number(value).toFixed(4))
                .join('|');
            const win = window as any;
            const previous = win.__pwFuzzStableViewport as
                { signature: string; since: number } | undefined;
            if (!previous || previous.signature !== signature) {
                win.__pwFuzzStableViewport = {
                    signature,
                    since: Date.now()
                };
                return false;
            }
            return Date.now() - previous.since >= 200;
        },
        undefined,
        { timeout: 10000, polling: 50 }
    );
}

async function selectFirstMasterLayer(page: Page): Promise<void> {
    await page.evaluate(async () => {
        const gc = (window as any).glyphCanvas;
        const oe = gc.outlineEditor;
        const hasLinked = () => {
            const layer = oe.getCurrentLayerModel?.();
            return (layer?._getLinkedLayers?.() || []).length > 0;
        };

        if (
            !oe.selectedLayerId ||
            !oe.getCurrentLayerModel?.() ||
            !hasLinked()
        ) {
            const sortedLayers = gc.getSortedLayers() || [];
            for (const candidate of sortedLayers) {
                await oe.selectLayer(candidate);
                if (hasLinked()) {
                    break;
                }
            }
        }
        gc.render();
    });
    await page.waitForFunction(
        () => {
            const oe = (window as any).glyphCanvas?.outlineEditor;
            const layer = oe?.getCurrentLayerModel?.();
            if (!layer || layer.is_background) {
                return false;
            }
            return (layer._getLinkedLayers?.() || []).length > 0;
        },
        undefined,
        { timeout: 20000 }
    );
}

async function glyphToPage(
    page: Page,
    glyphX: number,
    glyphY: number
): Promise<{ x: number; y: number }> {
    return page.evaluate(
        ({ gx, gy }) => {
            const gc = (window as any).glyphCanvas;
            const tre = gc.textRunEditor;
            const vm = gc.viewportManager;
            const canvas = gc.canvas as HTMLCanvasElement;
            const rect = canvas.getBoundingClientRect();
            const gp = tre._getGlyphPosition(tre.selectedGlyphIndex);
            const wx = gp.xPosition + gp.xOffset + gx;
            const wy = gp.yOffset + gy;
            const screen = vm.fontToScreenCoordinates(wx, wy);
            return { x: rect.left + screen.x, y: rect.top + screen.y };
        },
        { gx: glyphX, gy: glyphY }
    );
}

async function captureOutlineFingerprint(page: Page): Promise<{
    layers: Array<{
        id: string;
        paths: Array<{
            closed: boolean;
            nodes: Array<{
                x: number;
                y: number;
                nodetype: string;
                smooth: boolean;
            }>;
        }>;
    }>;
    compatible: boolean;
}> {
    return page.evaluate(() => {
        const round = (value: any) => Number(Number(value).toFixed(5));
        const toPathFingerprint = (pathModel: any) => {
            const pathJson = pathModel?.toJSON?.();
            const nodes = pathJson?.nodes || [];
            return {
                closed: Boolean(pathJson?.closed),
                nodes: nodes.map((node: any) => ({
                    x: round(node?.x),
                    y: round(node?.y),
                    nodetype: String(node?.nodetype || ''),
                    smooth: Boolean(node?.smooth)
                }))
            };
        };

        const oe = (window as any).glyphCanvas.outlineEditor;
        const currentLayer = oe.getCurrentLayerModel();
        const linkedLayers = currentLayer?._getLinkedLayers?.() || [];
        const glyph = oe.getCurrentGlyphModel();
        const compatibility = glyph?.calculateOutlineCompatibility?.();
        const layers = [currentLayer, ...linkedLayers]
            .filter(Boolean)
            .map((layer: any) => ({
                id: String(layer.id),
                paths: (layer.paths || []).map((path: any) =>
                    toPathFingerprint(path)
                )
            }))
            .sort((a: any, b: any) => a.id.localeCompare(b.id));

        return {
            layers,
            compatible: Boolean(compatibility?.compatible)
        };
    });
}

async function performUndo(page: Page): Promise<void> {
    const previousFingerprint = await captureOutlineFingerprint(page);
    const previousFingerprintJson = JSON.stringify(previousFingerprint);
    await page.evaluate(async () => {
        const testWindow = window as any;
        const context = testWindow.getUndoRedoContext?.();
        if (!context || !testWindow.runBridgeUndoRedo) {
            throw new Error('Undo bridge API is not available');
        }

        await testWindow.runBridgeUndoRedo(
            'undo',
            context.undoGlyphName,
            context.rootGlyphName,
            context.undoLayerId,
            context.historyTargetKey
        );
    });
    await page.waitForFunction(
        (previousJson) => {
            const round = (value: any) => Number(Number(value).toFixed(5));
            const toPathFingerprint = (pathModel: any) => {
                const pathJson = pathModel?.toJSON?.();
                const nodes = pathJson?.nodes || [];
                return {
                    closed: Boolean(pathJson?.closed),
                    nodes: nodes.map((node: any) => ({
                        x: round(node?.x),
                        y: round(node?.y),
                        nodetype: String(node?.nodetype || ''),
                        smooth: Boolean(node?.smooth)
                    }))
                };
            };

            const oe = (window as any).glyphCanvas?.outlineEditor;
            const currentLayer = oe?.getCurrentLayerModel?.();
            const linkedLayers = currentLayer?._getLinkedLayers?.() || [];
            const glyph = oe?.getCurrentGlyphModel?.();
            const compatibility = glyph?.calculateOutlineCompatibility?.();
            const layers = [currentLayer, ...linkedLayers]
                .filter(Boolean)
                .map((layer: any) => ({
                    id: String(layer.id),
                    paths: (layer.paths || []).map((path: any) =>
                        toPathFingerprint(path)
                    )
                }))
                .sort((a: any, b: any) => a.id.localeCompare(b.id));

            return (
                JSON.stringify({
                    layers,
                    compatible: Boolean(compatibility?.compatible)
                }) !== previousJson
            );
        },
        previousFingerprintJson,
        { timeout: 15000 }
    );
    await page.evaluate(async () => {
        await new Promise<void>((resolve) =>
            requestAnimationFrame(() => resolve())
        );
        await new Promise<void>((resolve) =>
            requestAnimationFrame(() => resolve())
        );
    });
}

test('fuzz path context actions on Fustat n: click intent maps to start node and reverse stays compatible', async ({
    page
}, testInfo: TestInfo) => {
    test.setTimeout(300000);

    await page.goto('/?test=true');
    await waitForCanvasReady(page);

    await openFustatFont(page);
    await waitForBridgeReady(page);

    await navigateToGlyphN(page);
    await selectFirstMasterLayer(page);

    const baseline = await page.evaluate(() => {
        const oe = (window as any).glyphCanvas.outlineEditor;
        const layer = oe.getCurrentLayerModel();
        const linkedLayers = layer?._getLinkedLayers?.() || [];
        const glyph = oe.getCurrentGlyphModel();
        const compatibility = glyph?.calculateOutlineCompatibility?.();

        return {
            linkedLayerCount: linkedLayers.length,
            compatibility
        };
    });

    expect(baseline.linkedLayerCount).toBeGreaterThan(0);
    expect(baseline.compatibility?.compatible).toBeTruthy();

    let seed = 1337 + testInfo.repeatEachIndex * 100003 + testInfo.retry * 1009;
    const rand = () => {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        return seed / 0x100000000;
    };
    const undoExpectations: Array<{
        label: string;
        fingerprint: Awaited<ReturnType<typeof captureOutlineFingerprint>>;
    }> = [];

    for (let i = 0; i < 12; i++) {
        const candidates = await page.evaluate(() => {
            const oe = (window as any).glyphCanvas.outlineEditor;
            const layer = oe.getCurrentLayerModel();
            const path =
                layer?.paths?.find((candidatePath: any) => {
                    if (!candidatePath?.closed) {
                        return false;
                    }

                    const onCurves = (candidatePath.nodes || []).filter(
                        (node: any) => node?.nodetype !== 'OffCurve'
                    );
                    if (onCurves.length < 4) {
                        return false;
                    }

                    const hasLine = onCurves.some(
                        (node: any) => node?.nodetype === 'Line'
                    );
                    const hasCurve = onCurves.some(
                        (node: any) =>
                            node?.nodetype === 'Curve' ||
                            node?.nodetype === 'QCurve'
                    );
                    return hasLine && hasCurve;
                }) || layer?.paths?.[0];
            const nodes = path?.nodes || [];
            let onCurveOrdinal = -1;
            const result: Array<{
                nodeIndex: number;
                onCurveOrdinal: number;
                x: number;
                y: number;
            }> = [];

            nodes.forEach((node: any, nodeIndex: number) => {
                if (node?.nodetype === 'OffCurve') {
                    return;
                }
                onCurveOrdinal += 1;
                if (nodeIndex > 0 && onCurveOrdinal > 0) {
                    result.push({
                        nodeIndex,
                        onCurveOrdinal,
                        x: Number(node.x),
                        y: Number(node.y)
                    });
                }
            });

            return result;
        });

        expect(candidates.length).toBeGreaterThan(0);
        const candidate =
            candidates[Math.floor(rand() * Math.max(1, candidates.length))];

        const screen = await glyphToPage(page, candidate.x, candidate.y);
        await page.mouse.click(screen.x, screen.y, { button: 'right' });

        const setStartItem = page.locator(
            '.plugin-menu-item:has-text("Set as start node")'
        );
        await expect(setStartItem).toBeVisible();

        const menuTarget = await page.evaluate(() => {
            const oe = (window as any).glyphCanvas.outlineEditor;
            return JSON.parse(JSON.stringify(oe.canvasContextMenuTarget));
        });

        expect(menuTarget?.canSetStartNode).toBeTruthy();
        expect(Number.isFinite(menuTarget?.intendedPoint?.x)).toBeTruthy();
        expect(Number.isFinite(menuTarget?.intendedPoint?.y)).toBeTruthy();
        const actionPathIndex = Number(menuTarget?.pathIndex ?? 0);

        const intendedStart = await page.evaluate(() => {
            const oe = (window as any).glyphCanvas.outlineEditor;
            const target = oe.canvasContextMenuTarget;
            const point = target?.intendedPoint;
            const layer = oe.getCurrentLayerModel();
            const path = layer?.paths?.[target?.pathIndex ?? -1];

            if (!point || !path?.nodes?.length) {
                return null;
            }

            let bestNode: any = null;
            let bestDistance = Infinity;

            path.nodes.forEach((node: any, nodeIndex: number) => {
                if (!node || node.nodetype === 'OffCurve' || nodeIndex === 0) {
                    return;
                }

                const distance = Math.hypot(
                    Number(node.x) - Number(point.x),
                    Number(node.y) - Number(point.y)
                );

                if (distance < bestDistance) {
                    bestDistance = distance;
                    bestNode = node;
                }
            });

            return bestNode
                ? {
                      x: Number(bestNode.x),
                      y: Number(bestNode.y)
                  }
                : null;
        });

        expect(intendedStart).not.toBeNull();

        undoExpectations.push({
            label: `iteration ${i + 1}: before set-start`,
            fingerprint: await captureOutlineFingerprint(page)
        });

        const setStartApplied = await page.evaluate(() => {
            const oe = (window as any).glyphCanvas.outlineEditor;
            return oe.setContextMenuPathStartNode();
        });
        expect(setStartApplied).toBeTruthy();
        await page.waitForTimeout(200);

        const afterSetStart = await page.evaluate(
            ({ expectedX, expectedY, expectedLinkedCount, pathIndex }) => {
                const oe = (window as any).glyphCanvas.outlineEditor;
                const layer = oe.getCurrentLayerModel();
                const path = layer?.paths?.[pathIndex];
                const nodes = path?.nodes || [];
                const startNode = nodes[0];
                const startNodeCoords = {
                    x: Number(startNode?.x),
                    y: Number(startNode?.y)
                };
                const target = oe.canvasContextMenuTarget;
                const glyph = oe.getCurrentGlyphModel();
                const compatibility = glyph?.calculateOutlineCompatibility?.();
                const linkedLayerCount =
                    layer?._getLinkedLayers?.()?.length || 0;

                return {
                    startNode: startNodeCoords,
                    target,
                    expectedX,
                    expectedY,
                    startMatches:
                        Math.abs(startNodeCoords.x - expectedX) < 0.001 &&
                        Math.abs(startNodeCoords.y - expectedY) < 0.001,
                    compatibilityOk: Boolean(compatibility?.compatible),
                    linkedLayerCount,
                    expectedLinkedCount
                };
            },
            {
                expectedX: intendedStart!.x,
                expectedY: intendedStart!.y,
                expectedLinkedCount: baseline.linkedLayerCount,
                pathIndex: actionPathIndex
            }
        );

        expect(
            afterSetStart.startMatches,
            `set-start mismatch: ${JSON.stringify(afterSetStart)}`
        ).toBeTruthy();
        expect(afterSetStart.compatibilityOk).toBeTruthy();
        expect(afterSetStart.linkedLayerCount).toBe(
            afterSetStart.expectedLinkedCount
        );

        const snapshotBeforeReverse = await page.evaluate(() => {
            const oe = (window as any).glyphCanvas.outlineEditor;
            const target = oe.canvasContextMenuTarget;
            const layer = oe.getCurrentLayerModel();
            const linkedLayers = layer?._getLinkedLayers?.() || [];
            const pathIndex = target?.pathIndex ?? 0;
            const toGeometrySignature = (pathData: any) => {
                const nodes = pathData?.nodes || [];
                return {
                    closed: Boolean(pathData?.closed),
                    nodes: nodes.map((node: any) => ({
                        x: Number(node.x),
                        y: Number(node.y),
                        off: node?.nodetype === 'OffCurve'
                    }))
                };
            };

            return [layer, ...linkedLayers].map((entry: any) => ({
                id: entry.id,
                path: toGeometrySignature(entry.paths?.[pathIndex]?.toJSON?.())
            }));
        });

        undoExpectations.push({
            label: `iteration ${i + 1}: before reverse #1`,
            fingerprint: await captureOutlineFingerprint(page)
        });

        await page.mouse.click(screen.x, screen.y, { button: 'right' });
        const reverseItem = page.locator(
            '.plugin-menu-item:has-text("Reverse path direction")'
        );
        await expect(reverseItem).toBeVisible();
        const reverseAppliedOnce = await page.evaluate(() => {
            const oe = (window as any).glyphCanvas.outlineEditor;
            return oe.reverseContextMenuPathDirection();
        });
        expect(reverseAppliedOnce).toBeTruthy();
        await page.waitForTimeout(200);

        undoExpectations.push({
            label: `iteration ${i + 1}: before reverse #2`,
            fingerprint: await captureOutlineFingerprint(page)
        });

        await page.mouse.click(screen.x, screen.y, { button: 'right' });
        await expect(reverseItem).toBeVisible();
        const reverseAppliedTwice = await page.evaluate(() => {
            const oe = (window as any).glyphCanvas.outlineEditor;
            return oe.reverseContextMenuPathDirection();
        });
        expect(reverseAppliedTwice).toBeTruthy();
        await page.waitForTimeout(200);

        const afterDoubleReverse = await page.evaluate(() => {
            const oe = (window as any).glyphCanvas.outlineEditor;
            const target = oe.canvasContextMenuTarget;
            const layer = oe.getCurrentLayerModel();
            const linkedLayers = layer?._getLinkedLayers?.() || [];
            const glyph = oe.getCurrentGlyphModel();
            const compatibility = glyph?.calculateOutlineCompatibility?.();
            const pathIndex = target?.pathIndex ?? 0;
            const toGeometrySignature = (pathData: any) => {
                const nodes = pathData?.nodes || [];
                return {
                    closed: Boolean(pathData?.closed),
                    nodes: nodes.map((node: any) => ({
                        x: Number(node.x),
                        y: Number(node.y),
                        off: node?.nodetype === 'OffCurve'
                    }))
                };
            };

            return {
                compatibility,
                linkedLayerCount: linkedLayers.length,
                paths: [layer, ...linkedLayers].map((entry: any) => ({
                    id: entry.id,
                    path: toGeometrySignature(
                        entry.paths?.[pathIndex]?.toJSON?.()
                    )
                }))
            };
        });

        expect(afterDoubleReverse.compatibility?.compatible).toBeTruthy();
        expect(afterDoubleReverse.linkedLayerCount).toBe(
            baseline.linkedLayerCount
        );
        expect(afterDoubleReverse.paths).toEqual(snapshotBeforeReverse);
    }

    for (let i = undoExpectations.length - 1; i >= 0; i--) {
        await performUndo(page);
        const actualFingerprint = await captureOutlineFingerprint(page);
        expect(
            actualFingerprint,
            `undo mismatch at step ${undoExpectations.length - i} (${undoExpectations[i].label})`
        ).toEqual(undoExpectations[i].fingerprint);
        expect(actualFingerprint.compatible).toBeTruthy();
    }
});
