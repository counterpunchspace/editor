/**
 * Before a font is uploaded to the cloud, every room it would use must fit
 * what the cloud can store and compact: at most MAX_SHARD_BYTES encoded and
 * MAX_COMPACTION_DECODED_STRUCTS Yjs structs. A font with a part that does
 * not fit is refused with a message that names the part.
 */
import * as Y from 'yjs';
import {
    MAX_COMPACTION_DECODED_STRUCTS,
    MAX_SHARD_BYTES
} from '../generated/collab-protocol-limits';
import { layoutDocumentKind } from './cloud-room-layout';

export type RoomFitProblem = {
    documentId: string;
    bytes: number;
    structs: number;
    message: string;
};

export type RoomFitLimits = { maxBytes: number; maxStructs: number };

export const CLOUD_ROOM_FIT_LIMITS: RoomFitLimits = {
    maxBytes: MAX_SHARD_BYTES,
    maxStructs: MAX_COMPACTION_DECODED_STRUCTS
};

function megabytes(bytes: number): string {
    return bytes < 1024 * 1024
        ? `${Math.max(1, Math.round(bytes / 1024))} KB`
        : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function describeRoom(
    documentId: string,
    glyphName: (documentId: string) => string | null
): string {
    switch (layoutDocumentKind(documentId)) {
        case 'glyph': {
            const name = glyphName(documentId);
            return name ? `The glyph “${name}”` : 'One of its glyphs';
        }
        case 'core':
            return 'Its general font data (font info, axes, masters, instances and glyph order)';
        case 'deps':
            return 'Its list of components and metrics keys';
        case 'features':
            return 'Its OpenType feature code';
        case 'catalog':
            return 'Its glyph list';
        case 'kerning':
            return 'Its kerning';
        default:
            return `Its part ${documentId}`;
    }
}

function adviceFor(documentId: string): string {
    switch (layoutDocumentKind(documentId)) {
        case 'glyph':
            return ' Simplify its outlines, or build it from components.';
        case 'features':
            return ' Move repeated code into lookups or classes.';
        case 'kerning':
            return ' Kerning groups need far fewer pairs than kerning between single glyphs.';
        case 'catalog':
            return ' Split the font into several fonts.';
        default:
            return '';
    }
}

/** Yjs structs in an encoded document, as the cloud's compactor counts them. */
export function countEncodedStructs(bytes: Uint8Array): number {
    return Y.decodeUpdate(bytes).structs.length;
}

/** The rooms of an upload that do not fit, each with a readable message. */
export function findRoomsThatDoNotFit(
    shards: Array<{ documentId: string; bytes: Uint8Array }>,
    options: {
        glyphName?: (documentId: string) => string | null;
        limits?: RoomFitLimits;
    } = {}
): RoomFitProblem[] {
    const limits = options.limits ?? CLOUD_ROOM_FIT_LIMITS;
    const glyphName = options.glyphName ?? (() => null);
    const problems: RoomFitProblem[] = [];
    for (const shard of shards) {
        const bytes = shard.bytes.byteLength;
        // Every struct takes at least one byte, so only a room with as many
        // bytes as the struct limit needs its structs counted.
        const structs =
            bytes >= limits.maxStructs ? countEncodedStructs(shard.bytes) : 0;
        const tooLarge = bytes > limits.maxBytes;
        const tooDetailed = structs > limits.maxStructs;
        if (!tooLarge && !tooDetailed) {
            continue;
        }
        const what = describeRoom(shard.documentId, glyphName);
        const measure = tooLarge
            ? `${megabytes(bytes)}, the limit is ${megabytes(limits.maxBytes)}`
            : `${structs.toLocaleString('en-US')} stored items, the limit is ${limits.maxStructs.toLocaleString('en-US')}`;
        problems.push({
            documentId: shard.documentId,
            bytes,
            structs,
            message: `${what} is too large for the cloud (${measure}).${adviceFor(shard.documentId)}`
        });
    }
    return problems;
}

/** One message for a refused upload, naming every part that does not fit. */
export function roomFitRefusalMessage(problems: RoomFitProblem[]): string {
    const shown = problems.slice(0, 5).map((problem) => problem.message);
    const more =
        problems.length > shown.length
            ? ` ${problems.length - shown.length} more parts are too large as well.`
            : '';
    return `This font can’t be saved to the cloud. ${shown.join(' ')}${more}`;
}
