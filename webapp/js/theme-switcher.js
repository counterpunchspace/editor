/**
 * Theme Switcher
 * Handles light/dark/auto theme switching with OS preference detection
 */

(function () {
    'use strict';

    // Theme management
    const THEME_KEY = 'preferred-theme';
    const THEMES = {
        LIGHT: 'light',
        DARK: 'dark',
        AUTO: 'auto'
    };

    class ThemeSwitcher {
        constructor() {
            this.settingsBtn = document.getElementById('settings-btn');
            this.settingsPanel = document.getElementById('settings-panel');
            this.settingsCloseBtn = document.getElementById('settings-close-btn');
            this.themeOptions = document.querySelectorAll('.theme-option');
            this.mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');

            this.init();
        }

        init() {
            // Load saved theme preference
            const savedTheme = localStorage.getItem(THEME_KEY) || THEMES.AUTO;
            this.applyThemePreference(savedTheme);
            this.updateActiveButton(savedTheme);

            // Settings panel toggle
            this.settingsBtn?.addEventListener('click', (e) => {
                e.stopPropagation();
                this.toggleSettings();
            });
            this.settingsCloseBtn?.addEventListener('click', () => this.closeSettings());

            // Click anywhere outside to close
            document.addEventListener('click', (e) => {
                if (this.settingsPanel?.classList.contains('open') &&
                    !this.settingsPanel.contains(e.target) &&
                    e.target !== this.settingsBtn) {
                    this.closeSettings();
                }
            });

            // Theme option clicks
            this.themeOptions.forEach(option => {
                option.addEventListener('click', () => {
                    const theme = option.dataset.theme;
                    this.setTheme(theme);
                });
            });

            // Listen for OS theme changes (only when in auto mode)
            this.mediaQuery.addEventListener('change', (e) => {
                const currentPreference = localStorage.getItem(THEME_KEY) || THEMES.AUTO;
                if (currentPreference === THEMES.AUTO) {
                    this.applyTheme(e.matches ? THEMES.DARK : THEMES.LIGHT);
                }
            });

            // Keyboard shortcut: Cmd/Ctrl + ,
            document.addEventListener('keydown', (e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === ',') {
                    e.preventDefault();
                    this.toggleSettings();
                }
            });

            // ESC to close settings
            document.addEventListener('keydown', (e) => {
                if (e.key === 'Escape' && this.settingsPanel?.classList.contains('open')) {
                    e.preventDefault();
                    this.closeSettings();
                }
            });
        }

        toggleSettings() {
            this.settingsPanel?.classList.toggle('open');
        }

        closeSettings() {
            this.settingsPanel?.classList.remove('open');
        }

        setTheme(preference) {
            localStorage.setItem(THEME_KEY, preference);
            this.applyThemePreference(preference);
            this.updateActiveButton(preference);
        }

        applyThemePreference(preference) {
            let actualTheme;

            if (preference === THEMES.AUTO) {
                // Use OS preference
                actualTheme = this.mediaQuery.matches ? THEMES.DARK : THEMES.LIGHT;
            } else {
                actualTheme = preference;
            }

            this.applyTheme(actualTheme);
        }

        applyTheme(theme) {
            const root = document.documentElement;

            if (theme === THEMES.LIGHT) {
                root.setAttribute('data-theme', 'light');
            } else {
                root.removeAttribute('data-theme');
            }

            // Update Ace editor theme if it exists
            this.updateAceTheme(theme);
        }

        updateAceTheme(theme) {
            // Wait for Ace editor to be initialized
            setTimeout(() => {
                const scriptEditor = window.scriptEditor;
                if (scriptEditor) {
                    if (theme === THEMES.LIGHT) {
                        scriptEditor.setTheme('ace/theme/chrome');
                    } else {
                        scriptEditor.setTheme('ace/theme/monokai');
                    }
                }
            }, 100);
        }

        updateActiveButton(preference) {
            this.themeOptions.forEach(option => {
                if (option.dataset.theme === preference) {
                    option.classList.add('active');
                } else {
                    option.classList.remove('active');
                }
            });
        }

        getCurrentTheme() {
            return localStorage.getItem(THEME_KEY) || THEMES.AUTO;
        }

        getActualTheme() {
            const preference = this.getCurrentTheme();
            if (preference === THEMES.AUTO) {
                return this.mediaQuery.matches ? THEMES.DARK : THEMES.LIGHT;
            }
            return preference;
        }
    }

    // Initialize when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            window.themeSwitcher = new ThemeSwitcher();
        });
    } else {
        window.themeSwitcher = new ThemeSwitcher();
    }

})();
