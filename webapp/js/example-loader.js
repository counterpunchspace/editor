// Example Loader
// Loads example fonts from the examples folder into the /user folder on app initialization

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

        const manifest = await manifestResponse.json();
        console.log(
            '[ExampleLoader]',
            `Found ${manifest.examples.length} example(s) in manifest`
        );

        // Ensure /user directory exists
        await window.pyodide.runPython(`
import os
if not os.path.exists('/user'):
    os.makedirs('/user')
    print('📁 Created /user directory')
        `);

        // Load each example
        let loadedCount = 0;
        for (const example of manifest.examples) {
            try {
                console.log(
                    '[ExampleLoader]',
                    `  Loading: ${example.source} → ${example.destination}`
                );

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

                // Write to destination in Pyodide filesystem
                await window.pyodide.FS.writeFile(
                    example.destination,
                    fileBytes
                );

                console.log(
                    '[ExampleLoader]',
                    `  ✅ Copied to ${example.destination} (${fileBytes.length} bytes)`
                );

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
            `✅ Loaded ${loadedCount}/${manifest.examples.length} example fonts`
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
