// Script Editor for Python code execution
(function () {
    let editor = null;
    let runButton = null;
    let isScriptViewFocused = false;

    /**
     * Initialize the script editor
     */
    async function init() {
        // Wait for Ace to be loaded
        if (!window.ace) {
            console.error('Ace Editor not loaded');
            return;
        }

        const container = document.getElementById('script-editor');
        runButton = document.getElementById('run-script-btn');

        if (!container || !runButton) {
            console.error('Script editor elements not found');
            return;
        }

        // Load saved script from localStorage
        const savedScript =
            localStorage.getItem('python_script') ||
            '# Write your Python script here...\n';

        // Create Ace editor
        editor = ace.edit('script-editor');

        // Set theme based on current theme preference
        const getInitialTheme = () => {
            const savedTheme =
                localStorage.getItem('preferred-theme') || 'auto';
            if (savedTheme === 'auto') {
                const isDark = window.matchMedia(
                    '(prefers-color-scheme: dark)'
                ).matches;
                return isDark ? 'ace/theme/monokai' : 'ace/theme/chrome';
            }
            return savedTheme === 'light'
                ? 'ace/theme/chrome'
                : 'ace/theme/monokai';
        };

        editor.setTheme(getInitialTheme());
        editor.session.setMode('ace/mode/python');
        editor.setValue(savedScript, -1); // -1 moves cursor to start

        // Make editor globally accessible for theme updates
        window.scriptEditor = editor;

        // Set top margin on the container
        container.style.marginTop = '11px';

        // Configure editor options
        editor.setOptions({
            fontSize: '12px',
            fontFamily: "'IBM Plex Mono', monospace",
            showPrintMargin: false,
            highlightActiveLine: true,
            enableBasicAutocompletion: true,
            enableLiveAutocompletion: false,
            tabSize: 4,
            useSoftTabs: true, // Use spaces instead of tabs
            wrap: false
        });

        let cursorWidth = '7px';
        let opacityLevel = '0.5';

        // Force wider cursor by injecting custom style and directly manipulating the cursor
        setTimeout(() => {
            // Method 1: Add a style tag to override cursor width
            const styleId = 'ace-cursor-width-override';
            if (!document.getElementById(styleId)) {
                const style = document.createElement('style');
                style.id = styleId;
                style.textContent = `
                    .ace_cursor {
                        width: ${cursorWidth} !important;
                        // opacity: ${opacityLevel} !important;
                        top: 2px !important;
                        left: -0px !important;
                    }
                `;
                document.head.appendChild(style);
            }

            // Method 2: Direct DOM manipulation
            const cursorLayer = editor.renderer.$cursorLayer;
            if (cursorLayer && cursorLayer.element) {
                const cursor = cursorLayer.element.querySelector('.ace_cursor');
                if (cursor) {
                    cursor.style.width = cursorWidth;
                    cursor.style.borderLeftWidth = cursorWidth;
                    // cursor.style.opacity = opacityLevel;
                }
            }

            // Method 3: Update on every cursor move
            editor.renderer.on('afterRender', () => {
                const cursor = editor.container.querySelector('.ace_cursor');
                if (cursor && cursor.style.width !== cursorWidth) {
                    cursor.style.width = cursorWidth;
                    cursor.style.borderLeftWidth = cursorWidth;
                    // cursor.style.opacity = opacityLevel;
                }
            });
        }, 100);

        // Save to localStorage on change
        editor.session.on('change', function () {
            localStorage.setItem('python_script', editor.getValue());
        });

        // Add custom keyboard shortcuts
        editor.commands.addCommand({
            name: 'runScript',
            bindKey: { win: 'Ctrl-Alt-R', mac: 'Command-Alt-R' },
            exec: function () {
                runScript();
            }
        });

        // Remove default Cmd+K binding to prevent conflicts with global shortcut
        editor.commands.removeCommand('gotoline');

        // Add passthrough commands for global view shortcuts
        // Read shortcuts from VIEW_SETTINGS to avoid redundancy
        if (window.VIEW_SETTINGS && window.VIEW_SETTINGS.shortcuts) {
            Object.entries(window.VIEW_SETTINGS.shortcuts).forEach(
                ([viewId, config]) => {
                    const isMac =
                        navigator.platform.toUpperCase().indexOf('MAC') >= 0;
                    const modifierKey = isMac ? 'Command' : 'Ctrl';
                    const shiftKey = config.modifiers.shift ? 'Shift-' : '';
                    const key = config.key.toUpperCase();

                    editor.commands.addCommand({
                        name: `global_${viewId}`,
                        bindKey: {
                            win: `Ctrl-${shiftKey}${key}`,
                            mac: `${modifierKey}-${shiftKey}${key}`
                        },
                        exec: function () {
                            // Do nothing - let the global handler deal with it
                            // The global handler will intercept this in capture phase
                            return false;
                        },
                        readOnly: true,
                        passEvent: true // This tells Ace to pass the event through
                    });
                }
            );
        }

        // Run button click handler
        runButton.addEventListener('click', runScript);

        // Handle keyboard shortcuts when script view is focused
        document.addEventListener('keydown', (event) => {
            // Skip if event already handled
            if (event.defaultPrevented) return;

            const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
            const cmdKey = isMac ? event.metaKey : event.ctrlKey;
            const altKey = event.altKey;
            const code = event.code;

            // Check if Cmd+Alt+R and script view is focused
            if (cmdKey && altKey && code === 'KeyR' && isScriptViewFocused) {
                event.preventDefault();
                event.stopPropagation();
                runScript();
                return;
            }
        });

        // Track cursor position and focus state
        let savedCursorPosition = null;
        let isPreventingCursorJump = false;

        // Intercept ALL mouse events on the container when not focused
        container.addEventListener(
            'mousedown',
            (e) => {
                if (!isScriptViewFocused) {
                    // Save cursor position before any click
                    savedCursorPosition = editor.getCursorPosition();
                    isPreventingCursorJump = true;

                    // Prevent the event from reaching the editor
                    e.stopPropagation();
                    e.preventDefault();

                    // Manually trigger focus on the view
                    const scriptView = document.getElementById('view-scripts');
                    if (scriptView) {
                        scriptView.click();
                    }

                    // Restore cursor after focus
                    setTimeout(() => {
                        if (savedCursorPosition) {
                            editor.moveCursorToPosition(savedCursorPosition);
                            editor.clearSelection();
                        }
                        isPreventingCursorJump = false;
                    }, 50);
                }
            },
            true
        ); // Use capture phase to intercept before Ace

        // Listen for view focus events
        window.addEventListener('viewFocused', (event) => {
            isScriptViewFocused = event.detail.viewId === 'view-scripts';

            if (isScriptViewFocused && editor) {
                // Focus the editor
                editor.focus();

                // If we saved a position, restore it
                if (isPreventingCursorJump && savedCursorPosition) {
                    setTimeout(() => {
                        editor.moveCursorToPosition(savedCursorPosition);
                        editor.clearSelection();
                    }, 0);
                }
            }
        });

        console.log('Script editor initialized with Ace Editor');
    }

    /**
     * Run the Python script
     */
    async function runScript() {
        if (!editor) {
            console.error('Script editor not initialized');
            return;
        }

        if (!window.pyodide) {
            alert('Python environment not ready yet');
            return;
        }

        const code = editor.getValue().trim();
        if (!code) {
            alert('Please write some Python code first');
            return;
        }

        // Disable the run button while executing
        runButton.disabled = true;
        runButton.textContent = '⏳ Running...';

        try {
            // Run the Python code in the console terminal
            if (window.term) {
                // Print a separator in the console
                window.term.echo('---');
                window.term.echo('🚀 Running script...');

                // Execute the code
                await window.pyodide.runPythonAsync(code);

                window.term.echo('✅ Script completed');
            } else {
                // Fallback: just execute the code
                await window.pyodide.runPythonAsync(code);
                console.log('Script executed successfully');
            }

            // Play done sound
            if (window.playSound) {
                window.playSound('done');
            }
        } catch (error) {
            console.error('Script execution error:', error);

            // Store the full traceback for the AI assistant
            const fullTraceback = error.message;

            // Display error in the terminal console
            if (window.consoleError) {
                // Use the global console error function
                window.consoleError(error.message);
            } else if (window.term) {
                // Fallback to direct term.error
                try {
                    if (window.term.paused) {
                        window.term.resume();
                    }
                    window.term.error(error.message);
                } catch (e) {
                    console.error('Failed to display error in terminal:', e);
                }
            } else {
                console.error(
                    'Script error (terminal not available):',
                    error.message
                );
            }

            // Notify the AI assistant about the error
            if (window.aiAssistant && window.aiAssistant.addErrorFixMessage) {
                window.aiAssistant.addErrorFixMessage(fullTraceback, code);
            }
        } finally {
            // Re-enable the run button
            runButton.disabled = false;
            runButton.innerHTML =
                'Run <span style="opacity: 0.5;"><span class="material-symbols-outlined">keyboard_command_key</span><span class="material-symbols-outlined">keyboard_option_key</span>R</span>';
        }
    }

    // Initialize when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    // Expose scriptEditor API globally for other scripts
    window.scriptEditor = {
        get editor() {
            return editor;
        },
        runScript: runScript
    };
})();
