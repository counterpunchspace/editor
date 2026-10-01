// @ts-nocheck
/**
 * CloudAdapter ping / liveness / reconnect-timer helpers.
 * Installed onto CloudAdapter.prototype from cloud-adapter.ts.
 */
import {
    CLIENT_RECONNECT_CLOSE_CODE,
    CLOUD_LIVENESS_STALE_MS,
    CLOUD_PING_INTERVAL_MS
} from './cloud-adapter-support';

export const cloudAdapterLivenessMethods = {
    _startLiveness(): void {
        this._stopLiveness();
        if (this._destroyed || !this._ws) {
            return;
        }
        this._pingTimer = setInterval(() => {
            this._sendPing();
        }, CLOUD_PING_INTERVAL_MS);
        this._livenessTimer = setInterval(() => {
            this._checkLiveness();
        }, CLOUD_PING_INTERVAL_MS);
    },

    _stopLiveness(): void {
        if (this._pingTimer !== null) {
            clearInterval(this._pingTimer);
            this._pingTimer = null;
        }
        if (this._livenessTimer !== null) {
            clearInterval(this._livenessTimer);
            this._livenessTimer = null;
        }
    },

    _sendPing(): void {
        const ws = this._ws;
        const openReadyState =
            typeof WebSocket !== 'undefined' &&
            typeof WebSocket.OPEN === 'number'
                ? WebSocket.OPEN
                : 1;
        if (!ws || ws.readyState !== openReadyState) {
            return;
        }
        try {
            ws.send(JSON.stringify({ type: 'ping', sentAt: Date.now() }));
        } catch (error) {
            console.warn('CloudAdapter: ping failed', error);
        }
    },

    _checkLiveness(): void {
        if (this._destroyed || !this._ws || !this._lastInboundMessageAt) {
            return;
        }
        const inboundAgeMs = Date.now() - this._lastInboundMessageAt;
        if (inboundAgeMs < CLOUD_LIVENESS_STALE_MS) {
            return;
        }
        this._livenessTimeoutCount += 1;
        this._lastReconnectReason = 'liveness-timeout';
        console.warn(
            `CloudAdapter: liveness timeout after ${inboundAgeMs}ms without inbound traffic`
        );
        const ws = this._ws;
        this._ws = null;
        this._clientId = null;
        this._markVisibleRebaselineNeeded();
        this._resetBootstrapStateForReconnect();
        this._setStatus('connecting', 'Cloud connection timed out');
        ws.close(CLIENT_RECONNECT_CLOSE_CODE, 'liveness-timeout');
        this._scheduleReconnect();
    },

    _clearReconnectTimer(): void {
        if (this._reconnectTimer !== null) {
            clearTimeout(this._reconnectTimer);
            this._reconnectTimer = null;
        }
    }
};
