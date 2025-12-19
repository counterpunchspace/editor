import {
    get_font_features,
    get_stylistic_set_names
} from '../../wasm-dist/babelfont_fontc_web';
import { getOpentypeFeatureInfo } from '../opentype-features';
import { ensureWasmInitialized } from '../wasm-init';

export class FeaturesManager {
    featureSettings: Record<string, boolean>;
    defaultFeatureSettings: Record<string, boolean>;
    fontBytes: Uint8Array | null;
    featuresSection: HTMLElement | null;
    featureResetButton: HTMLButtonElement | null;
    callbacks: Record<string, Function>;

    constructor() {
        this.featureSettings = {}; // Store OpenType feature on/off states
        this.defaultFeatureSettings = {}; // Store default states for reset
        this.fontBytes = null; // To be set to the compiled font bytes
        this.featuresSection = null;
        this.featureResetButton = null;
        this.callbacks = {}; // Optional callbacks for interaction with GlyphCanvas
    }

    on(event: string, callback: Function) {
        this.callbacks[event] = callback;
    }

    call(event: string, ...args: any[]) {
        if (this.callbacks[event]) {
            this.callbacks[event](...args);
        }
    }

    createFeaturesSection() {
        const featuresSection = document.createElement('div');
        featuresSection.id = 'glyph-features-section';
        featuresSection.style.display = 'flex';
        featuresSection.style.flexDirection = 'column';
        featuresSection.style.gap = '2px';
        featuresSection.style.marginTop = '10px';
        this.featuresSection = featuresSection;
        return featuresSection;
    }

    async getDiscretionaryFeatures() {
        // Get discretionary features from the compiled font
        if (!this.fontBytes) {
            console.log('[Features]', 'No fontBytes available');
            return [];
        }

        try {
            console.log(
                '[Features]',
                'Getting features from WASM, fontBytes length:',
                this.fontBytes.length
            );
            // Ensure WASM is initialized
            await ensureWasmInitialized();
            // Get all features from the font using WASM
            const featuresJson = get_font_features(this.fontBytes);
            console.log('[Features]', 'Features JSON:', featuresJson);
            const fontFeatures: string[] = JSON.parse(featuresJson);

            // Get stylistic set names
            const ssNamesJson = get_stylistic_set_names(this.fontBytes);
            console.log('[Features]', 'Stylistic set names JSON:', ssNamesJson);
            const ssNames: Record<string, string> = JSON.parse(ssNamesJson);

            // Get feature info from JavaScript module
            const featureInfo = getOpentypeFeatureInfo();

            const defaultOnFeatures = new Set(featureInfo.default_on);
            const defaultOffFeatures = new Set(featureInfo.default_off);
            const allDiscretionary = new Set([
                ...defaultOnFeatures,
                ...defaultOffFeatures
            ]);
            const descriptions = featureInfo.descriptions;

            // Filter to only discretionary features
            const discretionaryInFont: string[] = fontFeatures.filter(
                (tag: string) => allDiscretionary.has(tag)
            );

            // Build feature list with metadata
            return discretionaryInFont.map((tag: string) => {
                // Use stylistic set name if available, otherwise fall back to description
                const hasCustomName = !!ssNames[tag];
                const description = ssNames[tag] || descriptions[tag] || tag;

                return {
                    tag: tag,
                    defaultOn: defaultOnFeatures.has(tag),
                    description: description,
                    hasCustomName: hasCustomName
                };
            });
        } catch (error) {
            console.error('[Features]', 'Failed to get features:', error);
            return [];
        }
    }

