export type FontDataPatchOperation = {
    op: 'add' | 'remove' | 'replace';
    path: (string | number)[];
    value?: unknown;
};

export type FontDataPatchPair = {
    forward: FontDataPatchOperation;
    inverse: FontDataPatchOperation;
};

function cloneValue<T>(value: T): T {
    if (value === undefined) {
        return value;
    }
    return JSON.parse(JSON.stringify(value)) as T;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function valuesDiffer(left: unknown, right: unknown): boolean {
    return JSON.stringify(left) !== JSON.stringify(right);
}

function isFeatureTuple(
    value: unknown
): value is [string, Record<string, unknown>] {
    return (
        Array.isArray(value) &&
        value.length >= 2 &&
        typeof value[0] === 'string' &&
        isPlainObject(value[1])
    );
}

/** Same tags in the same order: diff each feature's code instead of the whole list. */
function isSameOrderFeatureTupleList(
    beforeValue: unknown[],
    afterValue: unknown[]
): boolean {
    if (beforeValue.length !== afterValue.length) {
        return false;
    }
    return beforeValue.every(
        (item, index) =>
            isFeatureTuple(item) &&
            isFeatureTuple(afterValue[index]) &&
            item[0] === afterValue[index][0]
    );
}

/**
 * Derive forward and inverse structural operations between two font snapshots.
 * Glyphs and layers are keyed by their stable names and ids. Feature lists
 * with unchanged tags diff each feature's code. Other arrays stay atomic so
 * their ordering and storage representation remain schema-safe.
 */
export function diffFontDataToPatchPairs(
    beforeValue: unknown,
    afterValue: unknown,
    path: (string | number)[] = [],
    collectionKind: 'glyphs' | 'layers' | null = null,
    patchPairs: FontDataPatchPair[] = []
): FontDataPatchPair[] {
    if (beforeValue === undefined && afterValue === undefined) {
        return patchPairs;
    }

    if (beforeValue === undefined) {
        patchPairs.push({
            forward: { op: 'add', path, value: cloneValue(afterValue) },
            inverse: { op: 'remove', path }
        });
        return patchPairs;
    }

    if (afterValue === undefined) {
        patchPairs.push({
            forward: { op: 'remove', path },
            inverse: { op: 'add', path, value: cloneValue(beforeValue) }
        });
        return patchPairs;
    }

    if (Array.isArray(beforeValue) && Array.isArray(afterValue)) {
        if (collectionKind === 'glyphs' || collectionKind === 'layers') {
            const keyField = collectionKind === 'glyphs' ? 'name' : 'id';
            const beforeEntries = beforeValue.flatMap((item) => {
                if (!isPlainObject(item)) {
                    return [];
                }
                const key = String(item[keyField] ?? '');
                return key
                    ? ([[key, item]] as Array<
                          [string, Record<string, unknown>]
                      >)
                    : [];
            });
            const afterEntries = afterValue.flatMap((item) => {
                if (!isPlainObject(item)) {
                    return [];
                }
                const key = String(item[keyField] ?? '');
                return key
                    ? ([[key, item]] as Array<
                          [string, Record<string, unknown>]
                      >)
                    : [];
            });
            const beforeMap = new Map(beforeEntries);
            const afterMap = new Map(afterEntries);
            const keys = new Set([...beforeMap.keys(), ...afterMap.keys()]);
            for (const key of keys) {
                diffFontDataToPatchPairs(
                    beforeMap.get(key),
                    afterMap.get(key),
                    [...path, key],
                    null,
                    patchPairs
                );
            }

            const beforeOrder = beforeEntries.map(([key]) => key);
            const afterOrder = afterEntries.map(([key]) => key);
            if (valuesDiffer(beforeOrder, afterOrder)) {
                const orderPath =
                    collectionKind === 'glyphs'
                        ? ['glyphOrder']
                        : [...path.slice(0, -1), 'layerOrder'];
                patchPairs.push({
                    forward: {
                        op: 'replace',
                        path: orderPath,
                        value: afterOrder
                    },
                    inverse: {
                        op: 'replace',
                        path: orderPath,
                        value: beforeOrder
                    }
                });
            }
            return patchPairs;
        }

        const isFeatureList =
            path.length >= 2 &&
            path[path.length - 2] === 'features' &&
            path[path.length - 1] === 'features';
        if (
            isFeatureList &&
            valuesDiffer(beforeValue, afterValue) &&
            isSameOrderFeatureTupleList(beforeValue, afterValue)
        ) {
            for (let index = 0; index < beforeValue.length; index++) {
                const beforeTuple = beforeValue[index] as [
                    string,
                    Record<string, unknown>
                ];
                const afterTuple = afterValue[index] as [
                    string,
                    Record<string, unknown>
                ];
                // Path segment 1 is the code record. Replacing the tuple
                // array itself writes that array into the feature tag.
                diffFontDataToPatchPairs(
                    beforeTuple[1],
                    afterTuple[1],
                    [...path, index, 1],
                    null,
                    patchPairs
                );
            }
            return patchPairs;
        }

        if (valuesDiffer(beforeValue, afterValue)) {
            patchPairs.push({
                forward: { op: 'replace', path, value: cloneValue(afterValue) },
                inverse: {
                    op: 'replace',
                    path,
                    value: cloneValue(beforeValue)
                }
            });
        }
        return patchPairs;
    }

    if (isPlainObject(beforeValue) && isPlainObject(afterValue)) {
        const keys = new Set([
            ...Object.keys(beforeValue),
            ...Object.keys(afterValue)
        ]);
        for (const key of keys) {
            diffFontDataToPatchPairs(
                beforeValue[key],
                afterValue[key],
                [...path, key],
                key === 'glyphs'
                    ? 'glyphs'
                    : key === 'layers'
                      ? 'layers'
                      : null,
                patchPairs
            );
        }
        return patchPairs;
    }

    if (valuesDiffer(beforeValue, afterValue)) {
        patchPairs.push({
            forward: { op: 'replace', path, value: cloneValue(afterValue) },
            inverse: {
                op: 'replace',
                path,
                value: cloneValue(beforeValue)
            }
        });
    }

    return patchPairs;
}
