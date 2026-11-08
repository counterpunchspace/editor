// Central State Manager with Automatic Change Tracking
// Captures all state changes with full stack traces for error reporting

import { Logger } from './logger';
import type { UserspaceLocation } from './locations';
import {
    updateUrlState,
    encodeLocation,
    encodeFeatures,
    decodeLocation,
    decodeFeatures
} from './url-state';
import {
    DEFAULT_LINE_HEIGHT_PERCENT,
    DEFAULT_TEXT_ALIGN,
    isTextAlign,
    parseLineHeightPercent
} from './glyph-canvas/text-run-layout';
import { mapStackTrace } from './stack-mapper';
import { resolveWebsiteURL } from './website-url';

const console = new Logger('StateManager');

export interface StateChange {
    timestamp: number;
    key: string;
    oldValue: any;
    newValue: any;
    stack: string;
}

export interface StateEvent {
    timestamp: number;
    type: string;
    source: string;
    payload?: Record<string, any>;
    stack: string;
}

export interface ErrorReport {
    error: {
        message: string;
        stack: string;
    };
    timestamp: number;
    state: Record<string, any>;
    history: StateChange[];
    events: StateEvent[];
}

export interface EditorState {
    file: string;
    text_buffer: string;
    cursor_position: number;
    mode: 'text' | 'edit';
    glyph_stack: string;
    harfbuzz_glyph_names: string;
    harfbuzz_gids: string;
    harfbuzz_dx: string;
    harfbuzz_dy: string;
    harfbuzz_ax: string;
    harfbuzz_ay: string;
    harfbuzz_cl: string;
    isInterpolating: boolean;
    isAnimating: boolean;
    opentype_features_in_subset: Record<string, boolean>;
    opentype_features_not_in_subset: Record<string, boolean>;
    variation_location: UserspaceLocation;
    active_canvas_plugins: string[];
    line_height: number;
    text_align: 'left' | 'center' | 'right';
}

const HISTORY_RETENTION_MS = 10000; // 10 seconds

/**
 * History and event stacks are source-mapped in the background. Mapping
 * fetches and parses each script's source map (megabytes), so it waits until
 * startup has passed instead of competing with it.
 */
const STACK_MAPPING_DELAY_MS = 5000;
const pendingStackRecords: Array<{
    record: { stack: string };
    failure: string;
}> = [];
let stackMappingTimer: ReturnType<typeof setTimeout> | null = null;

function queueStackMapping(record: { stack: string }, failure: string): void {
    pendingStackRecords.push({ record, failure });
    if (stackMappingTimer !== null) {
        return;
    }
    stackMappingTimer = setTimeout(() => {
        stackMappingTimer = null;
        for (const {
            record: pending,
            failure: message
        } of pendingStackRecords.splice(0)) {
            mapStackTrace(pending.stack)
                .then((mappedStack) => {
                    if (mappedStack) {
                        pending.stack = mappedStack;
                    }
                })
                .catch((error) => {
                    console.warn(message, error);
                });
        }
    }, STACK_MAPPING_DELAY_MS);
}
const SYNC_DEBOUNCE_MS = 100; // Debounce URL updates
const ERROR_REPORT_ENDPOINT = '/api/errors/report';

function getWebsiteURL(): string {
    return resolveWebsiteURL();
}

function getSessionTokenFromCookie(): string | null {
    const cookies = document.cookie.split(';');
    for (const cookie of cookies) {
        const trimmedCookie = cookie.trim();
        const separatorIndex = trimmedCookie.indexOf('=');
        if (separatorIndex === -1) {
            continue;
        }

        const name = trimmedCookie.slice(0, separatorIndex);
        const value = trimmedCookie.slice(separatorIndex + 1);
        if (name === 'editor_session') {
            return value;
        }
    }

    return null;
}

function safeErrorReason(reason: any): string {
    if (typeof reason === 'string') {
        return reason;
    }

    try {
        return JSON.stringify(reason);
    } catch (error) {
        return String(reason);
    }
}

