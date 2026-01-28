console.log('[Resizer]', 'resizer.js loaded');

class ResizableViews {
    // Minimum sizes for different view types
    static TITLE_BAR_HEIGHT = 24;
    static PRIMARY_MIN_WIDTH = 200;
    static PRIMARY_MIN_HEIGHT = 200;
    static SECONDARY_MIN_WIDTH = 100;
    static SECONDARY_MIN_HEIGHT = 24; // Title bar only
    static FONTINFO_MIN_WIDTH = 24; // Title bar width when rotated
    static FONTINFO_MIN_HEIGHT = 100;

    constructor() {
        console.log('[Resizer]', 'ResizableViews constructor called');
        this.isResizing = false;
        this.currentDivider = null;
        this.startX = 0;
        this.startY = 0;
        this.startWidths = {};
        this.startHeights = {};

        this.init();
    }

    /**
     * Get the minimum width for a view based on its type
     */
    getMinWidth(view) {
        if (view.classList.contains('view-editor')) {
            return ResizableViews.PRIMARY_MIN_WIDTH;
        }
        if (
            view.classList.contains('view-fontinfo') ||
            view.classList.contains('view-overview')
        ) {
            return ResizableViews.FONTINFO_MIN_WIDTH;
        }
        return ResizableViews.SECONDARY_MIN_WIDTH;
    }

    /**
     * Get the minimum height for a view based on its type
     */
    getMinHeight(view) {
        if (view.classList.contains('view-editor')) {
            return ResizableViews.PRIMARY_MIN_HEIGHT;
        }
        if (
            view.classList.contains('view-fontinfo') ||
            view.classList.contains('view-overview')
        ) {
            return ResizableViews.FONTINFO_MIN_HEIGHT;
        }
        return ResizableViews.SECONDARY_MIN_HEIGHT;
    }

    /**
     * Update collapsed state classes based on current view dimensions
     */
    updateCollapsedStates() {
        const views = document.querySelectorAll('.view');
        let shouldFocusEditor = false;
        const currentFocusedView = window.getCurrentFocusedView ? window.getCurrentFocusedView() : null;

        views.forEach((view) => {
            // Skip the editor (primary view)
            if (view.classList.contains('view-editor')) return;

            const rect = view.getBoundingClientRect();
            const titleBarHeight = ResizableViews.TITLE_BAR_HEIGHT;
            const threshold = 5; // Tolerance for float comparison

            if (
                view.classList.contains('view-fontinfo') ||
                view.classList.contains('view-overview')
            ) {
                // Font info and overview collapse by width
                const isWidthCollapsed =
                    rect.width <= ResizableViews.FONTINFO_MIN_WIDTH + threshold;
                const wasCollapsed = view.classList.contains('collapsed-width');
                view.classList.toggle('collapsed-width', isWidthCollapsed);
                view.classList.remove('collapsed');

                // If this view just became collapsed and it was the focused view, mark to focus editor
                if (isWidthCollapsed && !wasCollapsed && view.id === currentFocusedView) {
                    shouldFocusEditor = true;
                }
            } else {
                // Other secondary views collapse by height
                const isHeightCollapsed =
                    rect.height <= titleBarHeight + threshold;
                const wasCollapsed = view.classList.contains('collapsed');
                view.classList.toggle('collapsed', isHeightCollapsed);
                view.classList.remove('collapsed-width');

                // If this view just became collapsed and it was the focused view, mark to focus editor
                if (isHeightCollapsed && !wasCollapsed && view.id === currentFocusedView) {
                    shouldFocusEditor = true;
                }
            }
        });

        // Focus editor if any secondary view that was focused was just collapsed
        if (shouldFocusEditor && window.focusView) {
            window.focusView('view-editor');
        }
    }

