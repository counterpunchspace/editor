// Python Execution Wrapper
// Intercepts all Python code execution and logs it to the terminal

(function () {
    'use strict';

    // Wait for Pyodide to be loaded
    function initPythonWrapper() {
        if (!window.pyodide) {
            console.log('[PythonExec]', 'Waiting for Pyodide...');
            setTimeout(initPythonWrapper, 500);
            return;
        }

        if (window.pyodide.__counterpunchPythonExecutionWrapperInstalled) {
            return;
        }

        console.log(
            '[PythonExec]',
            '🔧 Installing Python execution wrapper...'
        );

        // Store the original functions
        const _originalRunPythonAsync = window.pyodide.runPythonAsync.bind(
            window.pyodide
        );
        const _originalRunPython = window.pyodide.runPython.bind(
            window.pyodide
        );

        // Expose original functions so they can be called directly when needed
        // (e.g., for internal checks that shouldn't trigger UI updates)
        window.pyodide._originalRunPythonAsync = _originalRunPythonAsync;
        window.pyodide._originalRunPython = _originalRunPython;
        window.pyodide.__counterpunchPythonExecutionWrapperInstalled = true;

        // Counter for execution tracking
        let executionCounter = 0;

        // Wrap runPythonAsync to log all Python code to BROWSER CONSOLE ONLY
        window.pyodide.runPythonAsync = async function (
            code: string,
            options?: unknown
        ) {
            executionCounter++;
            const execId = executionCounter;
            const totalStartTime = performance.now();

            // Call before-execution hook. Keep this run's context: a second
            // overlapping call replaces the global one.
            let historyContext: Window['pythonExecutionHistoryContext'] = null;
            if (window.beforePythonExecution) {
                const hookStartTime = performance.now();
                const returned = await window.beforePythonExecution(code);
                if (
                    returned &&
                    typeof returned === 'object' &&
                    'beforeFontDataJson' in returned
                ) {
                    historyContext = returned;
                }
                const hookDuration = performance.now() - hookStartTime;
                if (hookDuration > 10) {
                    console.log(
                        '[PythonExec]',
                        `⏱️ beforePythonExecution hook #${execId} took ${hookDuration.toFixed(1)}ms`
                    );
                }
            }

            // Log to browser console only (NOT terminal to avoid infinite loop)
            console.group(`🐍 Python Execution (Async) #${execId}`);
            console.log(
                '[PythonExec]',
                code.substring(0, 200) + (code.length > 200 ? '...' : '')
            );
            console.groupEnd();

            let succeeded = false;

            // Execute the original function
            try {
                const execStartTime = performance.now();
                const result = await _originalRunPythonAsync(code, options);
                succeeded = true;
                const execDuration = performance.now() - execStartTime;
                console.log(
                    '[PythonExec]',
                    `✅ Execution #${execId} completed in ${execDuration.toFixed(1)}ms`
                );
                return result;
            } catch (error) {
                const errorMessage =
                    error instanceof Error ? error.message : String(error);
                const sanitizedMessage =
                    typeof window.sanitizePythonRuntimeError === 'function'
                        ? window.sanitizePythonRuntimeError(errorMessage)
                        : errorMessage;
                console.error(
                    '[PythonExec]',
                    `❌ Execution #${execId} failed:`,
                    sanitizedMessage
                );
                if (
                    error instanceof Error &&
                    error.message !== sanitizedMessage
                ) {
                    try {
                        error.message = sanitizedMessage;
                    } catch {
                        // Some host Error objects freeze message.
                    }
                }
                throw error;
            } finally {
                // Call after-execution hook (always, even on error)
                if (window.afterPythonExecution) {
                    const afterHookStart = performance.now();
                    await window.afterPythonExecution(
                        { succeeded },
                        historyContext
                    );
                    const afterHookDuration =
                        performance.now() - afterHookStart;
                    if (afterHookDuration > 10) {
                        console.log(
                            '[PythonExec]',
                            `⏱️ afterPythonExecution hook #${execId} took ${afterHookDuration.toFixed(1)}ms`
                        );
                    }
                }

                const totalDuration = performance.now() - totalStartTime;
                console.log(
                    '[PythonExec]',
                    `⏱️ TOTAL time for execution #${execId}: ${totalDuration.toFixed(1)}ms`
                );
            }
        };

        // Wrap runPython (synchronous version used by console)
        window.pyodide.runPython = function (code: string, options?: unknown) {
            executionCounter++;
            const execId = executionCounter;

            // Call before-execution hook (sync version - no await)
            let historyContext: Window['pythonExecutionHistoryContext'] = null;
            if (window.beforePythonExecution) {
                const hookResult = window.beforePythonExecution(code);
                if (
                    hookResult &&
                    typeof hookResult === 'object' &&
                    'beforeFontDataJson' in hookResult
                ) {
                    historyContext = hookResult;
                } else if (
                    hookResult &&
                    typeof (hookResult as Promise<unknown>).then === 'function'
                ) {
                    // Sync Python cannot wait for an async before-hook.
                    console.warn(
                        '[PythonExec]',
                        'beforePythonExecution hook returned a promise in sync context - cannot await'
                    );
                }
            }

            // Log to browser console only (NOT terminal to avoid infinite loop)
            console.group(`🐍 Python Execution (Sync) #${execId}`);
            console.log('[PythonExec]', code);
            console.groupEnd();

            let succeeded = false;

            // Execute the original function
            try {
                const result = _originalRunPython(code, options);
                succeeded = true;
                console.log(
                    '[PythonExec]',
                    `✅ Execution #${execId} completed successfully`
                );
                return result;
            } catch (error) {
                const errorMessage =
                    error instanceof Error ? error.message : String(error);
                const sanitizedMessage =
                    typeof window.sanitizePythonRuntimeError === 'function'
                        ? window.sanitizePythonRuntimeError(errorMessage)
                        : errorMessage;
                console.error(
                    '[PythonExec]',
                    `❌ Execution #${execId} failed:`,
                    sanitizedMessage
                );
                if (
                    error instanceof Error &&
                    error.message !== sanitizedMessage
                ) {
                    try {
                        error.message = sanitizedMessage;
                    } catch {
                        // Some host Error objects freeze message.
                    }
                }
                throw error;
            } finally {
                // Call after-execution hook (always, even on error)
                if (window.afterPythonExecution) {
                    console.log(
                        '[PythonExec]',
                        `🪝 Calling afterPythonExecution hook for sync #${execId}`
                    );
                    const hookResult = window.afterPythonExecution(
                        { succeeded },
                        historyContext
                    );
                    if (hookResult && typeof hookResult.then === 'function') {
                        console.warn(
                            '[PythonExec]',
                            'afterPythonExecution hook returned a promise in sync context - cannot await'
                        );
                    }
                } else {
                    console.warn(
                        '[PythonExec]',
                        `⚠️ No afterPythonExecution hook registered for sync #${execId}`
                    );
                }
            }
        };

        console.log(
            '[PythonExec]',
            '✅ Python execution wrapper installed successfully'
        );

        // For console commands, intercept when window.term is set
        // Use a property descriptor to hook into the assignment
        let _term: any = null;
        Object.defineProperty(window, 'term', {
            get: function () {
                return _term;
            },
            set: function (newTerm: any) {
                _term = newTerm;

                if (newTerm && newTerm.get_command) {
                    console.log(
                        '[PythonExec]',
                        '🔧 Terminal assigned, wrapping interpreter...'
                    );

                    // Get the current interpreter
                    const originalInterpreter = newTerm.get_command();

                    // Create a wrapped interpreter
                    const wrappedInterpreter = async function (
                        this: any,
                        command: string
                    ) {
                        if (command && command.trim()) {
                            executionCounter++;
                            const execId = executionCounter;

                            console.group(
                                `🐍 Python Console Command #${execId}`
                            );
                            console.log('[PythonExec]', command);
                            console.groupEnd();
                        }

                        // Call the original interpreter
                        return originalInterpreter.call(this, command);
                    };

                    // Replace the interpreter
                    newTerm.set_interpreter(wrappedInterpreter);

                    console.log(
                        '[PythonExec]',
                        '✅ Terminal interpreter wrapped successfully'
                    );
                }
            },
            configurable: true
        });
    }

    // Start initialization when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initPythonWrapper);
    } else {
        initPythonWrapper();
    }
})();
