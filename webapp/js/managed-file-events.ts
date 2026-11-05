export const MANAGED_FILE_CHANGED_EVENT = 'managedFileChanged';

export type ManagedFileChangeSource =
    'script-editor-save' | 'glyph-filter-editor' | 'file-system-observer';

const INTERNAL_WRITE_TTL_MS = 5000;
const pendingInternalWrites = new Map<string, number>();

export interface ManagedFileChangedDetail {
    pluginId: string;
    source: ManagedFileChangeSource;
    paths?: string[];
    records?: unknown[];
    internalWrite?: boolean;
}

type ChangedPathRecord = {
    path?: unknown;
    relativePath?: unknown;
    changedPath?: unknown;
    oldPath?: unknown;
    newPath?: unknown;
    relativePathComponents?: unknown;
    movedFrom?: {
        path?: unknown;
        relativePathComponents?: unknown;
    };
    movedTo?: {
        path?: unknown;
        relativePathComponents?: unknown;
    };
};

export function normalizeManagedPath(path: string): string {
    const cleaned = path.replace(/\\/g, '/').replace(/^\/+/, '');
    return `/${cleaned}`.replace(/\/+/g, '/');
}

function internalWriteKey(pluginId: string, path: string): string {
    return `${pluginId}:${normalizeManagedPath(path)}`;
}

export function markManagedFileInternalWrite(
    pluginId: string,
    path: string
): void {
    pendingInternalWrites.set(
        internalWriteKey(pluginId, path),
        Date.now() + INTERNAL_WRITE_TTL_MS
    );
}

export function cancelManagedFileInternalWrite(
    pluginId: string,
    path: string
): void {
    pendingInternalWrites.delete(internalWriteKey(pluginId, path));
}

export function consumeManagedFileInternalWritePaths(
    pluginId: string,
    paths: string[]
): string[] {
    const now = Date.now();
    const internallyWrittenPaths: string[] = [];

    for (const path of paths) {
        const key = internalWriteKey(pluginId, path);
        const expiresAt = pendingInternalWrites.get(key);

        if (expiresAt === undefined) {
            continue;
        }

        pendingInternalWrites.delete(key);
        if (expiresAt >= now) {
            internallyWrittenPaths.push(normalizeManagedPath(path));
        }
    }

    return internallyWrittenPaths;
}

/** Peek whether a path still has an unexpired self-write marker. */
export function hasManagedFileInternalWrite(
    pluginId: string,
    path: string
): boolean {
    const expiresAt = pendingInternalWrites.get(
        internalWriteKey(pluginId, path)
    );
    return expiresAt !== undefined && expiresAt >= Date.now();
}

/**
 * True when every observed path still has a pending self-write marker.
 * Peek-only: markers stay valid for the full TTL so multiple FileSystemObserver
 * echoes from one createWritable() close are all suppressed.
 */
export function wereAllManagedPathsInternalWrites(
    pluginId: string,
    paths: string[]
): boolean {
    if (paths.length === 0) {
        return false;
    }

    return paths.every((path) => hasManagedFileInternalWrite(pluginId, path));
}

/**
 * True when every basename (e.g. `foo.py`) matches some pending internal write
 * path for `pluginId`. Used when observer records don't resolve to full paths.
 */
export function wereAllBasenamesInternalWrites(
    pluginId: string,
    basenames: string[]
): boolean {
    if (basenames.length === 0) {
        return false;
    }

    const prefix = `${pluginId}:`;
    const now = Date.now();
    const pendingBasenames = new Set<string>();

    for (const [key, expiresAt] of pendingInternalWrites) {
        if (!key.startsWith(prefix) || expiresAt < now) {
            continue;
        }
        const path = key.slice(prefix.length);
        const basename = path.split('/').pop();
        if (basename) {
            pendingBasenames.add(basename);
        }
    }

    return basenames.every((basename) => pendingBasenames.has(basename));
}

export function extractManagedChangedPaths(
    detail: ManagedFileChangedDetail
): string[] {
    const paths = new Set<string>();

    const addPath = (value: unknown) => {
        if (typeof value === 'string' && value.trim()) {
            paths.add(normalizeManagedPath(value));
        }
    };

    for (const path of detail.paths || []) {
        addPath(path);
    }

    for (const record of detail.records || []) {
        if (!record || typeof record !== 'object') {
            continue;
        }

        const changedRecord = record as ChangedPathRecord;
        addPath(changedRecord.path);
        addPath(changedRecord.relativePath);
        addPath(changedRecord.changedPath);
        addPath(changedRecord.oldPath);
        addPath(changedRecord.newPath);

        const relComps = changedRecord.relativePathComponents;
        if (Array.isArray(relComps) && relComps.length > 0) {
            addPath(relComps.join('/'));
        }

        const movedFrom = changedRecord.movedFrom;
        if (movedFrom && typeof movedFrom === 'object') {
            addPath(movedFrom.path);
            const comps = movedFrom.relativePathComponents;
            if (Array.isArray(comps) && comps.length > 0) {
                addPath(comps.join('/'));
            }
        }

        const movedTo = changedRecord.movedTo;
        if (movedTo && typeof movedTo === 'object') {
            addPath(movedTo.path);
            const comps = movedTo.relativePathComponents;
            if (Array.isArray(comps) && comps.length > 0) {
                addPath(comps.join('/'));
            }
        }
    }

    return Array.from(paths);
}

export function dispatchManagedFileChanged(
    detail: ManagedFileChangedDetail
): void {
    // Re-arm the TTL when an intentional in-app write notifies listeners, so
    // FileSystemObserver echoes that arrive after createWritable() closes are
    // still recognized as self-writes.
    if (detail.internalWrite) {
        for (const path of detail.paths || []) {
            markManagedFileInternalWrite(detail.pluginId, path);
        }
    }

    window.dispatchEvent(
        new CustomEvent<ManagedFileChangedDetail>(MANAGED_FILE_CHANGED_EVENT, {
            detail
        })
    );
}
