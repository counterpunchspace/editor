/**
 * Split one Yjs update into several smaller updates.
 *
 * The room accepts at most MAX_YJS_PACKET_BYTES per transaction: the
 * validator and the compactor hold one transaction in memory next to a full
 * shard, so the limit is a memory budget, not a framing limit. An edit whose
 * update is larger (a pasted glyph with many outlines, a long feature file)
 * is sent as several transactions instead. Applied in order, the parts give
 * exactly the state of the original update: every struct of the original is
 * in exactly one part, in clock order, and the delete set travels last.
 *
 * Only Yjs update format v1 is handled, which is what the editor sends.
 */
import * as Y from 'yjs';
import { MAX_YJS_PACKET_BYTES } from './generated/collab-protocol-limits';

/**
 * Size the parts aim for. Half a packet leaves room in the room’s
 * uncompacted journal (its hard cap is about one packet) for the next part
 * while the previous ones are compacted.
 */
export const CLOUD_UPDATE_PART_TARGET_BYTES = Math.floor(
    MAX_YJS_PACKET_BYTES / 2
);
/**
 * Largest part. A single value that cannot be cut (a map entry, an embed)
 * may fill a part on its own up to this size.
 */
export const CLOUD_UPDATE_PART_MAX_BYTES = MAX_YJS_PACKET_BYTES - 1024;

type DecodedStruct = Y.Item | Y.GC | Y.Skip;

type StructPiece = {
    struct: DecodedStruct;
    /** First unit of the struct in this piece. */
    start: number;
    /** One past the last unit of the struct in this piece. */
    end: number;
    bytes: Uint8Array;
};

type DeleteRange = { client: number; clock: number; len: number };

type DecodedDeleteSet = {
    clients: Map<number, Array<{ clock: number; len: number }>>;
};

function writeVarUint(out: number[], value: number): void {
    let num = value;
    while (num > 0x7f) {
        out.push(0x80 | (num & 0x7f));
        num = Math.floor(num / 128);
    }
    out.push(num & 0x7f);
}

function varUintBytes(value: number): number[] {
    const out: number[] = [];
    writeVarUint(out, value);
    return out;
}

function structLength(struct: DecodedStruct): number {
    return struct.length;
}

function isSplittable(struct: DecodedStruct): boolean {
    if (!(struct instanceof Y.Item)) {
        // GC and Skip are a clock and a length; they never need cutting.
        return false;
    }
    const content = struct.content;
    // instanceof, not constructor names: the bundle minifies class names.
    return (
        content.getLength() > 1 &&
        (content instanceof Y.ContentString ||
            content instanceof Y.ContentAny ||
            content instanceof Y.ContentJSON ||
            content instanceof Y.ContentDeleted)
    );
}

/** A cut inside a string must not separate the halves of a surrogate pair. */
function safeCut(struct: DecodedStruct, start: number, cut: number): number {
    if (!(struct instanceof Y.Item)) {
        return cut;
    }
    const content = struct.content as { str?: unknown };
    if (typeof content.str !== 'string') {
        return cut;
    }
    const code = content.str.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) {
        return cut - 1 > start ? cut - 1 : cut + 1;
    }
    return cut;
}

function encodePiece(
    struct: DecodedStruct,
    start: number,
    end: number
): Uint8Array {
    const encoder = new Y.UpdateEncoderV1();
    const length = structLength(struct);
    if (struct instanceof Y.Item) {
        let item: Y.Item = struct;
        if (end < length) {
            const content = struct.content.copy();
            // splice keeps [0, end) in `content` and returns the rest.
            content.splice(end);
            item = new Y.Item(
                struct.id,
                null,
                struct.origin,
                null,
                struct.rightOrigin,
                struct.parent,
                struct.parentSub,
                content
            );
        }
        item.write(encoder, start);
    } else if (struct instanceof Y.GC) {
        new Y.GC(struct.id, end).write(encoder, start);
    } else {
        new Y.Skip(struct.id, end).write(encoder, start);
    }
    return encoder.toUint8Array();
}

