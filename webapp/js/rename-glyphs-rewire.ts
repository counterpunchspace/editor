/**
 * Plan component and metrics-key rewires for the Rename Glyph(s) dialog.
 * The edit is the dialog's search and replace. This module does not read
 * or write the font model.
 */

export type RenameRewireContext = {
    /** Glyph names that exist once the rename has been applied. */
    postRenameNames: ReadonlySet<string>;
    /** Component bases and metrics-key glyph names stored on `glyphName`. */
    referencesOf: (glyphName: string) => readonly string[];
    /** Component bases stored on `glyphName`, before the rename. */
    componentsOf: (glyphName: string) => readonly string[];
};

/**
 * The reference the dialog's search and replace would propose.
 * A reference that contains `search` is substituted. Otherwise `replace`
 * is appended, which covers a duplicate composite that still points at
 * the original base.
 */
export function proposeRewiredReference(
    ref: string,
    search: string,
    replace: string
): string | null {
    if (!search || !ref) {
        return null;
    }
    const candidate = ref.includes(search)
        ? ref.split(search).join(replace)
        : replace
          ? ref + replace
          : ref;
    return candidate !== ref && candidate ? candidate : null;
}

function disappearingNames(renames: ReadonlyMap<string, string>): Set<string> {
    const targets = new Set<string>();
    for (const [oldName, newName] of renames) {
        if (oldName !== newName) {
            targets.add(newName);
        }
    }
    const removed = new Set<string>();
    for (const [oldName, newName] of renames) {
        if (oldName !== newName && !targets.has(oldName)) {
            removed.add(oldName);
        }
    }
    return removed;
}

function reaches(
    graph: ReadonlyMap<string, ReadonlySet<string>>,
    start: string,
    goal: string
): boolean {
    const seen = new Set<string>();
    const stack = [start];
    while (stack.length > 0) {
        const node = stack.pop() as string;
        if (node === goal) {
            return true;
        }
        if (seen.has(node)) {
            continue;
        }
        seen.add(node);
        for (const next of graph.get(node) ?? []) {
            stack.push(next);
        }
    }
    return false;
}

/**
 * Per renamed glyph, the references that should follow the dialog edit.
 * Keys are current glyph names. An empty map means the option is unavailable.
 */
export function planRenameRewires(
    search: string,
    replace: string,
    renames: ReadonlyMap<string, string>,
    context: RenameRewireContext
): Map<string, Map<string, string>> {
    const result = new Map<string, Map<string, string>>();
    if (!search) {
        return result;
    }

    const removed = disappearingNames(renames);
    const renamedSources = new Set<string>();
    for (const [oldName, newName] of renames) {
        if (oldName !== newName) {
            renamedSources.add(oldName);
        }
    }
    const sourceOfPost = new Map<string, string>();
    for (const postName of context.postRenameNames) {
        if (!removed.has(postName)) {
            sourceOfPost.set(postName, postName);
        }
    }
    for (const [oldName, newName] of renames) {
        if (oldName !== newName && context.postRenameNames.has(newName)) {
            sourceOfPost.set(newName, oldName);
        }
    }

    const accepted = new Map<string, Map<string, string>>();
    const componentTargets = (sourceName: string): Set<string> => {
        const local = accepted.get(sourceName);
        const targets = new Set<string>();
        for (const ref of context.componentsOf(sourceName)) {
            const resolved = local?.get(ref) ?? renames.get(ref) ?? ref;
            if (resolved) {
                targets.add(resolved);
            }
        }
        return targets;
    };

    const graph = new Map<string, Set<string>>();
    for (const [postName, sourceName] of sourceOfPost) {
        graph.set(postName, componentTargets(sourceName));
    }

    for (const [oldName, newName] of renames) {
        if (oldName === newName) {
            continue;
        }
        const componentRefs = new Set(context.componentsOf(oldName));
        const seen = new Set<string>();
        for (const ref of context.referencesOf(oldName)) {
            if (!ref || seen.has(ref) || renamedSources.has(ref)) {
                continue;
            }
            seen.add(ref);
            const candidate = proposeRewiredReference(ref, search, replace);
            if (
                !candidate ||
                candidate === newName ||
                !context.postRenameNames.has(candidate)
            ) {
                continue;
            }
            if (componentRefs.has(ref)) {
                const local = new Map(accepted.get(oldName) ?? []);
                local.set(ref, candidate);
                accepted.set(oldName, local);
                const previous = new Set(graph.get(newName) ?? []);
                graph.set(newName, componentTargets(oldName));
                if (reaches(graph, candidate, newName)) {
                    local.delete(ref);
                    if (local.size === 0) {
                        accepted.delete(oldName);
                    }
                    graph.set(newName, previous);
                    continue;
                }
            }
            let glyphRewires = result.get(oldName);
            if (!glyphRewires) {
                glyphRewires = new Map();
                result.set(oldName, glyphRewires);
            }
            glyphRewires.set(ref, candidate);
        }
    }

    return result;
}
