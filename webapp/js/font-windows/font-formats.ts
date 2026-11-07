// The font source formats Counterpunch opens, and how each lives on disk.

import type { PickerAcceptType } from './file-access';

/**
 * - `file`: one file.
 * - `package`: a folder that is the font (.ufo, .glyphspackage).
 * - `project`: one file that refers to others next to it (.designspace).
 */
export type FontFormatKind = 'file' | 'package' | 'project';

export type FontFormat = {
    ext: string;
    label: string;
    kind: FontFormatKind;
    /** Formats Save As can write. */
    writable: boolean;
};

export const FONT_FORMATS = {
    glyphs: {
        ext: '.glyphs',
        label: 'Glyphs (.glyphs)',
        kind: 'file',
        writable: true
    },
    glyphspackage: {
        ext: '.glyphspackage',
        label: 'Glyphs package (.glyphspackage)',
        kind: 'package',
        writable: true
    },
    ufo: { ext: '.ufo', label: 'UFO (.ufo)', kind: 'package', writable: true },
    designspace: {
        ext: '.designspace',
        label: 'Designspace and UFOs (.designspace)',
        kind: 'project',
        writable: true
    },
    babelfont: {
        ext: '.babelfont',
        label: 'Babelfont (.babelfont)',
        kind: 'file',
        writable: true
    },
    vfj: {
        ext: '.vfj',
        label: 'FontLab (.vfj)',
        kind: 'file',
        writable: false
    },
    sfd: {
        ext: '.sfd',
        label: 'FontForge (.sfd)',
        kind: 'file',
        writable: false
    }
} as const satisfies Record<string, FontFormat>;

export type FontFormatKey = keyof typeof FONT_FORMATS;

const FORMAT_KEYS = Object.keys(FONT_FORMATS) as FontFormatKey[];

export function fontFormatOf(name: string): FontFormatKey | null {
    const lower = name.toLowerCase();
    return (
        FORMAT_KEYS.find((key) => lower.endsWith(FONT_FORMATS[key].ext)) ?? null
    );
}

export function fontFormatKind(key: FontFormatKey): FontFormatKind {
    return FONT_FORMATS[key].kind;
}

/** The name without the format's extension. */
export function baseNameOf(name: string): string {
    const format = fontFormatOf(name);
    return format ? name.slice(0, -FONT_FORMATS[format].ext.length) : name;
}

/** Extensions for the system file picker's filter. */
export const FONT_PICKER_TYPES: PickerAcceptType[] = [
    {
        description: 'Font sources',
        accept: {
            'application/octet-stream': FORMAT_KEYS.map(
                (key) => FONT_FORMATS[key].ext
            )
        }
    }
];
