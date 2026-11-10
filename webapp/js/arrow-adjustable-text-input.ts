type ArrowAdjustableTextInputOptions = {
    input: HTMLInputElement;
    getValue: () => number;
    applyValue: (value: number) => void | Promise<void>;
    findReplacementInput?: () => HTMLInputElement | null;
    /**
     * What the field edits (layer, selection, cell). Together with the field
     * itself it names the edit burst: a held arrow key is one history item
     * and one cloud send, not one per repeat. `false` when `applyValue` runs
     * its own burst.
     */
    burstScope?: (() => string) | false;
};

export class ArrowAdjustableTextInput {
    private input: HTMLInputElement;
    private getValue: () => number;
    private applyValue: (value: number) => void | Promise<void>;
    private findReplacementInput?: () => HTMLInputElement | null;
    private burstScope?: (() => string) | false;
    private _isApplyingStep = false;

    constructor(options: ArrowAdjustableTextInputOptions) {
        this.input = options.input;
        this.getValue = options.getValue;
        this.applyValue = options.applyValue;
        this.findReplacementInput = options.findReplacementInput;
        this.burstScope = options.burstScope;

        this.input.addEventListener('keydown', this.handleKeyDown);
    }

    get isApplyingStep(): boolean {
        return this._isApplyingStep;
    }

    private static getStep(event: KeyboardEvent): number {
        if (event.metaKey) {
            return 100;
        }
        if (event.shiftKey) {
            return 10;
        }
        return 1;
    }

    private focusReplacementInput(): void {
        const replacementInput = this.findReplacementInput?.();
        if (!replacementInput) {
            return;
        }

        replacementInput.focus();
        const valueLength = replacementInput.value.length;
        replacementInput.setSelectionRange(valueLength, valueLength);
    }

    private getBurstKey(): string {
        const field =
            this.input.dataset.propertyField ||
            this.input.name ||
            this.input.id ||
            'field';
        const scope = this.burstScope ? this.burstScope() : '';
        return ['arrow-field', field, scope].join(':');
    }

    private handleKeyDown = async (event: KeyboardEvent): Promise<void> => {
        if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') {
            return;
        }

        event.preventDefault();
        event.stopPropagation();

        const currentValue = this.getValue();
        if (!Number.isFinite(currentValue)) {
            return;
        }

        const delta =
            (event.key === 'ArrowUp' ? 1 : -1) *
            ArrowAdjustableTextInput.getStep(event);
        const nextValue = currentValue + delta;

        this._isApplyingStep = true;
        this.input.value = String(nextValue);

        try {
            const engine = window.patchSyncEngine;
            if (this.burstScope !== false && engine?.runInEditBurst) {
                await engine.runInEditBurst(this.getBurstKey(), () =>
                    this.applyValue(nextValue)
                );
            } else {
                await this.applyValue(nextValue);
            }
        } finally {
            this._isApplyingStep = false;
            this.focusReplacementInput();
        }
    };
}
