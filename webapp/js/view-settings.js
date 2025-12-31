// View Settings Configuration
// This file contains all configurable settings for view shortcuts and resizing behavior

const VIEW_SETTINGS = {
    // Keyboard shortcuts for each view
    shortcuts: {
        'view-editor': {
            // Editor view
            key: 'e',
            modifiers: { cmd: true, shift: true },
            displayModifiers: ['⌘', '⇧'],
            secondaryBehavior: 'maximize' // Pressing shortcut again maximizes
        },
        'view-fontinfo': {
            // Font Info view
            key: 'i',
            modifiers: { cmd: true, shift: true },
            displayModifiers: ['⌘', '⇧'],
            secondaryBehavior: 'expandToTarget' // Expand to target if smaller
        },
        'view-scripts': {
            // Scripts view
            key: 's',
            modifiers: { cmd: true, shift: true },
            displayModifiers: ['⌘', '⇧'],
            secondaryBehavior: 'expandToTarget'
        },
        'view-console': {
            // Console view
            key: 'k',
            modifiers: { cmd: true, shift: true },
            displayModifiers: ['⌘', '⇧'],
            secondaryBehavior: 'expandToTarget'
        },
        'view-assistant': {
            // Assistant view
            key: 'a',
            modifiers: { cmd: true, shift: true },
            displayModifiers: ['⌘', '⇧'],
            secondaryBehavior: 'expandToTarget'
        }
    },

    // Thresholds and targets for auto-expansion on view activation
    // All values are fractions of container width/height
    activation: {
        // Secondary views (bottom row) - expand if smaller than threshold
        secondary: {
            heightThreshold: 0.25, // If height < 25% of container
            heightTarget: 0.5, // Expand to 50% height
            widthTarget: 0.33 // Expand to 33% width on secondary activation
        },
        // Font info view - expand by width
        fontinfo: {
            widthThreshold: 0.25, // If width < 25% of top row
            widthTarget: 0.5 // Expand to 50% of top row
        },
        // Editor view (primary)
        editor: {
            widthThreshold: 0.6, // If width < 60% of top row (3/5)
            heightThreshold: 0.6, // If height < 60% of container (3/5)
            widthTarget: 0.7, // Expand to 70% width (3/5)
            heightTarget: 0.7 // Expand to 70% height (3/5)
        }
    },

    // Resize behavior when shortcut is pressed again while view is focused (secondary shortcut)
    // Only applies to views with hasSecondaryResize: true
    resize: {
        'view-editor': {
            // Editor view - maximize on secondary shortcut
            width: 0.95, // 95% of container width
            height: 0.95 // 95% of container height
        },
        'view-fontinfo': {
            // Font Info view (no secondary resize)
            width: 0.33,
            height: 0.7
        },
        'view-files': {
            // Files view (no secondary resize)
            width: 0.33,
            height: 0.5
        },
        'view-assistant': {
            // Assistant view (no secondary resize)
            width: 0.33,
            height: 0.5
        },
        'view-scripts': {
            // Scripts view (no secondary resize)
            width: 0.33,
            height: 0.5
        },
        'view-console': {
            // Console view (no secondary resize)
            width: 0.33,
            height: 0.5
        }
    },

    // Minimum sizes to prevent views from becoming too small (in pixels)
    minimumSizes: {
        width: 100,
        height: 100
    },

    // Animation settings for view resizing
    animation: {
        enabled: true,
        duration: 300, // milliseconds
        easing: 'ease-in-out'
    }
};

// Make available globally
window.VIEW_SETTINGS = VIEW_SETTINGS;

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = VIEW_SETTINGS;
}
