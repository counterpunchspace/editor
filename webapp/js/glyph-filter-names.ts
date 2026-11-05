// Names of user glyph filter files (`<name>.py` in the Filters folder).

const FORBIDDEN_FILTER_NAME_CHARS = /[/\\:*?"<>|]/;

/** Filter name without a trailing `.py`, trimmed. */
export function normalizeFilterName(name: string): string {
    const trimmed = name.trim();
    return trimmed.toLowerCase().endsWith('.py')
        ? trimmed.slice(0, -3).trim()
        : trimmed;
}

/**
 * Why `name` cannot be used for a filter file in a folder that already
 * holds `existingNames` (file names with or without `.py`), or null when it
 * can. Comparison ignores case, as the macOS and Windows file systems do.
 * `currentName` is the file being renamed; it never counts as a clash.
 */
export function validateFilterName(
    name: string,
    existingNames: Iterable<string>,
    currentName?: string,
    noun: 'filter' | 'folder' = 'filter'
): string | null {
    const normalized = normalizeFilterName(name);
    if (!normalized) {
        return 'Enter a name.';
    }
    if (FORBIDDEN_FILTER_NAME_CHARS.test(normalized)) {
        return 'A name cannot contain / \\ : * ? " < > |';
    }
    if (normalized === '.' || normalized === '..') {
        return 'Enter a name.';
    }
    const wanted = normalized.toLowerCase();
    const current =
        currentName === undefined
            ? null
            : normalizeFilterName(currentName).toLowerCase();
    for (const existing of existingNames) {
        const existingName = normalizeFilterName(existing).toLowerCase();
        if (existingName === wanted && existingName !== current) {
            return `A ${noun} named “${normalized}” already exists.`;
        }
    }
    return null;
}

/** "New Filter", then "New Filter 2", "New Filter 3", … whichever is free. */
export function nextFreeFilterName(
    existingNames: Iterable<string>,
    baseName: string = 'New Filter'
): string {
    const taken = new Set(
        [...existingNames].map((name) =>
            normalizeFilterName(name).toLowerCase()
        )
    );
    if (!taken.has(baseName.toLowerCase())) {
        return baseName;
    }
    let suffix = 2;
    while (taken.has(`${baseName} ${suffix}`.toLowerCase())) {
        suffix += 1;
    }
    return `${baseName} ${suffix}`;
}
