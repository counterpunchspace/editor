// Official Pyodide Console integration
// Based on https://github.com/pyodide/pyodide/blob/main/src/templates/console.html

function sleep(s) {
    return new Promise((resolve) => setTimeout(resolve, s));
}

async function initPyodideConsole() {
    'use strict';

    let term;
    let pyodide;
    let pyconsole;
    let namespace;
    let await_fut;

    // Hide loading spinner initially
    document.getElementById('loading').style.display = 'block';

    try {
        // Load Pyodide
        pyodide = await loadPyodide({
            stdin: () => {
                let result = prompt();
                echo(result);
                return result;
            }
        });

        // Make pyodide globally available
        window.pyodide = pyodide;
        globalThis.pyodide = pyodide;

        // Import console components
        let { repr_shorten, BANNER, PyodideConsole } =
            pyodide.pyimport('pyodide.console');

        BANNER =
            `Welcome to the Pyodide ${pyodide.version} terminal emulator 🐍\n` +
            BANNER;
        pyconsole = PyodideConsole(pyodide.globals);

        namespace = pyodide.globals.get('dict')();
        await_fut = pyodide.runPython(
            `
      import builtins
      from pyodide.ffi import to_js

      async def await_fut(fut):
          res = await fut
          if res is not None:
              builtins._ = res
          return to_js([res], depth=1)

      await_fut
      `,
            { globals: namespace }
        );
        namespace.destroy();

        const echo = (msg, ...opts) =>
            term.echo(
                msg
                    .replaceAll(']]', '&rsqb;&rsqb;')
                    .replaceAll('[[', '&lsqb;&lsqb;'),
                ...opts
            );

        const ps1 = '>>> ';
        const ps2 = '... ';

        async function lock() {
            let resolve;
            const ready = term.ready;
            term.ready = new Promise((res) => (resolve = res));
            await ready;
            return resolve;
        }

        async function interpreter(command) {
            // Call before-execution hook
            if (window.beforePythonExecution) {
                window.beforePythonExecution();
            }

            // Log command to browser console
            if (command && command.trim()) {
                console.group('🐍 Python Console Command');
                console.log(command);
                console.groupEnd();
            }

            const unlock = await lock();
            term.pause();
            // multiline should be split (useful when pasting)
            for (const c of command.split('\n')) {
                const escaped = c.replaceAll(/\u00a0/g, ' ');
                const fut = pyconsole.push(escaped);
                term.set_prompt(fut.syntax_check === 'incomplete' ? ps2 : ps1);
                switch (fut.syntax_check) {
                    case 'syntax-error':
                        term.error(fut.formatted_error.trimEnd());
                        continue;
                    case 'incomplete':
                        continue;
                    case 'complete':
                        break;
                    default:
                        throw new Error(`Unexpected type ${fut.syntax_check}`);
                }
                // In JavaScript, await automatically also awaits any results of
                // awaits, so if an async function returns a future, it will await
                // the inner future too. This is not what we want so we
                // temporarily put it into a list to protect it.
                const wrapped = await_fut(fut);
                // complete case, get result / error and print it.
                try {
                    const [value] = await wrapped;
                    if (value !== undefined) {
                        echo(
                            repr_shorten.callKwargs(value, {
                                separator: '\n<long output truncated>\n'
                            })
                        );
                    }
                    if (value instanceof pyodide.ffi.PyProxy) {
                        value.destroy();
                    }

                    // Log completion to browser console
                    console.log('✅ Console command completed successfully');

                    // Play done sound after successful execution
                    if (window.playSound) {
                        window.playSound('done');
                    }
                } catch (e) {
                    // Log error to browser console
                    console.error('❌ Console command failed:', e.message || e);
                    if (e.constructor.name === 'PythonError') {
                        const message = fut.formatted_error || e.message;
                        term.error(message.trimEnd());
                    } else {
                        throw e;
                    }
                } finally {
                    fut.destroy();
                    wrapped.destroy();
                }
            }
            term.resume();
            await sleep(10);
            unlock();

            // Call after-execution hook (always, after all commands processed)
            if (window.afterPythonExecution) {
                window.afterPythonExecution();
            }
        }

        // Initialize terminal in the console container
        term = $('#console-container').terminal(interpreter, {
            greetings: BANNER,
            prompt: ps1,
            completionEscape: false,
            completion: function (command, callback) {
                callback(pyconsole.complete(command).toJs()[0]);
            },
            keymap: {
                'CTRL+C': async function (event, original) {
                    pyconsole.buffer.clear();
                    term.enter();
                    echo('KeyboardInterrupt');
                    term.set_command('');
                    term.set_prompt(ps1);
                },
                'CTRL+K': function (event, original) {
                    // Clear the terminal output
                    term.clear();
                    return false;
                },
                'META+K': function (event, original) {
                    // Clear the terminal output (for macOS cmd+k)
                    term.clear();
                    return false;
                },
                'TAB': (event, original) => {
                    const command = term.before_cursor();
                    // Disable completion for whitespaces.
                    if (command.trim() === '') {
                        term.insert('\t');
                        return false;
                    }
                    return original(event);
                }
            }
        });

        window.term = term;

        // Add custom wheel event handler to reduce scrolling speed
        // Wait a bit for terminal to fully initialize
        setTimeout(() => {
            const consoleContainer =
                document.getElementById('console-container');

            console.log('Setting up wheel handler for console-container');

            if (consoleContainer) {
                consoleContainer.addEventListener(
                    'wheel',
                    function (e) {
                        e.preventDefault();
                        e.stopPropagation();

                        console.log('Wheel event captured, deltaY:', e.deltaY);

                        // Find the actual scrollable element - could be terminal-scroller or terminal-output
                        let scrollableElement =
                            consoleContainer.querySelector(
                                '.terminal-scroller'
                            );
                        if (
                            !scrollableElement ||
                            scrollableElement.scrollHeight <=
                                scrollableElement.clientHeight
                        ) {
                            scrollableElement =
                                consoleContainer.querySelector(
                                    '.terminal-output'
                                );
                        }
                        if (
                            !scrollableElement ||
                            scrollableElement.scrollHeight <=
                                scrollableElement.clientHeight
                        ) {
                            scrollableElement =
                                consoleContainer.querySelector('.terminal');
                        }

                        if (!scrollableElement) {
                            console.log('No scrollable element found');
                            return;
                        }

                        console.log(
                            'Scrolling element:',
                            scrollableElement.className,
                            'current scrollTop:',
                            scrollableElement.scrollTop
                        );

                        // Reduce scroll speed by dividing deltaY by 20
                        const scrollAmount = e.deltaY / 2;
                        scrollableElement.scrollTop += scrollAmount;
                        console.log(
                            'Scrolled to:',
                            scrollableElement.scrollTop
                        );
                    },
                    { passive: false, capture: true }
                );
            }
        }, 500);

        // Helper function to play error sound
        const playErrorSound = () => {
            if (window.playSound) {
                window.playSound('error');
            } else {
                // Fallback if preloader not loaded yet
                const errorSound = new Audio('assets/sounds/error.wav');
                errorSound
                    .play()
                    .catch((e) =>
                        console.warn('Could not play error sound:', e)
                    );
            }
        };

        pyconsole.stdout_callback = (s) => {
            // Filter system messages from interactive console too
            if (isSystemMessage(s)) {
                console.log('[Pyodide Interactive]:', s.trim());
                return;
            }
            echo(s, { newline: false });
        };
        pyconsole.stderr_callback = (s) => {
            // Filter stderr system messages from interactive console
            if (isSystemMessage(s)) {
                console.warn('[Pyodide Interactive]:', s.trim());
                return;
            }
            term.error(s.trimEnd());
        };
        term.ready = Promise.resolve();

        // Wrap term.error to play error sound on ALL error calls
        const originalTermError = term.error.bind(term);
        term.error = function (...args) {
            playErrorSound();
            return originalTermError(...args);
        };

        // Make console output functions globally available
        window.consoleEcho = echo;
        window.consoleError = (s) => term.error(s);

        // Filter function to identify system messages vs user print output
        function isSystemMessage(message) {
            const systemPatterns = [
                /^Loading\s+\w+/i,
                /^Loaded\s+\w+/i,
                /^Installing\s+\w+/i,
                /^Installed\s+\w+/i,
                /^Downloading\s+/i,
                /^Downloaded\s+/i,
                /^Building\s+/i,
                /^Built\s+/i,
                /^Collecting\s+/i,
                /^Successfully\s+installed\s+/i,
                /^Requirement\s+already\s+satisfied/i,
                /^WARNING:\s+/i,
                /^Note:\s+/i,
                /micropip\s+install/i,
                /package\s+installed/i,
                /imported\s+successfully/i,
                /^Initializing/i,
                /^FontEditor/i
            ];

            return systemPatterns.some((pattern) =>
                pattern.test(message.trim())
            );
        }

        // Set global stdout/stderr callbacks for pyodide.runPython() calls
        pyodide.setStdout({
            batched: (s) => {
                // Filter out system messages - send them to browser console instead
                if (isSystemMessage(s)) {
                    console.log('[Pyodide System]:', s.trim());
                    return;
                }

                // Only show user print() output in the Python console
                if (s && !s.endsWith('\n')) {
                    echo(s); // Default behavior adds newline
                } else {
                    echo(s, { newline: false });
                }
            }
        });
        pyodide.setStderr({
            batched: (s) => {
                // Filter stderr system messages too
                if (isSystemMessage(s)) {
                    console.warn('[Pyodide System]:', s.trim());
                    return;
                }
                term.error(s.trimEnd());
            }
        });

        pyodide._api.on_fatal = async (e) => {
            if (e.name === 'Exit') {
                term.error(e);
                term.error('Pyodide exited and can no longer be used.');
            } else {
                term.error(
                    'Pyodide has suffered a fatal error. Please report this to the Pyodide maintainers.'
                );
                term.error('The cause of the fatal error was:');
                term.error(e);
                term.error('Look in the browser console for more details.');
            }
            await term.ready;
            term.pause();
            await sleep(15);
            term.pause();
        };

        // Wrap pyodide.runPython to handle errors properly
        const pyodide_py = pyodide.runPython;
        pyodide.runPython = (...args) => {
            try {
                const result = pyodide_py(...args);
                if (result && typeof result.then !== 'undefined') {
                    return result
                        .then((r) => {
                            if (r && r.toJs) {
                                r = r.toJs();
                            }
                            return r;
                        })
                        .catch((e) => {
                            // Handle Python exceptions and display in console
                            if (e.constructor.name === 'PythonError') {
                                term.error(e.message);
                            } else {
                                term.error(e.toString());
                            }
                            throw e; // Re-throw for caller to handle if needed
                        });
                } else {
                    if (result && result.toJs) {
                        return result.toJs();
                    }
                    return result;
                }
            } catch (e) {
                // Handle synchronous Python exceptions
                if (e.constructor.name === 'PythonError') {
                    term.error(e.message);
                } else {
                    term.error(e.toString());
                }
                throw e; // Re-throw for caller to handle if needed
            }
        };

        // Set up directory mounting if supported
        if ('showDirectoryPicker' in window) {
            async function mountDirectory() {
                const opts = {
                    mode: 'readwrite'
                };
                const { get, set } =
                    await import('https://cdn.skypack.dev/idb-keyval');
                const pyodideDirectory = '/home/pyodide';
                const directoryKey = 'pyodide-directory-handle';
                let directoryHandle = await get(directoryKey);
                if (!directoryHandle) {
                    directoryHandle = await showDirectoryPicker(opts);
                    await set(directoryKey, directoryHandle);
                }
                const permissionStatus =
                    await directoryHandle.requestPermission(opts);
                if (permissionStatus !== 'granted') {
                    throw new Error(
                        'readwrite access to directory not granted'
                    );
                }
                await pyodide.mountNativeFS(pyodideDirectory, directoryHandle);
            }
            globalThis.mountDirectory = mountDirectory;
        }

        // Hide loading spinner
        document.getElementById('loading').style.display = 'none';

        // Focus on terminal
        term.focus();
    } catch (error) {
        console.error('Error initializing Pyodide console:', error);
        document.getElementById('loading').innerHTML = `
      <div style="color: red; padding: 20px;">
        Error loading Python console: ${error.message}
      </div>
    `;
    }
}