function isSafariUserAgent(userAgent: string): boolean {
    return (
        /Safari\//.test(userAgent) &&
        !/Chrome\//.test(userAgent) &&
        !/Chromium\//.test(userAgent) &&
        !/CriOS\//.test(userAgent) &&
        !/Edg\//.test(userAgent) &&
        !/OPR\//.test(userAgent) &&
        !/FxiOS\//.test(userAgent) &&
        !/Firefox\//.test(userAgent) &&
        !/Android/.test(userAgent)
    );
}

function safeSessionStorageGet(key: string): string | null {
    try {
        return window.sessionStorage.getItem(key);
    } catch (_error) {
        return null;
    }
}

function getErrorRuntimeContext() {
    const userAgent = navigator.userAgent || '';
    const serviceWorker = navigator.serviceWorker;
    const hasServiceWorkerController = !!serviceWorker?.controller;

    return {
        startupMs: Math.round(performance.now()),
        readyState: document.readyState,
        visibilityState: document.visibilityState,
        userAgent,
        browserFamily: isSafariUserAgent(userAgent) ? 'safari' : 'other',
        hasServiceWorkerController,
        serviceWorkerState: serviceWorker?.controller?.state || null,
        coiReloadedBySelf: safeSessionStorageGet('coiReloadedBySelf'),
        hasSharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined'
    };
}

async function sendErrorReportToServer(payload: Record<string, any>) {
    try {
        const websiteURL = getWebsiteURL();
        const sessionToken =
            (window as any).authManager?.getSessionToken?.() ||
            getSessionTokenFromCookie();

        const headers: Record<string, string> = {
            'Content-Type': 'application/json'
        };

        if (sessionToken) {
            headers.Authorization = `Bearer ${sessionToken}`;
        }

        await fetch(`${websiteURL}${ERROR_REPORT_ENDPOINT}`, {
            method: 'POST',
            credentials: 'include',
            keepalive: true,
            headers,
            body: JSON.stringify(payload)
        });
    } catch (error) {
        console.warn('Failed to send error report to server:', error);
    }
}

/**
 * Build the full runtime-style error payload used for server reporting.
 */
export async function buildErrorReportPayload(
    error: Error | any,
    source: string,
    actionContext?: string
): Promise<Record<string, any>> {
    const runtimeContext = getErrorRuntimeContext();
    const mappedReport = await stateManager.captureErrorMapped(
        error,
        actionContext
    );
    const snapshot = stateManager.getStateSnapshot();

    return {
        ...mappedReport,
        state: snapshot.state,
        history: snapshot.history,
        events: snapshot.events,
        source,
        reason: safeErrorReason(error),
        runtimeContext,
        url: window.location.href,
        userAgent: navigator.userAgent,
        appVersion: (window as any).EDITOR_VERSION || null,
        buildHash: (window as any).BUILD_HASH_FULL || null
    };
}

export class StateManager {
    private _state: Record<string, any> = {};
    private _history: StateChange[] = [];
    private _events: StateEvent[] = [];
    private _urlSyncEnabled: boolean = false;
    private _urlSyncDebounceTimer: number | null = null;