    /**
     * Handle window resize: lock collapsed views to fixed width and adjust others
     */
    handleWindowResize() {
        // Process top row (horizontal layout)
        const topRow = document.querySelector('.top-row');
        if (topRow) {
            const views = Array.from(topRow.querySelectorAll('.view'));
            const threshold = 5;

            let totalFixedWidth = 0;
            const collapsedViews = [];
            const nonCollapsedViews = [];

            // Identify collapsed and non-collapsed views
            views.forEach((view) => {
                const rect = view.getBoundingClientRect();
                const minWidth = this.getMinWidth(view);
                const isCollapsed = rect.width <= minWidth + threshold;

                if (isCollapsed) {
                    collapsedViews.push({ view, width: minWidth });
                    totalFixedWidth += minWidth;
                } else {
                    nonCollapsedViews.push({ view, width: rect.width });
                }
            });

            if (collapsedViews.length > 0 && nonCollapsedViews.length > 0) {
                // Lock collapsed views to fixed width
                collapsedViews.forEach(({ view, width }) => {
                    view.style.flex = `0 0 ${width}px`;
                });

                // Set non-collapsed views to flexible with proper proportions
                const containerWidth = topRow.offsetWidth;
                const availableWidth = containerWidth - totalFixedWidth;

                let totalNonCollapsedWidth = 0;
                nonCollapsedViews.forEach(({ width }) => {
                    totalNonCollapsedWidth += width;
                });

                nonCollapsedViews.forEach(({ view, width }) => {
                    const proportion = width / totalNonCollapsedWidth;
                    const targetWidth = availableWidth * proportion;
                    view.style.flex = `${targetWidth}`;
                });
            }
        }

        // Process bottom row (horizontal layout)
        const bottomRow = document.querySelector('.bottom-row');
        if (bottomRow) {
            const views = Array.from(bottomRow.querySelectorAll('.view'));
            const threshold = 5;

            let totalFixedHeight = 0;
            const collapsedViews = [];
            const nonCollapsedViews = [];

            // Identify collapsed and non-collapsed views
            views.forEach((view) => {
                const rect = view.getBoundingClientRect();
                const minHeight = this.getMinHeight(view);
                const isCollapsed = rect.height <= minHeight + threshold;

                if (isCollapsed) {
                    collapsedViews.push({ view, height: minHeight });
                    totalFixedHeight += minHeight;
                } else {
                    nonCollapsedViews.push({ view, height: rect.height });
                }
            });

            // For bottom row, we mainly care about horizontal resizing, not vertical
            // So we don't need to lock heights, just update collapsed states
        }

        // Update collapsed state classes
        this.updateCollapsedStates();
    }

    init() {
        // Add event listeners for all dividers
        const verticalDividers = document.querySelectorAll('.vertical-divider');
        const horizontalDivider = document.querySelector('.horizontal-divider');

        verticalDividers.forEach((divider) => {
            divider.addEventListener('mousedown', (e) =>
                this.startResize(e, 'vertical')
            );
        });

        if (horizontalDivider) {
            horizontalDivider.addEventListener('mousedown', (e) =>
                this.startResize(e, 'horizontal')
            );
        }

        // Global mouse events
        document.addEventListener('mousemove', (e) => this.resize(e));
        document.addEventListener('mouseup', () => this.stopResize());

        // Prevent text selection during resize
        document.addEventListener('selectstart', (e) => {
            if (this.isResizing) {
                e.preventDefault();
            }
        });

        // Load saved layout after a short delay to ensure DOM is ready
        setTimeout(() => this.loadLayout(), 100);
    }

