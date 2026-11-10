// The example fonts in examples/examples-manifest.json, which the editor and
// the launcher write into browser storage: the sample font (Fustat), plus test
// fixtures in test mode. The demo depends on them, so they can't be deleted or
// renamed (`isExampleFontPath`).

export interface ExampleManifestEntry {
    source: string;
    destination: string;
    testOnly?: boolean;
    type?: 'directory' | 'file';
    fileList?: string;
    groups?: string[];
}

interface ExampleManifest {
    examples: ExampleManifestEntry[];
}

interface ExampleFileListManifest {
    files: string[];
}

// Chrome fails fetches with thousands pending, so fixture fetches are bounded.
const FETCH_CONCURRENCY = 16;

let exampleDestinations: string[] = [];

/** Map `items` through `fn` with at most `limit` calls in flight, keeping order. */
async function mapWithConcurrency<T, R>(
    items: T[],
    limit: number,
    fn: (item: T) => Promise<R>
): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let next = 0;
    await Promise.all(
        Array.from({ length: Math.min(limit, items.length) }, async () => {
            while (next < items.length) {
                const index = next++;
                results[index] = await fn(items[index]);
            }
        })
    );
    return results;
}

/**
 * The manifest entries that apply to this page: the sample font, and in test
 * mode the fixtures (`?examples=core` skips them, `?examples=<group>` picks a
 * group). Null when there is no manifest.
 */
export async function loadExampleManifest(): Promise<
    ExampleManifestEntry[] | null
> {
    const response = await fetch('./examples/examples-manifest.json');
    if (!response.ok) return null;
    const manifest = (await response.json()) as ExampleManifest;
    const isTestMode = !!window.isTestMode?.();
    const examplesParam = new URLSearchParams(window.location.search).get(
        'examples'
    );
    const namedGroup =
        isTestMode && !!examplesParam && examplesParam !== 'core';
    const entries = (manifest.examples || []).filter((example) => {
        if (!example.testOnly) return true;
        if (!isTestMode) return false;
        if (namedGroup) return example.groups?.includes(examplesParam) === true;
        return examplesParam !== 'core';
    });
    exampleDestinations = entries.map((entry) => entry.destination);
    return entries;
}

/**
 * Whether deleting or renaming `path` (a browser-storage path such as
 * `/user/Fustat.glyphs`) would remove an example font: the font itself, a
 * file inside an example package, or a folder that contains one. Knows the
 * examples once `loadExampleManifest` has run.
 */
export function isExampleFontPath(path: string): boolean {
    const value = path.replace(/\/+$/, '');
    return exampleDestinations.some(
        (destination) =>
            value === destination ||
            destination.startsWith(`${value}/`) ||
            value.startsWith(`${destination}/`)
    );
}

/**
 * Fetch the files of `entries`. Each File is named by its full destination
 * path. Files that fail to load are skipped with a warning.
 */
export async function fetchExampleFiles(
    entries: ExampleManifestEntry[]
): Promise<File[]> {
    const fileEntries = (
        await Promise.all(
            entries.map(async (example) => {
                if (example.type !== 'directory') {
                    return [
                        {
                            sourcePath: example.source,
                            destinationPath: example.destination
                        }
                    ];
                }
                try {
                    const response = await fetch(`./${example.fileList}`);
                    if (!response.ok) {
                        console.warn(
                            '[ExampleFonts]',
                            `Failed to fetch file list ${example.fileList}`
                        );
                        return [];
                    }
                    const list =
                        (await response.json()) as ExampleFileListManifest;
                    return (list.files || []).map((relativePath) => ({
                        sourcePath: `${example.source}/${relativePath}`,
                        destinationPath: `${example.destination}/${relativePath}`
                    }));
                } catch (error) {
                    console.error(
                        '[ExampleFonts]',
                        `Error loading ${example.source}:`,
                        error
                    );
                    return [];
                }
            })
        )
    ).flat();

    const files = await mapWithConcurrency(
        fileEntries,
        FETCH_CONCURRENCY,
        async ({ sourcePath, destinationPath }) => {
            try {
                const response = await fetch(`./${sourcePath}`);
                if (!response.ok) {
                    console.warn(
                        '[ExampleFonts]',
                        `Failed to fetch ${sourcePath}`
                    );
                    return null;
                }
                const bytes = new Uint8Array(await response.arrayBuffer());
                return new File([bytes], destinationPath, {
                    type: 'application/octet-stream'
                });
            } catch (error) {
                console.error(
                    '[ExampleFonts]',
                    `Error loading ${sourcePath}:`,
                    error
                );
                return null;
            }
        }
    );
    return files.filter((file): file is File => !!file);
}
