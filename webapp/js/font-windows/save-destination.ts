// Where File → Save As starts.

export type SaveDestination = 'disk' | 'cloud' | 'browser';

/**
 * Where Save As starts: where the font already lives; for a new font, the
 * last destination used, else this computer. A place that isn't available
 * falls back to this computer, then browser storage.
 */
export function chooseSaveDestination(
    current: SaveDestination | null,
    last: string | null,
    available: { fileAccess: boolean; cloud: boolean }
): SaveDestination {
    const remembered =
        last === 'disk' || last === 'cloud' || last === 'browser' ? last : null;
    let dest: SaveDestination = current ?? remembered ?? 'disk';
    if (dest === 'cloud' && !available.cloud) dest = 'disk';
    if (dest === 'disk' && !available.fileAccess) dest = 'browser';
    return dest;
}
