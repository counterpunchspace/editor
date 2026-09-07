/** Bounded parallel I/O for cloud shard hydrate/seed. Fail the batch if any worker throws. */

export { HYDRATE_SHARD_CONCURRENCY } from './cloud-shard-limits';

export async function mapPool<T, R>(
    items: readonly T[],
    concurrency: number,
    fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
    if (!items.length) {
        return [];
    }
    const limit = Math.max(1, Math.min(concurrency, items.length));
    const results = new Array<R>(items.length);
    let nextIndex = 0;
    const workers = Array.from({ length: limit }, async () => {
        while (true) {
            const index = nextIndex;
            nextIndex += 1;
            if (index >= items.length) {
                return;
            }
            results[index] = await fn(items[index], index);
        }
    });
    await Promise.all(workers);
    return results;
}