    loadLayout() {
        try {
            const saved = localStorage.getItem('viewLayout');
            if (!saved) {
                console.log(
                    '[Resizer]',
                    'No saved view layout found - applying defaults'
                );
                this.applyDefaultLayout();
                return;
            }

            const layout = JSON.parse(saved);
            console.log('[Resizer]', 'Loading view layout:', layout);

            // Apply horizontal layout
            if (layout.horizontal) {
                const topRow = document.querySelector('.top-row');
                const bottomRow = document.querySelector('.bottom-row');
                if (topRow && bottomRow) {
                    topRow.style.flex = layout.horizontal.top;
                    bottomRow.style.flex = layout.horizontal.bottom;
                    console.log('[Resizer]', 'Applied horizontal layout');
                }
            }

            // Apply vertical layouts
            if (layout.vertical) {
                if (layout.vertical.top) {
                    const topRow = document.querySelector('.top-row');
                    const topViews = topRow?.querySelectorAll('.view');
                    topViews?.forEach((view, index) => {
                        if (layout.vertical.top[index] !== undefined) {
                            view.style.flex = layout.vertical.top[index];
                        }
                    });
                    console.log(
                        '[Resizer]',
                        `Applied ${topViews?.length} top view layouts`
                    );
                }

                if (layout.vertical.bottom) {
                    const bottomRow = document.querySelector('.bottom-row');
                    const bottomViews = bottomRow?.querySelectorAll('.view');
                    bottomViews?.forEach((view, index) => {
                        if (layout.vertical.bottom[index] !== undefined) {
                            view.style.flex = layout.vertical.bottom[index];
                        }
                    });
                    console.log(
                        '[Resizer]',
                        `Applied ${bottomViews?.length} bottom view layouts`
                    );
                }
            }

            console.log(
                '[Resizer]',
                '✅ View layout restored from localStorage'
            );
        } catch (e) {
            console.warn('[Resizer]', 'Failed to load view layout:', e);
        }
    }

    applyDefaultLayout() {
        console.log('[Resizer]', 'Applying default view layout');

        const topRow = document.querySelector('.top-row');
        const topViews = topRow?.querySelectorAll('.view');

        if (topViews && topViews.length === 3) {
            // fontinfo: collapsed (24px), overview: 35%, editor: 65%
            // Assuming container width, calculate flex ratios
            // For collapsed fontinfo, use minimal flex
            const fontinfoFlex = 0.01; // Very small flex for collapsed state
            const overviewFlex = 0.35;
            const editorFlex = 0.65;
            const total = fontinfoFlex + overviewFlex + editorFlex;

            topViews[0].style.flex = `${fontinfoFlex / total}`; // fontinfo
            topViews[1].style.flex = `${overviewFlex / total}`; // overview
            topViews[2].style.flex = `${editorFlex / total}`; // editor

            console.log(
                '[Resizer]',
                'Applied default top row layout: fontinfo collapsed, overview 35%, editor 65%'
            );
        }

        // Update collapsed states to reflect the collapsed fontinfo
        setTimeout(() => {
            this.updateCollapsedStates();
        }, 100);
    }

    saveLayout() {
        try {
            const topRow = document.querySelector('.top-row');
            const bottomRow = document.querySelector('.bottom-row');

            const layout = {
                horizontal: {
                    top: topRow?.style.flex || '1',
                    bottom: bottomRow?.style.flex || '1'
                },
                vertical: {
                    top: [],
                    bottom: []
                }
            };

            // Save top row views
            const topViews = topRow?.querySelectorAll('.view');
            topViews?.forEach((view) => {
                layout.vertical.top.push(view.style.flex || '1');
            });

            // Save bottom row views
            const bottomViews = bottomRow?.querySelectorAll('.view');
            bottomViews?.forEach((view) => {
                layout.vertical.bottom.push(view.style.flex || '1');
            });

            localStorage.setItem('viewLayout', JSON.stringify(layout));
        } catch (e) {
            console.warn('[Resizer]', 'Failed to save view layout:', e);
        }
    }

    startResize(e, direction) {
        e.preventDefault();
        this.isResizing = true;
        this.currentDivider = e.target;
        this.direction = direction;
        this.startX = e.clientX;
        this.startY = e.clientY;

        // Add active class for visual feedback
        this.currentDivider.classList.add('active');

        // Store initial dimensions
        if (direction === 'vertical') {
            this.storeVerticalDimensions();
        } else {
            this.storeHorizontalDimensions();
        }

        // Change cursor for the entire document
        document.body.style.cursor =
            direction === 'vertical' ? 'col-resize' : 'row-resize';
        document.body.style.userSelect = 'none';
    }

