/**
 * Single apply-path classification for PatchSyncEngine.
 * Replaces the suppress-flag cluster for remote vs local vs silent applies.
 */
export enum ApplyKind {
    /** Normal local edit: record + auto-emit. */
    Local = 'local',
    /** Applying a remote peer update. */
    Remote = 'remote',
    /** Derived/local silent mutate: no record, auto-emit OK. */
    Silent = 'silent',
    /** Undo/redo apply: no record, no auto-emit. */
    UndoRedo = 'undo-redo',
    /** Glyph catch-up apply (remote-like). */
    CatchUp = 'catch-up',
    /**
     * Local commit/init packaging: recording already finished; suppress
     * automatic yDoc emission while ops are applied (callers emit manually).
     */
    ManualEmit = 'manual-emit'
}
