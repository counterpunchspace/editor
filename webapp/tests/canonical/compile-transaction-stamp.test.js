const { PatchSyncEngine } = require('../../js/patch-sync-engine');

function makeFont() {
    return {
        upm: 1000,
        version: [1, 0],
        names: { familyName: 'TestFont' },
        axes: [],
        masters: [
            {
                name: 'Regular',
                id: 'master-regular',
                location: {},
                kerning: {}
            }
        ],
        glyphs: [
            {
                name: 'A',
                layers: [
                    {
                        id: 'layer-1',
                        width: 600,
                        shapes: [],
                        anchors: [],
                        guides: []
                    }
                ]
            }
        ]
    };
}

describe('beginTransaction compile stamp', () => {
    test('omitting the stamp throws before a packet is written', () => {
        const bridge = new PatchSyncEngine('stamp-required');
        bridge.initFromJson(makeFont());
        const emitted = [];
        bridge.onLocalUpdate(() => {
            emitted.push(true);
        });

        expect(() => bridge.beginTransaction('Drag point')).toThrow(
            /compileChangeSource/
        );
        bridge.endTransaction();
        expect(emitted).toEqual([]);
        expect(bridge.getChangeLog()).toEqual([]);
        bridge.destroy();
    });

    test('an explicit null edit type is stored and is not invented as change-bridge-local', () => {
        const bridge = new PatchSyncEngine('stamp-explicit');
        bridge.initFromJson(makeFont());
        let entries = [];
        bridge.onLocalUpdate((_update, _message, changeLogEntries) => {
            entries = changeLogEntries;
        });

        bridge.beginTransaction('Drag point', null, {
            compileChangeSource: 'mouse-drag-outline',
            compileEditType: null
        });
        bridge.recordChange(
            ['glyphs', 'A', 'layers', 'layer-1', 'width'],
            'width',
            600,
            640
        );
        bridge.endTransaction();

        expect(entries.length).toBeGreaterThan(0);
        expect(entries[0].compileChangeSource).toBe('mouse-drag-outline');
        expect(entries[0].compileEditType).toBeNull();
        bridge.destroy();
    });
});