    async updateFeaturesUI() {
        if (!this.featuresSection) {
            console.warn('[Features]', 'Features section not created yet');
            return;
        }

        const features = await this.getDiscretionaryFeatures();
        console.log('[Features]', 'Updating features');

        if (features.length === 0) {
            console.log(
                '[Features]',
                'No discretionary features found in font'
            );
            requestAnimationFrame(() => {
                this.featuresSection!.innerHTML = '';
            });
            return; // No discretionary features
        }

        // Build content off-screen first, then swap in one operation
        const tempContainer = document.createElement('div');

        // Add section header with reset button
        const headerRow = document.createElement('div');
        headerRow.className = 'editor-section-header';
        headerRow.style.display = 'flex';
        headerRow.style.justifyContent = 'space-between';
        headerRow.style.alignItems = 'center';
        headerRow.style.marginBottom = '8px';

        const title = document.createElement('div');
        title.className = 'editor-section-title';
        title.textContent = 'OpenType Features';
        title.style.margin = '0';

        const resetButton = document.createElement('button');
        resetButton.className = 'feature-reset-button';
        resetButton.textContent = 'Reset';
        resetButton.style.fontSize = '11px';
        resetButton.style.padding = '2px 8px';
        resetButton.style.cursor = 'pointer';
        resetButton.style.opacity = '0.5';
        resetButton.style.pointerEvents = 'none';
        resetButton.disabled = true;

        resetButton.addEventListener('click', () => {
            this.resetFeaturesToDefaults();
        });

        headerRow.appendChild(title);
        headerRow.appendChild(resetButton);
        tempContainer.appendChild(headerRow);

        // Store reset button reference
        this.featureResetButton = resetButton;

        // Initialize default states and current states
        features.forEach((feature: any) => {
            this.defaultFeatureSettings[feature.tag] = feature.defaultOn;
            if (this.featureSettings[feature.tag] === undefined) {
                this.featureSettings[feature.tag] = feature.defaultOn;
            }
        });

        // Create button for each feature (no separate scrollable container)
        features.forEach((feature: any) => {
            const featureRow = document.createElement('div');
            featureRow.className = 'editor-feature-row';
            featureRow.style.display = 'flex';
            featureRow.style.alignItems = 'center';
            featureRow.style.gap = '8px';
            featureRow.style.fontSize = '12px';
            featureRow.style.padding = '2px 0';

            const tagButton = document.createElement('button');
            tagButton.className = 'editor-feature-tag-button tag-button';
            tagButton.setAttribute('data-feature-tag', feature.tag);
            tagButton.textContent = feature.tag;

            // Set initial state
            const isEnabled = this.featureSettings[feature.tag];
            tagButton.classList.toggle('enabled', isEnabled);

            tagButton.addEventListener('click', () => {
                this.featureSettings[feature.tag] =
                    !this.featureSettings[feature.tag];
                tagButton.classList.toggle(
                    'enabled',
                    this.featureSettings[feature.tag]
                );
                this.updateFeatureResetButton();
                this.call('change');
            });

            const descSpan = document.createElement('span');
            descSpan.className = 'editor-feature-description tag-description';
            if (feature.hasCustomName) {
                descSpan.classList.add('custom-name');
            }
            // Extract just the feature name (before the dash)
            const shortDesc = feature.description.split(' - ')[0];
            descSpan.textContent = shortDesc;

            featureRow.appendChild(tagButton);
            featureRow.appendChild(descSpan);
            tempContainer.appendChild(featureRow);
        });

        // Swap content in one frame to prevent flicker
        requestAnimationFrame(() => {
            this.featuresSection!.innerHTML = '';
            while (tempContainer.firstChild) {
                this.featuresSection!.appendChild(tempContainer.firstChild);
            }
        });

        this.updateFeatureResetButton();

        console.log('[Features]', `Created ${features.length} feature buttons`);
    }

    updateFeatureResetButton() {
        if (!this.featureResetButton) return;

        // Check if any feature is not in default state
        const isNonDefault = Object.keys(this.featureSettings).some((tag) => {
            return (
                this.featureSettings[tag] !== this.defaultFeatureSettings[tag]
            );
        });

        if (isNonDefault) {
            this.featureResetButton.style.opacity = '1';
            this.featureResetButton.style.pointerEvents = 'auto';
            this.featureResetButton.disabled = false;
        } else {
            this.featureResetButton.style.opacity = '0.5';
            this.featureResetButton.style.pointerEvents = 'none';
            this.featureResetButton.disabled = true;
        }
    }

    resetFeaturesToDefaults() {
        // Reset all features to their default states
        Object.keys(this.defaultFeatureSettings).forEach((tag) => {
            this.featureSettings[tag] = this.defaultFeatureSettings[tag];
        });

        // Update buttons
        if (this.featuresSection) {
            const buttons = this.featuresSection.querySelectorAll(
                'button[data-feature-tag]'
            );
            buttons.forEach((button) => {
                const tag = button.getAttribute('data-feature-tag');
                const isEnabled = this.defaultFeatureSettings[tag!];
                button.classList.toggle('enabled', isEnabled);
            });
        }

        this.updateFeatureResetButton();
        this.call('change');
    }

    getHarfBuzzFeatures() {
        // Build HarfBuzz feature string from feature settings
        // Format: "liga=1,dlig=0,kern=1" or undefined if no features
        const featureParts = [];

        for (const [tag, enabled] of Object.entries(this.featureSettings)) {
            featureParts.push(`${tag}=${enabled ? 1 : 0}`);
        }

        // Return undefined if no features (allows HarfBuzz to use defaults)
        return featureParts.length > 0 ? featureParts.join(',') : undefined;
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { FeaturesManager };
}
