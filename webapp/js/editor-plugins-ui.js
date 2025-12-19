// Copyright (C) 2025 Yanone
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.

/**
 * Editor Plugins UI Manager
 *
 * Manages the canvas plugins dropdown in the editor title bar.
 */

class EditorPluginsUI {
    constructor() {
        this.dropdownBtn = document.getElementById(
            'editor-plugins-dropdown-btn'
        );
        this.dropdown = document.getElementById('editor-plugins-dropdown');
        this.isOpen = false;

        this.init();
    }

    init() {
        // Toggle dropdown on button click
        this.dropdownBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.toggleDropdown();
        });

        // Close dropdown when clicking outside
        document.addEventListener('click', (e) => {
            if (this.isOpen && !this.dropdown.contains(e.target)) {
                this.closeDropdown();
            }
        });
    }

    toggleDropdown() {
        if (this.isOpen) {
            this.closeDropdown();
        } else {
            this.openDropdown();
        }
    }

    openDropdown() {
        this.updatePluginList();
        this.dropdown.style.display = 'block';
        this.isOpen = true;
    }

    closeDropdown() {
        this.dropdown.style.display = 'none';
        this.isOpen = false;
    }

    updatePluginList() {
        if (
            !window.canvasPluginManager ||
            !window.canvasPluginManager.isLoaded()
        ) {
            this.dropdown.innerHTML =
                '<div class="editor-plugins-dropdown-empty">No plugins loaded</div>';
            return;
        }

        const plugins = window.canvasPluginManager.getPlugins();

        if (plugins.length === 0) {
            this.dropdown.innerHTML =
                '<div class="editor-plugins-dropdown-empty">No plugins available</div>';
            return;
        }

        // Clear existing content
        this.dropdown.innerHTML = '';

        // Create plugin items
        plugins.forEach((plugin) => {
            const item = document.createElement('div');
            item.className = 'editor-plugins-dropdown-item';

            const isEnabled = window.canvasPluginManager.isPluginEnabled(
                plugin.entry_point
            );
            if (isEnabled) {
                item.classList.add('enabled');
            }

            // Create tag (like OpenType feature tag)
            const tag = document.createElement('span');
            tag.className = 'plugin-tag tag-button';
            if (isEnabled) {
                tag.classList.add('enabled');
            }
            tag.textContent = plugin.entry_point;

            // Create name
            const name = document.createElement('span');
            name.className = 'plugin-name tag-description';
            name.textContent = plugin.name || plugin.entry_point;

            item.appendChild(tag);
            item.appendChild(name);

            // Toggle on click
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                const newState = window.canvasPluginManager.togglePlugin(
                    plugin.entry_point
                );

                if (newState) {
                    item.classList.add('enabled');
                    tag.classList.add('enabled');
                } else {
                    item.classList.remove('enabled');
                    tag.classList.remove('enabled');
                }

                // Trigger canvas redraw
                if (window.glyphCanvas && window.glyphCanvas.renderer) {
                    window.glyphCanvas.renderer.render();
                }
            });

            this.dropdown.appendChild(item);
        });
    }
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        window.editorPluginsUI = new EditorPluginsUI();
    });
} else {
    window.editorPluginsUI = new EditorPluginsUI();
}
