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

        // Close dropdown with Escape key
        document.addEventListener(
            'keydown',
            (e) => {
                if (this.isOpen && e.key === 'Escape') {
                    e.preventDefault();
                    e.stopPropagation();
                    this.closeDropdown();

                    // Restore focus to canvas if editor view is active
                    this.restoreFocusToCanvas();
                }
            },
            true
        ); // Use capture phase to intercept before other handlers
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

    restoreFocusToCanvas() {
        const editorView = document.getElementById('view-editor');
        if (
            editorView &&
            editorView.classList.contains('focused') &&
            window.glyphCanvas &&
            window.glyphCanvas.canvas
        ) {
            setTimeout(() => window.glyphCanvas.canvas.focus(), 0);
        }
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

                // Don't toggle if clicking on UI elements
                if (e.target.closest('.plugin-ui-elements')) {
                    return;
                }

                const newState = window.canvasPluginManager.togglePlugin(
                    plugin.entry_point
                );

                // Update the entire dropdown to show/hide UI elements
                this.updatePluginList();

                // Trigger canvas redraw
                if (window.glyphCanvas && window.glyphCanvas.renderer) {
                    window.glyphCanvas.renderer.render();
                }

                // Restore focus to canvas if editor view is active
                this.restoreFocusToCanvas();
            });

            this.dropdown.appendChild(item);

            // Add UI elements if plugin is enabled and has UI elements
            if (
                isEnabled &&
                plugin.ui_elements &&
                plugin.ui_elements.length > 0
            ) {
                const uiContainer = document.createElement('div');
                uiContainer.className = 'plugin-ui-elements';

                plugin.ui_elements.forEach((element) => {
                    const uiElement = this.createUIElement(element, plugin);
                    if (uiElement) {
                        uiContainer.appendChild(uiElement);
                    }
                });

                this.dropdown.appendChild(uiContainer);
            }
        });
    }

    createUIElement(element, plugin) {
        if (element.type === 'slider') {
            return this.createSlider(element, plugin);
        }
        // Future: support other element types (checkbox, color-picker, etc.)
        return null;
    }

    createSlider(element, plugin) {
        const container = document.createElement('div');
        container.className = 'plugin-ui-slider';

        const label = document.createElement('label');
        label.textContent = element.label || element.id;
        label.className = 'plugin-ui-label';

        const valueInput = document.createElement('input');
        valueInput.type = 'text';
        valueInput.className = 'plugin-ui-value';

        const slider = document.createElement('input');
        slider.type = 'range';
        slider.min = element.min || 0;
        slider.max = element.max || 100;
        slider.step = element.step || 1;

        // Get current value or use default
        let currentValue = window.canvasPluginManager.getPluginParameter(
            plugin.entry_point,
            element.id
        );
        if (currentValue === null || currentValue === undefined) {
            currentValue = element.default || element.min || 0;
        }
        slider.value = currentValue;
        valueInput.value = currentValue;

        // Update from slider
        slider.addEventListener('input', (e) => {
            e.stopPropagation();
            const value = parseFloat(e.target.value);
            valueInput.value = value;
            window.canvasPluginManager.setPluginParameter(
                plugin.entry_point,
                element.id,
                value
            );

            // Trigger canvas redraw
            if (window.glyphCanvas && window.glyphCanvas.renderer) {
                window.glyphCanvas.renderer.render();
            }

            // Restore focus to canvas if editor view is active
            this.restoreFocusToCanvas();
        });

        // Update from text input
        valueInput.addEventListener('input', (e) => {
            e.stopPropagation();
            const value = parseFloat(e.target.value);
            if (!isNaN(value)) {
                // Clamp to min/max
                const clampedValue = Math.max(
                    element.min || 0,
                    Math.min(element.max || 100, value)
                );
                slider.value = clampedValue;
                window.canvasPluginManager.setPluginParameter(
                    plugin.entry_point,
                    element.id,
                    clampedValue
                );

                // Trigger canvas redraw
                if (window.glyphCanvas && window.glyphCanvas.renderer) {
                    window.glyphCanvas.renderer.render();
                }
            }
        });

        // Validate and format on blur
        valueInput.addEventListener('blur', (e) => {
            const value = parseFloat(e.target.value);
            if (isNaN(value)) {
                valueInput.value = slider.value;
            } else {
                const clampedValue = Math.max(
                    element.min || 0,
                    Math.min(element.max || 100, value)
                );
                valueInput.value = clampedValue;
                slider.value = clampedValue;
            }

            // Restore focus to canvas if editor view is active
            this.restoreFocusToCanvas();
        });

        // Handle Enter key
        valueInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                valueInput.blur();
            }
        });

        container.appendChild(label);
        container.appendChild(slider);
        container.appendChild(valueInput);

        return container;
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
