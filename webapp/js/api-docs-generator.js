/**
 * API Documentation Generator
 *
 * Provides functions to generate and download API documentation
 * for the Font Object Model.
 */

(function () {
    'use strict';

    /**
     * Generate API documentation by running the Python script
     * @returns {Promise<string>} The generated markdown documentation
     */
    async function generateAPIDocs() {
        console.log('[APIDocs]', 'Generating API documentation...');

        if (!window.pyodide) {
            throw new Error('Pyodide not loaded');
        }

        // Fetch and execute the generate_api_docs module
        const response = await fetch('./py/generate_api_docs.py');
        const code = await response.text();

        // Execute the module code and then call generate_docs()
        await window.pyodide.runPython(code);

        const result = await window.pyodide.runPythonAsync(`
docs = generate_docs()
docs
        `);

        console.log(
            '[APIDocs]',
            `Generated ${result.length} characters of documentation`
        );
        return result;
    }

    /**
     * Download the API documentation as a markdown file
     * @param {string} filename - Optional filename (default: 'font-api-docs.md')
     */
    async function downloadAPIDocs(filename = 'font-api-docs.md') {
        try {
            const docs = await generateAPIDocs();

            // Create a blob from the markdown text
            const blob = new Blob([docs], { type: 'text/markdown' });

            // Create a download link
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;

            // Trigger download
            document.body.appendChild(a);
            a.click();

            // Cleanup
            document.body.removeChild(a);
            URL.revokeObjectURL(url);

            console.log('[APIDocs]', `Downloaded ${filename}`);
            return docs;
        } catch (error) {
            console.error('[APIDocs]', 'Error generating docs:', error);
            throw error;
        }
    }

    /**
     * Display the API documentation in a new window
     */
    async function showAPIDocs() {
        try {
            const docs = await generateAPIDocs();

            // Open in new window
            const win = window.open('', '_blank');
            if (!win) {
                console.error(
                    '[APIDocs]',
                    'Failed to open new window - popup blocked?'
                );
                return;
            }

            // Create a simple HTML page with the markdown rendered
            win.document.write(`
<!DOCTYPE html>
<html>
<head>
    <title>Font API Documentation</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            max-width: 900px;
            margin: 40px auto;
            padding: 0 20px;
            line-height: 1.6;
            color: #333;
        }
        pre {
            background: #f5f5f5;
            padding: 15px;
            border-radius: 5px;
            overflow-x: auto;
        }
        code {
            background: #f5f5f5;
            padding: 2px 6px;
            border-radius: 3px;
            font-family: 'Monaco', 'Courier New', monospace;
        }
        pre code {
            background: none;
            padding: 0;
        }
        h1 {
            border-bottom: 3px solid #333;
            padding-bottom: 10px;
        }
        h2 {
            border-bottom: 2px solid #666;
            padding-bottom: 8px;
            margin-top: 40px;
        }
        h3 {
            margin-top: 30px;
            color: #555;
        }
        h4 {
            margin-top: 20px;
            color: #666;
        }
        hr {
            border: none;
            border-top: 1px solid #ddd;
            margin: 40px 0;
        }
    </style>
</head>
<body>
    <pre>${docs.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>
</body>
</html>
            `);
            win.document.close();

            console.log('[APIDocs]', 'Documentation opened in new window');
        } catch (error) {
            console.error('[APIDocs]', 'Error showing docs:', error);
            throw error;
        }
    }

    // Expose functions globally
    window.generateAPIDocs = generateAPIDocs;
    window.downloadAPIDocs = downloadAPIDocs;
    window.showAPIDocs = showAPIDocs;

    console.log('[APIDocs]', '✅ API documentation functions loaded');
    console.log('[APIDocs]', '   Use downloadAPIDocs() to download markdown');
    console.log('[APIDocs]', '   Use showAPIDocs() to view in browser');
    console.log('[APIDocs]', '   Use generateAPIDocs() to get markdown string');
})();
