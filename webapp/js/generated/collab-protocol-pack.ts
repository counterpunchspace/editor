/** GENERATED from collab/packages/protocol. Do not edit by hand. */
// @ts-nocheck

/**
 * Streamed shard pack: transport-only multiplexing of per-shard payloads.
 * Magic "CPK1", then frames. One shard is buffered at a time; the whole pack
 * is not assembled in the Worker.
 *
 * Frame:
 *   u8  type
 *   u8  flags (bit 0 = missing)
 *   u16 shardIdLen
 *   u32 payloadLen
 *   shardId utf8
 *   32-byte SHA-256 (zeros if unknown / missing)
 *   payload
 */

import { MAX_SHARD_BYTES } from "./collab-protocol-limits";

export const PACK_MAGIC = new Uint8Array([0x43, 0x50, 0x4b, 0x31]);
export const PACK_CONTENT_TYPE = "application/vnd.counterpunch.shard-pack";
export const PACK_MAX_SHARDS = 128;
export const PACK_MAX_BYTES = 48 * 1024 * 1024;
export const PACK_DIGEST_BYTES = 32;
export const PACK_MAX_SHARD_ID_BYTES = 256;

export const PACK_FRAME_TYPE = {
  SHARD: 1,
  RECEIPT: 2,
  ERROR: 3,
  END: 4,
};

const utf8 = new TextEncoder();
const utf8Decoder = new TextDecoder();

