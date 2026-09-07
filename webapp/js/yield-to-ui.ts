/**
 * Let the browser paint and handle input between chunks of CPU/network work.
 * Seed/hydrate loops must await this so Cancel stays clickable.
 */

export function yieldToUi(): Promise<void> {
    const schedulerWithYield = (
        globalThis as typeof globalThis & {
            scheduler?: { yield?: () => Promise<void> };
        }
    ).scheduler;
    if (typeof schedulerWithYield?.yield === 'function') {
        return schedulerWithYield.yield();
    }
    return new Promise((resolve) => {
        setTimeout(resolve, 0);
    });
}

export function throwIfAborted(signal?: AbortSignal | null): void {
    if (!signal?.aborted) {
        return;
    }
    if (signal.reason instanceof Error) {
        throw signal.reason;
    }
    throw new DOMException('The operation was aborted.', 'AbortError');
}
