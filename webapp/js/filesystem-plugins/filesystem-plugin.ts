// Filesystem plugin base class and shared types.
// Each plugin is a different file access method (OPFS, disk, cloud, etc.).

import type { FileSystemAdapter } from '../file-system-adapter';

/** What one save wrote, for backends that describe it (a commit message). */
export interface SaveSummary {
    fontName: string;
    /** Glyphs the save changed; null when it wrote the whole font. */
    glyphs: string[] | null;
    /** Whether font-level data (info, stations, kerning, features) changed. */
    fontLevel: boolean;
}

export interface CanAddGlyphsResult {
    allowed: boolean;
    remaining?: number | null;
    reason?: string;
}

export interface StationTopologyGate {
    allowed: boolean;
    reason?: string;
    /** Reopening with every glyph resident would lift the block. */
    canReopenWithAllGlyphs?: boolean;
}

/**
 * Abstract base class for filesystem plugins.
 * Hooks have safe defaults; subclasses override only what they need.
 */
export abstract class FilesystemPlugin {
    protected adapter: FileSystemAdapter;

    constructor(adapter: FileSystemAdapter) {
        this.adapter = adapter;
    }

    /** Unique identifier for this plugin (e.g., 'memory', 'disk', 'cloud') */
    abstract getId(): string;

    /** Display name shown in UI (e.g., 'Memory', 'Disk', 'Cloud Storage') */
    abstract getName(): string;

    /** Icon/emoji shown in UI (e.g., '🧠', '💾', '☁️') */
    abstract getIcon(): string;

    /** Get the underlying filesystem adapter */
    getAdapter(): FileSystemAdapter {
        return this.adapter;
    }

    /** Whether this plugin supports saving files */
    canSave(): boolean {
        return true;
    }

    /**
     * Get the current root path for this plugin's context
     */
    getDefaultPath(): string {
        return '/';
    }

    /** Whether this backend is offered at all (Cloud is feature-flagged). */
    isVisibleInUI(): boolean {
        return true;
    }

    /**
     * Save As for a backend that stores fonts its own way instead of through
     * adapter.writeFile (the cloud). Called by the Save As dialog.
     */
    async handleSaveAs(_name: string): Promise<boolean> {
        return false;
    }

    /**
     * Plugin-specific open handler for paths that cannot be read through the
     * generic adapter.readFile pipeline.
     * Return true when the plugin fully handled the open.
     */
    async handleOpenPath(_path: string): Promise<boolean> {
        return false;
    }

    /**
     * Refresh plugin-owned data (catalog, indexes) before Save or seed.
     */
    async prepareToSave(): Promise<void> {
        // Default: nothing extra to prepare
    }

    /**
     * Called once after a save has written every changed file.
     * Backends that publish a save as one unit (a commit, a transaction)
     * use this to send it; `writeFile` may buffer until then.
     */
    async afterSave(_summary: SaveSummary): Promise<void> {
        // Default: writes are already durable
    }

    async prepareToSeed(): Promise<void> {
        await this.prepareToSave();
    }

    /**
     * Whether `additionalGlyphCount` new glyphs may be added under this backend.
     */
    async canAddGlyphs(
        additionalGlyphCount: number
    ): Promise<CanAddGlyphsResult> {
        void additionalGlyphCount;
        return { allowed: true };
    }

    /**
     * Sync view of {@link canAddGlyphs} for model mutations that cannot await.
     * Cloud uses live glyph count vs the last known owner cap.
     */
    getCachedCanAddGlyphs(additionalGlyphCount: number): CanAddGlyphsResult {
        void additionalGlyphCount;
        return { allowed: true };
    }

    /**
     * Whether stations may be added, removed, or reinterpolated. Those edits
     * rewrite a drawing on every glyph, so every glyph must be resident.
     */
    getStationTopologyGate(): StationTopologyGate {
        return { allowed: true };
    }

    /**
     * Sync admission for a live Yjs commit. Cloud rejects oversize packets
     * or shards before the change-bridge emits. Local backends allow.
     */
    canSubmitCollabUpdate(
        requests: Array<{
            documentId: string;
            packetBytes: number;
            shardBytes: number;
        }>
    ): { allowed: boolean; reason?: string; kind?: 'packet' | 'shard' } {
        void requests;
        return { allowed: true };
    }

    notifyCollabSubmitRejected(_decision: {
        allowed: boolean;
        reason?: string;
        kind?: 'packet' | 'shard';
        documentId?: string;
        packetBytes?: number;
        shardBytes?: number;
    }): void {}

    /**
     * Return a copy of font JSON without this plugin's owned extra data.
     * Used when Save As targets a different plugin.
     */
    stripOwnedFontData<T>(fontJson: T): T {
        return fontJson;
    }
}
