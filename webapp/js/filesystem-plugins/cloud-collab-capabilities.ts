export {
    missingRequiredCollabCapabilities as missingRequiredCloudCapabilities,
    COLLAB_PROTOCOL_VERSION
} from '../generated/collab-protocol-capabilities';
import { COLLAB_PROTOCOL_VERSION as PROTOCOL_VERSION } from '../generated/collab-protocol-capabilities';

/** Equality on COLLAB_PROTOCOL_VERSION replaces the old capability matrix. */
export const REQUIRED_CLOUD_COLLAB_CAPABILITIES = Object.freeze({
    protocolVersion: PROTOCOL_VERSION
});
