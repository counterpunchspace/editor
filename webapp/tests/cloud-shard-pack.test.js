const { TextDecoder, TextEncoder } = require('util');
global.TextDecoder = TextDecoder;
global.TextEncoder = TextEncoder;

const {
    createPackParser,
    encodePackBody,
    encodePackEndFrame,
    encodePackShardFrame,
    PACK_FRAME_TYPE,
    partitionPackItems
} = require('../js/filesystem-plugins/cloud-shard-pack.ts');

describe('cloud shard pack codec', () => {
    test('roundtrips a shard frame split across pushes', () => {
        const payload = new Uint8Array([9, 8, 7]);
        const body = encodePackBody([
            encodePackShardFrame('font-deps', payload),
            encodePackEndFrame(1)
        ]);
        const parser = createPackParser();
        const frames = [
            ...parser.push(body.subarray(0, 6)),
            ...parser.push(body.subarray(6))
        ];
        parser.finish();
        expect(frames[0].type).toBe(PACK_FRAME_TYPE.SHARD);
        expect(frames[0].shardId).toBe('font-deps');
        expect([...frames[0].payload]).toEqual([9, 8, 7]);
        expect(frames[1].type).toBe(PACK_FRAME_TYPE.END);
    });

    test('partitionPackItems respects the item cap', () => {
        const batches = partitionPackItems([1, 2, 3, 4], () => 1, 3, 1000);
        expect(batches).toEqual([[1, 2, 3], [4]]);
    });
});
