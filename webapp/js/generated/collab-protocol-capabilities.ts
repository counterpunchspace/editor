/** GENERATED from collab/packages/protocol. Do not edit by hand. */

import { COLLAB_PROTOCOL_VERSION } from './collab-protocol-limits';

export { COLLAB_PROTOCOL_VERSION };

export const COLLAB_PROTOCOL_VERSION_HEADER = 'X-Collab-Protocol-Version';

/** @deprecated Prefer COLLAB_PROTOCOL_VERSION_HEADER. */
export const COLLAB_CAPABILITIES_HEADER = COLLAB_PROTOCOL_VERSION_HEADER;

export const MIXED_VERSION_DEPLOY_ORDER = Object.freeze([
    'website',
    'validator',
    'compactor',
    'room',
    'editor'
] as const);

export function advertisedCollabProtocolVersion(): number {
    return COLLAB_PROTOCOL_VERSION;
}

/** @deprecated Use advertisedCollabProtocolVersion. */
export function advertisedCollabCapabilities() {
    return { protocolVersion: COLLAB_PROTOCOL_VERSION };
}

export function missingRequiredCollabCapabilities(
    advertised: Record<string, unknown> | number | null | undefined
): string[] {
    const peer =
        typeof advertised === 'number'
            ? advertised
            : advertised && typeof advertised === 'object'
              ? Number(
                    (advertised as { protocolVersion?: unknown })
                        .protocolVersion
                )
              : NaN;
    return Number(peer) === Number(COLLAB_PROTOCOL_VERSION)
        ? []
        : ['protocolVersion'];
}