/**
 * The longest piece of `struct` from `start` whose encoding fits in
 * `room` bytes, or null when not even one unit fits.
 */
function largestPieceThatFits(
    struct: DecodedStruct,
    start: number,
    room: number
): StructPiece | null {
    const length = structLength(struct);
    let low = start + 1;
    let high = length;
    let best: StructPiece | null = null;
    while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        const end = safeCut(struct, start, mid);
        if (end <= start || end > length) {
            high = mid - 1;
            continue;
        }
        const bytes = encodePiece(struct, start, end);
        if (bytes.byteLength <= room) {
            best = { struct, start, end, bytes };
            low = mid + 1;
        } else {
            high = mid - 1;
        }
    }
    return best;
}

/** Client header in a part: struct count, client id and first clock. */
function clientHeaderBytes(
    structCount: number,
    client: number,
    clock: number
): number {
    return (
        varUintBytes(structCount).length +
        varUintBytes(client).length +
        varUintBytes(clock).length
    );
}

const PART_HEADER_RESERVE = 32;

type PartBuilder = {
    groups: Array<{ client: number; pieces: StructPiece[] }>;
    bytes: number;
    deletes: DeleteRange[];
};

function newPart(): PartBuilder {
    return { groups: [], bytes: PART_HEADER_RESERVE, deletes: [] };
}

function deleteSetBytes(ranges: DeleteRange[]): number {
    const byClient = new Map<number, DeleteRange[]>();
    for (const range of ranges) {
        const list = byClient.get(range.client) || [];
        list.push(range);
        byClient.set(range.client, list);
    }
    let size = varUintBytes(byClient.size).length;
    for (const [client, list] of byClient) {
        size += varUintBytes(client).length + varUintBytes(list.length).length;
        for (const range of list) {
            size +=
                varUintBytes(range.clock).length +
                varUintBytes(range.len).length;
        }
    }
    return size;
}

function encodePart(part: PartBuilder): Uint8Array {
    const out: number[] = [];
    const groups = part.groups.filter((group) => group.pieces.length);
    writeVarUint(out, groups.length);
    const chunks: Uint8Array[] = [];
    let flushed = 0;
    const flush = () => {
        if (out.length > flushed) {
            chunks.push(Uint8Array.from(out.slice(flushed)));
            flushed = out.length;
        }
    };
    for (const group of groups) {
        const first = group.pieces[0];
        writeVarUint(out, group.pieces.length);
        writeVarUint(out, group.client);
        writeVarUint(out, first.struct.id.clock + first.start);
        flush();
        for (const piece of group.pieces) {
            chunks.push(piece.bytes);
        }
    }
    const byClient = new Map<number, DeleteRange[]>();
    for (const range of part.deletes) {
        const list = byClient.get(range.client) || [];
        list.push(range);
        byClient.set(range.client, list);
    }
    writeVarUint(out, byClient.size);
    for (const [client, list] of byClient) {
        writeVarUint(out, client);
        writeVarUint(out, list.length);
        for (const range of list) {
            writeVarUint(out, range.clock);
            writeVarUint(out, range.len);
        }
    }
    flush();
    const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const result = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return result;
}

export type SplitYjsUpdateOptions = {
    /** Size each part aims for. */
    targetBytes?: number;
    /** No part may be larger than this. */
    maxBytes?: number;
};

/**
 * Split `update` into parts of at most `maxBytes`, each aiming for
 * `targetBytes`. Returns `[update]` when it already fits, and null when one
 * value in it cannot be cut and alone exceeds `maxBytes`.
 */
