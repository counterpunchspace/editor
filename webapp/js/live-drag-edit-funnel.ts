import APP_SETTINGS from './settings';
import type { EditingCompileContext } from './font-manager';

export type LiveDragEditKind = 'outline' | 'anchor' | 'sidebearing' | 'guide';

export type LiveDragCompilingEditType =
    'outline' | 'anchor' | 'sidebearing' | null;

const LIVE_PREVIEW_FRESHNESS: EditingCompileContext['dataFreshnessMode'] =
    'live-drag-worker-preview';

export type LiveCompileRequest = {
    changeSource: string;
    editType: LiveDragCompilingEditType;
};

export type LiveDragEditRequest = {
    kind?: LiveDragEditKind;
    prepare?: () => boolean | void | Promise<boolean | void>;
    run: () => boolean | void | Promise<boolean | void>;
    render?: () => void;
    isActive?: () => boolean;
    compile?: LiveCompileRequest | (() => LiveCompileRequest | null);
    onError?: (error: Error) => void;
};

function isThenable(
    value: boolean | void | Promise<boolean | void>
): value is Promise<boolean | void> {
    return (
        !!value &&
        typeof value === 'object' &&
        typeof (value as Promise<boolean | void>).then === 'function'
    );
}

/**
 * One serializer for pointer-drag and keyboard live previews.
 * Mouse-up drops a queued drag frame. Keyboard commit waits for the
 * latest queued overlay, then commits.
 */
export class LiveDragEditFunnel {
    private runningRequest: Promise<void> | null = null;
    private queuedRequest: LiveDragEditRequest | null = null;
    private commitTimer: number | null = null;
    private pendingCommit: (() => Promise<void>) | null = null;
    private prepareChain: Promise<void> = Promise.resolve();
    private asyncPrepareCount = 0;

    queue(request: LiveDragEditRequest): void {
        if (request.prepare || request.render) {
            this.queueKeyboardPreview(request);
            return;
        }
        this.queuedRequest = request;
        this.startNextRequest();
    }

    scheduleCommit(commit: () => Promise<void>): void {
        this.pendingCommit = commit;
        if (this.commitTimer !== null) {
            window.clearTimeout(this.commitTimer);
        }
        this.commitTimer = window.setTimeout(() => {
            this.commitTimer = null;
            void this.flushPendingCommit();
        }, APP_SETTINGS.KEYBOARD_PREVIEW_COMMIT_DEBOUNCE);
    }

    hasPendingWork(): boolean {
        return !!(
            this.runningRequest ||
            this.queuedRequest ||
            this.asyncPrepareCount > 0 ||
            this.pendingCommit ||
            this.commitTimer !== null
        );
    }

    clearQueued(): void {
        this.queuedRequest = null;
    }

    cancelPendingCommit(): void {
        if (this.commitTimer !== null) {
            window.clearTimeout(this.commitTimer);
            this.commitTimer = null;
        }
        this.pendingCommit = null;
    }

    async drainAndClearQueued(): Promise<void> {
        await this.prepareChain.catch(() => undefined);
        const finishQueued = this.queuedRequest
            ? this.queuedRequest.render != null ||
              this.queuedRequest.prepare != null
            : false;
        if (!finishQueued) {
            this.queuedRequest = null;
        }

        while (this.runningRequest || this.queuedRequest) {
            if (!this.runningRequest && this.queuedRequest) {
                this.startNextRequest();
            }
            const runningRequest = this.runningRequest;
            if (!runningRequest) {
                continue;
            }
            await runningRequest;
            if (this.runningRequest === runningRequest) {
                this.runningRequest = null;
            }
            if (!finishQueued) {
                this.queuedRequest = null;
            }
        }
    }

    async flushPendingCommit(): Promise<void> {
        if (this.commitTimer !== null) {
            window.clearTimeout(this.commitTimer);
            this.commitTimer = null;
        }

        await this.drainAndClearQueued();

        const commit = this.pendingCommit;
        this.pendingCommit = null;
        if (commit) {
            await commit();
        }
    }

    reset(): void {
        this.clearQueued();
        this.cancelPendingCommit();
    }

    private queueKeyboardPreview(request: LiveDragEditRequest): void {
        if (this.asyncPrepareCount === 0) {
            const prepareResult = request.prepare?.();
            if (isThenable(prepareResult)) {
                this.enqueuePrepare(request, prepareResult);
                return;
            }
            if (prepareResult === false) {
                this.clearMatchingCompileContext(request);
                return;
            }
            this.finishLocalPrepare(request);
            return;
        }
        this.enqueuePrepare(request);
    }

