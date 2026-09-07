export const REQUIRED_CLOUD_COLLAB_CAPABILITIES = Object.freeze({
    durableWal: 1,
    certifiedGeneration: 1,
    packetEnvelope: 1,
    glyphTombstones: 1,
    glyphQuotaReservation: 1
});

export function missingRequiredCloudCapabilities(
    advertised: Record<string, unknown> | null | undefined
): string[] {
    const source =
        advertised && typeof advertised === 'object' ? advertised : {};
    return Object.entries(REQUIRED_CLOUD_COLLAB_CAPABILITIES)
        .filter(([name, version]) => Number(source[name]) !== Number(version))
        .map(([name]) => name);
}
