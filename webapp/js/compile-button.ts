// Compile Button Handler
// Compiles the current font to TTF using the babelfont-fontc WASM module

import fontManager from './font-manager';

(function () {
    'use strict';

    const compileBtn = document.getElementById(
        'compile-font-btn'
    ) as HTMLButtonElement | null;
    let isCompiling = false;
    let worker: Worker | null = null;
    let workerReady = false;
    let compilationId = 0;
    let pendingCompilations = new Map();

    // Initialize the Web Worker
    async function initWorker() {
        if (worker) return workerReady;

        console.log('[CompileButton]', '🔧 Initializing fontc worker...');

        try {
            worker = new Worker('js/fontc-worker.js', { type: 'module' });

            worker.onmessage = (e) => {
                const { type, id, ttfBytes, duration, error, version } = e.data;

                if (type === 'ready') {
                    workerReady = true;
                    console.log(
                        '[CompileButton]',
                        '✅ Fontc worker ready:',
                        version
                    );
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
                console.error('[CompileButton]', '❌ Worker error:', e);
                workerReady = false;
            };

            // Send init message
            worker.postMessage({ type: 'init' });

            // Wait for ready
            await new Promise<void>((resolve, reject) => {
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
            console.error(
                '[CompileButton]',
                '❌ Failed to initialize worker:',
                error
            );
            return false;
        }
    }

    // Compile using the worker
    async function compileWithWorker(babelfontJson: string) {
        if (!workerReady) {
            throw new Error('Worker not ready');
        }

        const id = ++compilationId;

        return new Promise((resolve) => {
            pendingCompilations.set(id, resolve);
            worker!.postMessage({
                type: 'compile',
                id: id,
                data: { babelfontJson }
            });
        });
    }

    // Enable/disable compile button based on font availability
    function updateCompileButtonState() {
        const dropdown = document.getElementById(
            'open-fonts-dropdown'
        ) as HTMLSelectElement | null;
        const hasFontOpen =
            dropdown &&
            dropdown.options.length > 0 &&
            dropdown.value !== '' &&
            dropdown.options[0].textContent !== 'No fonts open';

        compileBtn!.disabled = !hasFontOpen || isCompiling;
    }

    // Compile the current font
    async function compileFont() {
        if (isCompiling) return;

        // Initialize worker if needed
        if (!workerReady) {
            console.log('[CompileButton]', 'Initializing worker...');
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
            const originalText = compileBtn!.textContent;
            compileBtn!.textContent = 'Compiling...';
            const startTime = performance.now();

            console.log('[CompileButton]', '🔨 Starting font compilation...');
            if (window.term) {
                window.term.echo('');
                window.term.echo('[[;cyan;]🔨 Compiling font to TTF...]');
            }

            // Get the font JSON from font manager
            let font = fontManager.currentFont;
            if (!font) {
                throw new Error('No font loaded');
            }
            const babelfontJson = font.babelfontJson;
            const fontPath = font.path;

            // Compile using the Web Worker
            const result: any = await compileWithWorker(babelfontJson);

            if (result.error) {
                throw new Error(result.error);
            }

            const { ttfBytes, duration } = result;
            console.log(
                '[CompileButton]',
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
            const outputPath = outputFilename;

            // Save directly to Pyodide's virtual filesystem using FS API (much faster than JSON roundtrip)
            window.pyodide.FS.writeFile(outputPath, ttfBytes);
            console.log('[CompileButton]', `💾 Saved to: ${outputPath}`);

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
                    `[[;gray;]  Compile: ${duration.toFixed(0)}ms]`
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
            compileBtn!.textContent = originalText;
        } catch (error: any) {
            console.error('[CompileButton]', '❌ Compilation failed:', error);

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
            if (!compileBtn!.disabled) {
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

    console.log('[CompileButton]', '✅ Compile button initialized');
})();
