/**
 * Pure helpers for adding, deleting and renaming the OpenType prefixes,
 * classes and features of the Font Info Features panel.
 */

export type FeaNamedKind = 'prefix' | 'class';

type CodeEntry = { code?: string };

export type FeaturesLike = {
    prefixes?: Record<string, CodeEntry>;
    classes?: Record<string, CodeEntry>;
    features?: Array<[string, CodeEntry]>;
};

export type ClassReferenceEdit =
    | { type: 'prefix' | 'class'; key: string; code: string }
    | { type: 'feature'; key: number; code: string };

const FEA_NAME_PATTERN = /^[A-Za-z_.][A-Za-z0-9_.-]{0,62}$/;
const FEA_NAME_CHAR = 'A-Za-z0-9_.\\-';

/** Error message for a prefix or class name, or null when it is valid. */
export function validateFeaName(
    name: string,
    kind: FeaNamedKind,
    existingNames: readonly string[],
    currentName?: string
): string | null {
    if (name.length === 0) {
        return 'Enter a name.';
    }
    if (kind === 'class' && name.startsWith('@')) {
        return 'Leave out the “@”. Counterpunch adds it.';
    }
    if (!FEA_NAME_PATTERN.test(name)) {
        return 'A name starts with a letter, “_” or “.”, has at most 63 characters, and can contain only letters, digits, “_”, “.” and “-”.';
    }
    if (name !== currentName && existingNames.includes(name)) {
        return `A ${kind} named “${name}” already exists.`;
    }
    return null;
}

/** `base1`, `base2`, …: the first name that is not in use. */
export function uniqueFeaName(
    base: string,
    existingNames: readonly string[]
): string {
    const used = new Set(existingNames);
    for (let n = 1; ; n++) {
        if (!used.has(`${base}${n}`)) {
            return `${base}${n}`;
        }
    }
}

function classReferencePattern(name: string): RegExp {
    const escaped = name.replace(/[.\\^$*+?()[\]{}|-]/g, '\\$&');
    return new RegExp(
        `(?<![${FEA_NAME_CHAR}@])@${escaped}(?![${FEA_NAME_CHAR}])`,
        'g'
    );
}

/**
 * Replace whole-word `@oldName` references with `@newName`. Comments (from
 * `#` to the end of the line) stay as they are.
 */
export function renameClassReferences(
    code: string,
    oldName: string,
    newName: string
): { code: string; count: number } {
    const pattern = classReferencePattern(oldName);
    let count = 0;
    const lines = code.split('\n').map((line) => {
        const hash = line.indexOf('#');
        const body = hash < 0 ? line : line.slice(0, hash);
        const comment = hash < 0 ? '' : line.slice(hash);
        const renamed = body.replace(pattern, () => {
            count += 1;
            return `@${newName}`;
        });
        return renamed + comment;
    });
    return { code: lines.join('\n'), count };
}

/** Every code change that renaming class `oldName` to `newName` needs. */
export function planClassReferenceRename(
    features: FeaturesLike,
    oldName: string,
    newName: string
): { edits: ClassReferenceEdit[]; count: number } {
    const edits: ClassReferenceEdit[] = [];
    let count = 0;
    const visit = (
        source: string | undefined,
        toEdit: (code: string) => ClassReferenceEdit
    ) => {
        const result = renameClassReferences(source || '', oldName, newName);
        if (result.count > 0) {
            count += result.count;
            edits.push(toEdit(result.code));
        }
    };
    for (const [key, entry] of Object.entries(features.prefixes || {})) {
        visit(entry?.code, (code) => ({ type: 'prefix', key, code }));
    }
    for (const [key, entry] of Object.entries(features.classes || {})) {
        if (key !== oldName) {
            visit(entry?.code, (code) => ({ type: 'class', key, code }));
        }
    }
    (features.features || []).forEach(([, entry], key) => {
        visit(entry?.code, (code) => ({ type: 'feature', key, code }));
    });
    return { edits, count };
}
