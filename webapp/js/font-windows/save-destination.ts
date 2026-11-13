// Where File → Save As starts.

export type SaveDestination = 'disk' | 'cloud' | 'browser' | 'github';

const DESTINATIONS: readonly SaveDestination[] = [
    'disk',
    'cloud',
    'browser',
    'github'
];

/**
 * Where Save As starts: where the font already lives; for a new font, the
 * last destination used, else this computer. A place that isn't available
 * falls back to this computer, then browser storage.
 */
export function chooseSaveDestination(
    current: SaveDestination | null,
    last: string | null,
    available: { fileAccess: boolean; cloud: boolean; github: boolean }
): SaveDestination {
    const remembered = DESTINATIONS.includes(last as SaveDestination)
        ? (last as SaveDestination)
        : null;
    let dest: SaveDestination = current ?? remembered ?? 'disk';
    if (dest === 'cloud' && !available.cloud) {
        dest = available.fileAccess ? 'disk' : 'browser';
    }
    if (dest === 'github' && !available.github) {
        dest = available.fileAccess ? 'disk' : 'browser';
    }
    if (dest === 'disk' && !available.fileAccess) dest = 'browser';
    return dest;
}

/** The Cloud choice: whether it can be picked, its note and its tooltip. */
export type CloudState = { available: boolean; note: string; blocked?: string };

/** The part of the account's cloud eligibility Save As decides on. */
export type CloudSaveEligibility = {
    cloudHostingEnabled: boolean;
    maxFontsOwned: number | null;
    fontsOwnedCount: number;
    subscriptionLapse?: { state?: string; message?: string };
};

export type CloudSaveWarning = {
    visible: boolean;
    title: string;
    label: string;
    canSave: boolean;
};

export const CLOUD_UNREACHABLE_NOTE =
    'Couldn’t reach the cloud. Check your connection and try again.';

/** Why the account can't take another cloud font, or null when it can. */
export function cloudEligibilityRefusal(
    eligibility: CloudSaveEligibility | null
): CloudState | null {
    if (!eligibility) {
        return { available: false, note: CLOUD_UNREACHABLE_NOTE };
    }
    if (!eligibility.cloudHostingEnabled) {
        return {
            available: false,
            note: 'Your plan doesn’t include cloud fonts'
        };
    }
    const lapse = eligibility.subscriptionLapse;
    if (lapse?.state === 'lapsed') {
        return {
            available: false,
            note: 'Your subscription has ended',
            blocked: lapse.message
        };
    }
    const { maxFontsOwned, fontsOwnedCount } = eligibility;
    if (maxFontsOwned !== null && fontsOwnedCount >= maxFontsOwned) {
        return {
            available: false,
            note:
                maxFontsOwned === 1
                    ? 'The one cloud font in your plan is used'
                    : `All ${maxFontsOwned} cloud fonts in your plan are used`
        };
    }
    return null;
}

/** The Cloud choice for an eligible account, with the font's size warning. */
export function cloudStateWithWarning(
    eligibility: CloudSaveEligibility | null,
    warning: CloudSaveWarning | null
): CloudState {
    if (warning?.visible && !warning.canSave) {
        return {
            available: false,
            note: warning.label,
            blocked: warning.title
        };
    }
    const max = eligibility?.maxFontsOwned ?? null;
    const used =
        max === null
            ? 'Collaborate and share'
            : `Collaborate and share · ${eligibility?.fontsOwnedCount ?? 0} of ${max} fonts used`;
    return {
        available: true,
        note: warning?.visible ? `${used} · ${warning.label}` : used,
        blocked: warning?.visible ? warning.title : undefined
    };
}
