/** Glyphs replaced by the managed ccmp decomposition block. */

import { arabicIsolShells } from './arabic-forms';
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
    const names = new Set(
        owned
            ? managedInputs(features ?? undefined, CCMP_GENERATOR, CCMP_BLOCK)
            : []
    );
    for (const name of arabicIsolShells(features)) {
        names.add(name);
    }
    return names;
}

/** Component names written in the managed ccmp decomposition, keyed by glyph. */
export function ccmpDecomposition(
    features: FeaturesDocument | null | undefined
): Map<string, string[]> {
    const owned = (features?.features || []).find(([, code]) => {
        const stamp = generatorStamp(code);
        return (
            stamp?.generator === CCMP_GENERATOR &&
            stamp.block === CCMP_BLOCK &&
            code.automatic !== false
        );
    });
    const rules = new Map<string, string[]>();
    if (!owned?.[1].code) {
        return rules;
    }
    for (const line of owned[1].code.split('\n')) {
        const match = line.match(/^\s*sub\s+(\S+)\s+by\s+(.+?)\s*;\s*$/);
        if (!match) {
            continue;
        }
        rules.set(
            match[1],
            match[2].split(/\s+/).filter((name) => name.length > 0)
        );
    }
    return rules;
}

type ShellNamesMemo = { signature: unknown[]; names: Set<string> };
let currentShellNamesMemo: ShellNamesMemo | null = null;

/** Every input `ccmpShellNames` reads, per feature entry. */
function shellNamesSignature(
    features: FeaturesDocument | undefined
): unknown[] {
    const signature: unknown[] = [];
    for (const [tag, code] of features?.features || []) {
        const stamp = generatorStamp(code);
        signature.push(
            tag,
            code?.code,
            code?.automatic,
            stamp?.generator,
            stamp?.block
        );
    }
    return signature;
}

function sameSignature(a: unknown[], b: unknown[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

/**
 * Shell names of the current font. Tiles and the canvas ask per glyph, so
 * this reads the raw features (no live-mutable proxies) and reuses the last
 * result while the inputs it depends on are unchanged.
 */
export function currentCcmpShellNames(): Set<string> {
    const font = window.currentFontModel as
        { toJSON?: () => unknown; features?: unknown } | null | undefined;
    const features = (
        typeof font?.toJSON === 'function'
            ? (font.toJSON() as { features?: unknown } | undefined)?.features
            : font?.features
    ) as FeaturesDocument | undefined;
    const signature = shellNamesSignature(features);
    if (
        currentShellNamesMemo &&
        sameSignature(currentShellNamesMemo.signature, signature)
    ) {
        return currentShellNamesMemo.names;
    }
    const names = ccmpShellNames(features);
    currentShellNamesMemo = { signature, names };
    return names;
}

export function isCcmpShellGlyph(
    glyphName: string | null | undefined
): boolean {
    if (!glyphName) {
        return false;
    }
    return currentCcmpShellNames().has(glyphName);
}
