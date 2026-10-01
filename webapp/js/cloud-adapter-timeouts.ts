// @ts-nocheck
/**
 * CloudAdapter auth / initial-sync / outbound-ACK timeout arms and handlers.
 */
import {
    AUTHENTICATION_MAX_WAIT_MS,
    AUTHENTICATION_TIMEOUT_MS,
    CLIENT_RECONNECT_CLOSE_CODE,
    INITIAL_SYNC_MAX_WAIT_MS,
    INITIAL_SYNC_TIMEOUT_MS,
    OUTBOUND_ACK_MAX_WAIT_MS,
    OUTBOUND_ACK_TIMEOUT_MS
} from './cloud-adapter-support';

export const cloudAdapterTimeoutMethods = {
    _armInitialSyncTimeout(
        startedAt = Date.now(),
        delayOverrideMs = INITIAL_SYNC_TIMEOUT_MS
    ): void {
        this._clearInitialSyncTimeout();
        this._initialSyncTimer = setTimeout(() => {
            this._initialSyncTimer = null;

            if (
                this._destroyed ||
                this._status !== 'syncing' ||
                !this._ws ||
                this._ws.readyState !== WebSocket.OPEN
            ) {
                return;
            }

            if (
                this._hasSynced &&
                this._initialServerStateApplied &&
                this._initialSyncDurable
            ) {
                return;
            }

            const syncAgeMs = Date.now() - startedAt;
            if (syncAgeMs < INITIAL_SYNC_MAX_WAIT_MS) {
                console.warn(
                    `CloudAdapter: initial sync still pending after ${syncAgeMs}ms; waiting before reconnect`
                );
                this._armInitialSyncTimeout(
                    startedAt,
                    INITIAL_SYNC_MAX_WAIT_MS - syncAgeMs
                );
                return;
            }

            this._handleInitialSyncTimeout();
        }, delayOverrideMs);
    },

    _clearInitialSyncTimeout(): void {
        if (this._initialSyncTimer !== null) {
            clearTimeout(this._initialSyncTimer);
            this._initialSyncTimer = null;
        }
    },

    _armOutboundAckTimeout(delayOverrideMs?: number): void {
        this._clearOutboundAckTimeout();
        const oldestPendingEntry = this._outboundAckSentAtBySeq
            .entries()
            .next().value;
        if (!oldestPendingEntry) {
            return;
        }

        const [seq, sentAt] = oldestPendingEntry as [number, number];
        const delayMs = Math.max(
            0,
            delayOverrideMs ?? OUTBOUND_ACK_TIMEOUT_MS - (Date.now() - sentAt)
        );
        this._outboundAckTimer = setTimeout(() => {
            this._outboundAckTimer = null;
            if (!this._outboundAckSentAtBySeq.has(seq)) {
                this._armOutboundAckTimeout();
                return;
            }
            this._handleOutboundAckTimeout(seq);
        }, delayMs);
    },

    _clearOutboundAckTimeout(): void {
        if (this._outboundAckTimer !== null) {
            clearTimeout(this._outboundAckTimer);
            this._outboundAckTimer = null;
        }
    },

    _handleInitialSyncTimeout(): void {
        if (
            this._destroyed ||
            this._status !== 'syncing' ||
            !this._ws ||
            this._ws.readyState !== WebSocket.OPEN
        ) {
            return;
        }

        if (
            this._hasSynced &&
            this._initialServerStateApplied &&
            this._initialSyncDurable
        ) {
            return;
        }

        const detail = !this._hasSynced
            ? 'Cloud initial sync timed out before server response'
            : !this._initialServerStateApplied
              ? 'Cloud initial sync timed out before applying server state'
              : 'Cloud initial sync durability ack timed out';
        console.warn(`CloudAdapter: ${detail}`);
        this._lastReconnectReason = 'sync-timeout';
        this._clearAuthenticationTimeout();
        this._clearInitialSyncTimeout();
        this._setStatus('connecting', detail);
        this._markVisibleRebaselineNeeded();
        this._resetBootstrapStateForReconnect();

        const ws = this._ws;
        if (ws) {
            this._ws = null;
            this._clientId = null;
            ws.close(CLIENT_RECONNECT_CLOSE_CODE, 'sync-timeout');
        }
        this._scheduleReconnect();
    },

    _handleOutboundAckTimeout(seq: number): void {
        if (
            this._destroyed ||
            !this._outboundAckSentAtBySeq.has(seq) ||
            (this._status !== 'connected' && this._status !== 'syncing')
        ) {
            this._armOutboundAckTimeout();
            return;
        }

        const sentAt = this._outboundAckSentAtBySeq.get(seq);
        if (typeof sentAt !== 'number') {
            this._armOutboundAckTimeout();
            return;
        }

        const ackAgeMs = Date.now() - sentAt;
        const inboundActivitySeen = this._lastInboundMessageAt > sentAt;
        const inboundQuietMs = inboundActivitySeen
            ? Date.now() - this._lastInboundMessageAt
            : Number.POSITIVE_INFINITY;
        if (
            inboundActivitySeen &&
            inboundQuietMs < OUTBOUND_ACK_TIMEOUT_MS &&
            ackAgeMs < OUTBOUND_ACK_MAX_WAIT_MS
        ) {
            const nextCheckDelayMs = Math.min(
                OUTBOUND_ACK_TIMEOUT_MS - inboundQuietMs,
                OUTBOUND_ACK_MAX_WAIT_MS - ackAgeMs
            );
            this._armOutboundAckTimeout(nextCheckDelayMs);
            return;
        }

        const detail = 'Cloud update acknowledgement timed out';
        console.warn(`CloudAdapter: ${detail}`);
        this._lastReconnectReason = 'ack-timeout';
        this._clearAuthenticationTimeout();
        this._clearOutboundAckTimeout();
        this._resetLiveAckTracking();
        this._requeueUnackedOutboxPackets();
        this._setStatus('connecting', detail);
        this._markVisibleRebaselineNeeded();
        this._resetBootstrapStateForReconnect();
        this._pendingInboundUpdates = [];
        this._inboundFlushScheduled = false;

        const ws = this._ws;
        if (ws) {
            this._ws = null;
            this._clientId = null;
            ws.close(CLIENT_RECONNECT_CLOSE_CODE, 'ack-timeout');
        }
        this._scheduleReconnect();
    },

    _armAuthenticationTimeout(
        ws: WebSocket,
        startedAt = Date.now(),
        delayOverrideMs = AUTHENTICATION_TIMEOUT_MS
    ): void {
        this._clearAuthenticationTimeout();
        this._authenticationStartedAt = startedAt;
        this._authenticationTimer = setTimeout(() => {
            if (
                this._destroyed ||
                this._ws !== ws ||
                this._status !== 'authenticating'
            ) {
                return;
            }

            const authAgeMs = Date.now() - startedAt;
            if (authAgeMs < AUTHENTICATION_MAX_WAIT_MS) {
                console.warn(
                    `CloudAdapter: authentication still pending after ${authAgeMs}ms; waiting before reconnect`
                );
                this._armAuthenticationTimeout(
                    ws,
                    startedAt,
                    AUTHENTICATION_MAX_WAIT_MS - authAgeMs
                );
                return;
            }

            const detail = 'Cloud room authentication timed out';
            console.warn(`CloudAdapter: ${detail}`);
            this._lastReconnectReason = 'auth-timeout';
            this._setStatus('connecting', detail);
            this._markVisibleRebaselineNeeded();
            this._resetBootstrapStateForReconnect();
            if (this._ws === ws) {
                // Do not wait for a possibly delayed close event before retrying.
                // Once auth has stalled, this socket is no longer the active path.
                this._ws = null;
                this._clientId = null;
            }
            ws.close(CLIENT_RECONNECT_CLOSE_CODE, 'auth-timeout');
            this._scheduleReconnect();
        }, delayOverrideMs);
    },

    _clearAuthenticationTimeout(): void {
        if (this._authenticationTimer !== null) {
            clearTimeout(this._authenticationTimer);
            this._authenticationTimer = null;
        }
        this._authenticationStartedAt = 0;
    }
};
