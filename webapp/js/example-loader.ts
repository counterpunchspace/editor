// Example Loader
// Writes the example fonts (example-fonts.ts) into browser storage on every
// editor start, so the sample font is always there and unchanged.

import { fetchExampleFiles, loadExampleManifest } from './example-fonts';

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

        const examplesToLoad = await loadExampleManifest();
        if (!examplesToLoad) {
            console.warn(
                '[ExampleLoader]',
                'No examples manifest found, skipping example loading'
            );
            return;
        }

        const files = await fetchExampleFiles(examplesToLoad);

        // Write to the memory filesystem (manifest has full paths). Each
        // write is a worker round trip, so a few lanes keep it pipelined.
        const WRITE_LANES = 8;
        await Promise.all(
            Array.from({ length: WRITE_LANES }, (_, lane) =>
                window.uploadFiles(
                    files.filter((_, index) => index % WRITE_LANES === lane),
                    { directory: '/', pluginId: 'memory', skipRefresh: true }
                )
            )
        );

        console.log(
            '[ExampleLoader]',
            `✅ Loaded ${files.length} file(s) from ${examplesToLoad.length} example entry/entries`
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
