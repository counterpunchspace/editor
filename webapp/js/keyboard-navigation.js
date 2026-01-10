// Keyboard Navigation System
(function () {
    let currentFocusedView = null;
    let isFocusing = false; // Prevent recursive focus calls

    // Get view settings from the global VIEW_SETTINGS object
    function getViewSettings() {
        if (!window.VIEW_SETTINGS) {
            console.error(
                '[KeyboardNav]',
                '[KeyboardNav]',
                'VIEW_SETTINGS not loaded! Make sure view-settings.js is loaded before keyboard-navigation.js'
            );
            return null;
        }
        return window.VIEW_SETTINGS;
    }

    /**
     * Update collapsed states on views after resize
     */
    function updateCollapsedStates() {
        if (
            window.resizableViews &&
            window.resizableViews.updateCollapsedStates
        ) {
            window.resizableViews.updateCollapsedStates();
        }
    }

    /**
     * Expand view on activation if it's below threshold
     * Returns true if expansion was performed
     */
    function expandViewOnActivation(viewId) {
        const settings = getViewSettings();
        if (!settings || !settings.activation) return false;

        const view = document.getElementById(viewId);
        if (!view) return false;

        const container = document.querySelector('.container');
        const containerWidth = container.offsetWidth;
        const containerHeight = container.offsetHeight;
        const horizontalDividerHeight = 4;
        const availableHeight = containerHeight - horizontalDividerHeight;

        const isTopRow = view.closest('.top-row') !== null;
        const isBottomRow = view.closest('.bottom-row') !== null;

        // Enable transitions if configured
        if (settings.animation && settings.animation.enabled) {
            enableTransitions(
                settings.animation.duration,
                settings.animation.easing
            );
        }

        let expanded = false;

        if (viewId === 'view-editor') {
            // Editor view - expand if below threshold
            const config = settings.activation.editor;
            const topRow = view.closest('.top-row');
            const topRowViews = Array.from(topRow.querySelectorAll('.view'));
            const viewIndex = topRowViews.indexOf(view);

            const currentWidth = view.offsetWidth;
            const currentHeight = topRow.offsetHeight;
            const widthRatio = currentWidth / containerWidth;
            const heightRatio = currentHeight / availableHeight;

            console.log('[KeyboardNav]', 'Editor activation check:', {
                currentWidth,
                currentHeight,
                containerWidth,
                availableHeight,
                widthRatio: widthRatio.toFixed(3),
                heightRatio: heightRatio.toFixed(3),
                widthThreshold: config.widthThreshold,
                heightThreshold: config.heightThreshold
            });

            if (widthRatio < config.widthThreshold) {
                // Expand width
                const targetWidth = containerWidth * config.widthTarget;
                const otherView = topRowViews[1 - viewIndex];
                const otherWidth = containerWidth - targetWidth;

                console.log('[KeyboardNav]', 'Expanding editor width:', {
                    targetWidth,
                    otherWidth
                });

                if (otherWidth >= 24) {
                    const totalWidth = targetWidth + otherWidth;
                    view.style.flex = `${targetWidth / totalWidth}`;
                    otherView.style.flex = `${otherWidth / totalWidth}`;
                    expanded = true;
                }
            }

            if (heightRatio < config.heightThreshold) {
                // Expand height
                const targetHeight = availableHeight * config.heightTarget;
                const bottomRow = document.querySelector('.bottom-row');
                const bottomHeight = availableHeight - targetHeight;

                console.log('[KeyboardNav]', 'Expanding editor height:', {
                    targetHeight,
                    bottomHeight,
                    topFlex: (targetHeight / availableHeight).toFixed(3),
                    bottomFlex: (bottomHeight / availableHeight).toFixed(3)
                });

                if (bottomHeight >= 24) {
                    topRow.style.flex = `${targetHeight / availableHeight}`;
                    bottomRow.style.flex = `${bottomHeight / availableHeight}`;
                    expanded = true;
                }
            }
        } else if (viewId === 'view-fontinfo') {
            // Font info view - expand by width if below threshold
            const config = settings.activation.fontinfo;
            const topRow = view.closest('.top-row');
            const topRowViews = Array.from(topRow.querySelectorAll('.view'));
            const viewIndex = topRowViews.indexOf(view);

            const currentWidth = view.offsetWidth;
            const widthRatio = currentWidth / containerWidth;

            if (widthRatio < config.widthThreshold) {
                // Expand width
                const targetWidth = containerWidth * config.widthTarget;
                const otherView = topRowViews[1 - viewIndex];
                const otherWidth = containerWidth - targetWidth;

                if (otherWidth >= 200) {
                    // Ensure editor keeps min size
                    const totalWidth = targetWidth + otherWidth;
                    view.style.flex = `${targetWidth / totalWidth}`;
                    otherView.style.flex = `${otherWidth / totalWidth}`;
                    expanded = true;
                }
            }
        } else if (isBottomRow) {
            // Secondary views in bottom row - expand by height if below threshold
            const config = settings.activation.secondary;
            const bottomRow = view.closest('.bottom-row');
            const topRow = document.querySelector('.top-row');

            const currentHeight = bottomRow.offsetHeight;
            const heightRatio = currentHeight / availableHeight;

            if (heightRatio < config.heightThreshold) {
                // Expand height
                const targetHeight = availableHeight * config.heightTarget;
                const topHeight = availableHeight - targetHeight;

                if (topHeight >= 200) {
                    // Ensure top row keeps editor min size
                    topRow.style.flex = `${topHeight / availableHeight}`;
                    bottomRow.style.flex = `${targetHeight / availableHeight}`;
                    expanded = true;
                }
            }
        }

        // Disable transitions and update collapsed states after animation
        if (settings.animation && settings.animation.enabled) {
            setTimeout(() => {
                disableTransitions();
                updateCollapsedStates();
                if (window.resizableViews) {
                    window.resizableViews.saveLayout();
                }
            }, settings.animation.duration);
        } else {
            updateCollapsedStates();
            if (window.resizableViews) {
                window.resizableViews.saveLayout();
            }
        }

        return expanded;
    }

    /**
     * Resize a view based on secondary shortcut behavior
     * - 'maximize': Resize to maximize values (for editor)
     * - 'expandToTarget': Expand to activation target if smaller (for secondary views)
     */
    function resizeView(viewId) {
        const settings = getViewSettings();
        if (!settings) return;

        const shortcutConfig = settings.shortcuts[viewId];
        if (!shortcutConfig) return;

        const secondaryBehavior = shortcutConfig.secondaryBehavior;
        if (!secondaryBehavior) {
            console.log(
                '[KeyboardNav]',
                'No secondary behavior for view:',
                viewId
            );
            return;
        }

        const view = document.getElementById(viewId);
        if (!view) return;

        const container = document.querySelector('.container');
        const containerWidth = container.offsetWidth;
        const containerHeight = container.offsetHeight;
        const horizontalDividerHeight = 4;
        const availableHeight = containerHeight - horizontalDividerHeight;

        // Enable transitions if configured
        if (settings.animation && settings.animation.enabled) {
            enableTransitions(
                settings.animation.duration,
                settings.animation.easing
            );
        }

        const isTopRow = view.closest('.top-row') !== null;
        const isBottomRow = view.closest('.bottom-row') !== null;

        // Title bar size constant (matches resizer.js)
        const TITLE_BAR_SIZE = 24;

        if (secondaryBehavior === 'maximize') {
            // Maximize behavior (for editor)
            // Calculate dynamic resize config: full size minus title bar for collapsed secondary views
            const resizeConfig = {
                // Width: full container minus title bar width for font info (collapsed sideways)
                width: (containerWidth - TITLE_BAR_SIZE) / containerWidth,
                // Height: full available height minus title bar height for bottom row
                height: (availableHeight - TITLE_BAR_SIZE) / availableHeight
            };

            console.log(
                '[KeyboardNav]',
                'Maximize behavior for:',
                viewId,
                resizeConfig
            );

            if (isTopRow) {
                resizeTopRowView(
                    viewId,
                    view,
                    resizeConfig,
                    containerWidth,
                    containerHeight,
                    true // forceResize
                );
            } else if (isBottomRow) {
                resizeBottomRowView(
                    viewId,
                    view,
                    resizeConfig,
                    containerWidth,
                    containerHeight,
                    true // forceResize
                );
            }
        } else if (secondaryBehavior === 'expandToTarget') {
            // Expand to activation target if smaller (for secondary views)
            if (viewId === 'view-fontinfo') {
                // Font info - expand width to target if smaller
                const config = settings.activation.fontinfo;
                const topRow = view.closest('.top-row');
                const topRowViews = Array.from(
                    topRow.querySelectorAll('.view')
                );
                const viewIndex = topRowViews.indexOf(view);
                const currentWidth = view.offsetWidth;
                const targetWidth = containerWidth * config.widthTarget;

                if (currentWidth < targetWidth) {
                    const otherView = topRowViews[1 - viewIndex];
                    const otherWidth = containerWidth - targetWidth;

                    if (otherWidth >= 200) {
                        const totalWidth = targetWidth + otherWidth;
                        view.style.flex = `${targetWidth / totalWidth}`;
                        otherView.style.flex = `${otherWidth / totalWidth}`;
                    }
                }
            } else if (isBottomRow) {
                // Bottom row secondary views - expand height and width to target if smaller
                const config = settings.activation.secondary;
                const bottomRow = view.closest('.bottom-row');
                const topRow = document.querySelector('.top-row');
                const views = Array.from(bottomRow.querySelectorAll('.view'));
                const viewIndex = views.indexOf(view);

                // Expand height if smaller than target
                const currentHeight = bottomRow.offsetHeight;
                const targetHeight = availableHeight * config.heightTarget;

                if (currentHeight < targetHeight) {
                    const topHeight = availableHeight - targetHeight;

                    if (topHeight >= 200) {
                        topRow.style.flex = `${topHeight / availableHeight}`;
                        bottomRow.style.flex = `${targetHeight / availableHeight}`;
                    }
                }

                // Expand width if smaller than target
                const currentWidth = view.offsetWidth;
                const targetWidth = containerWidth * config.widthTarget;

                if (currentWidth < targetWidth && views.length > 1) {
                    const remainingWidth = containerWidth - targetWidth;
                    const otherViewsCount = views.length - 1;
                    const remainingWidthPerView =
                        remainingWidth / otherViewsCount;

                    if (remainingWidthPerView >= 100) {
                        const widths = {};
                        views.forEach((v, i) => {
                            widths[i] =
                                i === viewIndex
                                    ? targetWidth
                                    : remainingWidthPerView;
                        });

                        const totalWidth = Object.values(widths).reduce(
                            (sum, w) => sum + w,
                            0
                        );
                        views.forEach((v, i) => {
                            v.style.flex = `${widths[i] / totalWidth}`;
                        });
                    }
                }
            }
        }

        // Disable transitions and update collapsed states after animation completes
        if (settings.animation && settings.animation.enabled) {
            setTimeout(() => {
                disableTransitions();
                updateCollapsedStates();
                // Save layout after resize completes
                if (window.resizableViews) {
                    window.resizableViews.saveLayout();
                }
            }, settings.animation.duration);
        } else {
            updateCollapsedStates();
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
     * @param {boolean} forceResize - If true, resize even if target is smaller than current
     */
    function resizeTopRowView(
        viewId,
        view,
        resizeConfig,
        containerWidth,
        containerHeight,
        forceResize = false
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

        // Resize if target is larger than current, or if forceResize is true
        const shouldResizeWidth = forceResize || targetViewWidth > currentWidth;
        const shouldResizeHeight =
            forceResize || targetViewHeight > currentHeight;

        console.log('[KeyboardNav]', 'resizeTopRowView:', {
            viewId,
            forceResize,
            currentWidth,
            targetViewWidth,
            shouldResizeWidth,
            currentHeight,
            targetViewHeight,
            shouldResizeHeight
        });

        // Handle width resizing
        if (shouldResizeWidth && views.length > 1) {
            const otherView = views[1 - viewIndex]; // Get the other view in top row
            const otherTargetWidth = containerWidth - targetViewWidth;

            if (otherTargetWidth >= 24) {
                // Allow collapse to min width
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

            if (bottomTargetHeight >= 24) {
                // Allow collapse to min height
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
    /**
     * Resize a view in the bottom row
     * @param {boolean} forceResize - If true, resize even if target is smaller than current
     */
    function resizeBottomRowView(
        viewId,
        view,
        resizeConfig,
        containerWidth,
        containerHeight,
        forceResize = false
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

        // Resize if target is larger than current, or if forceResize is true
        const shouldResizeHeight =
            forceResize || targetBottomHeight > currentBottomHeight;
        const shouldResizeWidth = forceResize || targetViewWidth > currentWidth;

        // Handle height resizing (affects top/bottom split)
        if (shouldResizeHeight) {
            const topTargetHeight = availableHeight - targetBottomHeight;

            if (topTargetHeight >= 200) {
                // Ensure minimum height for top row (editor)
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
                        '[KeyboardNav]',
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
                console.warn('[KeyboardNav]', 'Could not blur Ace editor:', e);
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
     * @param {string} viewId - The ID of the view to focus
     * @param {boolean} viaKeyboard - Whether the focus was triggered by keyboard shortcut
     */
    function focusView(viewId, viaKeyboard = false) {
        // Prevent recursive calls
        if (isFocusing) {
            console.warn(
                '[KeyboardNav]',
                'focusView already in progress, skipping'
            );
            return;
        }
        isFocusing = true;

        console.log('[KeyboardNav]', 'focusView called with:', viewId);

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

            // Expand view if below threshold (auto-expand on activation)
            expandViewOnActivation(viewId);

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
                setTimeout(() => {
                    // Only focus text field when activated via keyboard
                    if (viaKeyboard) {
                        const prompt = document.getElementById('ai-prompt');
                        if (prompt) {
                            prompt.focus();
                            prompt.click();
                        }

                        // Scroll to bottom when activated via keyboard
                        const viewContent = document.querySelector(
                            '#view-assistant .view-content'
                        );
                        if (viewContent) {
                            viewContent.scrollTop = viewContent.scrollHeight;
                        }
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
     * Check if element is a text input where Cmd+A should be allowed
     */
    function isTextInputElement(element) {
        if (!element) return false;

        const tagName = element.tagName?.toLowerCase();
        const type = element.type?.toLowerCase();

        // Allow in input fields (except non-text types)
        if (tagName === 'input') {
            const textInputTypes = [
                'text',
                'password',
                'email',
                'search',
                'tel',
                'url',
                'number'
            ];
            return !type || textInputTypes.includes(type);
        }

        // Allow in textarea elements
        if (tagName === 'textarea') {
            return true;
        }

        // Allow in contenteditable elements (like Ace Editor)
        if (element.isContentEditable || element.contentEditable === 'true') {
            return true;
        }

        // Allow in elements within Ace Editor
        if (element.closest('.ace_editor')) {
            return true;
        }

        return false;
    }

    /**
     * Handle keyboard shortcuts
     */
    function handleKeyDown(event) {
        const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
        const cmdKey = isMac ? event.metaKey : event.ctrlKey;
        const shiftKey = event.shiftKey;
        const key = event.key.toLowerCase();

        // Prevent browser back navigation shortcuts to avoid accidentally closing the app
        const activeElement = document.activeElement;
        const isInTextInput = isTextInputElement(activeElement);

        // Backspace - browser back (when not in text input)
        if (key === 'backspace' && !isInTextInput) {
            console.log(
                '[KeyboardNav]',
                'Blocking Backspace browser navigation'
            );
            event.preventDefault();
            return;
        }

        // Alt+Left Arrow - browser back (Windows/Linux)
        if (event.altKey && key === 'arrowleft') {
            console.log(
                '[KeyboardNav]',
                'Blocking Alt+Left browser navigation'
            );
            event.preventDefault();
            return;
        }

        // Cmd+[ - browser back (macOS)
        if (isMac && cmdKey && key === '[') {
            console.log('[KeyboardNav]', 'Blocking Cmd+[ browser navigation');
            event.preventDefault();
            return;
        }

        // Cmd+Left Arrow - browser back (some browsers on macOS)
        if (
            isMac &&
            cmdKey &&
            key === 'arrowleft' &&
            !shiftKey &&
            !event.altKey
        ) {
            console.log(
                '[KeyboardNav]',
                'Blocking Cmd+Left browser navigation'
            );
            event.preventDefault();
            return;
        }

        // Prevent page reload shortcuts in production (allow in development)
        if (!window.isDevelopment?.()) {
            // Cmd+R (macOS) or Ctrl+R (Windows/Linux)
            if (
                (cmdKey || event.ctrlKey) &&
                key === 'r' &&
                !shiftKey &&
                !event.altKey
            ) {
                console.log(
                    '[KeyboardNav]',
                    'Blocking page reload shortcut (Cmd/Ctrl+R) in production'
                );
                event.preventDefault();
                return;
            }
            // F5 - reload page
            if (key === 'f5') {
                console.log(
                    '[KeyboardNav]',
                    'Blocking page reload shortcut (F5) in production'
                );
                event.preventDefault();
                return;
            }
        }

        // Handle Cmd+A (select all) blocking
        const isCmdA = cmdKey && key === 'a' && !shiftKey && !event.altKey;

        if (isCmdA) {
            const activeElement = document.activeElement;
            const tagName = activeElement?.tagName?.toLowerCase();

            console.log('[KeyboardNav]', 'Cmd+A detected - activeElement:', {
                tagName,
                id: activeElement?.id,
                glyphCanvasExists: !!window.glyphCanvas,
                outlineEditorActive: window.glyphCanvas?.outlineEditor?.active,
                isGlyphCanvas: window.glyphCanvas?.canvas === activeElement
            });

            // Special case: Handle glyph canvas in text mode
            if (
                tagName === 'canvas' &&
                window.glyphCanvas?.canvas === activeElement
            ) {
                const glyphCanvas = window.glyphCanvas;
                if (glyphCanvas && !glyphCanvas.outlineEditor?.active) {
                    // In text mode - handle select all ourselves
                    console.log(
                        '[KeyboardNav]',
                        'Handling Cmd+A in canvas text mode'
                    );
                    event.preventDefault();
                    event.stopPropagation();
                    event.stopImmediatePropagation();
                    glyphCanvas.textRunEditor?.selectAll();
                    glyphCanvas.render();
                    return;
                }
            }

            // Allow Cmd+A in text input elements
            if (isTextInputElement(activeElement)) {
                console.log(
                    '[KeyboardNav]',
                    'Allowing Cmd+A in text input:',
                    activeElement.tagName,
                    activeElement.id || activeElement.className
                );
                return;
            }

            // Block Cmd+A everywhere else
            console.log(
                '[KeyboardNav]',
                'Blocking Cmd+A outside text inputs',
                activeElement?.tagName
            );
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();
            return;
        }

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
                    // View is already focused
                    // For assistant, focus text field instead of resizing
                    if (viewId === 'view-assistant') {
                        const prompt = document.getElementById('ai-prompt');
                        if (prompt) {
                            prompt.focus();
                            prompt.click();
                        }
                        // Scroll to bottom
                        const viewContent = document.querySelector(
                            '#view-assistant .view-content'
                        );
                        if (viewContent) {
                            viewContent.scrollTop = viewContent.scrollHeight;
                        }
                    } else {
                        // For other views, trigger resize
                        resizeView(viewId);
                    }
                } else {
                    // View is not focused, just focus it
                    focusView(viewId, true); // Pass true for viaKeyboard
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

        console.log('[KeyboardNav]', 'Keyboard navigation initialized');
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
