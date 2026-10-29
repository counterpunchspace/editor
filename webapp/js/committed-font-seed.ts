export type EncodedFontShard = { documentId: string; bytes: Uint8Array };

export type CommittedFontSeedSource = {
    buildWorkerSeedDocumentSet?: () => EncodedFontShard[] | null;
    buildWorkerSeedYjsState?: () => Uint8Array | null;
};

export type SeedableFontCompiler = {
    seedWorkerDocumentSet?: (documents: EncodedFontShard[]) => Promise<void>;
    bootstrapWorkerCacheFromFontState?: (
        state: Uint8Array | ArrayBufferLike
    ) => Promise<void>;
};

/**
 * Seed an isolated compiler with the committed font. While the sync bridge
 * is active, glyph bodies live only in per-glyph shards: the core snapshot
 * has masters and features but no glyphs, and compiling it traps in the
 * metrics pass. The single snapshot is only valid without a bridge.
 */
export async function seedCompilerFromCommittedFont(
    source: CommittedFontSeedSource,
    compiler: SeedableFontCompiler,
    messages: { unavailable: string; noSnapshot: string }
): Promise<void> {
    const documentSet = source.buildWorkerSeedDocumentSet?.() || null;
    if (documentSet?.length) {
        if (typeof compiler.seedWorkerDocumentSet !== 'function') {
            throw new Error(messages.unavailable);
        }
        await compiler.seedWorkerDocumentSet(documentSet);
        return;
    }

    if (typeof compiler.bootstrapWorkerCacheFromFontState !== 'function') {
        throw new Error(messages.unavailable);
    }
    const state = source.buildWorkerSeedYjsState?.();
    if (!state?.length) {
        throw new Error(messages.noSnapshot);
    }
    await compiler.bootstrapWorkerCacheFromFontState(state);
}
