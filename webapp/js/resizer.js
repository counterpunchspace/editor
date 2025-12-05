console.log('resizer.js loaded');

class ResizableViews {
    constructor() {
        console.log('ResizableViews constructor called');
        this.isResizing = false;
        this.currentDivider = null;
        this.startX = 0;
        this.startY = 0;
        this.startWidths = {};
        this.startHeights = {};

        this.init();
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
                console.log('No saved view layout found');
                return;
            }

            const layout = JSON.parse(saved);
            console.log('Loading view layout:', layout);

            // Apply horizontal layout
            if (layout.horizontal) {
                const topRow = document.querySelector('.top-row');
                const bottomRow = document.querySelector('.bottom-row');
                if (topRow && bottomRow) {
                    topRow.style.flex = layout.horizontal.top;
                    bottomRow.style.flex = layout.horizontal.bottom;
                    console.log('Applied horizontal layout');
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
                    console.log(`Applied ${topViews?.length} top view layouts`);
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
                        `Applied ${bottomViews?.length} bottom view layouts`
                    );
                }
            }

            console.log('✅ View layout restored from localStorage');
        } catch (e) {
            console.warn('Failed to load view layout:', e);
        }
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
            console.warn('Failed to save view layout:', e);
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
            this.startWidths[index] = view.offsetWidth;
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

        const minWidth = 100;

        // Determine which side to resize based on drag direction
        if (deltaX < 0) {
            // Dragging left - resize left views proportionally, only the immediate right view changes
            const leftViews = views.slice(0, dividerIndex + 1);
            const rightView = views[dividerIndex + 1];

            if (leftViews.length === 0 || !rightView) return;

            // Calculate total width of left group
            let leftTotalWidth = 0;
            leftViews.forEach((view, i) => {
                leftTotalWidth += this.startWidths[i];
            });

            const rightStartWidth = this.startWidths[dividerIndex + 1];
            const newLeftTotalWidth = leftTotalWidth + deltaX;
            const newRightWidth = rightStartWidth - deltaX;

            // Check minimums
            const minLeftTotalWidth = minWidth * leftViews.length;
            if (
                newLeftTotalWidth >= minLeftTotalWidth &&
                newRightWidth >= minWidth
            ) {
                // Scale left views proportionally
                const leftScale = newLeftTotalWidth / leftTotalWidth;

                const newWidths = {};
                leftViews.forEach((view, i) => {
                    newWidths[i] = this.startWidths[i] * leftScale;
                });
                newWidths[dividerIndex + 1] = newRightWidth;

                // Keep other views unchanged
                for (let i = dividerIndex + 2; i < views.length; i++) {
                    newWidths[i] = this.startWidths[i];
                }

                // Calculate total and set flex
                let totalWidth = 0;
                views.forEach((view, index) => {
                    totalWidth += newWidths[index];
                });

                views.forEach((view, index) => {
                    view.style.flex = `${newWidths[index] / totalWidth}`;
                });
            }
        } else if (deltaX > 0) {
            // Dragging right - resize right views proportionally, only the immediate left view changes
            const leftView = views[dividerIndex];
            const rightViews = views.slice(dividerIndex + 1);

            if (!leftView || rightViews.length === 0) return;

            const leftStartWidth = this.startWidths[dividerIndex];

            // Calculate total width of right group
            let rightTotalWidth = 0;
            rightViews.forEach((view, i) => {
                rightTotalWidth += this.startWidths[dividerIndex + 1 + i];
            });

            const newLeftWidth = leftStartWidth + deltaX;
            const newRightTotalWidth = rightTotalWidth - deltaX;

            // Check minimums
            const minRightTotalWidth = minWidth * rightViews.length;
            if (
                newLeftWidth >= minWidth &&
                newRightTotalWidth >= minRightTotalWidth
            ) {
                // Scale right views proportionally
                const rightScale = newRightTotalWidth / rightTotalWidth;

                const newWidths = {};

                // Keep left views unchanged except the immediate one
                for (let i = 0; i < dividerIndex; i++) {
                    newWidths[i] = this.startWidths[i];
                }
                newWidths[dividerIndex] = newLeftWidth;

                // Scale right views
                rightViews.forEach((view, i) => {
                    const index = dividerIndex + 1 + i;
                    newWidths[index] = this.startWidths[index] * rightScale;
                });

                // Calculate total and set flex
                let totalWidth = 0;
                views.forEach((view, index) => {
                    totalWidth += newWidths[index];
                });

                views.forEach((view, index) => {
                    view.style.flex = `${newWidths[index] / totalWidth}`;
                });
            }
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

        // Enforce minimum heights
        const minHeight = 100;
        if (newTopHeight >= minHeight && newBottomHeight >= minHeight) {
            // Calculate flex-grow values based on the ratio of each row
            const totalHeight = newTopHeight + newBottomHeight;
            const topFlex = newTopHeight / totalHeight;
            const bottomFlex = newBottomHeight / totalHeight;

            topRow.style.flex = `${topFlex}`;
            bottomRow.style.flex = `${bottomFlex}`;
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

        // Save layout after resize
        this.saveLayout();
    }
}

// Initialize the resizable views when the DOM is loaded
function initResizableViews() {
    console.log('Initializing ResizableViews...');
    window.resizableViews = new ResizableViews();
    console.log('ResizableViews initialized');
}

// Check if DOM is already loaded (in case script loads late)
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initResizableViews);
} else {
    // DOM already loaded, run immediately
    initResizableViews();
}

// Handle window resize to maintain proportions
window.addEventListener('resize', () => {
    // Optional: Add logic to maintain view proportions on window resize
    // This is a good place to recalculate flex values if needed
});
