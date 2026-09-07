const {
    missingRequiredCloudCapabilities,
    REQUIRED_CLOUD_COLLAB_CAPABILITIES
} = require('../js/filesystem-plugins/cloud-collab-capabilities.ts');

describe('cloud collab capability negotiation', () => {
    test('accepts the current advertised set and rejects mixed versions', () => {
        expect(
            missingRequiredCloudCapabilities(REQUIRED_CLOUD_COLLAB_CAPABILITIES)
        ).toEqual([]);
        expect(missingRequiredCloudCapabilities(undefined)).toEqual(
            Object.keys(REQUIRED_CLOUD_COLLAB_CAPABILITIES)
        );
        expect(missingRequiredCloudCapabilities({ durableWal: 1 })).toEqual(
            Object.keys(REQUIRED_CLOUD_COLLAB_CAPABILITIES).filter(
                (name) => name !== 'durableWal'
            )
        );
    });
});
