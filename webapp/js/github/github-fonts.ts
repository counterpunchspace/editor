// Font sources in a repository, found from the paths of its files.

import {
    fontFormatKind,
    fontFormatOf,
    type FontFormatKey
} from '../font-windows/font-formats';
import type { GitHubRepositorySpec } from './github-session';

export type GitHubFontSource = {
    /** Path inside the repository, with no leading slash. */
    path: string;
    format: FontFormatKey;
};

/**
 * Every font a file list holds: font files, and the folders that are fonts
 * (.ufo, .glyphspackage). Nothing inside a font folder counts again.
 */
export function fontSourcesIn(filePaths: string[]): GitHubFontSource[] {
    const found = new Map<string, FontFormatKey>();
    for (const filePath of filePaths) {
        const segments = filePath.split('/');
        for (let index = 0; index < segments.length; index += 1) {
            const format = fontFormatOf(segments[index]);
            const last = index === segments.length - 1;
            if (!format) continue;
            if (fontFormatKind(format) === 'package') {
                found.set(segments.slice(0, index + 1).join('/'), format);
                break;
            }
            if (last) found.set(filePath, format);
        }
    }
    return [...found]
        .map(([path, format]) => ({ path, format }))
        .sort((a, b) => a.path.localeCompare(b.path));
}

/** Folders that hold files, for choosing where Save As writes. */
export function foldersIn(filePaths: string[]): string[] {
    const folders = new Set<string>(['']);
    for (const filePath of filePaths) {
        const segments = filePath.split('/');
        for (let index = 1; index < segments.length; index += 1) {
            const folder = segments.slice(0, index).join('/');
            // A font folder is a font, not a place to save into.
            if (fontFormatOf(segments[index - 1])) break;
            folders.add(folder);
        }
    }
    return [...folders].sort((a, b) => a.localeCompare(b));
}

/** The document key of a font in a repository. */
export function gitHubFontKey(
    spec: GitHubRepositorySpec,
    path: string
): string {
    return `github:///${spec.owner}/${spec.repo}/${path}`;
}