    storeVerticalDimensions() {
        const container = this.currentDivider.parentElement;
        const views = container.querySelectorAll('.view');

        views.forEach((view, index) => {
            const actualWidth = view.offsetWidth;
            const minWidth = this.getMinWidth(view);
            // If view is collapsed, lock to exact minimum width to prevent drift
            const isCollapsed = actualWidth <= minWidth + 5;
            this.startWidths[index] = isCollapsed ? minWidth : actualWidth;
        });
    }

    storeHorizontalDimensions() {
        const topRow = document.querySelector('.top-row');
        const bottomRow = document.querySelector('.bottom-row');

        this.startHeights = {
            top: topRow.offsetHeight,
            bottom: bottomRow.offsetHeight
        };
    }

    resize(e) {
        if (!this.isResizing) return;

        e.preventDefault();

        if (this.direction === 'vertical') {
            this.resizeVertical(e);
        } else {
            this.resizeHorizontal(e);
        }
    }

    resizeVertical(e) {
        const deltaX = e.clientX - this.startX;
        const container = this.currentDivider.parentElement;
        const views = Array.from(container.querySelectorAll('.view'));
        const dividers = Array.from(
            container.querySelectorAll('.vertical-divider')
        );

        // Find which divider is being dragged
        const dividerIndex = dividers.indexOf(this.currentDivider);
        if (dividerIndex === -1) return;

        // Get the view to the left of the divider
        const leftView = views[dividerIndex];
        if (!leftView) return;

        // Get all views to the right
        const rightViews = views.slice(dividerIndex + 1);
        if (rightViews.length === 0) return;

        // Filter out collapsed views from the right side
        const nonCollapsedRightViews = rightViews.filter((view) => {
            const index = views.indexOf(view);
            const minWidth = this.getMinWidth(view);
            return this.startWidths[index] > minWidth + 5;
        });

        if (nonCollapsedRightViews.length === 0) return;

        // Calculate current widths
        const leftStartWidth = this.startWidths[dividerIndex];
        let newLeftWidth = leftStartWidth + deltaX;

        // Check minimums
        const leftMinWidth = this.getMinWidth(leftView);

        // Snap to minimum if within 10 pixels
        const snapThreshold = 10;
        if (Math.abs(newLeftWidth - leftMinWidth) < snapThreshold) {
            newLeftWidth = leftMinWidth;
        }

        // Calculate total width of non-collapsed right views
        let rightTotalWidth = 0;
        nonCollapsedRightViews.forEach((view) => {
            const index = views.indexOf(view);
            rightTotalWidth += this.startWidths[index];
        });

        const newRightTotalWidth =
            rightTotalWidth - (newLeftWidth - leftStartWidth);

        let minRightTotalWidth = 0;
        nonCollapsedRightViews.forEach((view) => {
            minRightTotalWidth += this.getMinWidth(view);
        });

        if (
            newLeftWidth >= leftMinWidth &&
            newRightTotalWidth >= minRightTotalWidth
        ) {
            // Calculate new widths
            const newWidths = {};

            // Set new left width
            newWidths[dividerIndex] = newLeftWidth;

            // Scale non-collapsed right views proportionally
            const rightScale = newRightTotalWidth / rightTotalWidth;
            nonCollapsedRightViews.forEach((view) => {
                const index = views.indexOf(view);
                newWidths[index] = this.startWidths[index] * rightScale;
            });

            // Lock all other views to minimum width if collapsed, otherwise keep unchanged
            views.forEach((view, index) => {
                if (!(index in newWidths)) {
                    const minWidth = this.getMinWidth(view);
                    const isCollapsed = this.startWidths[index] <= minWidth + 5;
                    newWidths[index] = isCollapsed
                        ? minWidth
                        : this.startWidths[index];
                }
            });

            // Calculate total and set flex
            let totalWidth = 0;
            views.forEach((view, index) => {
                totalWidth += newWidths[index];
            });

            // Ensure editor view (last view) is at least 33% of total width
            const editorIndex = views.length - 1;
            const editorMinRatio = 0.33;
            const editorNewWidth = newWidths[editorIndex];

            if (editorNewWidth / totalWidth < editorMinRatio) {
                // Editor is too narrow, recalculate to enforce minimum
                const requiredEditorWidth = totalWidth * editorMinRatio;
                const editorShortfall = requiredEditorWidth - editorNewWidth;

                // Reduce other non-collapsed views proportionally to give space to editor
                const otherNonCollapsedIndices = [];
                let otherNonCollapsedTotal = 0;

                views.forEach((view, index) => {
                    if (index !== editorIndex) {
                        const minWidth = this.getMinWidth(view);
                        const isCollapsed = newWidths[index] <= minWidth + 5;
                        if (!isCollapsed) {
                            otherNonCollapsedIndices.push(index);
                            otherNonCollapsedTotal += newWidths[index];
                        }
                    }
                });

                if (otherNonCollapsedTotal > editorShortfall) {
                    // Reduce others proportionally
                    otherNonCollapsedIndices.forEach((index) => {
                        const reduction =
                            (newWidths[index] / otherNonCollapsedTotal) *
                            editorShortfall;
                        newWidths[index] -= reduction;
                    });
                    newWidths[editorIndex] = requiredEditorWidth;
                }
            }

            views.forEach((view, index) => {
                view.style.flex = `${newWidths[index] / totalWidth}`;
            });

            // Update collapsed states
            this.updateCollapsedStates();
        }
    }

