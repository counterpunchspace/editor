/**
 * Binary LIVE_UPDATE / sync-page frame encode+decode for CloudAdapter.
 */
import type { CollaborationMessageEnvelope } from './collaboration-message';
import { FRAME_TYPE } from './generated/collab-protocol-limits';

export function decodeCollabLiveFrames(bytes: Uint8Array): Array<{
    type: number;
    logId: number;
    payload: Uint8Array;
}> {
    const frames: Array<{
        type: number;
        logId: number;
        payload: Uint8Array;
    }> = [];
    let offset = 0;
    while (offset + 16 <= bytes.byteLength) {
        const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 16);
        const type = view.getUint32(0, false);
        const logHi = view.getUint32(4, false);
        const logLo = view.getUint32(8, false);
        const payloadLen = view.getUint32(12, false);
        const start = offset + 16;
        const end = start + payloadLen;
        if (end > bytes.byteLength) {
            break;
        }
        frames.push({
            type,
            logId: logHi * 0x100000000 + logLo,
            payload: bytes.subarray(start, end)
        });
        offset = end;
        if (type === 3) {
            break;
        }
    }
    return frames;
}

export function utf8Decode(bytes: Uint8Array): string {
    if (typeof TextDecoder === 'function') {
        try {
            return new TextDecoder().decode(bytes);
        } catch {
            /* fall through */
        }
    }
    return Array.from(bytes, (byte) => String.fromCharCode(byte)).join('');
}

export function decodeCheckpointMeta(payload: Uint8Array): {
    hasMore: boolean;
    throughLogId: number;
    lastLogId: number;
    collaborationMessageHistory: CollaborationMessageEnvelope[];
} {
    if (!payload.byteLength) {
        return {
            hasMore: false,
            throughLogId: 0,
            lastLogId: 0,
            collaborationMessageHistory: []
        };
    }
    try {
        const parsed = JSON.parse(utf8Decode(payload)) as {
            hasMore?: boolean;
            throughLogId?: number;
            lastLogId?: number;
            collaborationMessageHistory?: CollaborationMessageEnvelope[];
        };
        return {
            hasMore: parsed.hasMore === true,
            throughLogId: Number(parsed.throughLogId || 0),
            lastLogId: Number(parsed.lastLogId || 0),
            collaborationMessageHistory: Array.isArray(
                parsed.collaborationMessageHistory
            )
                ? parsed.collaborationMessageHistory
                : []
        };
    } catch {
        return {
            hasMore: false,
            throughLogId: 0,
            lastLogId: 0,
            collaborationMessageHistory: []
        };
    }
}

export function assembleTailTransactionsFromFrames(
    frames: Array<{ type: number; logId: number; payload: Uint8Array }>
): Uint8Array[] {
    const pending = new Map<
        string,
        { chunks: Array<Uint8Array | null>; received: number; total: number }
    >();
    const updates: Uint8Array[] = [];
    for (const frame of frames) {
        if (frame.type !== 2) {
            continue;
        }
        const view = new DataView(
            frame.payload.buffer,
            frame.payload.byteOffset,
            frame.payload.byteLength
        );
        if (frame.payload.byteLength < 12) {
            continue;
        }
        const chunkIndex = view.getUint32(0, false);
        const totalChunks = Math.max(1, view.getUint32(4, false));
        const txnLen = view.getUint32(8, false);
        const transactionId = utf8Decode(
            frame.payload.subarray(12, 12 + txnLen)
        );
        const blob = frame.payload.subarray(12 + txnLen);
        if (totalChunks <= 1) {
            updates.push(blob);
            continue;
        }
        const key = transactionId || String(frame.logId);
        let state = pending.get(key);
        if (!state) {
            state = {
                chunks: new Array(totalChunks).fill(null),
                received: 0,
                total: totalChunks
            };
            pending.set(key, state);
        }
        if (!state.chunks[chunkIndex]) {
            state.chunks[chunkIndex] = blob;
            state.received++;
        }
        if (state.received === state.total) {
            const totalLen = state.chunks.reduce(
                (sum, chunk) => sum + (chunk ? chunk.byteLength : 0),
                0
            );
            const combined = new Uint8Array(totalLen);
            let offset = 0;
            for (const chunk of state.chunks) {
                combined.set(chunk as Uint8Array, offset);
                offset += (chunk as Uint8Array).byteLength;
            }
            updates.push(combined);
            pending.delete(key);
        }
    }
    return updates;
}

