import { isExactDurableAck } from './cloud-durability-contract';

export function ackIsDurable(
    msg: Record<string, unknown>,
    pendingIds: string[],
    seq: number
): boolean {
    if (msg.durable !== true) {
        return false;
    }
    if (!pendingIds.length) {
        return true;
    }
    return pendingIds.some((clientTransactionId) =>
        isExactDurableAck(msg, {
            clientTransactionId,
            seq: msg.phase === 'sync-complete' ? undefined : seq
        })
    );
}
