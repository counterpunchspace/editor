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
    partitionPackItems,
    SEED_PACK_MAX_SHARDS,
    SEED_PACK_MAX_BYTES,
    LARGE_SHARD_BYTES,
    seedPackByteBudget
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
        const errorFrame = encodePackErrorFrame({
            error: 'seed failed',
            shardId: 'font-core'
        });
        expect(errorFrame[0]).toBe(PACK_FRAME_TYPE.ERROR);
        expect(errorFrame.byteLength).toBeGreaterThan(8 + 32);
        const body = concatBytes([PACK_MAGIC, errorFrame]);
        const parser = createPackParser();
        const frames = parser.push(body);
        parser.finish();
        expect(frames.map((frame) => frame.type)).toEqual([
            PACK_FRAME_TYPE.ERROR
        ]);
        expect(frames[0].shardId).toBe('font-core');
        expect(frames[0].payload.byteLength).toBeGreaterThan(0);
        const errorReceipt =
            frames[0].receipt ||
            JSON.parse(new TextDecoder().decode(frames[0].payload));
        expect(errorReceipt.error).toBe('seed failed');
    });

    test('partitionPackItems respects the item cap', () => {
        const batches = partitionPackItems([1, 2, 3, 4], () => 1, 3, 1000);
        expect(batches).toEqual([[1, 2, 3], [4]]);
    });

    test('seed packs split on the paid byte cap and keep a large shard alone', () => {
        const small = Array.from({ length: 3 }, (_, index) => index);
        const batches = partitionPackItems(
            small,
            () => SEED_PACK_MAX_BYTES - 1,
            SEED_PACK_MAX_SHARDS,
            SEED_PACK_MAX_BYTES
        );
        expect(batches).toEqual([[0], [1], [2]]);
        const mixed = partitionPackItems(
            [1, 2, 3],
            (item) => (item === 2 ? LARGE_SHARD_BYTES : 10),
            SEED_PACK_MAX_SHARDS,
            SEED_PACK_MAX_BYTES
        );
        expect(mixed).toEqual([[1], [2], [3]]);
        expect(seedPackByteBudget()).toBe(SEED_PACK_MAX_BYTES - 1024 * 1024);
    });
});
