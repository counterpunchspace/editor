// Example Loader
// Loads example fonts from the examples folder into the /user folder on app initialization

interface ExampleManifestEntry {
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
 * Load example fonts into the /user folder based on examples-manifest.json
 */
async function loadExampleFonts() {
    if (!window.pyodide) {
        console.error(
            '[ExampleLoader]',
            'Pyodide not available for loading examples'
        );
        return;
    }

    try {
        console.log('[ExampleLoader]', '📦 Loading example fonts...');

        // Fetch the manifest
        const manifestResponse = await fetch(
            './examples/examples-manifest.json'
        );
        if (!manifestResponse.ok) {
            console.warn(
                '[ExampleLoader]',
                'No examples manifest found, skipping example loading'
            );
            return;
        }

        const manifest = (await manifestResponse.json()) as ExampleManifest;
        const isTestMode = !!window.isTestMode?.();
        const examplesParam = new URLSearchParams(window.location.search).get(
            'examples'
        );
        const namedGroup =
            isTestMode && !!examplesParam && examplesParam !== 'core';
        const examplesToLoad = (manifest.examples || []).filter((example) => {
            if (!example.testOnly) {
                return true;
            }
            if (!isTestMode) {
                return false;
            }
            if (namedGroup) {
                return example.groups?.includes(examplesParam) === true;
            }
            return examplesParam !== 'core';
        });
        console.log(
            '[ExampleLoader]',
            `Found ${manifest.examples.length} example(s) in manifest, loading ${examplesToLoad.length}`
        );

        // Resolve every file first, fetch them in parallel, then write them.
        const fileEntries = (
            await Promise.all(
                examplesToLoad.map(async (example) => {
                    if (example.type !== 'directory') {
                        return [
                            {
                                sourcePath: example.source,
                                destinationPath: example.destination
                            }
                        ];
                    }
                    try {
                        const fileListResponse = await fetch(
                            `./${example.fileList}`
                        );
                        if (!fileListResponse.ok) {
                            console.warn(
                                '[ExampleLoader]',
                                `  ⚠️ Failed to fetch file list ${example.fileList}`
                            );
                            return [];
                        }
                        const fileListManifest =
                            (await fileListResponse.json()) as ExampleFileListManifest;
                        return (fileListManifest.files || []).map(
                            (relativeFilePath) => ({
                                sourcePath: `${example.source}/${relativeFilePath}`,
                                destinationPath: `${example.destination}/${relativeFilePath}`
                            })
                        );
                    } catch (error) {
                        console.error(
                            '[ExampleLoader]',
                            `  ❌ Error loading ${example.source}:`,
                            error
                        );
                        return [];
                    }
                })
            )
        ).flat();

        const fetchedFiles = await mapWithConcurrency(
            fileEntries,
            FETCH_CONCURRENCY,
            async ({ sourcePath, destinationPath }) => {
                try {
                    const response = await fetch(`./${sourcePath}`);
                    if (!response.ok) {
                        console.warn(
                            '[ExampleLoader]',
                            `  ⚠️ Failed to fetch ${sourcePath}`
                        );
                        return null;
                    }
                    const bytes = new Uint8Array(await response.arrayBuffer());
                    return new File([bytes], destinationPath, {
                        type: 'application/octet-stream'
                    });
                } catch (error) {
                    console.error(
                        '[ExampleLoader]',
                        `  ❌ Error loading ${sourcePath}:`,
                        error
                    );
                    return null;
                }
            }
        );

        // Write to the memory filesystem (manifest has full paths). Each
        // write is a worker round trip, so a few lanes keep it pipelined.
        const files = fetchedFiles.filter((file): file is File => !!file);
        const WRITE_LANES = 8;
        await Promise.all(
            Array.from({ length: WRITE_LANES }, (_, lane) =>
                window.uploadFiles(
                    files.filter((_, index) => index % WRITE_LANES === lane),
                    { directory: '/', pluginId: 'memory', skipRefresh: true }
                )
            )
        );
        const loadedCount = files.length;

        console.log(
            '[ExampleLoader]',
            `✅ Loaded ${loadedCount} file(s) from ${examplesToLoad.length} example entry/entries`
        );

        // Refresh file browser if available
        if (window.refreshFileSystem) {
            window.refreshFileSystem();
        }
    } catch (error) {
        console.error('[ExampleLoader]', 'Error loading example fonts:', error);
    }
}

// Export the function
window.loadExampleFonts = loadExampleFonts;

console.log('[ExampleLoader]', '✅ Example Loader module loaded');
