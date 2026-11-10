const {
    ArrowAdjustableTextInput
} = require('../js/arrow-adjustable-text-input');

describe('ArrowAdjustableTextInput edit bursts', () => {
    const originalEngine = window.patchSyncEngine;
    let burstKeys;

    beforeEach(() => {
        burstKeys = [];
        window.patchSyncEngine = {
            runInEditBurst: jest.fn((key, fn) => {
                burstKeys.push(key);
                return fn();
            })
        };
    });

    afterEach(() => {
        window.patchSyncEngine = originalEngine;
    });

    const makeField = (options = {}) => {
        const input = document.createElement('input');
        input.dataset.propertyField = 'anchor-x';
        input.value = '10';
        const applied = [];
        new ArrowAdjustableTextInput({
            input,
            getValue: () => Number(input.value),
            applyValue: (value) => {
                applied.push(value);
            },
            ...options
        });
        return { input, applied };
    };
    const press = async (input, key = 'ArrowUp') => {
        input.dispatchEvent(new KeyboardEvent('keydown', { key }));
        await Promise.resolve();
    };

    it('runs every step as a tick of one burst named by field and scope', async () => {
        const { input, applied } = makeField({ burstScope: () => 'layer-1' });

        await press(input);
        await press(input);

        expect(applied).toEqual([11, 12]);
        expect(burstKeys).toEqual([
            'arrow-field:anchor-x:layer-1',
            'arrow-field:anchor-x:layer-1'
        ]);
    });

    it('names a different burst for a different target', async () => {
        let layerId = 'layer-1';
        const { input } = makeField({ burstScope: () => layerId });

        await press(input);
        layerId = 'layer-2';
        await press(input);

        expect(new Set(burstKeys).size).toBe(2);
    });

    it('leaves the burst to a field whose write runs its own', async () => {
        const { input, applied } = makeField({ burstScope: false });

        await press(input, 'ArrowDown');

        expect(applied).toEqual([9]);
        expect(window.patchSyncEngine.runInEditBurst).not.toHaveBeenCalled();
    });
});