    private enqueuePrepare(
        request: LiveDragEditRequest,
        startedPrepare?: Promise<boolean | void>
    ): void {
        this.asyncPrepareCount += 1;
        this.prepareChain = this.prepareChain
            .catch(() => undefined)
            .then(() => this.runPrepareStep(request, startedPrepare))
            .finally(() => {
                this.asyncPrepareCount = Math.max(
                    0,
                    this.asyncPrepareCount - 1
                );
            });
    }

    private async runPrepareStep(
        request: LiveDragEditRequest,
        startedPrepare?: Promise<boolean | void>
    ): Promise<void> {
        try {
            const shouldContinue = startedPrepare
                ? await startedPrepare
                : request.prepare
                  ? await request.prepare()
                  : true;
            if (shouldContinue === false) {
                this.clearMatchingCompileContext(request);
                return;
            }
        } catch (error) {
            const normalizedError =
                error instanceof Error ? error : new Error(String(error));
            request.onError?.(normalizedError);
            this.clearMatchingCompileContext(request);
            return;
        }
        this.finishLocalPrepare(request);
    }

    private finishLocalPrepare(request: LiveDragEditRequest): void {
        if (!this.isRequestActive(request)) {
            this.clearMatchingCompileContext(request);
            return;
        }
        request.render?.();
        this.queuedRequest = {
            ...request,
            prepare: undefined
        };
        this.startNextRequest();
    }

    private startNextRequest(): void {
        if (this.runningRequest || !this.queuedRequest) {
            return;
        }

        const request = this.queuedRequest;
        this.queuedRequest = null;

        const runningRequest = this.processRequest(request);
        this.runningRequest = runningRequest;

        void runningRequest.finally(() => {
            if (this.runningRequest === runningRequest) {
                this.runningRequest = null;
            }
            this.startNextRequest();
        });
    }

    private async processRequest(request: LiveDragEditRequest): Promise<void> {
        if (!this.isRequestActive(request)) {
            this.clearMatchingCompileContext(request);
            return;
        }

        if (request.render) {
            await this.waitForNextPaint();
            if (!this.isRequestActive(request)) {
                this.clearMatchingCompileContext(request);
                return;
            }
        }

        let shouldCompile: boolean | void;
        try {
            shouldCompile = await request.run();
        } catch (error) {
            const normalizedError =
                error instanceof Error ? error : new Error(String(error));
            request.onError?.(normalizedError);
            this.clearMatchingCompileContext(request);
            return;
        }

        if (shouldCompile === false) {
            this.clearMatchingCompileContext(request);
            return;
        }

        if (!this.isRequestActive(request)) {
            this.clearOrphanedPreviewOverlay(request);
            this.clearMatchingCompileContext(request);
            return;
        }

        this.requestLiveCompile(request);
    }

    private clearOrphanedPreviewOverlay(request: LiveDragEditRequest): void {
        if (request.kind !== 'sidebearing' && request.kind !== 'anchor') {
            return;
        }
        window.fontManager?.clearLiveDragPreview?.();
    }

    private isRequestActive(request: LiveDragEditRequest): boolean {
        return request.isActive ? request.isActive() : true;
    }

    private requestLiveCompile(request: LiveDragEditRequest): void {
        const compileRequest = this.resolveCompileRequest(request);
        if (!compileRequest) {
            return;
        }

        const fontCompilation = window.fontCompilation;
        if (
            fontCompilation?.isInitialized &&
            !fontCompilation.hasWorkerCacheDocument?.()
        ) {
            return;
        }

        const fm = window.fontManager;
        const currentFont = fm?.currentFont;
        if (!fm || !currentFont) {
            return;
        }

        fm.setEditingCompileContext(
            compileRequest.changeSource,
            compileRequest.editType
        );
        currentFont.requestRecompileWithoutDataChange({
            compileContext: {
                changeSource: compileRequest.changeSource,
                editType: compileRequest.editType,
                dataFreshnessMode: LIVE_PREVIEW_FRESHNESS
            }
        });
        window.autoCompileManager?.checkAndSchedule?.();
        this.clearMatchingCompileContext(request);
    }

    private clearMatchingCompileContext(request: LiveDragEditRequest): void {
        const compileRequest = this.resolveCompileRequest(request);
        if (!compileRequest) {
            return;
        }

        const fm = window.fontManager;
        if (!fm) {
            return;
        }

        if (
            fm.lastChangeSource === compileRequest.changeSource &&
            fm.lastEditType === compileRequest.editType
        ) {
            fm.clearEditingCompileContext();
        }
    }

    private resolveCompileRequest(
        request: LiveDragEditRequest
    ): LiveCompileRequest | null {
        if (!request.compile) {
            return null;
        }
        return typeof request.compile === 'function'
            ? request.compile()
            : request.compile;
    }

    private async waitForNextPaint(): Promise<void> {
        await new Promise<void>((resolve) => {
            requestAnimationFrame(() => {
                requestAnimationFrame(() => resolve());
            });
        });
    }
}
