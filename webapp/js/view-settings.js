// View Settings Configuration
// This file contains all configurable settings for view shortcuts and resizing behavior

const VIEW_SETTINGS = {
    // Keyboard shortcuts for each view
    shortcuts: {
        'view-editor': {
            // Editor view
            key: 'e',
            modifiers: { cmd: true, shift: true },
            displayModifiers: ['⌘', '⇧'] // Mac symbols for display
        },
        'view-fontinfo': {
            // Font Info view
            key: 'i',
            modifiers: { cmd: true, shift: true },
            displayModifiers: ['⌘', '⇧']
        },
        'view-scripts': {
            // Scripts view
            key: 's',
            modifiers: { cmd: true, shift: true },
            displayModifiers: ['⌘', '⇧']
        },
        'view-console': {
            // Console view
            key: 'k',
            modifiers: { cmd: true, shift: true },
            displayModifiers: ['⌘', '⇧']
        },
        'view-assistant': {
            // Assistant view
            key: 'a',
            modifiers: { cmd: true, shift: true },
            displayModifiers: ['⌘', '⇧']
        }
    },

    // Resize behavior when shortcut is pressed again while view is focused
    // All values are MINIMUM values - views only grow, never shrink
    resize: {
        'view-editor': {
            // Editor view (top-right)
            width: 0.9, // 80% of container width
            height: 0.8 // 80% of container height
        },
        'view-fontinfo': {
            // Font Info view (top-left)
            width: 0.33, // 33% of container width
            height: 0.7 // 70% of container height
        },
        'view-files': {
            // Files view (bottom-left)
            width: 0.33, // 33% of bottom row width
            height: 0.5 // 50% of total container height
        },
        'view-assistant': {
            // Assistant view (bottom-middle-left)
            width: 0.33, // 33% of bottom row width
            height: 0.5 // 50% of total container height
        },
        'view-scripts': {
            // Scripts view (bottom-middle-right)
            width: 0.33, // 33% of bottom row width
            height: 0.5 // 50% of total container height
        },
        'view-console': {
            // Console view (bottom-right)
            width: 0.33, // 33% of bottom row width
            height: 0.5 // 50% of total container height
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