export function concatBytes(chunks) {
  let total = 0;
  for (const chunk of chunks) {
    total += chunk.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export function hexToBytes(hex) {
  const value = String(hex || "");
  if (!value || value.length % 2 !== 0) {
    return new Uint8Array(PACK_DIGEST_BYTES);
  }
  const out = new Uint8Array(value.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function bytesToHex(bytes) {
  return Array.from(bytes || [], (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function encodePackFrame({
  type,
  shardId = "",
  payload = new Uint8Array(),
  digest = new Uint8Array(PACK_DIGEST_BYTES),
  missing = false,
}) {
  const idBytes = utf8.encode(String(shardId || ""));
  if (idBytes.byteLength > PACK_MAX_SHARD_ID_BYTES) {
    throw new Error("pack shard id too long");
  }
  const body = payload instanceof Uint8Array ? payload : new Uint8Array();
  if (body.byteLength > MAX_SHARD_BYTES && type === PACK_FRAME_TYPE.SHARD) {
    throw new Error("pack shard payload exceeds MAX_SHARD_BYTES");
  }
  const digestBytes =
    digest instanceof Uint8Array && digest.byteLength === PACK_DIGEST_BYTES
      ? digest
      : hexToBytes(typeof digest === "string" ? digest : "");
  const header = new Uint8Array(
    8 + idBytes.byteLength + PACK_DIGEST_BYTES + body.byteLength,
  );
  const view = new DataView(header.buffer);
  view.setUint8(0, type);
  view.setUint8(1, missing ? 1 : 0);
  view.setUint16(2, idBytes.byteLength, false);
  view.setUint32(4, body.byteLength, false);
  header.set(idBytes, 8);
  header.set(digestBytes, 8 + idBytes.byteLength);
  header.set(body, 8 + idBytes.byteLength + PACK_DIGEST_BYTES);
  return header;
}

export function encodePackShardFrame(shardId, payload, digest) {
  return encodePackFrame({
    type: PACK_FRAME_TYPE.SHARD,
    shardId,
    payload,
    digest,
  });
}

export function encodePackMissingFrame(shardId) {
  return encodePackFrame({
    type: PACK_FRAME_TYPE.SHARD,
    shardId,
    missing: true,
  });
}

export function encodePackReceiptFrame(receipt) {
  return encodePackFrame({
    type: PACK_FRAME_TYPE.RECEIPT,
    shardId: receipt?.shardId || "",
    payload: utf8.encode(JSON.stringify(receipt || {})),
    digest: hexToBytes(receipt?.checkpointSha256 || receipt?.snapshotSha256 || ""),
  });
}

export function encodePackErrorFrame(error) {
  return encodePackFrame({
    type: PACK_FRAME_TYPE.ERROR,
    shardId: error?.shardId || "",
    payload: utf8.encode(JSON.stringify(error || { error: "pack error" })),
  });
}

export function encodePackEndFrame(count = 0) {
  const payload = new Uint8Array(4);
  new DataView(payload.buffer).setUint32(0, Number(count) || 0, false);
  return encodePackFrame({
    type: PACK_FRAME_TYPE.END,
    payload,
  });
}

export function encodePackBody(frames) {
  const hasEnd = frames.some((frame) => {
    if (!(frame instanceof Uint8Array) || frame.byteLength < 1) {
      return false;
    }
    return frame[0] === PACK_FRAME_TYPE.END;
  });
  const shardCount = frames.filter((frame) => {
    if (!(frame instanceof Uint8Array) || frame.byteLength < 1) {
      return false;
    }
    return frame[0] === PACK_FRAME_TYPE.SHARD;
  }).length;
  const encoded = hasEnd
    ? frames
    : [...frames, encodePackEndFrame(shardCount)];
  return concatBytes([PACK_MAGIC, ...encoded]);
}

export function createPackParser() {
  let buffer = new Uint8Array(0);
  let sawMagic = false;
  let sawEnd = false;
  let sawError = false;

  function take(n) {
    if (buffer.byteLength < n) {
      return null;
    }
    const slice = buffer.subarray(0, n);
    buffer = buffer.subarray(n);
    return slice;
  }

  return {
    push(chunk) {
      if (!chunk?.byteLength) {
        return [];
      }
      buffer = concatBytes([buffer, chunk]);
      const frames = [];
      if (!sawMagic) {
        if (buffer.byteLength < PACK_MAGIC.byteLength) {
          return frames;
        }
        const magic = take(PACK_MAGIC.byteLength);
        if (
          !magic ||
          magic[0] !== PACK_MAGIC[0] ||
          magic[1] !== PACK_MAGIC[1] ||
          magic[2] !== PACK_MAGIC[2] ||
          magic[3] !== PACK_MAGIC[3]
        ) {
          throw new Error("invalid shard pack magic");
        }
        sawMagic = true;
      }
      while (buffer.byteLength >= 8) {
        const view = new DataView(buffer.buffer, buffer.byteOffset, 8);
        const type = view.getUint8(0);
        const flags = view.getUint8(1);
        const idLen = view.getUint16(2, false);
        const payloadLen = view.getUint32(4, false);
        if (idLen > PACK_MAX_SHARD_ID_BYTES) {
          throw new Error("pack shard id too long");
        }
        if (payloadLen > MAX_SHARD_BYTES && type === PACK_FRAME_TYPE.SHARD) {
          throw new Error("pack shard payload exceeds MAX_SHARD_BYTES");
        }
        const frameLen = 8 + idLen + PACK_DIGEST_BYTES + payloadLen;
        if (buffer.byteLength < frameLen) {
          break;
        }
        const raw = take(frameLen);
        const shardId = utf8Decoder.decode(raw.subarray(8, 8 + idLen));
        const digest = raw.subarray(8 + idLen, 8 + idLen + PACK_DIGEST_BYTES);
        const payload = raw.subarray(8 + idLen + PACK_DIGEST_BYTES);
        let receipt = null;
        if (type === PACK_FRAME_TYPE.RECEIPT || type === PACK_FRAME_TYPE.ERROR) {
          try {
            receipt = JSON.parse(utf8Decoder.decode(payload));
          } catch {
            receipt = null;
          }
        }
        frames.push({
          type,
          missing: (flags & 1) === 1,
          shardId,
          digest,
          digestHex: bytesToHex(digest),
          payload,
          receipt,
          count:
            type === PACK_FRAME_TYPE.END && payload.byteLength >= 4
              ? new DataView(
                  payload.buffer,
                  payload.byteOffset,
                  payload.byteLength,
                ).getUint32(0, false)
              : 0,
        });
        if (type === PACK_FRAME_TYPE.END) {
          sawEnd = true;
        }
        if (type === PACK_FRAME_TYPE.ERROR) {
          sawError = true;
        }
      }
      return frames;
    },
    finish() {
      if (buffer.byteLength > 0) {
        throw new Error("truncated shard pack");
      }
      if (!sawMagic) {
        throw new Error("empty shard pack");
      }
      if (!sawEnd && !sawError) {
        throw new Error("shard pack missing END");
      }
    },
  };
}

export async function readPackStream(stream, onFrame) {
  const parser = createPackParser();
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (value) {
        const frames = parser.push(value instanceof Uint8Array ? value : new Uint8Array(value));
        for (const frame of frames) {
          await onFrame(frame);
        }
      }
      if (done) {
        break;
      }
    }
    parser.finish();
  } finally {
    reader.releaseLock();
  }
}

export function partitionPackItems(items, byteLengthOf, maxItems = PACK_MAX_SHARDS, maxBytes = PACK_MAX_BYTES) {
  const batches = [];
  let current = [];
  let bytes = 0;
  for (const item of items) {
    const size = byteLengthOf(item);
    if (
      current.length &&
      (current.length >= maxItems || bytes + size > maxBytes)
    ) {
      batches.push(current);
      current = [];
      bytes = 0;
    }
    current.push(item);
    bytes += size;
  }
  if (current.length) {
    batches.push(current);
  }
  return batches;
}
