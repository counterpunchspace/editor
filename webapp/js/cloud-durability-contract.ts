/** Browser copy of collab/packages/protocol/src/durability-contract.js. */

export function allocateClientTransactionId(prefix = 'txn'): string {
    if (
        typeof crypto !== 'undefined' &&
        typeof crypto.randomUUID === 'function'
    ) {
        return `${prefix}:${crypto.randomUUID()}`;
    }
    return `${prefix}:${Date.now().toString(16)}`;
}

export function createMutationIdentity({
    clientId,
    clientTransactionId,
    clientSequence
}: {
    clientId?: string | null;
    clientTransactionId?: string | null;
    clientSequence?: number | null;
} = {}): {
    clientId: string;
    clientTransactionId: string;
    clientSequence: number;
} | null {
    const resolvedClientId = String(clientId || '').trim();
    const resolvedTransactionId = String(clientTransactionId || '').trim();
    const resolvedSequence = Number.isInteger(clientSequence)
        ? (clientSequence as number)
        : null;
    if (
        !resolvedClientId ||
        !resolvedTransactionId ||
        resolvedSequence === null ||
        resolvedSequence < 0
    ) {
        return null;
    }
    return {
        clientId: resolvedClientId,
        clientTransactionId: resolvedTransactionId,
        clientSequence: resolvedSequence
    };
}

export function createGenerationIdentity({
    generationId,
    parentGenerationId = null,
    schemaVersion = null
}: {
    generationId?: string | null;
    parentGenerationId?: string | null;
    schemaVersion?: number | null;
} = {}): {
    generationId: string;
    parentGenerationId: string | null;
    schemaVersion: number | null;
} | null {
    const resolvedGenerationId = String(generationId || '').trim();
    if (!resolvedGenerationId) {
        return null;
    }
    return {
        generationId: resolvedGenerationId,
        parentGenerationId: parentGenerationId
            ? String(parentGenerationId).trim() || null
            : null,
        schemaVersion:
            Number.isInteger(schemaVersion) && (schemaVersion as number) > 0
                ? (schemaVersion as number)
                : null
    };
}

export function isExactDurableAck(
    payload: Record<string, unknown> | null | undefined,
    expected: {
        clientTransactionId?: string | null;
        clientSequence?: number | null;
        seq?: number | null;
        generationId?: string | null;
        lastLogId?: number | null;
    } = {}
): boolean {
    if (!payload || typeof payload !== 'object') {
        return false;
    }
    if (payload.durable !== true) {
        return false;
    }
    if (payload.ok === false) {
        return false;
    }
    if (payload.type && payload.type !== 'ack') {
        return false;
    }
    const expectedTransactionId = String(
        expected.clientTransactionId || ''
    ).trim();
    const actualTransactionId = String(
        payload.clientTransactionId || ''
    ).trim();
    if (!actualTransactionId) {
        return false;
    }
    if (
        expectedTransactionId &&
        actualTransactionId !== expectedTransactionId
    ) {
        return false;
    }
    if (expected.generationId) {
        if (
            String(payload.generationId || '') !== String(expected.generationId)
        ) {
            return false;
        }
    }
    if (payload.phase === 'sync-complete') {
        return true;
    }
    const expectedSeq = Number.isInteger(expected.clientSequence)
        ? expected.clientSequence
        : Number.isInteger(expected.seq)
          ? expected.seq
          : null;
    if (expectedSeq !== null && Number(payload.seq) !== expectedSeq) {
        return false;
    }
    if (
        Number.isInteger(expected.lastLogId) &&
        Number(payload.lastLogId) !== Number(expected.lastLogId)
    ) {
        return false;
    }
    return true;
}
