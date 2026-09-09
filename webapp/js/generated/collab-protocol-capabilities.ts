/** GENERATED from collab/packages/protocol/src/capabilities.js. Do not edit by hand. */

export const COLLAB_CAPABILITIES = Object.freeze({
    durableWal: 1,
    certifiedGeneration: 1,
    packetEnvelope: 1,
    glyphTombstones: 1,
    glyphQuotaReservation: 1,
    writeReceipts: 1,
    dualDigests: 1
});

export const COLLAB_CAPABILITIES_HEADER = 'X-Collab-Capabilities';

export const MIXED_VERSION_DEPLOY_ORDER = Object.freeze([
    'website',
    'validator',
    'compactor',
    'room',
    'editor'
]);

export function advertisedCollabCapabilities() {
    return { ...COLLAB_CAPABILITIES };
}

export function missingRequiredCollabCapabilities(
    advertised: Record<string, unknown> | null | undefined
): string[] {
    const source =
        advertised && typeof advertised === 'object' ? advertised : {};
    return Object.entries(COLLAB_CAPABILITIES)
        .filter(([name, version]) => Number(source[name]) !== Number(version))
        .map(([name]) => name);
}
