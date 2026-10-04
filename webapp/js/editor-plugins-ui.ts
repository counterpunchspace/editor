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

import { bindModalEscape, type ModalEscapeBinding } from './ui/modal-escape';
import {
    createPluginSettingControl,
    type PluginSetting
} from './plugin-settings/plugin-settings-controls';

type PluginOption = {
    label?: string;
    value: string;
};

type PluginUIElement = {
    type: string;
    id: string;
    label?: string;
    default?: string | number | boolean;
    min?: number;
    max?: number;
    step?: number;
    placeholder?: string;
    options?: PluginOption[];
};

type CanvasPluginEntry = {
    entry_point: string;
    name?: string;
    ui_elements?: PluginUIElement[];
    instance?: {
        visible?: () => boolean;
    };
};

class EditorPluginsUI {
    dropdownBtn: HTMLElement | null;
    dropdown: HTMLElement | null;
    isOpen: boolean;
    private escapeBinding: ModalEscapeBinding | null = null;

    constructor() {
        this.dropdownBtn = document.getElementById(
            'editor-plugins-dropdown-btn'
        );
        this.dropdown = document.getElementById('editor-plugins-dropdown');
        this.isOpen = false;

        this.init();
    }

    updateButtonVisibility() {
        if (!this.dropdownBtn) {
            return;
        }

        const isEditMode = !!window.glyphCanvas?.outlineEditor?.active;

        if (!isEditMode && this.isOpen) {
            this.closeDropdown();
        }

        if (this.dropdownBtn instanceof HTMLButtonElement) {
            this.dropdownBtn.disabled = !isEditMode;
        }
        this.dropdownBtn.setAttribute('aria-disabled', String(!isEditMode));
        this.dropdownBtn.classList.toggle('inactive', !isEditMode);
        this.dropdownBtn.style.display = 'flex';
    }

