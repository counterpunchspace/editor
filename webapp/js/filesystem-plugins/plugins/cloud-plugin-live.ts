// @ts-nocheck
/** CloudPlugin live connect / disconnect. */

export const cloudPluginLiveMethods = {
    async connectToRoom(assetId: string): Promise<void> {
        const bridge = window.patchSyncEngine;
        this._disconnectCurrent();
        this._activeAssetId = assetId;
        void this._fetchAssetLimits(assetId);

        if (!bridge) {
            console.error('No patchSyncEngine available — load a font first');
            this._updateConnectionStatus(
                assetId,
                'error',
                'Cloud bridge not ready'
            );
            return;
        }

        const { token, roomUrl, generationId } =
            await this._fetchRoomToken(assetId);
        console.log(`Connecting to room: ${assetId}`);
        await this._attachLiveSession({
            assetId,
            token,
            roomUrl,
            bridge,
            bootstrapMode: 'required',
            generationId
        });
    },

    /**
     * Dev-only: Connect directly with a pre-built token and room URL,
     * bypassing the website auth endpoint.
     */ async connectToRoomWithToken(
        assetId: string,
        token: string,
        roomUrl: string
    ): Promise<void> {
        const hostname =
            typeof location !== 'undefined' ? location.hostname : '';
        if (hostname !== 'localhost' && hostname !== '127.0.0.1') {
            throw new Error('Direct room-token connections are disabled');
        }
        const bridge = window.patchSyncEngine;
        this._disconnectCurrent();
        this._activeAssetId = assetId;

        if (!bridge) {
            console.error('No patchSyncEngine available — load a font first');
            this._updateConnectionStatus(
                assetId,
                'error',
                'Cloud bridge not ready'
            );
            return;
        }

        console.log(`Connecting directly to room: ${assetId}`);
        await this._attachLiveSession({
            assetId,
            token,
            roomUrl,
            bridge,
            bootstrapMode: 'required'
        });
    },
    disconnectFromRoom(): void {
        this._disconnectCurrent();
    }
};
