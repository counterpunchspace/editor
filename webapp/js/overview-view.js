// Overview View
// Handles overview view initialization with sidebar

console.log('[OverviewView]', 'overview-view.js loaded');

function initOverviewView() {
    const overviewContent = document.querySelector(
        '#view-overview .view-content'
    );
    if (overviewContent) {
        // Create main container with flexbox layout
        const mainContainer = document.createElement('div');
        mainContainer.style.display = 'flex';
        mainContainer.style.width = '100%';
        mainContainer.style.height = '100%';
        mainContainer.style.overflow = 'hidden';

        // Create left sidebar (identical styling to editor view sidebar)
        const leftSidebar = document.createElement('div');
        leftSidebar.id = 'overview-sidebar';
        leftSidebar.style.width = '200px';
        leftSidebar.style.height = '100%';
        leftSidebar.style.backgroundColor = 'var(--background-editor-sidebar)';
        leftSidebar.style.borderRight = '1px solid var(--border-primary)';
        leftSidebar.style.padding = '12px';
        leftSidebar.style.overflowY = 'auto';
        leftSidebar.style.display = 'flex';
        leftSidebar.style.flexDirection = 'column';
        leftSidebar.style.gap = '12px';
        leftSidebar.style.flexShrink = '0'; // Prevent sidebar from shrinking

        // Create main content area
        const mainContent = document.createElement('div');
        mainContent.id = 'overview-main';
        mainContent.style.flex = '1';
        mainContent.style.height = '100%';
        mainContent.style.position = 'relative';
        mainContent.style.padding = '12px';

        // Assemble layout (sidebar, main content)
        mainContainer.appendChild(leftSidebar);
        mainContainer.appendChild(mainContent);
        overviewContent.appendChild(mainContainer);

        // Observe when the overview view gains/loses focus (via 'focused' class)
        const overviewView = document.querySelector('#view-overview');
        if (overviewView) {
            const updateSidebarStyles = () => {
                const isFocused = overviewView.classList.contains('focused');
                const isCollapsed =
                    overviewView.classList.contains('collapsed-width');
                const bgColor = isFocused
                    ? 'var(--background-editor-sidebar)'
                    : 'var(--background-secondary)';
                leftSidebar.style.backgroundColor = bgColor;

                // Hide entire container when view is collapsed
                mainContainer.style.display = isCollapsed ? 'none' : 'flex';
            };

            const observer = new MutationObserver((mutations) => {
                mutations.forEach((mutation) => {
                    if (
                        mutation.type === 'attributes' &&
                        mutation.attributeName === 'class'
                    ) {
                        updateSidebarStyles();
                    }
                });
            });
            observer.observe(overviewView, {
                attributes: true,
                attributeFilter: ['class']
            });

            // Set initial state
            updateSidebarStyles();
        }

        console.log('[OverviewView]', 'Overview view initialized with sidebar');
    } else {
        setTimeout(initOverviewView, 100);
    }
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initOverviewView);
} else {
    initOverviewView();
}
