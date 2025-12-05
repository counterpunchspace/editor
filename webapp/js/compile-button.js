// Compile Button Handler
// Compiles the current font to TTF using the babelfont-fontc WASM module

(function () {
    'use strict';

    const compileBtn = document.getElementById('compile-font-btn');
    let isCompiling = false;
    let worker = null;
    let workerReady = false;
    let compilationId = 0;
    let pendingCompilations = new Map();

    // Initialize the Web Worker
    async function initWorker() {
        if (worker) return workerReady;

        console.log('🔧 Initializing fontc worker...');

        try {
            worker = new Worker('js/fontc-worker.js', { type: 'module' });

            worker.onmessage = (e) => {
                const { type, id, ttfBytes, duration, error, version } = e.data;

                if (type === 'ready') {
                    workerReady = true;
                    console.log('✅ Fontc worker ready:', version);
                } else if (type === 'compiled') {
                    const resolve = pendingCompilations.get(id);
                    if (resolve) {
                        resolve({ ttfBytes, duration });
                        pendingCompilations.delete(id);
                    }
                } else if (type === 'error') {
                    const resolve = pendingCompilations.get(id);
                    if (resolve) {
                        resolve({ error });
                        pendingCompilations.delete(id);
                    }
                }
            };

            worker.onerror = (e) => {
                console.error('❌ Worker error:', e);
                workerReady = false;
            };

            // Send init message
            worker.postMessage({ type: 'init' });

            // Wait for ready
            await new Promise((resolve, reject) => {
                const timeout = setTimeout(
                    () => reject(new Error('Worker init timeout')),
                    10000
                );
                const checkReady = () => {
                    if (workerReady) {
                        clearTimeout(timeout);
                        resolve();
                    } else {
                        setTimeout(checkReady, 100);
                    }
                };
                checkReady();
            });

            return true;
        } catch (error) {
            console.error('❌ Failed to initialize worker:', error);
            return false;
        }
    }

    // Compile using the worker
    async function compileWithWorker(babelfontJson) {
        if (!workerReady) {
            throw new Error('Worker not ready');
        }

        const id = ++compilationId;

        return new Promise((resolve) => {
            pendingCompilations.set(id, resolve);
            worker.postMessage({
                type: 'compile',
                id: id,
                data: { babelfontJson }
            });
        });
    }

    // Enable/disable compile button based on font availability
    function updateCompileButtonState() {
        const dropdown = document.getElementById('open-fonts-dropdown');
        const hasFontOpen =
            dropdown &&
            dropdown.options.length > 0 &&
            dropdown.value !== '' &&
            dropdown.options[0].textContent !== 'No fonts open';

        compileBtn.disabled = !hasFontOpen || isCompiling;
    }

    // Compile the current font
    async function compileFont() {
        if (isCompiling) return;

        if (!window.pyodide) {
            alert('Python environment not ready yet');
            return;
        }

        // Initialize worker if needed
        if (!workerReady) {
            console.log('Initializing worker...');
            const initialized = await initWorker();
            if (!initialized) {
                alert(
                    'Failed to initialize font compiler. Check console for errors.'
                );
                return;
            }
        }

        try {
            isCompiling = true;
            updateCompileButtonState();

            // Update button text to show progress
            const originalText = compileBtn.textContent;
            compileBtn.textContent = 'Compiling...';

            console.log('🔨 Starting font compilation...');
            if (window.term) {
                window.term.echo('');
                window.term.echo('[[;cyan;]🔨 Compiling font to TTF...]');
            }

            // Get the font JSON from Python
            const startTime = performance.now();
            const pythonResult = await window.pyodide.runPythonAsync(`
import orjson
import os

# Get current font using CurrentFont()
font = CurrentFont()
if not font:
    raise ValueError("No font is currently open")

# Get the font's file path for naming the output
font_path = font.path if hasattr(font, 'path') and font.path else 'font.context'

# Get directory of source file
source_dir = os.path.dirname(font_path) if font_path else '.'

# Export to .babelfont JSON format using orjson (handles datetime objects)
font_dict = font.to_dict()
babelfont_json = orjson.dumps(font_dict).decode('utf-8')

# Return JSON, path, and directory
(babelfont_json, font_path, source_dir)
            `);

            const babelfontJson = pythonResult[0];
            const fontPath = pythonResult[1];
            const sourceDir = pythonResult[2];
            const exportTime = performance.now() - startTime;
            console.log(
                `✅ Exported to JSON in ${exportTime.toFixed(0)}ms (${babelfontJson.length} bytes)`
            );

            // Compile using the Web Worker
            const compileStart = performance.now();
            const result = await compileWithWorker(babelfontJson);

            if (result.error) {
                throw new Error(result.error);
            }

            const { ttfBytes, duration } = result;
            console.log(
                `✅ Compiled in ${duration.toFixed(0)}ms (${ttfBytes.length} bytes)`
            );

            // Determine output filename
            const basename =
                fontPath
                    .replace(
                        /\.(glyphs|designspace|ufo|babelfont|context)$/,
                        ''
                    )
                    .split('/')
                    .pop() || 'font';
            const outputFilename = `${basename}.ttf`;
            const outputPath =
                sourceDir === '.'
                    ? outputFilename
                    : `${sourceDir}/${outputFilename}`;

            // Save directly to Pyodide's virtual filesystem using FS API (much faster than JSON roundtrip)
            window.pyodide.FS.writeFile(outputPath, ttfBytes);
            console.log(`💾 Saved to: ${outputPath}`);

            const totalTime = performance.now() - startTime;

            // Refresh file browser to show the new file
            if (window.refreshFileSystem) {
                window.refreshFileSystem();
            }

            // Show success message
            if (window.term) {
                window.term.echo(
                    `[[;lime;]✅ Compiled successfully in ${totalTime.toFixed(0)}ms]`
                );
                window.term.echo(
                    `[[;lime;]💾 Saved: ${outputPath} (${ttfBytes.length} bytes)]`
                );
                window.term.echo(
                    `[[;gray;]   Export: ${exportTime.toFixed(0)}ms | Compile: ${duration.toFixed(0)}ms]`
                );
                window.term.echo('');
            }

            // Dispatch event for canvas to load the compiled font
            window.dispatchEvent(
                new CustomEvent('fontCompiled', {
                    detail: { ttfBytes, outputPath, duration: totalTime }
                })
            );

            // Reset button text
            compileBtn.textContent = originalText;
        } catch (error) {
            console.error('❌ Compilation failed:', error);

            if (window.term) {
                window.term.error(`❌ Compilation failed: ${error.message}`);
                window.term.echo('');
            }

            alert(`Compilation failed: ${error.message}`);
        } finally {
            isCompiling = false;
            updateCompileButtonState();
        }
    }

    // Set up event listener
    if (compileBtn) {
        compileBtn.addEventListener('click', compileFont);
    }

    // Keyboard shortcut: Cmd+B / Ctrl+B
    document.addEventListener('keydown', (e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'b') {
            e.preventDefault();
            if (!compileBtn.disabled) {
                compileFont();
            }
        }
    });

    // Listen for font changes to update button state
    window.addEventListener('fontLoaded', () => {
        updateCompileButtonState();
        // NOTE: Auto-compile disabled - font manager now handles compilation
        // The font manager compiles typing and editing fonts automatically
        // setTimeout(() => compileFont(), 100);
    });
    window.addEventListener('fontClosed', updateCompileButtonState);

    // Initial state
    updateCompileButtonState();

    // Export for external use
    window.compileFontButton = {
        compile: compileFont,
        updateState: updateCompileButtonState
    };

    console.log('✅ Compile button initialized');
})();
