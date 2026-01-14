// UI text translations for the application
// Centralized location for all UI strings

const translations = {
    ai: {
        buttons: {
            reviewChanges: {
                text: 'Review',
                title: 'Review Changes in Script Editor'
            },
            openInEditor: {
                text: 'Open',
                title: 'Open in Script Editor Without Review'
            }
        }
    }
};

// Make available globally immediately (not in DOMContentLoaded)
window.translations = translations;
