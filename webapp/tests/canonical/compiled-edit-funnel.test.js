/**
 * Canonical tests for CompiledEditFunnel — the single post-commit reaction owner.
 *
 * Tests lock down:
 *   1. The funnel always processes (no guard blocks it).
 *   2. Guide edits skip compilation.
 *   3. Fast-path edit types arm the deferred full compile.
 *   4. The startup bootstrap guard prevents no-data wake-ups.
 *   5. Compile context is passed explicitly with the compile request.
 *
 * See developer-docs/COMPILATION_EDIT_POLICY.md §CompiledEditFunnel.
 */

jest.mock('../../js/font-manager', () => ({}));

let funnel;

beforeEach(() => {
    jest.resetModules();
    funnel = require('../../js/compiled-edit-funnel');
    window.fontManager = {
        currentFont: {
            changeVersion: 5,
            compileRequestVersion: 10,
            requestRecompileWithoutDataChange: jest.fn(),
            syncJsonFromModel: jest.fn()
        },
        editingFont: new Uint8Array([1, 2, 3]),
        lastChangeSource: null,
        lastEditType: null,
        lastCompilationMode: 'outline-only',
        pendingBabelfontJsonSyncAfterDrag: false,
        setEditingCompileContext(changeSource, editType) {
            this.lastChangeSource = changeSource;
            this.lastEditType = editType;
        },
        clearEditingCompileContext() {
            this.lastChangeSource = null;
            this.lastEditType = null;
        }
    };
    window.autoCompileManager = {
        checkAndSchedule: jest.fn(),
        forceTrigger: jest.fn().mockResolvedValue(undefined)
    };
    window.glyphCanvas = {
        outlineEditor: {
            draggingSomething: false
        }
    };
});

afterEach(() => {
    delete window.fontManager;
    delete window.autoCompileManager;
    delete window.glyphCanvas;
    funnel.reset();
    jest.clearAllTimers();
    jest.useRealTimers();
});

function process(changeSource, editType, options) {
    return funnel.processCommittedEdit(changeSource, editType, options);
}

