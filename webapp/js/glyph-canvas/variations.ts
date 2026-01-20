import { get_font_axes } from '../../wasm-dist/babelfont_fontc_web';
import type { Axis } from '../babelfont-types';
import { ensureWasmInitialized } from '../wasm-init';

interface VariationAxis {
    tag: string;
    name: string;
    min: number;
    max: number;
    default: number;
}

export class AxesManager {
    variationSettings: Record<string, number>;
    axesSection: HTMLElement | null;
    // Animation state
    animationFrames: number;
    isAnimating: boolean;
    animationStartValues: Record<string, number>;
    animationTargetValues: Record<string, number>;
    animationCurrentFrame: number;
    fontBytes: Uint8Array | null;
    callbacks: Record<string, Function[]>; // Support multiple callbacks per event
    isSliderActive: boolean;
    isTextFieldChange: boolean;
    pendingSliderMouseUp: boolean;
    lastSliderReleaseTime: number;
    isLoopAnimating: boolean;
    loopAnimationStopCallbacks: (() => void)[];

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
        this.isTextFieldChange = false;
        this.pendingSliderMouseUp = false;
        this.lastSliderReleaseTime = 0;
        this.isLoopAnimating = false;
        this.loopAnimationStopCallbacks = [];

        this.fontBytes = null; // To be set externally
        this.callbacks = {}; // Array of callbacks for each event
    }

    stopAllLoopAnimations() {
        if (this.loopAnimationStopCallbacks.length > 0) {
            console.log('[AxesManager] Stopping all loop animations');
            // Call all stop callbacks
            this.loopAnimationStopCallbacks.forEach((stop) => stop());
            this.loopAnimationStopCallbacks = [];
            this.isLoopAnimating = false;
            // Trigger sliderMouseUp to finalize
            this.isSliderActive = false;
            if (this.isAnimating) {
                this.pendingSliderMouseUp = true;
            } else {
                this.call('sliderMouseUp');
            }
        }
    }

    on(event: string, callback: Function) {
        if (!this.callbacks[event]) {
            this.callbacks[event] = [];
        }
        this.callbacks[event].push(callback);
    }

    async call(event: string, ...args: any[]) {
        if (this.callbacks[event]) {
            for (const callback of this.callbacks[event]) {
                try {
                    await callback(...args);
                } catch (error) {
                    console.error(
                        `[AxesManager] Error in ${event} callback:`,
                        error
                    );
                }
            }
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

                // Update slider fill
                const min = parseFloat(slider.min);
                const max = parseFloat(slider.max);
                const value = parseFloat(slider.value);
                const percent = ((value - min) / (max - min)) * 100;
                slider.style.setProperty('--value-percent', `${percent}%`);
            }
        });

        // Update all value labels
        const valueLabels = this.axesSection.querySelectorAll(
            'input[data-axis-tag].editor-axis-value'
        );
        valueLabels.forEach((label) => {
            const axisTag: string | null = label.getAttribute('data-axis-tag');
            if (axisTag && this.variationSettings[axisTag] !== undefined) {
                (label as HTMLInputElement).value =
                    this.variationSettings[axisTag].toFixed(0);
            }
        });
    }

    async getVariationAxes(): Promise<VariationAxis[]> {
        if (!this.fontBytes) {
            console.log('[AxesManager]', 'No fontBytes available');
            return [];
        }

        try {
            console.log(
                '[AxesManager]',
                'Getting axes from WASM, fontBytes length:',
                this.fontBytes.length
            );
            await ensureWasmInitialized();
            const axesJson = get_font_axes(this.fontBytes);
            console.log('[AxesManager]', 'Axes JSON:', axesJson);
            return JSON.parse(axesJson);
        } catch (error) {
            console.error('[AxesManager]', 'Failed to get font axes:', error);
            return [];
        }
    }

    getAxisValue(axisTag: string): number | undefined {
        return this.variationSettings[axisTag];
    }

    setAxisValue(axisTag: string, value: number): void {
        this.variationSettings[axisTag] = value;
        this.updateAxisSliders();
    }

    async updateAxesUI() {
        if (!this.axesSection) return;

        const axes = await this.getVariationAxes();

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
        axes.forEach((axis: VariationAxis) => {
            const axisContainer = document.createElement('div');
            axisContainer.className = 'editor-axis-container';

            // Label row (axis name and value)
            const labelRow = document.createElement('div');
            labelRow.className = 'editor-axis-label-row';

            const axisLabel = document.createElement('span');
            axisLabel.className = 'editor-axis-name';
            axisLabel.textContent = axis.name || axis.tag;

            const valueLabel = document.createElement('input');
            valueLabel.type = 'text';
            valueLabel.className = 'editor-axis-value';
            valueLabel.value = axis.default.toFixed(0);
            valueLabel.setAttribute('data-axis-tag', axis.tag); // Add identifier for programmatic updates
            valueLabel.setAttribute('inputmode', 'numeric');

            // Play/pause button for animation
            const playButton = document.createElement('button');
            playButton.className = 'editor-axis-play-button';
            playButton.innerHTML =
                '<span class="material-symbols-rounded">play_arrow</span>';
            playButton.title = 'Animate axis';

            let animationActive = false;
            let animationStartTime = 0;
            let animationFrameId: number | null = null;
            let animationStartValue = 0;

            const animateAxis = () => {
                if (!animationActive) return;

                const now = performance.now();
                const elapsed = now - animationStartTime;
                const wavelength =
                    (window as any).APP_SETTINGS?.AXIS_ANIMATION_WAVELENGTH ||
                    5000;

                // Calculate phase offset so animation starts from current value
                const midpoint = (axis.min + axis.max) / 2;
                const amplitude = (axis.max - axis.min) / 2;
                // Find the phase that corresponds to the start value: sin(phase) = (startValue - midpoint) / amplitude
                const normalizedStart =
                    (animationStartValue - midpoint) / amplitude;
                const startPhase = Math.asin(
                    Math.max(-1, Math.min(1, normalizedStart))
                );

                // Sine wave oscillation starting from the calculated phase
                const sineValue = Math.sin(
                    startPhase + (elapsed / wavelength) * 2 * Math.PI
                );
                // Map sine (-1 to 1) to axis range (min to max)
                const value = midpoint + sineValue * amplitude;

                // Update slider and value label
                slider.value = value.toString();
                valueLabel.value = value.toFixed(0);
                updateSliderFill();

                // Trigger the same callbacks as manual slider interaction
                this.call('onSliderChange', axis.tag, value);
                this.setVariation(axis.tag, value);

                animationFrameId = requestAnimationFrame(animateAxis);
            };

            // Function to stop this animation (called by stopAllLoopAnimations or click)
            const stopAnimation = () => {
                animationActive = false;
                playButton.innerHTML =
                    '<span class="material-symbols-rounded">play_arrow</span>';
                playButton.classList.remove('playing');
                if (animationFrameId !== null) {
                    cancelAnimationFrame(animationFrameId);
                    animationFrameId = null;
                }
            };

            playButton.addEventListener('click', async () => {
                // Toggle: if was active, we're stopping; if was inactive, we're starting
                const wasActive = animationActive;

                if (!wasActive) {
                    // Start animation
                    animationActive = true;
                    playButton.innerHTML =
                        '<span class="material-symbols-rounded">pause</span>';
                    playButton.classList.add('playing');
                    animationStartTime = performance.now();
                    animationStartValue = parseFloat(slider.value);

                    // Mark as loop animating to suppress layer selection
                    this.isLoopAnimating = true;

                    // Register stop callback
                    this.loopAnimationStopCallbacks.push(stopAnimation);

                    // Enter preview mode (same as slider mousedown)
                    this.isSliderActive = true;
                    await this.call('sliderMouseDown');

                    animateAxis();
                } else {
                    // Stop animation
                    stopAnimation();

                    // Remove from callbacks list
                    const index =
                        this.loopAnimationStopCallbacks.indexOf(stopAnimation);
                    if (index > -1) {
                        this.loopAnimationStopCallbacks.splice(index, 1);
                    }

                    // Clear loop animating flag if no more animations
                    if (this.loopAnimationStopCallbacks.length === 0) {
                        this.isLoopAnimating = false;
                    }

                    // Exit preview mode (same as slider mouseup)
                    this.isSliderActive = false;
                    if (this.isAnimating) {
                        this.pendingSliderMouseUp = true;
                    } else {
                        this.call('sliderMouseUp');
                    }
                }
            });

            labelRow.appendChild(axisLabel);
            labelRow.appendChild(playButton);
            labelRow.appendChild(valueLabel);

            // Slider
            const slider = document.createElement('input');
            slider.type = 'range';
            slider.className = 'editor-axis-slider';
            slider.min = axis.min.toString();
            slider.max = axis.max.toString();
            slider.step = '1';
            slider.setAttribute('data-axis-tag', axis.tag); // Add identifier for programmatic updates

            // Restore value if it exists, otherwise use default
            const initialValue =
                this.variationSettings[axis.tag] !== undefined
                    ? this.variationSettings[axis.tag]
                    : axis.default;

            slider.value = initialValue.toString();
            valueLabel.value = initialValue.toFixed(0);

            // Initialize variation setting
            this.variationSettings[axis.tag] = initialValue;

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

            // Handle value input changes
            valueLabel.addEventListener('input', (e) => {
                // @ts-ignore
                let inputValue = e.target.value.replace(/[^0-9.-]/g, '');
                // @ts-ignore
                e.target.value = inputValue;
            });

            valueLabel.addEventListener('change', async (e) => {
                // @ts-ignore
                let value = parseFloat(e.target.value);

                // Clamp value to axis bounds
                if (isNaN(value)) {
                    value = initialValue;
                } else {
                    value = Math.max(axis.min, Math.min(axis.max, value));
                }

                // @ts-ignore
                e.target.value = value.toFixed(0);

                // Update the slider position to match
                slider.value = value.toString();

                // Update slider fill
                updateSliderFill();

                // Mark this as a text field change
                this.isTextFieldChange = true;

                // Execute the same sequence as slider interaction:
                // 1. Mouse down to start interpolation
                await this.call('sliderMouseDown');

                // 2. Change the value and trigger animation
                this.call('onSliderChange', axis.tag, value);
                this.setVariation(axis.tag, value);

                // Note: Layer selection will be handled when animation completes
            });

            valueLabel.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    // @ts-ignore
                    e.target.blur();
                }
            });

            // Enter preview mode on mousedown
            slider.addEventListener('mousedown', () => {
                this.isSliderActive = true;
                this.call('sliderMouseDown');
            });

            // Handle both mouseup (for clicks) and change (for drags)
            const handleSliderRelease = () => {
                const now = Date.now();
                // Prevent duplicate calls within 50ms
                if (now - this.lastSliderReleaseTime < 50) {
                    console.log(
                        '[Variations] Ignoring duplicate slider release event'
                    );
                    return;
                }
                this.lastSliderReleaseTime = now;

                console.log('[Variations] slider release handler called', {
                    isSliderActive: this.isSliderActive,
                    isAnimating: this.isAnimating
                });

                this.isSliderActive = false;

                // If animation is still running, defer sliderMouseUp until it completes
                if (this.isAnimating) {
                    console.log(
                        '[Variations] Animation still running, deferring sliderMouseUp'
                    );
                    this.pendingSliderMouseUp = true;
                } else {
                    console.log(
                        '[Variations] Calling sliderMouseUp immediately'
                    );
                    this.call('sliderMouseUp');
                }
            };

            // mouseup fires for clicks, change fires after drag ends
            slider.addEventListener('mouseup', handleSliderRelease);
            slider.addEventListener('change', handleSliderRelease);

            // Update on change
            slider.addEventListener('input', (e) => {
                // @ts-ignore
                const value = parseFloat(e.target.value);
                valueLabel.value = value.toFixed(0);

                // Update slider fill
                updateSliderFill();

                console.log(
                    '[Variations] Slider input event, calling onSliderChange',
                    axis.tag,
                    value
                );
                this.call('onSliderChange', axis.tag, value);

                this.setVariation(axis.tag, value);
            });
            console.log(
                '[Variations] Attached input listener to slider for axis:',
                axis.tag
            );

            axisContainer.appendChild(labelRow);
            axisContainer.appendChild(slider);
            tempContainer.appendChild(axisContainer);
        });

        console.log(
            '[Variations] About to swap DOM content in requestAnimationFrame'
        );
        // Swap content in one frame to prevent flicker
        requestAnimationFrame(() => {
            console.log('[Variations] Swapping DOM content now');
            this.axesSection!.innerHTML = '';
            while (tempContainer.firstChild) {
                this.axesSection!.appendChild(tempContainer.firstChild);
            }
            console.log('[Variations] DOM swap complete');
        });

        console.log(
            '[Variations]',
            `Created ${axes.length} variable axis sliders`
        );

        // Global mouseup handler to exit preview mode if slider was active
        // This catches cases where mouse is released outside the slider element
        document.addEventListener('mouseup', () => {
            console.log(
                '[Variations] Global mouseup event, isSliderActive:',
                this.isSliderActive
            );
            if (this.isSliderActive) {
                this.isSliderActive = false;
                // If animation is still running, defer sliderMouseUp until it completes
                if (this.isAnimating) {
                    console.log(
                        '[Variations] Global mouseup: Animation still running, deferring'
                    );
                    this.pendingSliderMouseUp = true;
                } else {
                    console.log(
                        '[Variations] Global mouseup: Calling sliderMouseUp'
                    );
                    this.call('sliderMouseUp');
                }
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
            this.updateAxisSliders(); // Update slider UI to match final values

            // If this was a text field change, trigger layer selection now
            if (this.isTextFieldChange) {
                this.isTextFieldChange = false;
                this.call('textFieldAnimationComplete');
            }

            // If slider was released during animation, trigger sliderMouseUp now
            if (this.pendingSliderMouseUp) {
                console.log(
                    '[Variations] Animation complete, triggering deferred sliderMouseUp'
                );
                this.pendingSliderMouseUp = false;
                this.call('sliderMouseUp');
            }

            this.call('animationComplete');

            // Clear isAnimating AFTER deferred sliderMouseUp and animationComplete
            // Always clear isAnimating when animation completes, regardless of isSliderActive state
            // The isSliderActive flag is managed separately by mousedown/mouseup handlers
            this.isAnimating = false;
        }
    }
}
