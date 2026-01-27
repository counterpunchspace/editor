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
        'view-overview': {
            // Overview view
            key: 'o',
            modifiers: { cmd: true, shift: true },
            displayModifiers: ['⌘', '⇧'],
            secondaryBehavior: 'expandToTarget'
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
        },
        'view-files': {
            // Files view
            key: 'f',
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
            heightThreshold: 0.1, // If height < 10% of container
            heightTarget: 0.33, // Expand to 33% height
            widthTarget: 0.33 // Expand to 33% width on secondary activation
        },
        // Font info view - expand by width
        fontinfo: {
            widthThreshold: 0.25, // If width < 25% of top row
            widthTarget: 0.5 // Expand to 50% of top row
        },
        // Editor view (primary)
        editor: {
            widthThreshold: 0.5, // If width < 50% of top row
            heightThreshold: 0.5, // If height < 50% of container
            widthTarget: 0.5, // Expand to 50% width
            heightTarget: 0.5 // Expand to 50% height
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
        'view-overview': {
            // Overview view (no secondary resize)
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
