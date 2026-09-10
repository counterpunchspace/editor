const { TextDecoder, TextEncoder } = require('util');
global.TextDecoder = TextDecoder;
global.TextEncoder = TextEncoder;

const {
    PACK_MAGIC,
    concatBytes,
    createPackParser,
    encodePackBody,
    encodePackEndFrame,
    encodePackErrorFrame,
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

    test('encodePackBody appends END when the caller omits it', () => {
        const body = encodePackBody([
            encodePackShardFrame('font-core', new Uint8Array([1, 2]))
        ]);
        const parser = createPackParser();
        const frames = parser.push(body);
        parser.finish();
        expect(frames.map((frame) => frame.type)).toEqual([
            PACK_FRAME_TYPE.SHARD,
            PACK_FRAME_TYPE.END
        ]);
        expect(frames[1].count).toBe(1);
    });

    test('encodePackBody does not append a second END', () => {
        const body = encodePackBody([
            encodePackShardFrame('font-core', new Uint8Array([1])),
            encodePackEndFrame(1)
        ]);
        const parser = createPackParser();
        const frames = parser.push(body);
        parser.finish();
        expect(
            frames.filter((frame) => frame.type === PACK_FRAME_TYPE.END).length
        ).toBe(1);
    });

    test('finish rejects a pack that has neither END nor ERROR', () => {
        const body = concatBytes([
            PACK_MAGIC,
            encodePackShardFrame('font-core', new Uint8Array([1]))
        ]);
        const parser = createPackParser();
        parser.push(body);
        expect(() => parser.finish()).toThrow('shard pack missing END');
    });

    test('finish accepts a pack that ends with ERROR instead of END', () => {
        const body = concatBytes([
            PACK_MAGIC,
            encodePackErrorFrame({
                error: 'seed failed',
                shardId: 'font-core'
            })
        ]);
        const parser = createPackParser();
        const frames = parser.push(body);
        parser.finish();
        expect(frames.map((frame) => frame.type)).toEqual([
            PACK_FRAME_TYPE.ERROR
        ]);
        expect(frames[0].receipt.error).toBe('seed failed');
    });

    test('partitionPackItems respects the item cap', () => {
        const batches = partitionPackItems([1, 2, 3, 4], () => 1, 3, 1000);
        expect(batches).toEqual([[1, 2, 3], [4]]);
    });
});
