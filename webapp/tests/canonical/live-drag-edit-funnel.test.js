/**
 * Canonical tests for LiveDragEditFunnel — the pre-commit drag-time refresh
 * and compile owner.
 */

const { LiveDragEditFunnel } = require('../../js/live-drag-edit-funnel');

function deferred() {
    let resolve;
    const promise = new Promise((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

beforeEach(() => {
    const recordedCompileContexts = [];
    window.fontManager = {
        currentFont: {
            compileRequestVersion: 0,
            requestRecompileWithoutDataChange: jest.fn((options) => {
                window.fontManager.currentFont.compileRequestVersion += 1;
                window.fontManager.recordEditingCompileRequestContext(
                    window.fontManager.currentFont.compileRequestVersion,
                    options?.compileContext
                );
            })
        },
        lastChangeSource: null,
        lastEditType: null,
        recordedCompileContexts,
        clearLiveDragPreview: jest.fn(),
        setEditingCompileContext(changeSource, editType) {
            this.lastChangeSource = changeSource;
            this.lastEditType = editType;
        },
        clearEditingCompileContext() {
            this.lastChangeSource = null;
            this.lastEditType = null;
        },
        recordEditingCompileRequestContext(
            compileRequestVersion,
            compileContext
        ) {
            this.recordedCompileContexts.push({
                compileRequestVersion,
                changeSource: this.lastChangeSource,
                editType: this.lastEditType,
                dataFreshnessMode: compileContext?.dataFreshnessMode ?? null
            });
        }
    };
    window.autoCompileManager = {
        checkAndSchedule: jest.fn()
    };
});

afterEach(() => {
    delete window.fontManager;
    delete window.autoCompileManager;
});

describe('LiveDragEditFunnel', () => {
    test('runs a live refresh before requesting its compile', async () => {
        const funnel = new LiveDragEditFunnel();
        const calls = [];

        funnel.queue({
            kind: 'sidebearing',
            compile: {
                changeSource: 'mouse-drag-sidebearing',
                editType: 'sidebearing'
            },
            run: () => {
                calls.push('refresh');
            }
        });

        await funnel.drainAndClearQueued();

        expect(calls).toEqual(['refresh']);
        expect(window.fontManager.lastChangeSource).toBeNull();
        expect(window.fontManager.lastEditType).toBeNull();
        expect(window.fontManager.recordedCompileContexts).toEqual([
            {
                compileRequestVersion: 1,
                changeSource: 'mouse-drag-sidebearing',
                editType: 'sidebearing',
                dataFreshnessMode: 'live-drag-worker-preview'
            }
        ]);
        expect(
            window.fontManager.currentFont.requestRecompileWithoutDataChange
        ).toHaveBeenCalledWith({
            compileContext: {
                changeSource: 'mouse-drag-sidebearing',
                editType: 'sidebearing',
                dataFreshnessMode: 'live-drag-worker-preview'
            }
        });
        expect(
            window.autoCompileManager.checkAndSchedule
        ).toHaveBeenCalledTimes(1);
    });

    test('does not wake live compile while worker Yjs document is not ready', async () => {
        const originalFontCompilation = window.fontCompilation;
        window.fontCompilation = {
            isInitialized: true,
            hasWorkerCacheDocument: jest.fn(() => false)
        };

        const funnel = new LiveDragEditFunnel();

        try {
            funnel.queue({
                kind: 'outline',
                compile: {
                    changeSource: 'mouse-drag-outline',
                    editType: 'outline'
                },
                run: () => true
            });

            await funnel.drainAndClearQueued();
        } finally {
            window.fontCompilation = originalFontCompilation;
        }

        expect(
            window.fontManager.currentFont.requestRecompileWithoutDataChange
        ).not.toHaveBeenCalled();
        expect(
            window.autoCompileManager.checkAndSchedule
        ).not.toHaveBeenCalled();
        expect(window.fontManager.lastChangeSource).toBeNull();
        expect(window.fontManager.lastEditType).toBeNull();
    });

    test('coalesces queued drag refreshes behind the running refresh', async () => {
        const funnel = new LiveDragEditFunnel();
        const first = deferred();
        const calls = [];

        funnel.queue({
            kind: 'outline',
            compile: {
                changeSource: 'mouse-drag-outline',
                editType: 'outline'
            },
            run: async () => {
                calls.push('first');
                await first.promise;
            }
        });
        funnel.queue({
            kind: 'outline',
            compile: {
                changeSource: 'mouse-drag-outline',
                editType: 'outline'
            },
            run: () => {
                calls.push('second');
            }
        });

        expect(calls).toEqual(['first']);

        first.resolve();
        await funnel.drainAndClearQueued();

        expect(calls).toEqual(['first']);
        expect(
            window.fontManager.currentFont.requestRecompileWithoutDataChange
        ).toHaveBeenCalledTimes(1);
        expect(window.fontManager.lastChangeSource).toBeNull();
        expect(window.fontManager.lastEditType).toBeNull();
    });

    test('runs the latest queued refresh after the current one completes', async () => {
        const funnel = new LiveDragEditFunnel();
        const first = deferred();
        const calls = [];

        funnel.queue({
            kind: 'anchor',
            compile: {
                changeSource: 'mouse-drag-anchor',
                editType: 'anchor'
            },
            run: async () => {
                calls.push('first');
                await first.promise;
            }
        });
        funnel.queue({
            kind: 'anchor',
            compile: {
                changeSource: 'mouse-drag-anchor',
                editType: 'anchor'
            },
            run: () => {
                calls.push('discarded');
            }
        });
        funnel.queue({
            kind: 'anchor',
            compile: {
                changeSource: 'mouse-drag-anchor',
                editType: 'anchor'
            },
            run: () => {
                calls.push('latest');
            }
        });

        first.resolve();
        await new Promise((resolve) => setTimeout(resolve, 0));
        await funnel.drainAndClearQueued();

        expect(calls).toEqual(['first', 'latest']);
        expect(
            window.fontManager.currentFont.requestRecompileWithoutDataChange
        ).toHaveBeenCalledTimes(2);
        expect(window.fontManager.lastChangeSource).toBeNull();
        expect(window.fontManager.lastEditType).toBeNull();
    });

    test('successful stage wakes compile even when newer ticks arrived mid-await', async () => {
        const funnel = new LiveDragEditFunnel();
        const firstStage = deferred();
        const calls = [];

        funnel.queue({
            kind: 'sidebearing',
            compile: {
                changeSource: 'mouse-drag-outline',
                editType: 'outline'
            },
            isActive: () => true,
            run: async () => {
                calls.push('stage-1-start');
                await firstStage.promise;
                calls.push('stage-1-done');
                // Outline-editor stage runners return true after a successful
                // stage even if generation advanced during the await.
                return true;
            }
        });

        funnel.queue({
            kind: 'sidebearing',
            compile: {
                changeSource: 'mouse-drag-outline',
                editType: 'outline'
            },
            isActive: () => true,
            run: async () => {
                calls.push('stage-2');
                return true;
            }
        });

        firstStage.resolve();
        await new Promise((resolve) => setTimeout(resolve, 0));
        await funnel.drainAndClearQueued();

        expect(calls).toEqual(['stage-1-start', 'stage-1-done', 'stage-2']);
        expect(
            window.fontManager.currentFont.requestRecompileWithoutDataChange
        ).toHaveBeenCalledTimes(2);
        expect(
            window.autoCompileManager.checkAndSchedule
        ).toHaveBeenCalledTimes(2);
    });

    test('empty/failed stage return false skips compile but still runs next queued stage', async () => {
        const funnel = new LiveDragEditFunnel();
        const firstStage = deferred();
        const calls = [];

        funnel.queue({
            kind: 'sidebearing',
            compile: {
                changeSource: 'mouse-drag-outline',
                editType: 'outline'
            },
            run: async () => {
                calls.push('empty');
                await firstStage.promise;
                return false;
            }
        });
        funnel.queue({
            kind: 'sidebearing',
            compile: {
                changeSource: 'mouse-drag-outline',
                editType: 'outline'
            },
            run: async () => {
                calls.push('latest');
                return true;
            }
        });

        firstStage.resolve();
        await new Promise((resolve) => setTimeout(resolve, 0));
        await funnel.drainAndClearQueued();

        expect(calls).toEqual(['empty', 'latest']);
        expect(
            window.fontManager.currentFont.requestRecompileWithoutDataChange
        ).toHaveBeenCalledTimes(1);
    });

    test('draining after mouseup waits for in-flight refresh but skips stale compile', async () => {
        const funnel = new LiveDragEditFunnel();
        const refresh = deferred();
        let active = true;

        window.fontManager.lastChangeSource = 'mouse-drag-outline';
        window.fontManager.lastEditType = 'outline';

        funnel.queue({
            kind: 'sidebearing',
            compile: {
                changeSource: 'mouse-drag-outline',
                editType: 'outline'
            },
            isActive: () => active,
            run: async () => {
                await refresh.promise;
            }
        });

        active = false;
        const drained = funnel.drainAndClearQueued();
        refresh.resolve();
        await drained;

        expect(
            window.fontManager.currentFont.requestRecompileWithoutDataChange
        ).not.toHaveBeenCalled();
        expect(
            window.autoCompileManager.checkAndSchedule
        ).not.toHaveBeenCalled();
        expect(window.fontManager.clearLiveDragPreview).toHaveBeenCalledTimes(
            1
        );
        expect(window.fontManager.lastChangeSource).toBeNull();
        expect(window.fontManager.lastEditType).toBeNull();
    });

    test('session death after sidebearing stage clears orphaned preview overlay', async () => {
        const funnel = new LiveDragEditFunnel();
        const refresh = deferred();
        let active = true;

        funnel.queue({
            kind: 'sidebearing',
            compile: {
                changeSource: 'mouse-drag-outline',
                editType: 'outline'
            },
            isActive: () => active,
            run: async () => {
                await refresh.promise;
                return true;
            }
        });

        active = false;
        const drained = funnel.drainAndClearQueued();
        refresh.resolve();
        await drained;

        expect(window.fontManager.clearLiveDragPreview).toHaveBeenCalledTimes(
            1
        );
        expect(
            window.fontManager.currentFont.requestRecompileWithoutDataChange
        ).not.toHaveBeenCalled();
    });

    test('session death after outline stage does not clear preview overlay', async () => {
        const funnel = new LiveDragEditFunnel();
        const refresh = deferred();
        let active = true;

        funnel.queue({
            kind: 'outline',
            compile: {
                changeSource: 'mouse-drag-outline',
                editType: 'outline'
            },
            isActive: () => active,
            run: async () => {
                await refresh.promise;
                return true;
            }
        });

        active = false;
        const drained = funnel.drainAndClearQueued();
        refresh.resolve();
        await drained;

        expect(window.fontManager.clearLiveDragPreview).not.toHaveBeenCalled();
    });

    test('non-compiling live drag requests never wake auto compile', async () => {
        const funnel = new LiveDragEditFunnel();

        funnel.queue({
            kind: 'guide',
            run: () => true
        });

        await funnel.drainAndClearQueued();

        expect(
            window.fontManager.currentFont.requestRecompileWithoutDataChange
        ).not.toHaveBeenCalled();
        expect(
            window.autoCompileManager.checkAndSchedule
        ).not.toHaveBeenCalled();
    });
});
