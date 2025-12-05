/**
 * Matplotlib Plot Handler
 * Intercepts matplotlib plots and displays them in a centered modal overlay
 *
 * This prevents matplotlib canvases from breaking the page layout by appearing
 * inline in the console. Instead, plots are shown in a modal that can be easily
 * closed with ESC, clicking the X button, or clicking outside the plot.
 */

(function () {
    'use strict';

    let matplotlibModal = null;
    let matplotlibModalBody = null;
    let matplotlibModalCloseBtn = null;
    let observer = null;

    // Track canvases we've already processed to avoid duplicates
    const processedCanvases = new WeakSet();

    // Initialize modal elements when DOM is ready
    function initMatplotlibModal() {
        matplotlibModal = document.getElementById('matplotlib-modal');
        matplotlibModalBody = document.getElementById('matplotlib-modal-body');
        matplotlibModalCloseBtn = document.getElementById(
            'matplotlib-modal-close-btn'
        );

        if (
            !matplotlibModal ||
            !matplotlibModalBody ||
            !matplotlibModalCloseBtn
        ) {
            console.warn('Matplotlib modal elements not found in DOM');
            return;
        }

        // Close button handler
        matplotlibModalCloseBtn.addEventListener('click', closePlotModal);

        // Close on background click
        matplotlibModal.addEventListener('click', function (event) {
            if (event.target === matplotlibModal) {
                closePlotModal();
            }
        });

        // Close on Escape key
        document.addEventListener('keydown', function (event) {
            if (
                event.key === 'Escape' &&
                matplotlibModal.classList.contains('active')
            ) {
                event.preventDefault();
                event.stopPropagation();
                closePlotModal();
            }
        });

        // Set up MutationObserver to watch for matplotlib canvases
        setupCanvasObserver();

        console.log('Matplotlib plot handler initialized');
    }

    function setupCanvasObserver() {
        // Disconnect existing observer if any
        if (observer) {
            observer.disconnect();
        }

        // Watch for matplotlib elements being added to the DOM
        // Pyodide matplotlib WebAgg backend creates a plain div with no id/class
        // appended to the end of body, containing the plot
        observer = new MutationObserver(function (mutations) {
            mutations.forEach(function (mutation) {
                mutation.addedNodes.forEach(function (node) {
                    // Check for matplotlib-figure custom elements (some backends)
                    if (node.nodeName === 'MATPLOTLIB-FIGURE') {
                        console.log(
                            '📊 Detected matplotlib-figure element:',
                            node
                        );
                        handleMatplotlibFigure(node);
                    }
                    // Check for regular canvas elements
                    else if (node.nodeName === 'CANVAS') {
                        handleNewCanvas(node);
                    }
                    // Check for DIVs added directly to body (WebAgg backend pattern)
                    else if (
                        node.nodeName === 'DIV' &&
                        node.parentNode === document.body
                    ) {
                        // WebAgg creates a div with no id/class containing the plot
                        if (!node.id && !node.className) {
                            console.log(
                                '📊 Detected potential WebAgg plot div:',
                                node
                            );
                            handlePotentialWebAggDiv(node);
                        }
                    }
                    // Check for divs or other containers with matplotlib content
                    else if (node.querySelectorAll) {
                        // Check for matplotlib-figure elements in subtrees
                        const matplotlibFigures =
                            node.querySelectorAll('matplotlib-figure');
                        if (matplotlibFigures.length > 0) {
                            console.log(
                                '📊 Found matplotlib-figure elements in subtree:',
                                matplotlibFigures
                            );
                        }
                        matplotlibFigures.forEach(handleMatplotlibFigure);

                        // Check for canvases in added subtrees
                        const canvases = node.querySelectorAll('canvas');
                        canvases.forEach(handleNewCanvas);
                    }
                });
            });
        });

        // Observe the body to catch matplotlib elements wherever they appear
        observer.observe(document.body, {
            childList: true,
            subtree: true
        });
    }

    function handleMatplotlibFigure(figureElement) {
        // Skip if already processed
        if (processedCanvases.has(figureElement)) {
            return;
        }

        // Skip figures already in our modal
        if (figureElement.closest('#matplotlib-modal')) {
            return;
        }

        console.log('Processing matplotlib-figure element:', figureElement);
        processedCanvases.add(figureElement);

        // Small delay to ensure the figure is fully rendered
        setTimeout(() => {
            showPlotInModal(figureElement);
        }, 150);
    }

    function handlePotentialWebAggDiv(div) {
        // Skip if already processed
        if (processedCanvases.has(div)) {
            return;
        }

        // Skip divs already in our modal
        if (div.closest('#matplotlib-modal')) {
            return;
        }

        // Check if this div contains a canvas (WebAgg pattern)
        const canvases = div.querySelectorAll('canvas');
        if (canvases.length > 0) {
            console.log(
                '📊 Confirmed WebAgg plot div with canvas:',
                div,
                canvases
            );
            processedCanvases.add(div);

            // Small delay to ensure the plot is fully rendered
            setTimeout(() => {
                showPlotInModal(div);
            }, 150);
            return;
        }

        // Also check if it has typical matplotlib structure (buttons, canvas, etc.)
        if (div.children.length >= 2) {
            // WebAgg creates a div with multiple children (toolbar, canvas, etc.)
            console.log(
                '📊 Potential WebAgg plot div with multiple children:',
                div
            );
            processedCanvases.add(div);

            setTimeout(() => {
                showPlotInModal(div);
            }, 150);
        }
    }

    function handleNewCanvas(canvas) {
        // Check if this looks like a matplotlib canvas
        // Skip if already processed
        if (processedCanvases.has(canvas)) {
            return false;
        }

        // Skip canvases already in our modal
        if (canvas.closest('#matplotlib-modal')) {
            return false;
        }

        // Skip the loading animation canvas
        if (canvas.id === 'loading-animation-canvas') {
            return false;
        }

        // Skip the glyph editor canvas
        if (canvas.closest('#glyph-canvas-container')) {
            return false;
        }

        // Skip very small canvases (likely not plots)
        if (canvas.width < 100 || canvas.height < 100) {
            return false;
        }

        // WebAgg backend creates canvas elements with specific characteristics
        // Check if canvas has matplotlib-related attributes or parent
        const parent = canvas.parentElement;
        const hasMatplotlibClass =
            canvas.className && canvas.className.includes('mpl');
        const parentHasMatplotlibClass =
            parent && parent.className && parent.className.includes('mpl');
        const isInTerminal = canvas.closest('.terminal');

        // If it's in the terminal and looks like a plot, it's probably matplotlib
        if (isInTerminal && canvas.width >= 100 && canvas.height >= 100) {
            console.log(
                '📊 Detected matplotlib WebAgg canvas in terminal:',
                canvas
            );
            processedCanvases.add(canvas);

            // Check if it has a parent container we should move instead
            if (
                parent &&
                parent !== document.body &&
                !parent.closest('.terminal-output')
            ) {
                // Move the parent container
                setTimeout(() => {
                    showPlotInModal(parent);
                }, 150);
            } else {
                setTimeout(() => {
                    showPlotInModal(canvas);
                }, 150);
            }
            return true;
        }

        // Check if canvas has some content drawn on it
        // Matplotlib canvases will have pixel data
        try {
            const ctx = canvas.getContext('2d');
            if (!ctx) {
                return false;
            }

            // Check a small sample of pixels to see if anything is drawn
            const imageData = ctx.getImageData(
                0,
                0,
                Math.min(canvas.width, 10),
                Math.min(canvas.height, 10)
            );
            const hasContent = imageData.data.some((value, index) => {
                // Check alpha channel (every 4th byte)
                if (index % 4 === 3) {
                    return value > 0;
                }
                return false;
            });

            if (hasContent) {
                console.log(
                    '📊 Detected matplotlib canvas with content:',
                    canvas
                );
                processedCanvases.add(canvas);
                setTimeout(() => {
                    showPlotInModal(canvas);
                }, 150);
                return true;
            }
        } catch (e) {
            // If we can't read the canvas (e.g., CORS), assume it's not a plot
            console.warn('Could not analyze canvas:', e);
            return false;
        }

        return false;
    }

    function showPlotInModal(element) {
        if (!matplotlibModalBody || !matplotlibModal) {
            console.warn('Modal not initialized, cannot show plot');
            return;
        }

        // Clear any existing plot
        matplotlibModalBody.innerHTML = '';

        // Remove the element from its original location
        const parent = element.parentNode;
        if (parent) {
            element.remove();
        }

        // Add the element to the modal
        matplotlibModalBody.appendChild(element);

        // Show the modal
        matplotlibModal.classList.add('active');

        console.log('Plot displayed in modal overlay');
    }

    function closePlotModal() {
        if (!matplotlibModal) {
            return;
        }

        // Hide the modal
        matplotlibModal.classList.remove('active');

        // Clear the plot after transition
        setTimeout(() => {
            if (matplotlibModalBody) {
                matplotlibModalBody.innerHTML = '';
            }
        }, 300);

        console.log('Plot modal closed');
    }

    // Global function to manually show a plot
    window.showMatplotlibPlot = function (element) {
        if (element && element.nodeType === 1) {
            // Element node
            processedCanvases.add(element);
            showPlotInModal(element);
        } else {
            console.error('showMatplotlibPlot requires a DOM element');
        }
    };

    // Global function to close plot modal
    window.closePlotModal = closePlotModal;

    // Initialize when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initMatplotlibModal);
    } else {
        initMatplotlibModal();
    }
})();
