/** GENERATED from collab/packages/protocol. Do not edit by hand. */
// @ts-nocheck

import { timingSafeEqualString } from './collab-protocol-timing-safe';

export const PACK_SEED_GRANT_OPERATION = 'pack-seed';
export const PACK_SEED_GRANT_TTL_MS = 120_000;

export function canonicalizePackSeedGrant(payload) {
    const shardIds = Array.isArray(payload?.shardIds)
        ? [...payload.shardIds].map((id) => String(id)).sort()
        : [];
    return JSON.stringify({
        assetId: String(payload?.assetId || ''),
        operation: String(payload?.operation || PACK_SEED_GRANT_OPERATION),
        shardIds,
        issuedAt: Number(payload?.issuedAt || 0),
        expiresAt: Number(payload?.expiresAt || 0),
        writesAllowed: payload?.writesAllowed === true
    });
}

export async function hmacSha256Hex(secret, message) {
    const key = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(String(secret || '')),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
    );
    const signature = await crypto.subtle.sign(
        'HMAC',
        key,
        new TextEncoder().encode(String(message || ''))
    );
    return Array.from(new Uint8Array(signature), (byte) =>
        byte.toString(16).padStart(2, '0')
    ).join('');
}

function hexToBytes(hex) {
    const normalized = String(hex || '').toLowerCase();
    if (!/^[0-9a-f]*$/.test(normalized) || normalized.length % 2 !== 0) {
        return null;
    }
    const bytes = new Uint8Array(normalized.length / 2);
    for (let i = 0; i < bytes.length; i += 1) {
        bytes[i] = Number.parseInt(normalized.slice(i * 2, i * 2 + 2), 16);
    }
    return bytes;
}

function timingSafeEqualHex(left, right) {
    const leftBytes = hexToBytes(left);
    const rightBytes = hexToBytes(right);
    if (!leftBytes || !rightBytes || leftBytes.length !== rightBytes.length) {
        return false;
    }
    let different = 0;
    for (let i = 0; i < leftBytes.length; i += 1) {
        different |= leftBytes[i] ^ rightBytes[i];
    }
    return different === 0;
}

export async function signPackSeedGrant(payload, secret) {
    return hmacSha256Hex(secret, canonicalizePackSeedGrant(payload));
}

export async function verifyPackSeedGrant(grant, secret, expected = {}) {
    if (!grant || typeof grant !== 'object') {
        return false;
    }
    const signature = String(grant.signature || '');
    if (!signature || !secret) {
        return false;
    }
    const expectedSignature = await signPackSeedGrant(grant, secret);
    if (!timingSafeEqualHex(signature, expectedSignature)) {
        return false;
    }
    if (!timingSafeEqualString(grant.operation, PACK_SEED_GRANT_OPERATION)) {
        return false;
    }
    if (Number(grant.expiresAt || 0) <= Date.now()) {
        return false;
    }
    if (expected.assetId && grant.assetId !== expected.assetId) {
        return false;
    }
    const granted = new Set(
        Array.isArray(grant.shardIds)
            ? grant.shardIds.map((id) => String(id))
            : []
    );
    const required = Array.isArray(expected.shardIds) ? expected.shardIds : [];
    return required.every((shardId) => granted.has(String(shardId)));
}

export async function createSignedPackSeedGrant({
    assetId,
    shardIds,
    writesAllowed,
    secret,
    now = Date.now(),
    ttlMs = PACK_SEED_GRANT_TTL_MS
}) {
    const payload = {
        assetId,
        operation: PACK_SEED_GRANT_OPERATION,
        shardIds: [...new Set((shardIds || []).map((id) => String(id)))].sort(),
        issuedAt: now,
        expiresAt: now + ttlMs,
        writesAllowed: writesAllowed === true
    };
    return {
        ...payload,
        signature: await signPackSeedGrant(payload, secret)
    };
}