export function splitYjsUpdate(
    update: Uint8Array,
    options: SplitYjsUpdateOptions = {}
): Uint8Array[] | null {
    const maxBytes = options.maxBytes ?? CLOUD_UPDATE_PART_MAX_BYTES;
    const targetBytes = Math.min(
        maxBytes,
        options.targetBytes ?? CLOUD_UPDATE_PART_TARGET_BYTES
    );
    if (update.byteLength <= maxBytes) {
        return [update];
    }
    let decoded: { structs: DecodedStruct[]; ds: DecodedDeleteSet };
    try {
        decoded = Y.decodeUpdate(update) as unknown as {
            structs: DecodedStruct[];
            ds: DecodedDeleteSet;
        };
    } catch {
        return null;
    }

    const parts: PartBuilder[] = [];
    let part = newPart();
    const startNewPart = () => {
        if (part.groups.some((group) => group.pieces.length)) {
            parts.push(part);
        }
        part = newPart();
    };
    const appendPiece = (piece: StructPiece) => {
        const client = piece.struct.id.client;
        let group = part.groups[part.groups.length - 1];
        if (!group || group.client !== client) {
            group = { client, pieces: [] };
            part.groups.push(group);
            part.bytes += clientHeaderBytes(
                1,
                client,
                piece.struct.id.clock + piece.start
            );
        }
        group.pieces.push(piece);
        part.bytes += piece.bytes.byteLength;
    };

    for (const struct of decoded.structs) {
        const length = structLength(struct);
        let start = 0;
        while (start < length) {
            const client = struct.id.client;
            const last = part.groups[part.groups.length - 1];
            const header =
                last && last.client === client
                    ? 0
                    : clientHeaderBytes(1, client, struct.id.clock + start) + 8;
            const room = targetBytes - part.bytes - header;
            const whole = encodePiece(struct, start, length);
            if (whole.byteLength <= room) {
                appendPiece({ struct, start, end: length, bytes: whole });
                start = length;
                continue;
            }
            if (isSplittable(struct)) {
                const piece =
                    room > 0 ? largestPieceThatFits(struct, start, room) : null;
                if (piece) {
                    appendPiece(piece);
                    start = piece.end;
                    startNewPart();
                    continue;
                }
                if (part.groups.length) {
                    startNewPart();
                    continue;
                }
                // An empty part and still not one unit fits the target: fall
                // back to the hard limit for this single unit.
                const unit = largestPieceThatFits(
                    struct,
                    start,
                    maxBytes - PART_HEADER_RESERVE - header
                );
                if (!unit) {
                    return null;
                }
                appendPiece(unit);
                start = unit.end;
                startNewPart();
                continue;
            }
            // A value that cannot be cut goes into a part of its own when it
            // does not fit next to what is already there.
            if (part.groups.length) {
                startNewPart();
                continue;
            }
            if (whole.byteLength + PART_HEADER_RESERVE + header > maxBytes) {
                return null;
            }
            appendPiece({ struct, start, end: length, bytes: whole });
            start = length;
            startNewPart();
        }
    }

    // Deletions go last, so every item they refer to has arrived.
    const ranges: DeleteRange[] = [];
    decoded.ds.clients.forEach(
        (items: Array<{ clock: number; len: number }>, client: number) => {
            for (const item of items) {
                ranges.push({ client, clock: item.clock, len: item.len });
            }
        }
    );
    let structBytes = part.bytes;
    for (const range of ranges) {
        const nonEmpty =
            part.deletes.length > 0 ||
            part.groups.some((group) => group.pieces.length);
        if (
            nonEmpty &&
            structBytes + deleteSetBytes([...part.deletes, range]) > targetBytes
        ) {
            parts.push(part);
            part = newPart();
            structBytes = part.bytes;
        }
        part.deletes.push(range);
    }
    if (
        part.groups.some((group) => group.pieces.length) ||
        part.deletes.length
    ) {
        parts.push(part);
    }

    const encoded = parts.map(encodePart);
    if (encoded.some((bytes) => bytes.byteLength > maxBytes)) {
        return null;
    }
    return encoded;
}

/**
 * The size the cloud packet limit judges an edit by: the update itself, or
 * when it has to be split, its largest part. An update that cannot be split
 * into parts that fit is judged by its full size.
 */
export function cloudPacketBytesForLimit(update: Uint8Array): number {
    if (update.byteLength < MAX_YJS_PACKET_BYTES) {
        return update.byteLength;
    }
    const parts = splitYjsUpdate(update);
    if (!parts) {
        return update.byteLength;
    }
    return parts.reduce((max, part) => Math.max(max, part.byteLength), 0);
}
