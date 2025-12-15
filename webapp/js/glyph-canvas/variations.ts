import { Font } from 'opentype.js';
import Babelfont from '../babelfont';

export class AxesManager {
    variationSettings: Record<string, number>;
    axesSection: HTMLElement | null;
    // Animation state
    animationFrames: number;
    isAnimating: boolean;
    animationStartValues: Record<string, number>;
    animationTargetValues: Record<string, number>;
    animationCurrentFrame: number;
    opentypeFont: Font | null;
    callbacks: Record<string, Function>;
    isSliderActive: boolean;

    constructor() {
        this.variationSettings = {}; // Current variation settings
        this.axesSection = null; // Container for axes UI
        // Animation state
        this.animationFrames = parseInt(
            localStorage.getItem('animationFrames') || '10',
            10
        );
        this.isAnimating = false;
        this.animationStartValues = {};
        this.animationTargetValues = {};
        this.animationCurrentFrame = 0;
        this.isSliderActive = false;

        this.opentypeFont = null; // To be set externally
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

    createAxesSection() {
        const axesSection = document.createElement('div');
        axesSection.id = 'glyph-axes-section';
        axesSection.style.display = 'flex';
        axesSection.style.flexDirection = 'column';
        axesSection.style.gap = '10px';
        this.axesSection = axesSection;
        return axesSection;
    }

    updateAxisSliders() {
        // Update axis slider positions to match current variationSettings
        if (!this.axesSection) return;

        // Update all sliders
        const sliders: NodeListOf<HTMLInputElement> =
            this.axesSection.querySelectorAll('input[data-axis-tag]');
        sliders.forEach((slider) => {
            const axisTag: string | null = slider.getAttribute('data-axis-tag');
            if (axisTag && this.variationSettings[axisTag] !== undefined) {
                slider.value = this.variationSettings[axisTag].toString();
            }
        });

        // Update all value labels
        const valueLabels = this.axesSection.querySelectorAll(
            'span[data-axis-tag]'
        );
        valueLabels.forEach((label) => {
            const axisTag: string | null = label.getAttribute('data-axis-tag');
            if (axisTag && this.variationSettings[axisTag] !== undefined) {
                label.textContent = this.variationSettings[axisTag].toFixed(0);
            }
        });
    }

    getVariationAxes() {
        if (!this.opentypeFont || !this.opentypeFont.tables.fvar) {
            return [];
        }
        return this.opentypeFont.tables.fvar.axes || [];
    }

    getAxisValue(axisTag: string): number | undefined {
        return this.variationSettings[axisTag];
    }

    setAxisValue(axisTag: string, value: number): void {
        this.variationSettings[axisTag] = value;
        this.updateAxisSliders();
    }

    updateAxesUI() {
        if (!this.axesSection) return;

        const axes = this.getVariationAxes();

        if (axes.length === 0) {
            requestAnimationFrame(() => {
                this.axesSection!.innerHTML = '';
            });
            return; // No variable axes
        }

        // Build content off-screen first, then swap in one operation
        const tempContainer = document.createElement('div');

        // Add section title
        const title = document.createElement('div');
        title.className = 'editor-section-title';
        title.textContent = 'Variable Axes';
        tempContainer.appendChild(title);

        // Create slider for each axis
        axes.forEach((axis: any) => {
            const axisContainer = document.createElement('div');
            axisContainer.className = 'editor-axis-container';

            // Label row (axis name and value)
            const labelRow = document.createElement('div');
            labelRow.className = 'editor-axis-label-row';

            const axisLabel = document.createElement('span');
            axisLabel.className = 'editor-axis-name';
            axisLabel.textContent = axis.name.en || axis.tag;

            const valueLabel = document.createElement('span');
            valueLabel.className = 'editor-axis-value';
            valueLabel.textContent = axis.defaultValue.toFixed(0);
            valueLabel.setAttribute('data-axis-tag', axis.tag); // Add identifier for programmatic updates

            labelRow.appendChild(axisLabel);
            labelRow.appendChild(valueLabel);

            // Slider
            const slider = document.createElement('input');
            slider.type = 'range';
            slider.className = 'editor-axis-slider';
            slider.min = axis.minValue;
            slider.max = axis.maxValue;
            slider.step = '1';
            slider.setAttribute('data-axis-tag', axis.tag); // Add identifier for programmatic updates

            // Restore 7 value if it exists, otherwise use default
            const initialValue =
                this.variationSettings[axis.tag] !== undefined
                    ? this.variationSettings[axis.tag]
                    : axis.defaultValue;

            slider.value = initialValue;
            valueLabel.textContent = initialValue.toFixed(0);

            // Initialize variation setting
            this.variationSettings[axis.tag] = initialValue;

            // Enter preview mode on mousedown
            slider.addEventListener('mousedown', () => {
                this.isSliderActive = true;
                this.call('sliderMouseDown');
            });

            // Exit preview mode and restore focus on mouseup
            slider.addEventListener('mouseup', () => {
                this.isSliderActive = false;
                this.call('sliderMouseUp');
            });

            // Update on change
            slider.addEventListener('input', (e) => {
                // @ts-ignore
                const value = parseFloat(e.target.value);
                valueLabel.textContent = value.toFixed(0);
                this.call('onSliderChange', axis.tag, value);

                this.setVariation(axis.tag, value);
            });

            axisContainer.appendChild(labelRow);
            axisContainer.appendChild(slider);
            tempContainer.appendChild(axisContainer);
        });

        // Swap content in one frame to prevent flicker
        requestAnimationFrame(() => {
            this.axesSection!.innerHTML = '';
            while (tempContainer.firstChild) {
                this.axesSection!.appendChild(tempContainer.firstChild);
            }
        });

        console.log(
            '[Variations]',
            `Created ${axes.length} variable axis sliders`
        );

        // Global mouseup handler to exit preview mode if slider was active
        // This catches cases where mouse is released outside the slider element
        document.addEventListener('mouseup', () => {
            if (this.isSliderActive) {
                this.isSliderActive = false;
                this.call('sliderMouseUp');
            }
        });
    }

    setVariation(axisTag: string, value: number) {
        this._setupAnimation({ [axisTag]: value });
    }

    _setupAnimation(newSettings: { [key: string]: number }) {
        if (this.isAnimating) {
            this.isAnimating = false;
        }

        this.animationStartValues = { ...this.variationSettings };
        this.animationTargetValues = {
            ...this.variationSettings,
            ...newSettings
        };
        this.animationCurrentFrame = 0;
        this.isAnimating = true;
        this.animateVariation();
    }

    async animateVariation() {
        if (!this.isAnimating) return;

        this.animationCurrentFrame++;
        const progress = Math.min(
            this.animationCurrentFrame / this.animationFrames,
            1.0
        );

        // Ease-out cubic for smoother animation
        const easedProgress = 1 - Math.pow(1 - progress, 3);

        // Interpolate all axes
        for (const axisTag in this.animationTargetValues) {
            const startValue =
                this.animationStartValues[axisTag] ||
                this.animationTargetValues[axisTag];
            const targetValue = this.animationTargetValues[axisTag];
            this.variationSettings[axisTag] =
                startValue + (targetValue - startValue) * easedProgress;
        }

        // Update sliders during animation
        this.updateAxisSliders();
        // Skip rendering on frame 1 (just after setup) to prevent jitter
        // Frame 1 would show the target layer at near-start position which causes a flash
        if (this.animationCurrentFrame > 1) {
            this.call('animationInProgress');
        }

        if (progress < 1.0) {
            const delay =
                (window as any).APP_SETTINGS?.OUTLINE_EDITOR
                    ?.INTERPOLATION_ANIMATION_DELAY || 0;
            if (delay > 0) {
                setTimeout(
                    () => requestAnimationFrame(() => this.animateVariation()),
                    delay
                );
            } else {
                requestAnimationFrame(() => this.animateVariation());
            }
        } else {
            // Ensure we end exactly at target values
            this.variationSettings = { ...this.animationTargetValues };
            // Only clear isAnimating if slider is not actively being dragged
            // During slider drag, keep isAnimating=true to prevent auto-pan jitter
            if (!this.isSliderActive) {
                this.isAnimating = false;
            }
            this.updateAxisSliders(); // Update slider UI to match final values
            this.call('animationComplete');
        }
    }
}
