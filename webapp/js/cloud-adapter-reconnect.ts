export type CloudReconnectBootstrapState = {
    hasSynced: boolean;
    initialServerStateApplied: boolean;
    initialSyncDurable: boolean;
    lastInboundMessageAt: number;
    outboxNeedsServerRetarget: boolean;
};

export function createReconnectBootstrapState(): CloudReconnectBootstrapState {
    return {
        hasSynced: false,
        initialServerStateApplied: false,
        initialSyncDurable: false,
        lastInboundMessageAt: 0,
        outboxNeedsServerRetarget: true
    };
}
