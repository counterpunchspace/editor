// Example Loader
// Loads example fonts from the examples folder into the /user folder on app initialization

interface ExampleManifestEntry {
    source: string;
    destination: string;
    testOnly?: boolean;
    type?: 'directory' | 'file';
    fileList?: string;
}

interface ExampleManifest {
    examples: ExampleManifestEntry[];
}

interface ExampleFileListManifest {
    files: string[];
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
        const loadTestOnly = isTestMode && examplesParam !== 'core';
        const examplesToLoad = (manifest.examples || []).filter(
            (example) => !example.testOnly || loadTestOnly
        );
        console.log(
            '[ExampleLoader]',
            `Found ${manifest.examples.length} example(s) in manifest, loading ${examplesToLoad.length}`
        );

        // Load each example
        let loadedCount = 0;
        for (const example of examplesToLoad) {
            try {
                console.log(
                    '[ExampleLoader]',
                    `  Loading: ${example.source} → ${example.destination}`
                );

                if (example.type === 'directory') {
                    const fileListResponse = await fetch(
                        `./${example.fileList}`
                    );
                    if (!fileListResponse.ok) {
                        console.warn(
                            '[ExampleLoader]',
                            `  ⚠️ Failed to fetch file list ${example.fileList}`
                        );
                        continue;
                    }

                    const fileListManifest =
                        (await fileListResponse.json()) as ExampleFileListManifest;
                    const relativeFiles = fileListManifest.files || [];
                    let uploadedFromDirectory = 0;

                    for (const relativeFilePath of relativeFiles) {
                        const sourcePath = `${example.source}/${relativeFilePath}`;
                        const destinationPath = `${example.destination}/${relativeFilePath}`;

                        const nestedFileResponse = await fetch(
                            `./${sourcePath}`
                        );
                        if (!nestedFileResponse.ok) {
                            console.warn(
                                '[ExampleLoader]',
                                `  ⚠️ Failed to fetch ${sourcePath}`
                            );
                            continue;
                        }

                        const nestedArrayBuffer =
                            await nestedFileResponse.arrayBuffer();
                        const nestedBytes = new Uint8Array(nestedArrayBuffer);
                        const nestedFile = new File(
                            [nestedBytes],
                            destinationPath,
                            {
                                type: 'application/octet-stream'
                            }
                        );

                        await window.uploadFiles([nestedFile], {
                            directory: '/',
                            pluginId: 'memory',
                            skipRefresh: true
                        });
                        uploadedFromDirectory++;
                    }

                    loadedCount += uploadedFromDirectory;
                    console.log(
                        '[ExampleLoader]',
                        `  ✅ Loaded ${uploadedFromDirectory} file(s) from directory ${example.source}`
                    );
                    continue;
                }

                // Fetch the example file
                const fileResponse = await fetch(`./${example.source}`);
                if (!fileResponse.ok) {
                    console.warn(
                        '[ExampleLoader]',
                        `  ⚠️ Failed to fetch ${example.source}`
                    );
                    continue;
                }

                // Get file content as ArrayBuffer for efficient binary handling
                const fileArrayBuffer = await fileResponse.arrayBuffer();
                const fileBytes = new Uint8Array(fileArrayBuffer);
                const file = new File([fileBytes], example.destination, {
                    type: 'application/octet-stream'
                });

                // Write to destination in memory filesystem (manifest has full paths)
                await window.uploadFiles([file], {
                    directory: '/',
                    pluginId: 'memory',
                    skipRefresh: true
                });
                loadedCount++;
            } catch (error) {
                console.error(
                    '[ExampleLoader]',
                    `  ❌ Error loading ${example.source}:`,
                    error
                );
            }
        }

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