    resizeHorizontal(e) {
        const deltaY = e.clientY - this.startY;
        const topRow = document.querySelector('.top-row');
        const bottomRow = document.querySelector('.bottom-row');

        const containerHeight =
            document.querySelector('.container').offsetHeight;
        const dividerHeight = 4; // Fixed divider height
        const availableHeight = containerHeight - dividerHeight;

        const topStartHeight = this.startHeights.top;
        const bottomStartHeight = this.startHeights.bottom;

        const newTopHeight = topStartHeight + deltaY;
        const newBottomHeight = bottomStartHeight - deltaY;

        // Calculate minimum heights based on views in each row
        // Top row contains fontinfo and editor - use editor's min height
        const topMinHeight = ResizableViews.PRIMARY_MIN_HEIGHT;
        // Bottom row contains secondary views - use title bar height
        const bottomMinHeight = ResizableViews.SECONDARY_MIN_HEIGHT;

        if (
            newTopHeight >= topMinHeight &&
            newBottomHeight >= bottomMinHeight
        ) {
            // Calculate flex-grow values based on the ratio of each row
            const totalHeight = newTopHeight + newBottomHeight;
            const topFlex = newTopHeight / totalHeight;
            const bottomFlex = newBottomHeight / totalHeight;

            topRow.style.flex = `${topFlex}`;
            bottomRow.style.flex = `${bottomFlex}`;

            // Update collapsed states
            this.updateCollapsedStates();
        }
    }

    stopResize() {
        if (!this.isResizing) return;

        this.isResizing = false;

        if (this.currentDivider) {
            this.currentDivider.classList.remove('active');
            this.currentDivider = null;
        }

        // Reset cursor and selection
        document.body.style.cursor = 'default';
        document.body.style.userSelect = 'auto';

        // Final update of collapsed states
        this.updateCollapsedStates();

        // Save layout after resize
        this.saveLayout();
    }
}

// Initialize the resizable views when the DOM is loaded
function initResizableViews() {
    console.log('[Resizer]', 'Initializing ResizableViews...');
    window.resizableViews = new ResizableViews();
    // Update collapsed states after layout is loaded
    setTimeout(() => {
        window.resizableViews.updateCollapsedStates();
    }, 150);
    console.log('[Resizer]', 'ResizableViews initialized');
}

// Check if DOM is already loaded (in case script loads late)
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initResizableViews);
} else {
    // DOM already loaded, run immediately
    initResizableViews();
}

// Handle window resize to maintain proportions and collapsed states
window.addEventListener('resize', () => {
    if (window.resizableViews) {
        window.resizableViews.handleWindowResize();
    }
});
