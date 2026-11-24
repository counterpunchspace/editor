// The contract between the engine and the outline editor for glyph model
// rebuilds.
//
// The engine sometimes replaces a glyph's model objects with new ones read
// from the glyph's Yjs document: after a remote update, a catch-up, a
// rebaseline or hydrate, or when it reads targets back after a commit that
// was refused or wrote nothing. An edit the outline editor has shown but not
// yet committed (an arrow-key nudge waiting for its debounced commit) lives
// only in the editor's drawing data then. If the editor reloaded that drawing
// from the rebuilt model first, the edit would be gone, so the engine tells
// the editor before and after it rebuilds (patch-sync-engine.ts):
//
// - `onBeforeGlyphModelRebuild` listeners run synchronously before the model
//   data is replaced, only where a local commit may run (never inside an
//   engine transaction, a commit or a remote apply). The editor writes its
//   pending edit to the documents then, so the rebuild reads it back.
// - `onGlyphModelRebuilt` listeners run after the new objects are in place,
//   possibly still inside a commit or a remote apply. The editor never
//   commits there: it queues a reload of the edited drawing, and that reload
//   writes a pending edit first (or waits for a commit in flight).

import type {
    BeforeGlyphModelRebuildListener,
    GlyphModelRebuildEvent,
    GlyphModelRebuiltListener
} from '../patch-sync-engine';

export type {
    BeforeGlyphModelRebuildListener,
    GlyphModelRebuildEvent,
    GlyphModelRebuiltListener
};

/**
 * What the outline editor needs from the engine. Optional, so the editor
 * works with an engine that does not offer it; without it the editor still
 * writes a pending edit first whenever it is asked to reload the edited
 * drawing, and checks every commit for a lost edit.
 */
export interface GlyphModelRebuildSource {
    /** Returns a function that ends the subscription. */
    onBeforeGlyphModelRebuild?(
        listener: BeforeGlyphModelRebuildListener
    ): () => void;
    /** Returns a function that ends the subscription. */
    onGlyphModelRebuilt?(listener: GlyphModelRebuiltListener): () => void;
}