describe('CompiledEditFunnel', () => {
    describe('processCommittedEdit', () => {
        test('requests outline compiles with explicit compile context', async () => {
            await process('keyboard-outline', 'outline');

            expect(
                window.fontManager.currentFont.requestRecompileWithoutDataChange
            ).toHaveBeenCalledWith({
                compileContext: {
                    changeSource: 'keyboard-outline',
                    editType: 'outline',
                    dataFreshnessMode: 'authoritative-worker-yjs'
                }
            });
            expect(window.fontManager.lastChangeSource).toBeNull();
            expect(window.fontManager.lastEditType).toBeNull();
            expect(
                window.autoCompileManager.checkAndSchedule
            ).toHaveBeenCalledTimes(1);
        });

        test('requests anchor compiles with explicit compile context', async () => {
            await process('keyboard-anchor', 'anchor');

            expect(
                window.fontManager.currentFont.requestRecompileWithoutDataChange
            ).toHaveBeenCalledWith({
                compileContext: {
                    changeSource: 'keyboard-anchor',
                    editType: 'anchor',
                    dataFreshnessMode: 'authoritative-worker-yjs'
                }
            });
            expect(window.fontManager.lastChangeSource).toBeNull();
            expect(window.fontManager.lastEditType).toBeNull();
        });

        test('requests full compiles with explicit null edit type', async () => {
            await process('change-bridge-local', null);

            expect(
                window.fontManager.currentFont.requestRecompileWithoutDataChange
            ).toHaveBeenCalledWith({
                compileContext: {
                    changeSource: 'change-bridge-local',
                    editType: null,
                    dataFreshnessMode: 'authoritative-worker-yjs'
                }
            });
            expect(window.fontManager.lastChangeSource).toBeNull();
            expect(window.fontManager.lastEditType).toBeNull();
        });

        test('feature-code compiles keep authoritative worker freshness', async () => {
            await process('feature-code', null);

            expect(
                window.fontManager.currentFont.requestRecompileWithoutDataChange
            ).toHaveBeenCalledWith({
                compileContext: {
                    changeSource: 'feature-code',
                    editType: null,
                    dataFreshnessMode: 'authoritative-worker-yjs'
                }
            });
        });

        test('ignores stale ambient context when requesting a committed compile', async () => {
            window.fontManager.lastChangeSource = 'mouse-drag-anchor';
            window.fontManager.lastEditType = 'anchor';

            await process('keyboard-outline', 'outline');

            expect(
                window.fontManager.currentFont.requestRecompileWithoutDataChange
            ).toHaveBeenCalledWith({
                compileContext: {
                    changeSource: 'keyboard-outline',
                    editType: 'outline',
                    dataFreshnessMode: 'authoritative-worker-yjs'
                }
            });
            expect(window.fontManager.lastChangeSource).toBeNull();
            expect(window.fontManager.lastEditType).toBeNull();
        });

        test('guide edits skip compile context and skip compilation', async () => {
            await process('keyboard-guide', 'guide');

            expect(window.fontManager.lastChangeSource).toBeNull();
            expect(window.fontManager.lastEditType).toBeNull();
            expect(
                window.fontManager.currentFont.requestRecompileWithoutDataChange
            ).not.toHaveBeenCalled();
            expect(
                window.autoCompileManager.checkAndSchedule
            ).not.toHaveBeenCalled();
        });

        test('bootstrap guard skips no-data commits before first editing font', async () => {
            window.fontManager.currentFont.changeVersion = 0;
            delete window.fontManager.editingFont;

            await process('change-bridge-local', 'outline');

            expect(
                window.fontManager.currentFont.requestRecompileWithoutDataChange
            ).not.toHaveBeenCalled();
            expect(
                window.autoCompileManager.checkAndSchedule
            ).not.toHaveBeenCalled();
        });

        test('bootstrap guard does not skip when editing font already exists', async () => {
            window.fontManager.currentFont.changeVersion = 0;
            window.fontManager.editingFont = new Uint8Array([1, 2, 3]);

            await process('change-bridge-local', 'outline');

            expect(
                window.fontManager.currentFont.requestRecompileWithoutDataChange
            ).toHaveBeenCalledTimes(1);
        });

        test('forceTrigger calls forceTrigger when available', async () => {
            await process('remote-outline', 'outline', {
                forceTrigger: true
            });

            expect(
                window.autoCompileManager.forceTrigger
            ).toHaveBeenCalledTimes(1);
        });

        test('forceTrigger skips when not available', async () => {
            delete window.autoCompileManager.forceTrigger;

            await process('remote-outline', 'outline', {
                forceTrigger: true
            });

            // Should not throw
            expect(
                window.fontManager.currentFont.requestRecompileWithoutDataChange
            ).toHaveBeenCalledTimes(1);
        });

        test('waitForCompletion waits for the requested compiled revision', async () => {
            window.fontManager.currentFont.requestRecompileWithoutDataChange.mockImplementation(
                () => {
                    window.fontManager.currentFont.compileRequestVersion += 1;
                }
            );
            window.autoCompileManager.forceTrigger.mockImplementation(
                async () => {
                    window.dispatchEvent(
                        new CustomEvent('editingFontCompiled', {
                            detail: { fontRevisionKey: '10' }
                        })
                    );
                }
            );

            const processPromise = process('keyboard-outline', 'outline', {
                forceTrigger: true,
                waitForCompletion: true
            });
            let settled = false;
            processPromise.then(() => {
                settled = true;
            });

            await Promise.resolve();
            await Promise.resolve();

            expect(settled).toBe(false);

            window.dispatchEvent(
                new CustomEvent('editingFontCompiled', {
                    detail: { fontRevisionKey: '11' }
                })
            );

            await processPromise;
            expect(settled).toBe(true);
        });

        test('waitForCompletion retries with a fresh revision when the requested revision never compiles', async () => {
            jest.useFakeTimers();
            window.fontManager.currentFont.requestRecompileWithoutDataChange.mockImplementation(
                () => {
                    window.fontManager.currentFont.compileRequestVersion += 1;
                    window.fontManager.currentFont.needsRecompile = true;
                }
            );
            let forceTriggerCallCount = 0;
            window.autoCompileManager.forceTrigger.mockImplementation(
                async () => {
                    forceTriggerCallCount += 1;
                    if (forceTriggerCallCount === 2) {
                        window.dispatchEvent(
                            new CustomEvent('editingFontCompiled', {
                                detail: { fontRevisionKey: '12' }
                            })
                        );
                    }
                }
            );

            const processPromise = process('keyboard-outline', 'outline', {
                forceTrigger: true,
                waitForCompletion: true
            });

            await Promise.resolve();
            jest.advanceTimersByTime(4000);

            await expect(processPromise).resolves.toBeUndefined();
            expect(window.fontManager.currentFont.needsRecompile).toBe(true);
            expect(
                window.fontManager.currentFont.requestRecompileWithoutDataChange
            ).toHaveBeenCalledTimes(2);
            expect(
                window.autoCompileManager.checkAndSchedule
            ).toHaveBeenCalledTimes(2);
            expect(
                window.autoCompileManager.forceTrigger
            ).toHaveBeenCalledTimes(2);
            expect(window.fontManager.currentFont.compileRequestVersion).toBe(
                12
            );
        });

        test('waitForCompletion still rejects after a timed-out committed retry', async () => {
            jest.useFakeTimers();
            window.fontManager.currentFont.requestRecompileWithoutDataChange.mockImplementation(
                () => {
                    window.fontManager.currentFont.compileRequestVersion += 1;
                }
            );

            const processPromise = process('keyboard-outline', 'outline', {
                forceTrigger: true,
                waitForCompletion: true
            });

            await Promise.resolve();
            jest.advanceTimersByTime(4000);
            await Promise.resolve();
            jest.advanceTimersByTime(4000);

            await expect(processPromise).rejects.toThrow(
                'Timed out waiting for editing font revision 12 after committed retry'
            );
        });
    });

    describe('deferred full compile', () => {
        beforeEach(() => {
            jest.useFakeTimers();
        });

        test('committed outline does not arm a deferred full compile', async () => {
            await process('keyboard-outline', 'outline');

            jest.advanceTimersByTime(500);

            expect(
                window.fontManager.currentFont.requestRecompileWithoutDataChange
            ).toHaveBeenCalledTimes(1);
        });

        test('does not serialize the model before a deferred full compile', async () => {
            window.fontManager.pendingBabelfontJsonSyncAfterDrag = true;

            await process('keyboard-kerning-value', 'kerning-value');
            jest.advanceTimersByTime(500);

            expect(
                window.fontManager.currentFont.syncJsonFromModel
            ).not.toHaveBeenCalled();
            expect(window.fontManager.pendingBabelfontJsonSyncAfterDrag).toBe(
                true
            );
        });

        test('does not arm deferred full compile for remote fast-path edits', async () => {
            await process('remote-outline', 'outline');

            jest.advanceTimersByTime(500);

            expect(
                window.fontManager.currentFont.requestRecompileWithoutDataChange
            ).toHaveBeenCalledTimes(1);
        });

        test('does not arm deferred full compile for full compile packets', async () => {
            await process('feature-code', null);

            jest.advanceTimersByTime(500);

            expect(
                window.fontManager.currentFont.requestRecompileWithoutDataChange
            ).toHaveBeenCalledTimes(1);
        });

        test('does not arm deferred full compile for guide edits', async () => {
            await process('keyboard-guide', 'guide');

            jest.advanceTimersByTime(500);

            expect(
                window.fontManager.currentFont.requestRecompileWithoutDataChange
            ).not.toHaveBeenCalled();
        });

        test('re-arms when drag is active', async () => {
            await process('keyboard-kerning-value', 'kerning-value');
            const callCountBefore =
                window.fontManager.currentFont.requestRecompileWithoutDataChange
                    .mock.calls.length;

            // Drag becomes active before timer fires
            window.glyphCanvas.outlineEditor.draggingSomething = true;
            jest.advanceTimersByTime(500);
            // Drag still active — should re-arm, not fire
            expect(
                window.fontManager.currentFont.requestRecompileWithoutDataChange
            ).toHaveBeenCalledTimes(callCountBefore);

            // Drag ends
            window.glyphCanvas.outlineEditor.draggingSomething = false;
            jest.advanceTimersByTime(500);

            // Should fire now
            expect(
                window.fontManager.currentFont.requestRecompileWithoutDataChange
            ).toHaveBeenCalledTimes(callCountBefore + 1);
        });

        test('re-arms when a kerning preview burst is active', async () => {
            window.glyphCanvas.hasActiveTextModeKerningPreviewBurst = jest
                .fn()
                .mockReturnValue(true);

            await process('keyboard-kerning-value', 'kerning-value');
            const callCountBefore =
                window.fontManager.currentFont.requestRecompileWithoutDataChange
                    .mock.calls.length;

            jest.advanceTimersByTime(500);
            expect(
                window.fontManager.currentFont.requestRecompileWithoutDataChange
            ).toHaveBeenCalledTimes(callCountBefore);

            window.glyphCanvas.hasActiveTextModeKerningPreviewBurst.mockReturnValue(
                false
            );
            jest.advanceTimersByTime(500);

            expect(
                window.fontManager.currentFont.requestRecompileWithoutDataChange
            ).toHaveBeenCalledTimes(callCountBefore + 1);
        });

        test('skips deferred full compile when last mode was already full', async () => {
            window.fontManager.lastCompilationMode = 'full';

            await process('keyboard-kerning-value', 'kerning-value');
            const callCountBefore =
                window.fontManager.currentFont.requestRecompileWithoutDataChange
                    .mock.calls.length;

            jest.advanceTimersByTime(500);

            // Timer fires but skips because lastCompilationMode is 'full'
            expect(
                window.fontManager.currentFont.requestRecompileWithoutDataChange
            ).toHaveBeenCalledTimes(callCountBefore);
        });

        test('timer is cancelled and re-armed on subsequent edits', async () => {
            await process('keyboard-kerning-value', 'kerning-value');
            const callCountBefore =
                window.fontManager.currentFont.requestRecompileWithoutDataChange
                    .mock.calls.length;

            // Second edit re-arms the timer
            jest.advanceTimersByTime(400);
            await process('keyboard-kerning-value', 'kerning-value');

            // Timer shouldn't fire at 500ms from first edit (re-armed)
            jest.advanceTimersByTime(100);
            expect(
                window.fontManager.currentFont.requestRecompileWithoutDataChange
            ).toHaveBeenCalledTimes(callCountBefore + 1); // +1 for second edit

            // Should fire 500ms from second edit
            jest.advanceTimersByTime(400);
            expect(
                window.fontManager.currentFont.requestRecompileWithoutDataChange
            ).toHaveBeenCalledTimes(callCountBefore + 2); // +1 for deferred
        });
    });

    describe('no guard — funnel always processes', () => {
        test('processes even when lastFullCompiledDataVersion >= changeVersion', async () => {
            // Previous architecture had a guard here that blocked the funnel.
            // The guard is removed — the funnel always processes.
            window.fontManager.lastFullCompiledDataVersion = 100;
            window.fontManager.currentFont.changeVersion = 100;

            await process('keyboard-kerning-value', 'kerning-value');

            expect(
                window.fontManager.currentFont.requestRecompileWithoutDataChange
            ).toHaveBeenCalledTimes(1);
        });
    });
});