// Global function to safely clear the console
window.clearConsole = function () {
    // Try window.term first
    if (window.term && typeof window.term.clear === 'function') {
        window.term.clear();
        return true;
    }

    // Fallback: try to get terminal directly from jQuery
    const terminalElement = $('#console-container');
    if (terminalElement.length && terminalElement.terminal) {
        const term = terminalElement.terminal();
        if (term && typeof term.clear === 'function') {
            term.clear();
            return true;
        }
    }

    console.warn('Console terminal not yet initialized');
    return false;
};

// Global keyboard shortcut for Cmd+K to clear console
document.addEventListener('keydown', (event) => {
    // Skip if event already handled
    if (event.defaultPrevented) return;

    const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
    const cmdKey = isMac ? event.metaKey : event.ctrlKey;
    const shiftKey = event.shiftKey;
    const code = event.code;

    // Check if Cmd+K (without Shift or Alt) to clear console
    if (cmdKey && !event.altKey && !shiftKey && code === 'KeyK') {
        event.preventDefault();
        event.stopPropagation();
        window.clearConsole();
        return;
    }
});

// Initialize when DOM is ready and container exists
document.addEventListener('DOMContentLoaded', () => {
    // Wait a bit for the view to be properly rendered
    setTimeout(() => {
        if (document.getElementById('console-container')) {
            initPyodideConsole();
        }
    }, 100);

    // Add click handler for Clear button
    const clearButton = document.getElementById('clear-console-btn');
    if (clearButton) {
        clearButton.addEventListener('click', (event) => {
            event.stopPropagation(); // Prevent view focus
            window.clearConsole();
        });
    }
});
