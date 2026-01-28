// Overview View
// Handles overview view initialization with sidebar and glyph overview
// Note: glyphOverviewFilterManager is loaded via glyph-overview.ts bundle
// and available on window.glyphOverviewFilterManager

console.log('[OverviewView]', 'overview-view.js loaded');

let glyphOverviewInstance = null;

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

        // Create filter sidebar container
        const filterSidebarContainer = document.createElement('div');
        filterSidebarContainer.id = 'overview-filters';
        leftSidebar.appendChild(filterSidebarContainer);

        // Create main content area with flex column layout
        const mainContent = document.createElement('div');
        mainContent.id = 'overview-main';
        mainContent.style.flex = '1';
        mainContent.style.height = '100%';
        mainContent.style.position = 'relative';
        mainContent.style.overflow = 'hidden';
        mainContent.style.display = 'flex';
        mainContent.style.flexDirection = 'column';

        // Create color legend container (hidden by default, shown when filter has colors)
        const colorLegendContainer = document.createElement('div');
        colorLegendContainer.id = 'overview-color-legend';
        colorLegendContainer.className = 'glyph-filter-legend';
        colorLegendContainer.style.display = 'none';
        mainContent.appendChild(colorLegendContainer);

        // Create glyph container that will hold the glyph overview
        const glyphContainer = document.createElement('div');
        glyphContainer.id = 'overview-glyph-container';
        glyphContainer.style.flex = '1';
        glyphContainer.style.overflow = 'hidden';
        glyphContainer.style.position = 'relative';
        mainContent.appendChild(glyphContainer);

        // Initialize glyph overview in the glyph container
        if (window.GlyphOverview) {
            glyphOverviewInstance = new window.GlyphOverview(glyphContainer);

            // Populate with current font glyphs if available
            if (window.currentFontModel?.glyphs) {
                const glyphData = window.currentFontModel.glyphs.map(
                    (glyph, index) => ({
                        id: String(index),
                        name: glyph.name
                    })
                );
                glyphOverviewInstance.updateGlyphs(glyphData);

                // Render glyphs if font is already compiled
                // (font needs to be cached in Rust via store_font before rendering)
                setTimeout(async () => {
                    try {
                        await glyphOverviewInstance.renderGlyphOutlines();
                        console.log(
                            '[OverviewView]',
                            `Initial render: ${glyphData.length} glyph tiles`
                        );
                    } catch (error) {
                        console.error(
                            '[OverviewView]',
                            'Failed to render glyphs on init:',
                            error
                        );
                    }
                }, 500);
            }
        } else {
            console.warn(
                '[OverviewView]',
                'GlyphOverview class not available yet'
            );
        }

        // Initialize filter manager with sidebar and glyph overview
        if (glyphOverviewInstance && window.glyphOverviewFilterManager) {
            window.glyphOverviewFilterManager.initialize(
                filterSidebarContainer,
                glyphOverviewInstance,
                colorLegendContainer
            );
        }

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

// Update glyph overview when font is loaded
window.addEventListener('fontReady', async () => {
    console.log('[OverviewView]', 'Font ready, updating glyph overview');

    // Wait a bit for currentFontModel to be set
    setTimeout(async () => {
        if (glyphOverviewInstance && window.currentFontModel?.glyphs) {
            const glyphData = window.currentFontModel.glyphs.map(
                (glyph, index) => ({
                    id: String(index),
                    name: glyph.name
                })
            );
            glyphOverviewInstance.updateGlyphs(glyphData);

            // Render glyph outlines at default location
            // Font is now cached in worker, safe to render
            try {
                await glyphOverviewInstance.renderGlyphOutlines();
                console.log(
                    '[OverviewView]',
                    `Rendered ${glyphData.length} glyph tiles`
                );

                // Refresh filter plugins after font load
                if (window.glyphOverviewFilterManager?.isLoaded()) {
                    await window.glyphOverviewFilterManager.refreshPlugins();
                }
            } catch (error) {
                console.error(
                    '[OverviewView]',
                    'Failed to render glyphs:',
                    error
                );
            }
        }
    }, 100);
});

// Initialize when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initOverviewView);
} else {
    initOverviewView();
}