    constructor() {
        // Root-level UI state
        this._state.focused_view = '';

        // Initialize with default editor state (flattened)
        this._state.editor_file = '';
        this._state.editor_text_buffer = 'Hamburgevons';
        this._state.editor_cursor_position = 0;
        this._state.editor_mode = 'text' as 'text' | 'edit';
        this._state.editor_glyph_stack = '';
        this._state.editor_harfbuzz_glyph_names = '';
        this._state.editor_harfbuzz_gids = '';
        this._state.editor_harfbuzz_dx = '';
        this._state.editor_harfbuzz_dy = '';
        this._state.editor_harfbuzz_ax = '';
        this._state.editor_harfbuzz_ay = '';
        this._state.editor_harfbuzz_cl = '';
        this._state.editor_isInterpolating = false;
        this._state.editor_isAnimating = false;
        this._state.editor_opentype_features_in_subset = {};
        this._state.editor_opentype_features_not_in_subset = {};
        this._state.editor_variation_location = {};
        this._state.editor_active_canvas_plugins = [];
        this._state.editor_line_height = DEFAULT_LINE_HEIGHT_PERCENT;
        this._state.editor_text_align = DEFAULT_TEXT_ALIGN;

        console.log('StateManager initialized');

        // Return a Proxy to intercept all property access
        return new Proxy(this, {
            get: (target, prop: string) => {
                // Allow access to methods and private properties
                if (
                    prop.startsWith('_') ||
                    typeof (target as any)[prop] === 'function'
                ) {
                    return (target as any)[prop];
                }
                // Return state values
                return target._state[prop];
            },
            set: (target, prop: string, value) => {
                // Don't track private properties or methods
                if (prop.startsWith('_')) {
                    (target as any)[prop] = value;
                    return true;
                }

                const oldValue = target._state[prop];

                // Only record if value actually changed
                if (oldValue === value) {
                    return true;
                }

                // Capture and clean stack trace
                const rawStack = new Error().stack || '';
                // Remove "Error" line and Proxy/StateManager internals
                const stack = rawStack
                    .split('\n')
                    .slice(1) // Remove "Error" line
                    .filter(
                        (line) =>
                            !line.includes('Proxy.set') &&
                            !line.includes('state-manager')
                    )
                    .join('\n');

                // Record the change
                const change: StateChange = {
                    timestamp: performance.now(),
                    key: prop,
                    oldValue: oldValue,
                    newValue: value,
                    stack: stack
                };

                target._history.push(change);
                target._state[prop] = value;

                // Map the stack later so historical records point to original
                // source without fetching source maps during startup.
                queueStackMapping(
                    change,
                    'Failed to source-map history stack:'
                );

                // Prune old history and events
                target._pruneHistory();

                // Sync to URL if enabled (debounced)
                if (target._urlSyncEnabled) {
                    target._syncToUrl();
                }

                console.log(`State changed: ${prop}`);

                return true;
            }
        });
    }

    private _pruneHistory(): void {
        const now = performance.now();
        const cutoff = now - HISTORY_RETENTION_MS;

        // Remove state changes older than retention window
        this._history = this._history.filter(
            (change) => change.timestamp >= cutoff
        );

        // Remove events older than retention window
        this._events = this._events.filter(
            (event) => event.timestamp >= cutoff
        );
    }

    private _syncToUrl(): void {
        // Debounce URL updates to avoid excessive history entries
        if (this._urlSyncDebounceTimer !== null) {
            clearTimeout(this._urlSyncDebounceTimer);
        }

        this._urlSyncDebounceTimer = window.setTimeout(() => {
            this._urlSyncDebounceTimer = null;
            this._performUrlSync();
        }, SYNC_DEBOUNCE_MS);
    }

    private _performUrlSync(): void {
        // Encode state to URL parameters (read from flat structure)
        const urlState: any = {};

        // File URI
        const fileUri = this._state.editor_file;
        if (fileUri) {
            urlState.file = fileUri;
        }

        // Text buffer (limit length)
        const textBuffer = this._state.editor_text_buffer;
        if (textBuffer && textBuffer.length < 200) {
            urlState.text = textBuffer;
        }

        // Cursor position
        urlState.cursor = this._state.editor_cursor_position;

        // Mode
        urlState.mode = this._state.editor_mode;

        // OpenType features (only active ones)
        const activeFeatures = Object.entries(
            this._state.editor_opentype_features_in_subset || {}
        )
            .filter(([tag, enabled]) => enabled)
            .map(([tag, _]) => tag);

        if (activeFeatures.length > 0) {
            urlState.features = encodeFeatures(activeFeatures);
        } else {
            urlState.features = null;
        }

        // Variation location
        const varLocation = this._state.editor_variation_location;
        if (varLocation && Object.keys(varLocation).length > 0) {
            urlState.location = encodeLocation(varLocation);
        } else {
            urlState.location = null;
        }

        const lineHeight = parseLineHeightPercent(
            this._state.editor_line_height
        );
        if (lineHeight !== null && lineHeight !== DEFAULT_LINE_HEIGHT_PERCENT) {
            urlState.lineheight = lineHeight;
        } else {
            urlState.lineheight = null;
        }

        const textAlign = this._state.editor_text_align;
        if (isTextAlign(textAlign) && textAlign !== DEFAULT_TEXT_ALIGN) {
            urlState.align = textAlign;
        } else {
            urlState.align = null;
        }

        updateUrlState(urlState);
    }

