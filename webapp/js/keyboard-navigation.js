// Keyboard Navigation System
(function () {
    let currentFocusedView = null;
    let isFocusing = false; // Prevent recursive focus calls

    // Get view settings from the global VIEW_SETTINGS object
    function getViewSettings() {
        if (!window.VIEW_SETTINGS) {
            console.error(
                'VIEW_SETTINGS not loaded! Make sure view-settings.js is loaded before keyboard-navigation.js'
            );
            return null;
        }
        return window.VIEW_SETTINGS;
    }

    /**
     * Resize a view to its configured minimum size
     */
    function resizeView(viewId) {
        const settings = getViewSettings();
        if (!settings) return;

        const resizeConfig = settings.resize[viewId];

        if (!resizeConfig) {
            console.warn('No resize configuration for view:', viewId);
            return;
        }

        const view = document.getElementById(viewId);
        if (!view) return;

        const container = document.querySelector('.container');
        const containerWidth = container.offsetWidth;
        const containerHeight = container.offsetHeight;

        // Enable transitions if configured
        if (settings.animation && settings.animation.enabled) {
            enableTransitions(
                settings.animation.duration,
                settings.animation.easing
            );
        }

        // Determine if view is in top or bottom row
        const isTopRow = view.closest('.top-row') !== null;
        const isBottomRow = view.closest('.bottom-row') !== null;

        if (isTopRow) {
            resizeTopRowView(
                viewId,
                view,
                resizeConfig,
                containerWidth,
                containerHeight
            );
        } else if (isBottomRow) {
            resizeBottomRowView(
                viewId,
                view,
                resizeConfig,
                containerWidth,
                containerHeight
            );
        }

        // Disable transitions after animation completes
        if (settings.animation && settings.animation.enabled) {
            setTimeout(() => {
                disableTransitions();
                // Save layout after resize completes
                if (window.resizableViews) {
                    window.resizableViews.saveLayout();
                }
            }, settings.animation.duration);
        } else {
            // Save immediately if no animation
            if (window.resizableViews) {
                window.resizableViews.saveLayout();
            }
        }
    }

    /**
     * Enable CSS transitions for smooth resizing
     */
    function enableTransitions(duration, easing) {
        const transition = `flex ${duration}ms ${easing}`;

        // Apply to all views and rows
        document
            .querySelectorAll('.view, .top-row, .bottom-row')
            .forEach((element) => {
                element.style.transition = transition;
            });
    }

    /**
     * Disable CSS transitions
     */
    function disableTransitions() {
        document
            .querySelectorAll('.view, .top-row, .bottom-row')
            .forEach((element) => {
                element.style.transition = '';
            });
    }

    /**
     * Resize a view in the top row
     */
    function resizeTopRowView(
        viewId,
        view,
        resizeConfig,
        containerWidth,
        containerHeight
    ) {
        const topRow = view.closest('.top-row');
        const views = Array.from(topRow.querySelectorAll('.view'));
        const viewIndex = views.indexOf(view);

        if (viewIndex === -1) return;

        // Calculate target dimensions
        const horizontalDividerHeight = 4;
        const availableHeight = containerHeight - horizontalDividerHeight;
        const targetViewWidth = containerWidth * resizeConfig.width;
        const targetViewHeight = availableHeight * resizeConfig.height;

        // Get current dimensions
        const currentWidth = view.offsetWidth;
        const currentHeight = topRow.offsetHeight;

        // Only resize if target is larger than current (minimum values)
        const shouldResizeWidth = targetViewWidth > currentWidth;
        const shouldResizeHeight = targetViewHeight > currentHeight;

        // Handle width resizing
        if (shouldResizeWidth && views.length > 1) {
            const otherView = views[1 - viewIndex]; // Get the other view in top row
            const otherTargetWidth = containerWidth - targetViewWidth;

            if (otherTargetWidth >= 100) {
                // Ensure minimum width for other view
                const totalWidth = targetViewWidth + otherTargetWidth;
                const viewFlex = targetViewWidth / totalWidth;
                const otherFlex = otherTargetWidth / totalWidth;

                view.style.flex = `${viewFlex}`;
                otherView.style.flex = `${otherFlex}`;
            }
        }

        // Handle height resizing
        if (shouldResizeHeight) {
            const bottomRow = document.querySelector('.bottom-row');
            const bottomTargetHeight = availableHeight - targetViewHeight;

            if (bottomTargetHeight >= 100) {
                // Ensure minimum height for bottom row
                const topFlex = targetViewHeight / availableHeight;
                const bottomFlex = bottomTargetHeight / availableHeight;

                topRow.style.flex = `${topFlex}`;
                bottomRow.style.flex = `${bottomFlex}`;
            }
        }
    }

    /**
     * Resize a view in the bottom row
     */
    function resizeBottomRowView(
        viewId,
        view,
        resizeConfig,
        containerWidth,
        containerHeight
    ) {
        const bottomRow = view.closest('.bottom-row');
        const topRow = document.querySelector('.top-row');
        const views = Array.from(bottomRow.querySelectorAll('.view'));
        const viewIndex = views.indexOf(view);

        if (viewIndex === -1) return;

        // Calculate target dimensions
        const horizontalDividerHeight = 4;
        const availableHeight = containerHeight - horizontalDividerHeight;
        const targetBottomHeight = availableHeight * resizeConfig.height;
        const targetViewWidth = containerWidth * resizeConfig.width;

        // Get current dimensions
        const currentBottomHeight = bottomRow.offsetHeight;
        const currentWidth = view.offsetWidth;

        // Only resize if target is larger than current (minimum values)
        const shouldResizeHeight = targetBottomHeight > currentBottomHeight;
        const shouldResizeWidth = targetViewWidth > currentWidth;

        // Handle height resizing (affects top/bottom split)
        if (shouldResizeHeight) {
            const topTargetHeight = availableHeight - targetBottomHeight;

            if (topTargetHeight >= 100) {
                // Ensure minimum height for top row
                const topFlex = topTargetHeight / availableHeight;
                const bottomFlex = targetBottomHeight / availableHeight;

                topRow.style.flex = `${topFlex}`;
                bottomRow.style.flex = `${bottomFlex}`;
            }
        }

        // Handle width resizing (affects bottom row column distribution)
        if (shouldResizeWidth && views.length > 1) {
            const remainingWidth = containerWidth - targetViewWidth;
            const otherViewsCount = views.length - 1;
            const remainingWidthPerView = remainingWidth / otherViewsCount;

            if (remainingWidthPerView >= 100) {
                // Ensure minimum width for other views
                const widths = {};

                // Distribute width to all views
                views.forEach((v, i) => {
                    if (i === viewIndex) {
                        // Set target width for the selected view
                        widths[i] = targetViewWidth;
                    } else {
                        // Distribute remaining width equally among ALL other views (left and right)
                        widths[i] = remainingWidthPerView;
                    }
                });

                // Calculate total width for flex calculation
                const totalWidth = Object.values(widths).reduce(
                    (sum, w) => sum + w,
                    0
                );

                // Apply flex values to ALL views in the bottom row
                views.forEach((v, i) => {
                    const flexValue = widths[i] / totalWidth;
                    v.style.flex = `${flexValue} 1 0%`;
                    console.log(
                        `View ${i} (${v.id}): flex = ${flexValue.toFixed(3)}, width = ${widths[i].toFixed(0)}px`
                    );
                });
            }
        }
    }

    /**
     * Blur the console terminal cursor
     */
    function blurConsole() {
        // Find and blur the actual hidden input element that jQuery Terminal uses
        const terminalInput = document.querySelector(
            '.cmd textarea, .cmd input, #console-container .terminal'
        );
        if (terminalInput) {
            // Use blur on the actual input element
            terminalInput.blur();
        }

        // Also try to blur any focused element within the console container
        const consoleContainer = document.getElementById('console-container');
        if (
            consoleContainer &&
            consoleContainer.contains(document.activeElement)
        ) {
            document.activeElement.blur();
        }
    }

    /**
     * Blur all bottom view editors (console, scripts, assistant)
     */
    function blurBottomViewEditors() {
        // Blur console terminal
        blurConsole();

        // Blur script editor (Ace Editor)
        // Try to get the Ace editor instance
        const scriptEditorElement = document.getElementById('script-editor');
        if (scriptEditorElement && window.ace) {
            try {
                const aceEditor = window.ace.edit('script-editor');
                if (aceEditor && aceEditor.blur) {
                    aceEditor.blur();
                }
                // Also blur the textarea used by Ace
                const aceTextarea =
                    scriptEditorElement.querySelector('textarea');
                if (aceTextarea) {
                    aceTextarea.blur();
                }
            } catch (e) {
                console.warn('Could not blur Ace editor:', e);
            }
        }

        // Blur AI assistant textarea
        const assistantPrompt = document.getElementById('ai-prompt');
        if (assistantPrompt) {
            assistantPrompt.blur();
        }
    }

    /**
     * Add CSS to hide cursors in unfocused bottom views
     */
    function addCursorHidingStyles() {
        const styleId = 'cursor-hiding-styles';
        if (!document.getElementById(styleId)) {
            const style = document.createElement('style');
            style.id = styleId;
            style.textContent = `
                /* Make Ace editor cursor visible but non-blinking when view is not focused */
                #view-scripts:not(.focused) .ace_cursor {
                    opacity: 0.3 !important;
                    animation: none !important;
                }
                
                /* Hide terminal cursor when view is not focused */
                #view-console:not(.focused) .cmd .cursor,
                #view-console:not(.focused) .cmd-cursor,
                #view-console:not(.focused) .terminal-output .cursor {
                    display: none !important;
                    opacity: 0 !important;
                }
                
                /* Hide blinking animation on terminal cursor */
                #view-console:not(.focused) .cmd span[data-text],
                #view-console:not(.focused) span.terminal-inverted {
                    animation: none !important;
                    background: transparent !important;
                }
            `;
            document.head.appendChild(style);
        }
    }

    /**
     * Focus a view by ID
     */
    function focusView(viewId) {
        // Prevent recursive calls
        if (isFocusing) {
            console.warn('focusView already in progress, skipping');
            return;
        }
        isFocusing = true;

        console.log('focusView called with:', viewId);

        // Remove focus from all views
        document.querySelectorAll('.view').forEach((view) => {
            view.classList.remove('focused');
        });

        // Add focus to the target view
        const view = document.getElementById(viewId);
        if (view) {
            view.classList.add('focused');
            currentFocusedView = viewId;

            // Save the last active view to localStorage
            localStorage.setItem('last_active_view', viewId);

            // Determine if we're focusing a top view (editor or fontinfo)
            const isTopView =
                viewId === 'view-editor' || viewId === 'view-fontinfo';

            // If focusing a top view, blur all bottom view editors
            if (isTopView) {
                blurBottomViewEditors();
            }

            // Blur console for all non-console views first
            if (viewId !== 'view-console') {
                blurConsole();
            }

            // If activating scripts, focus the script editor after blurring console
            if (viewId === 'view-scripts') {
                setTimeout(() => {
                    const scriptEditor =
                        document.getElementById('script-editor');
                    if (scriptEditor) {
                        scriptEditor.focus();
                        scriptEditor.click();
                    }
                }, 100);
            }

            // If activating console, blur the assistant's text field and focus terminal
            if (viewId === 'view-console') {
                const prompt = document.getElementById('ai-prompt');
                if (prompt) {
                    prompt.blur();
                }

                // Focus the terminal
                setTimeout(() => {
                    // Try to get terminal instance from window.term or directly from jQuery
                    let term = window.term;

                    // If window.term doesn't exist, try to get it from the jQuery terminal plugin
                    if (!term) {
                        const consoleElement = $('#console-container');
                        if (consoleElement.length && consoleElement.terminal) {
                            term = consoleElement.terminal();
                        }
                    }

                    if (term && term.focus) {
                        // Call terminal focus method
                        term.focus();
                    }

                    // Always try to focus the input element directly as well
                    const cmdInput = document.querySelector(
                        '#console-container .cmd textarea'
                    );
                    if (cmdInput) {
                        cmdInput.focus();
                    }
                }, 50);
            }

            // If activating assistant, focus and scroll
            if (viewId === 'view-assistant') {
                // Focus on the assistant's text input field and scroll to bottom
                setTimeout(() => {
                    const prompt = document.getElementById('ai-prompt');
                    if (prompt) {
                        prompt.focus();
                        prompt.click();
                    }

                    // Scroll the view-content to bottom
                    const viewContent = document.querySelector(
                        '#view-assistant .view-content'
                    );
                    if (viewContent) {
                        viewContent.scrollTop = viewContent.scrollHeight;
                    }
                }, 100);
            }

            // If activating editor, focus the canvas
            if (viewId === 'view-editor') {
                setTimeout(() => {
                    if (window.glyphCanvas && window.glyphCanvas.canvas) {
                        window.glyphCanvas.canvas.focus();
                    }
                }, 100);
            }

            // Trigger any view-specific focus handlers
            const event = new CustomEvent('viewFocused', {
                detail: { viewId }
            });
            window.dispatchEvent(event);
        }

        // Reset the flag after a short delay
        setTimeout(() => {
            isFocusing = false;
        }, 200);
    }

    /**
     * Handle keyboard shortcuts
     */
    function handleKeyDown(event) {
        const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
        const cmdKey = isMac ? event.metaKey : event.ctrlKey;
        const shiftKey = event.shiftKey;
        const key = event.key.toLowerCase();

        const settings = getViewSettings();
        if (!settings) return;

        const shortcuts = settings.shortcuts;

        // Check each view's shortcut
        for (const [viewId, config] of Object.entries(shortcuts)) {
            if (config.modifiers.cmd && !cmdKey) continue;
            if (config.modifiers.shift && !shiftKey) continue;
            if (key === config.key) {
                event.preventDefault();
                event.stopPropagation();
                event.stopImmediatePropagation();

                // Check if this view is already focused
                if (currentFocusedView === viewId) {
                    // View is already focused, trigger resize
                    resizeView(viewId);
                } else {
                    // View is not focused, just focus it
                    focusView(viewId);
                }
                return;
            }
        }
    }

    /**
     * Handle view clicks for focus
     */
    function handleViewClick(event) {
        // Find the closest parent view element
        const view = event.currentTarget;
        if (view && view.id) {
            // Only focus if not already focused to avoid unnecessary operations
            if (!view.classList.contains('focused')) {
                focusView(view.id);
            }
        }
    }

    /**
     * Initialize keyboard navigation
     */
    function init() {
        // Add cursor hiding styles
        addCursorHidingStyles();

        // Add keyboard event listener in CAPTURE phase to intercept before Ace Editor
        document.addEventListener('keydown', handleKeyDown, true);

        // Add click listeners to all views
        document.querySelectorAll('.view').forEach((view) => {
            view.addEventListener('click', handleViewClick);
        });

        console.log('Keyboard navigation initialized');
    }

    // Initialize when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    // Expose focusView globally for other scripts
    window.focusView = focusView;
})();