    init() {
        if (!this.dropdownBtn || !this.dropdown) {
            return;
        }

        this.updateButtonVisibility();

        // Toggle dropdown on button click
        this.dropdownBtn.addEventListener('click', (e: MouseEvent) => {
            e.stopPropagation();

            if ((this.dropdownBtn as HTMLButtonElement).disabled) {
                return;
            }

            this.toggleDropdown();
        });

        // Close dropdown when clicking outside
        document.addEventListener('click', (e: MouseEvent) => {
            if (this.isOpen && !this.dropdown?.contains(e.target as Node)) {
                this.closeDropdown();
            }
        });

        window.addEventListener('editorModeChanged', () => {
            this.updateButtonVisibility();
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
        if (!this.dropdown) {
            return;
        }
        const dropdown = this.dropdown;
        this.updatePluginList();
        this.dropdown.style.display = 'block';
        this.isOpen = true;
        this.escapeBinding?.release();
        this.escapeBinding = bindModalEscape(() => this.closeDropdown(), {
            isOpen: () => this.isOpen
        });
    }

    closeDropdown() {
        if (!this.dropdown) {
            return;
        }
        this.escapeBinding?.release();
        this.escapeBinding = null;
        this.dropdown.style.display = 'none';
        this.isOpen = false;
    }

    restoreFocusToCanvas() {
        window.restoreFocusedViewDomFocus?.();
    }

    updatePluginList() {
        if (
            !window.canvasPluginManager ||
            !window.canvasPluginManager.isLoaded()
        ) {
            if (!this.dropdown) {
                return;
            }
            this.dropdown.innerHTML =
                '<div class="editor-plugins-dropdown-empty">No plugins loaded</div>';
            return;
        }

        const plugins =
            window.canvasPluginManager.getPlugins() as CanvasPluginEntry[];

        if (plugins.length === 0) {
            if (!this.dropdown) {
                return;
            }
            this.dropdown.innerHTML =
                '<div class="editor-plugins-dropdown-empty">No plugins available</div>';
            return;
        }

        if (!this.dropdown) {
            return;
        }
        const dropdown = this.dropdown;

        // Clear existing content
        dropdown.innerHTML = '';

        // Create plugin items
        plugins.forEach((plugin: CanvasPluginEntry) => {
            // Skip plugins that have visible() method returning false
            if (plugin.instance && plugin.instance.visible) {
                try {
                    const isVisible = plugin.instance.visible();
                    if (!isVisible) {
                        return; // Skip this plugin
                    }
                } catch (e) {
                    console.error(
                        `Error checking visibility for plugin ${plugin.name}:`,
                        e
                    );
                }
            }

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
            item.addEventListener('click', (e: MouseEvent) => {
                e.stopPropagation();

                // Don't toggle if clicking on UI elements
                if (
                    (e.target as HTMLElement | null)?.closest(
                        '.plugin-ui-elements'
                    )
                ) {
                    return;
                }

                window.canvasPluginManager.togglePlugin(plugin.entry_point);

                // Update the entire dropdown to show/hide UI elements
                this.updatePluginList();

                // Trigger canvas redraw
                if (window.glyphCanvas && window.glyphCanvas.renderer) {
                    window.glyphCanvas.renderer.render();
                }

                // Restore focus to canvas if editor view is active
                this.restoreFocusToCanvas();
            });

            dropdown.appendChild(item);

            // Add UI elements if plugin is enabled and has UI elements
            if (
                isEnabled &&
                plugin.ui_elements &&
                plugin.ui_elements.length > 0
            ) {
                const uiContainer = document.createElement('div');
                uiContainer.className = 'plugin-ui-elements';

                plugin.ui_elements.forEach((element: PluginUIElement) => {
                    const uiElement = this.createUIElement(element, plugin);
                    if (uiElement) {
                        uiContainer.appendChild(uiElement);
                    }
                });

                dropdown.appendChild(uiContainer);
            }
        });
    }

    createUIElement(element: PluginUIElement, plugin: CanvasPluginEntry) {
        return createPluginSettingControl(
            { ...element, target: 'canvas.plugins' } as PluginSetting,
            {
                get: (id) =>
                    window.canvasPluginManager.getPluginParameter(
                        plugin.entry_point,
                        id
                    ),
                set: (id, value) => {
                    window.canvasPluginManager.setPluginParameter(
                        plugin.entry_point,
                        id,
                        value
                    );
                    window.glyphCanvas?.renderer?.render();
                    this.restoreFocusToCanvas();
                }
            }
        );
    }

    createSlider(element: PluginUIElement, plugin: CanvasPluginEntry) {
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
        slider.min = String(element.min ?? 0);
        slider.max = String(element.max ?? 100);
        slider.step = String(element.step ?? 1);

        // Get current value or use default
        let currentValue = window.canvasPluginManager.getPluginParameter(
            plugin.entry_point,
            element.id
        );
        if (currentValue === null || currentValue === undefined) {
            currentValue = element.default || element.min || 0;
        }
        slider.value = String(currentValue);
        valueInput.value = String(currentValue);

        // Function to update slider fill
        const updateSliderFill = () => {
            const min = parseFloat(slider.min);
            const max = parseFloat(slider.max);
            const value = parseFloat(slider.value);
            const percent = ((value - min) / (max - min)) * 100;
            slider.style.setProperty('--value-percent', `${percent}%`);
        };

        // Set initial fill
        updateSliderFill();

        // Update from slider
        slider.addEventListener('input', (e: Event) => {
            e.stopPropagation();
            const value = parseFloat((e.target as HTMLInputElement).value);
            valueInput.value = String(value);
            updateSliderFill();
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
        valueInput.addEventListener('input', (e: Event) => {
            e.stopPropagation();
            const value = parseFloat((e.target as HTMLInputElement).value);
            if (!isNaN(value)) {
                // Clamp to min/max
                const clampedValue = Math.max(
                    element.min || 0,
                    Math.min(element.max || 100, value)
                );
                slider.value = String(clampedValue);
                updateSliderFill();
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
        valueInput.addEventListener('blur', (e: Event) => {
            const value = parseFloat((e.target as HTMLInputElement).value);
            if (isNaN(value)) {
                valueInput.value = slider.value;
            } else {
                const clampedValue = Math.max(
                    element.min || 0,
                    Math.min(element.max || 100, value)
                );
                valueInput.value = String(clampedValue);
                slider.value = String(clampedValue);
                updateSliderFill();
            }

            // Restore focus to canvas if editor view is active
            this.restoreFocusToCanvas();
        });

        // Handle Enter key
        valueInput.addEventListener('keydown', (e: KeyboardEvent) => {
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

    createTextField(element: PluginUIElement, plugin: CanvasPluginEntry) {
        const container = document.createElement('div');
        container.className = 'plugin-ui-textfield';

        const label = document.createElement('label');
        label.textContent = element.label || element.id;
        label.className = 'plugin-ui-label';

        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'plugin-ui-text-input';
        input.placeholder = element.placeholder || '';

        // Get current value or use default
        let currentValue = window.canvasPluginManager.getPluginParameter(
            plugin.entry_point,
            element.id
        );
        if (currentValue === null || currentValue === undefined) {
            currentValue = element.default || '';
        }
        input.value = currentValue;

        // Update on input
        input.addEventListener('input', (e: Event) => {
            e.stopPropagation();
            const value = (e.target as HTMLInputElement).value;
            window.canvasPluginManager.setPluginParameter(
                plugin.entry_point,
                element.id,
                value
            );

            // Trigger canvas redraw
            if (window.glyphCanvas && window.glyphCanvas.renderer) {
                window.glyphCanvas.renderer.render();
            }
        });

        // Handle Enter key
        input.addEventListener('keydown', (e: KeyboardEvent) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                input.blur();
            }
        });

        // Restore focus on blur
        input.addEventListener('blur', () => {
            this.restoreFocusToCanvas();
        });

        container.appendChild(label);
        container.appendChild(input);

        return container;
    }

    createCheckbox(element: PluginUIElement, plugin: CanvasPluginEntry) {
        const container = document.createElement('div');
        container.className = 'plugin-ui-checkbox';

        const label = document.createElement('label');
        label.textContent = element.label || element.id;
        label.className = 'plugin-ui-label';

        const input = document.createElement('input');
        input.type = 'checkbox';
        input.className = 'plugin-ui-checkbox-input';

        // Get current value or use default
        let currentValue = window.canvasPluginManager.getPluginParameter(
            plugin.entry_point,
            element.id
        );
        if (currentValue === null || currentValue === undefined) {
            currentValue =
                element.default !== undefined ? element.default : false;
        }
        input.checked = currentValue;

        // Update on change
        input.addEventListener('change', (e: Event) => {
            e.stopPropagation();
            const value = (e.target as HTMLInputElement).checked;
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

        container.appendChild(label);
        container.appendChild(input);

        return container;
    }

    createRadioGroup(element: PluginUIElement, plugin: CanvasPluginEntry) {
        const container = document.createElement('div');
        container.className = 'plugin-ui-radio-group';

        const groupLabel = document.createElement('div');
        groupLabel.textContent = element.label || element.id;
        groupLabel.className = 'plugin-ui-label';
        container.appendChild(groupLabel);

        // Get current value or use default
        let currentValue = window.canvasPluginManager.getPluginParameter(
            plugin.entry_point,
            element.id
        );
        if (currentValue === null || currentValue === undefined) {
            currentValue =
                element.default ||
                (element.options && element.options[0]?.value) ||
                '';
        }

        const optionsContainer = document.createElement('div');
        optionsContainer.className = 'plugin-ui-radio-options';

        // Create radio buttons for each option
        (element.options || []).forEach((option: PluginOption) => {
            const optionLabel = document.createElement('label');
            optionLabel.className = 'plugin-ui-radio-label';

            const input = document.createElement('input');
            input.type = 'radio';
            input.name = `${plugin.entry_point}_${element.id}`;
            input.value = option.value;
            input.className = 'plugin-ui-radio-input';
            input.checked = option.value === currentValue;

            const labelText = document.createElement('span');
            labelText.textContent = option.label || option.value;

            // Update on change
            input.addEventListener('change', (e: Event) => {
                e.stopPropagation();
                const target = e.target as HTMLInputElement;
                if (target.checked) {
                    const value = target.value;
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
                }
            });

            optionLabel.appendChild(input);
            optionLabel.appendChild(labelText);
            optionsContainer.appendChild(optionLabel);
        });

        container.appendChild(optionsContainer);

        return container;
    }

    createColorPicker(element: PluginUIElement, plugin: CanvasPluginEntry) {
        const container = document.createElement('div');
        container.className = 'plugin-ui-color';

        const label = document.createElement('label');
        label.textContent = element.label || element.id;
        label.className = 'plugin-ui-label';

        const input = document.createElement('input');
        input.type = 'color';
        input.className = 'plugin-ui-color-input';

        // Get current value or use default
        let currentValue = window.canvasPluginManager.getPluginParameter(
            plugin.entry_point,
            element.id
        );
        if (currentValue === null || currentValue === undefined) {
            currentValue = element.default || '#000000';
        }
        input.value = currentValue;

        // Update on change
        input.addEventListener('input', (e: Event) => {
            e.stopPropagation();
            const value = (e.target as HTMLInputElement).value;
            window.canvasPluginManager.setPluginParameter(
                plugin.entry_point,
                element.id,
                value
            );

            // Trigger canvas redraw
            if (window.glyphCanvas && window.glyphCanvas.renderer) {
                window.glyphCanvas.renderer.render();
            }
        });

        container.appendChild(label);
        container.appendChild(input);

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