    /**
     * Enable URL synchronization
     */
    enableUrlSync(): void {
        this._urlSyncEnabled = true;
        console.log('URL sync enabled');
    }

    /**
     * Disable URL synchronization
     */
    disableUrlSync(): void {
        this._urlSyncEnabled = false;
        if (this._urlSyncDebounceTimer !== null) {
            clearTimeout(this._urlSyncDebounceTimer);
            this._urlSyncDebounceTimer = null;
        }
        console.log('URL sync disabled');
    }

    /**
     * Check if URL sync is enabled
     */
    isUrlSyncEnabled(): boolean {
        return this._urlSyncEnabled;
    }

    /**
     * Flush URL synchronization immediately using current StateManager state.
     * Useful when downstream consumers need the URL to be up to date in the
     * same task, for example before reloading linked windows.
     */
    syncUrlNow(): void {
        if (!this._urlSyncEnabled) {
            return;
        }

        if (this._urlSyncDebounceTimer !== null) {
            clearTimeout(this._urlSyncDebounceTimer);
            this._urlSyncDebounceTimer = null;
        }

        this._performUrlSync();
    }

    /**
     * Get a snapshot of current state and history
     */
    getStateSnapshot(): {
        state: Record<string, any>;
        history: StateChange[];
        events: StateEvent[];
    } {
        return {
            state: JSON.parse(JSON.stringify(this._state)), // Deep copy
            history: [...this._history], // Shallow copy is fine
            events: JSON.parse(JSON.stringify(this._events))
        };
    }

    /**
     * Get a snapshot with source-mapped stack traces
     * Use this for error reporting to get readable stacks
     */
    async getStateSnapshotMapped(): Promise<{
        state: Record<string, any>;
        history: StateChange[];
        events: StateEvent[];
    }> {
        const snapshot = this.getStateSnapshot();

        // Map all stack traces in parallel
        const mappedHistory = await Promise.all(
            snapshot.history.map(async (change) => ({
                ...change,
                stack: await mapStackTrace(change.stack)
            }))
        );

        return {
            state: snapshot.state,
            history: mappedHistory,
            events: snapshot.events
        };
    }

    /**
     * Capture error with full state and history
     */
    captureError(error: Error | any, actionContext?: string): ErrorReport {
        const report: ErrorReport = {
            error: {
                message: error?.message || String(error),
                stack: error?.stack || ''
            },
            timestamp: performance.now(),
            state: JSON.parse(JSON.stringify(this._state)),
            history: [...this._history],
            events: JSON.parse(JSON.stringify(this._events))
        };

        // Log the error report (will be source-mapped by browser devtools)
        console.error('[StateManager] Error captured:');
        console.error(JSON.stringify(report, null, 2));

        // Also log source-mapped version asynchronously
        this.captureErrorMapped(error, actionContext).then((mappedReport) => {
            console.error('[StateManager] Error captured (source-mapped):');
            console.error(JSON.stringify(mappedReport, null, 2));
        });

        return report;
    }

    /**
     * Capture error with source-mapped stack traces
     * Use this for sending error reports with readable stacks
     */
    async captureErrorMapped(
        error: Error | any,
        actionContext?: string
    ): Promise<ErrorReport> {
        const snapshot = await this.getStateSnapshotMapped();

        const report: ErrorReport = {
            error: {
                message: error?.message || String(error),
                stack: await mapStackTrace(error?.stack || '')
            },
            timestamp: performance.now(),
            state: snapshot.state,
            history: snapshot.history,
            events: snapshot.events
        };

        return report;
    }

