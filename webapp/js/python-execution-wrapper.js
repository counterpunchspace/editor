// Python Execution Wrapper
// Intercepts all Python code execution and logs it to the terminal

(function () {
    'use strict';

    // Wait for Pyodide to be loaded
    function initPythonWrapper() {
        if (!window.pyodide) {
            console.log('Waiting for Pyodide...');
            setTimeout(initPythonWrapper, 500);
            return;
        }

        console.log('🔧 Installing Python execution wrapper...');

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

        // Counter for execution tracking
        let executionCounter = 0;

        // Wrap runPythonAsync to log all Python code to BROWSER CONSOLE ONLY
        window.pyodide.runPythonAsync = async function (code, options) {
            executionCounter++;
            const execId = executionCounter;

            // Call before-execution hook
            if (window.beforePythonExecution) {
                window.beforePythonExecution();
            }

            // Log to browser console only (NOT terminal to avoid infinite loop)
            console.group(`🐍 Python Execution (Async) #${execId}`);
            console.log(code);
            console.groupEnd();

            // Execute the original function
            try {
                const result = await _originalRunPythonAsync(code, options);
                console.log(`✅ Execution #${execId} completed successfully`);
                return result;
            } catch (error) {
                console.error(`❌ Execution #${execId} failed:`, error.message);
                throw error;
            } finally {
                // Call after-execution hook (always, even on error)
                if (window.afterPythonExecution) {
                    window.afterPythonExecution();
                }
            }
        };

        // Wrap runPython (synchronous version used by console)
        window.pyodide.runPython = function (code, options) {
            executionCounter++;
            const execId = executionCounter;

            // Call before-execution hook
            if (window.beforePythonExecution) {
                window.beforePythonExecution();
            }

            // Log to browser console only (NOT terminal to avoid infinite loop)
            console.group(`🐍 Python Execution (Sync) #${execId}`);
            console.log(code);
            console.groupEnd();

            // Execute the original function
            try {
                const result = _originalRunPython(code, options);
                console.log(`✅ Execution #${execId} completed successfully`);
                return result;
            } catch (error) {
                console.error(`❌ Execution #${execId} failed:`, error.message);
                throw error;
            } finally {
                // Call after-execution hook (always, even on error)
                if (window.afterPythonExecution) {
                    window.afterPythonExecution();
                }
            }
        };

        console.log('✅ Python execution wrapper installed successfully');

        // For console commands, intercept when window.term is set
        // Use a property descriptor to hook into the assignment
        let _term = null;
        Object.defineProperty(window, 'term', {
            get: function () {
                return _term;
            },
            set: function (newTerm) {
                _term = newTerm;

                if (newTerm && newTerm.get_command) {
                    console.log(
                        '🔧 Terminal assigned, wrapping interpreter...'
                    );

                    // Get the current interpreter
                    const originalInterpreter = newTerm.get_command();

                    // Create a wrapped interpreter
                    const wrappedInterpreter = async function (command) {
                        if (command && command.trim()) {
                            executionCounter++;
                            const execId = executionCounter;

                            console.group(
                                `🐍 Python Console Command #${execId}`
                            );
                            console.log(command);
                            console.groupEnd();
                        }

                        // Call the original interpreter
                        return originalInterpreter.call(this, command);
                    };

                    // Replace the interpreter
                    newTerm.set_interpreter(wrappedInterpreter);

                    console.log('✅ Terminal interpreter wrapped successfully');
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
