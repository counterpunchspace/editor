/** Glyphs replaced by the managed ccmp decomposition block. */

import {
    generatorStamp,
    managedInputs,
    type FeaturesDocument
} from './managed-features';

const CCMP_GENERATOR = 'space.counterpunch.ccmp';
const CCMP_BLOCK = 'decomposition';

export function ccmpShellNames(
    features: FeaturesDocument | null | undefined
): Set<string> {
    const owned = (features?.features || []).find(([, code]) => {
        const stamp = generatorStamp(code);
        return (
            stamp?.generator === CCMP_GENERATOR &&
            stamp.block === CCMP_BLOCK &&
            code.automatic !== false
        );
    });
    if (!owned) {
        return new Set();
    }
    return new Set(
        managedInputs(features ?? undefined, CCMP_GENERATOR, CCMP_BLOCK)
    );
}

export function isCcmpShellGlyph(
    glyphName: string | null | undefined
): boolean {
    if (!glyphName) {
        return false;
    }
    const features = window.currentFontModel?.features as
        FeaturesDocument | undefined;
    return ccmpShellNames(features).has(glyphName);
}
