import { mountModalOverlay } from '../ui/confirm-dialog';
import {
    CALIBRATION_CSS_CM,
    CM_PER_INCH,
    computeUnitScaleFromMeasurement,
    DEFAULT_UNIT_SCALE,
    getScreenUnitScale,
    resetScreenUnitScale,
    setScreenUnitScale,
    type ScreenCalibrationUnit
} from './point-size';

function impliedMeasurement(
    unit: ScreenCalibrationUnit,
    unitScale: number
): string {
    const cssLength =
        unit === 'in' ? CALIBRATION_CSS_CM / CM_PER_INCH : CALIBRATION_CSS_CM;
    const measured = cssLength / unitScale;
    return String(Math.round(measured * 1000) / 1000);
}

export function showScreenCalibrationDialog(): void {
    const { overlay, close } = mountModalOverlay({
        closeSelector: '.info-popup-close',
        onDismiss: () => {},
        innerHTML: `
        <div class="info-popup screen-calibration-popup">
            <div class="info-popup-header">
                <h3>Calibrate screen</h3>
                <button type="button" class="info-popup-close" aria-label="Close">
                    <span class="material-symbols-outlined">close</span>
                </button>
            </div>
            <div class="info-popup-content">
                <p>
                    Point size is a print unit (1&nbsp;pt = 1/72&nbsp;inch).
                    Screens do not report true physical size, so a
                    “point” on screen is usually wrong for print.
                </p>
                <p>
                    Measure the bar with a ruler and enter the length to
                    match on-screen type to printed points.
                </p>
                <p>
                    This only affects the canvas point-size field.
                    Repeat after changing OS scale, browser zoom, or monitor.
                    Counterpunch cannot save the calibration settings
                    for your different monitors.
                </p>
                <div class="screen-calibration-ruler-wrap">
                    <div
                        class="screen-calibration-ruler"
                        style="width: ${CALIBRATION_CSS_CM}cm"
                        aria-hidden="true"
                    ></div>
                    <div class="screen-calibration-ruler-label">
                        ${CALIBRATION_CSS_CM}&nbsp;cm
                    </div>
                </div>
                <div class="screen-calibration-measure-row">
                    <label class="screen-calibration-measure-label" for="screen-calibration-measured">
                        Measured length
                    </label>
                    <input
                        id="screen-calibration-measured"
                        class="screen-calibration-measured-input"
                        type="text"
                        inputMode="decimal"
                    />
                    <div
                        class="screen-calibration-unit-toggle"
                        role="group"
                        aria-label="Measurement unit"
                    >
                        <button
                            type="button"
                            class="dialog-button screen-calibration-unit-btn"
                            data-unit="cm"
                        >
                            cm
                        </button>
                        <button
                            type="button"
                            class="dialog-button screen-calibration-unit-btn"
                            data-unit="in"
                        >
                            in
                        </button>
                    </div>
                </div>
                <div class="confirm-dialog-actions">
                    <button type="button" class="dialog-button" data-action="reset">
                        Reset
                    </button>
                    <button
                        type="button"
                        class="dialog-button dialog-button-primary"
                        data-action="apply"
                    >
                        Apply
                    </button>
                </div>
            </div>
        </div>
    `
    });

    const measuredInput = overlay.querySelector(
        '#screen-calibration-measured'
    ) as HTMLInputElement;
    let unit: ScreenCalibrationUnit = 'cm';
    const currentScale = getScreenUnitScale();
    measuredInput.value = impliedMeasurement(unit, currentScale);

    const unitButtons = overlay.querySelectorAll<HTMLButtonElement>(
        '.screen-calibration-unit-btn'
    );

    function syncUnitButtons() {
        unitButtons.forEach((button) => {
            const isActive = button.dataset.unit === unit;
            button.classList.toggle('dialog-button-primary', isActive);
        });
    }

    syncUnitButtons();

    unitButtons.forEach((button) => {
        button.addEventListener('click', () => {
            const next = button.dataset.unit;
            if (next !== 'cm' && next !== 'in') {
                return;
            }
            const previous = Number.parseFloat(measuredInput.value);
            if (Number.isFinite(previous) && previous > 0 && next !== unit) {
                measuredInput.value =
                    next === 'in'
                        ? String(
                              Math.round((previous / CM_PER_INCH) * 1000) / 1000
                          )
                        : String(
                              Math.round(previous * CM_PER_INCH * 1000) / 1000
                          );
            }
            unit = next;
            syncUnitButtons();
        });
    });

    function applyCalibration(): void {
        const next = computeUnitScaleFromMeasurement(
            Number.parseFloat(measuredInput.value),
            unit
        );
        if (next === null) {
            return;
        }
        setScreenUnitScale(next);
        close();
    }

    overlay
        .querySelector('[data-action="reset"]')
        ?.addEventListener('click', () => {
            resetScreenUnitScale();
            measuredInput.value = impliedMeasurement(unit, DEFAULT_UNIT_SCALE);
            close();
        });

    overlay
        .querySelector('[data-action="apply"]')
        ?.addEventListener('click', applyCalibration);

    measuredInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            applyCalibration();
        }
    });

    queueMicrotask(() => {
        measuredInput.focus();
        measuredInput.select();
    });
}
