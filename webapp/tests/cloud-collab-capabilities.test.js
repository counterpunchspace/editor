const {
    missingRequiredCloudCapabilities,
    REQUIRED_CLOUD_COLLAB_CAPABILITIES,
    COLLAB_PROTOCOL_VERSION
} = require('../js/filesystem-plugins/cloud-collab-capabilities.ts');

describe('cloud collab capability negotiation', () => {
    test('accepts matching protocol version and rejects others', () => {
        expect(
            missingRequiredCloudCapabilities(REQUIRED_CLOUD_COLLAB_CAPABILITIES)
        ).toEqual([]);
        expect(
            missingRequiredCloudCapabilities(COLLAB_PROTOCOL_VERSION)
        ).toEqual([]);
        expect(missingRequiredCloudCapabilities(undefined)).toEqual([
            'protocolVersion'
        ]);
        expect(
            missingRequiredCloudCapabilities({ protocolVersion: 1 })
        ).toEqual(['protocolVersion']);
    });
});