    /**
     * Clear history (for testing/debugging)
     */
    clearHistory(): void {
        this._history = [];
        this._events = [];
        console.log('History cleared');
    }

    /**
     * Get history for a specific key or time range
     */
    getHistory(key?: string, since?: number): StateChange[] {
        let filtered = this._history;

        if (key) {
            filtered = filtered.filter((change) => change.key === key);
        }

        if (since) {
            filtered = filtered.filter((change) => change.timestamp >= since);
        }

        return filtered;
    }

    /**
     * Record a high-level event for debugging timelines
     */
    recordEvent(
        type: string,
        source: string,
        payload?: Record<string, any>
    ): void {
        const rawStack = new Error().stack || '';
        const stack = rawStack
            .split('\n')
            .slice(1)
            .filter(
                (line) =>
                    !line.includes('recordEvent') &&
                    !line.includes('state-manager')
            )
            .join('\n');

        const event: StateEvent = {
            timestamp: performance.now(),
            type,
            source,
            payload,
            stack
        };

        this._events.push(event);

        queueStackMapping(event, 'Failed to source-map event stack:');

        this._pruneHistory();
    }

    /**
     * Get event history for a specific event type or time range
     */
    getEventHistory(type?: string, since?: number): StateEvent[] {
        let filtered = this._events;

        if (type) {
            filtered = filtered.filter((event) => event.type === type);
        }

        if (since) {
            filtered = filtered.filter((event) => event.timestamp >= since);
        }

        return filtered;
    }

    /**
     * Export state and history as pretty JSON
     */
    exportJSON(): string {
        return JSON.stringify(this.getStateSnapshot(), null, 2);
    }

    /**
     * Export state and history with source-mapped stacks
     * Use this for error reporting
     */
    async exportJSONMapped(): Promise<string> {
        const snapshot = await this.getStateSnapshotMapped();
        return JSON.stringify(snapshot, null, 2);
    }

    /**
     * Get direct access to state (for reading, not mutation)
     */
    getState(): Record<string, any> {
        return this._state;
    }

    /**
     * Get direct access to history array
     */
    get history(): StateChange[] {
        return this._history;
    }

    /**
     * Get direct access to event history array
     */
    get events(): StateEvent[] {
        return this._events;
    }
}

// Export singleton instance creation helper
export function createStateManager(): StateManager {
    return new StateManager();
}

// Create singleton instance
const stateManager = new StateManager();

// Assign to window
(window as any).stateManager = stateManager;
(window as any).triggerRuntimeErrorForTesting = (message?: string) => {
    const errorMessage =
        message ||
        `Counterpunch runtime error test (${new Date().toISOString()})`;

    window.setTimeout(() => {
        throw new Error(errorMessage);
    }, 0);
};
(window as any).triggerUnhandledRejectionForTesting = (message?: string) => {
    const errorMessage =
        message ||
        `Counterpunch unhandled rejection test (${new Date().toISOString()})`;

    Promise.reject(new Error(errorMessage));
};

// Install global error handlers
window.addEventListener('error', async (event) => {
    const reason = event.error || event.message || 'Unknown window error';
    stateManager.captureError(reason, 'window.error');
    const payload = await buildErrorReportPayload(
        reason,
        'editor.window.error',
        'window.error'
    );

    void sendErrorReportToServer(payload);
});

window.addEventListener('unhandledrejection', async (event) => {
    const reason = event.reason || 'Unhandled promise rejection';

    stateManager.captureError(reason, 'window.unhandledrejection');
    const payload = await buildErrorReportPayload(
        reason,
        'editor.window.unhandledrejection',
        'window.unhandledrejection'
    );

    void sendErrorReportToServer(payload);
});

export default stateManager;