export function decodeLiveUpdatePayload(payload: Uint8Array): {
    type: 'update';
    clientId: string;
    seq: number;
    update: Uint8Array;
    clientTransactionId: string | null;
    collaborationMessages: CollaborationMessageEnvelope[] | undefined;
} {
    const view = new DataView(
        payload.buffer,
        payload.byteOffset,
        payload.byteLength
    );
    const seq = view.getInt32(0, false);
    const clientIdLen = view.getUint32(4, false);
    const clientId = new TextDecoder().decode(
        payload.subarray(8, 8 + clientIdLen)
    );
    const updateLenOff = 8 + clientIdLen;
    const updateLen = view.getUint32(updateLenOff, false);
    const updateStart = updateLenOff + 4;
    const update = payload.subarray(updateStart, updateStart + updateLen);
    const extraLenOff = updateStart + updateLen;
    const extraLen = view.getUint32(extraLenOff, false);
    const extraBytes = payload.subarray(
        extraLenOff + 4,
        extraLenOff + 4 + extraLen
    );
    const extra = extraLen
        ? (JSON.parse(new TextDecoder().decode(extraBytes)) as Record<
              string,
              unknown
          >)
        : {};
    return {
        type: 'update',
        clientId,
        seq,
        update,
        clientTransactionId:
            typeof extra.clientTransactionId === 'string'
                ? extra.clientTransactionId
                : null,
        collaborationMessages: Array.isArray(extra.collaborationMessages)
            ? (extra.collaborationMessages as CollaborationMessageEnvelope[])
            : undefined
    };
}

export function encodeLiveUpdatePayload(fields: {
    clientId: string;
    seq: number;
    update: Uint8Array;
    clientTransactionId?: string | null;
    collaborationMessages?: CollaborationMessageEnvelope[] | null;
}): Uint8Array {
    const extra: Record<string, unknown> = {};
    if (fields.clientTransactionId) {
        extra.clientTransactionId = fields.clientTransactionId;
    }
    if (
        Array.isArray(fields.collaborationMessages) &&
        fields.collaborationMessages.length
    ) {
        extra.collaborationMessages = fields.collaborationMessages;
    }
    const utf8 = new TextEncoder();
    const clientIdBytes = utf8.encode(String(fields.clientId || ''));
    const extraBytes = Object.keys(extra).length
        ? utf8.encode(JSON.stringify(extra))
        : new Uint8Array(0);
    const body = fields.update || new Uint8Array();
    const out = new Uint8Array(
        16 + clientIdBytes.length + body.byteLength + extraBytes.length
    );
    const view = new DataView(out.buffer);
    view.setInt32(0, Number(fields.seq || 0), false);
    view.setUint32(4, clientIdBytes.length, false);
    out.set(clientIdBytes, 8);
    const updateLenOff = 8 + clientIdBytes.length;
    view.setUint32(updateLenOff, body.byteLength, false);
    out.set(body, updateLenOff + 4);
    const extraLenOff = updateLenOff + 4 + body.byteLength;
    view.setUint32(extraLenOff, extraBytes.length, false);
    out.set(extraBytes, extraLenOff + 4);
    return out;
}

/**
 * Wrap a LIVE_UPDATE payload in the room's length-prefixed binary frame:
 * [u32 type][u32 logId-hi][u32 logId-lo][u32 payloadLen][payload].
 * Client-originated updates carry logId 0; the room assigns the journal id.
 */
export function encodeLiveUpdateFrame(fields: {
    clientId: string;
    seq: number;
    update: Uint8Array;
    clientTransactionId?: string | null;
    collaborationMessages?: CollaborationMessageEnvelope[] | null;
}): Uint8Array {
    const payload = encodeLiveUpdatePayload(fields);
    const out = new Uint8Array(16 + payload.byteLength);
    const view = new DataView(out.buffer);
    view.setUint32(0, FRAME_TYPE.LIVE_UPDATE, false);
    view.setUint32(4, 0, false);
    view.setUint32(8, 0, false);
    view.setUint32(12, payload.byteLength, false);
    out.set(payload, 16);
    return out;
}
