/**
 * RTL kerning is flat per master, like LTR kerning. Glyphs files keep it
 * font-wide in format_specific["com.schriftgestalt.Glyphs.kerningRTL"];
 * babelfont moves it onto the masters when it reads one, and the editor
 * moves any copy older saves still carry.
 */
const {
    Font,
    normalizeLegacyGlyphsRtlKerning
} = require('../js/babelfont-model');
const { setKerningPairValueOnMaster } = require('../js/kerning-utils');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { open_font_file } = require('../wasm-dist/babelfont_fontc_web');

/** Compile with the real WASM; returns the font's bytes. */
function compileWithWasm(babelfontJson) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rtl-compile-'));
    try {
        const input = path.join(dir, 'args.json');
        const output = path.join(dir, 'result.ttf');
        fs.writeFileSync(input, JSON.stringify([babelfontJson, {}]));
        execFileSync(process.execPath, [
            path.join(__dirname, 'helpers', 'call-wasm-export.mjs'),
            'compile_babelfont',
            input,
            output
        ]);
        return fs.readFileSync(output);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

/** Table tags in a TrueType font's table directory. */
function tableTags(bytes) {
    const count = bytes.readUInt16BE(4);
    const tags = [];
    for (let i = 0; i < count; i += 1) {
        tags.push(bytes.toString('latin1', 12 + i * 16, 16 + i * 16));
    }
    return tags;
}

/** The real WASM's `save_font_as_glyphs`; Jest's module is a stub. */
function saveFontAsGlyphs(babelfontJson) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rtl-glyphs-save-'));
    try {
        const input = path.join(dir, 'args.json');
        const output = path.join(dir, 'result.txt');
        fs.writeFileSync(input, JSON.stringify([babelfontJson]));
        execFileSync(process.execPath, [
            path.join(__dirname, 'helpers', 'call-wasm-export.mjs'),
            'save_font_as_glyphs',
            input,
            output
        ]);
        return fs.readFileSync(output, 'utf-8');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

const KEY = 'com.schriftgestalt.Glyphs.kerningRTL';

function fontData(overrides = {}) {
    return {
        upm: 1000,
        axes: [],
        masters: [
            { id: 'm1', name: { dflt: 'Regular' }, location: {}, kerning: {} },
            { id: 'm2', name: { dflt: 'Bold' }, location: {}, kerning: {} }
        ],
        glyphs: [],
        instances: [],
        ...overrides
    };
}

describe('flat RTL kerning', () => {
    test('a Glyphs-style copy moves onto the masters and is dropped', () => {
        const data = fontData({
            format_specific: {
                [KEY]: {
                    m1: { '@MMK_R_reh': { '@MMK_L_alef': -90 } },
                    m2: { 'beh-ar': { 'alef-ar': -20 } }
                }
            }
        });
        normalizeLegacyGlyphsRtlKerning(data);
        expect(data.masters[0].kerning_rtl).toEqual({ '@reh:@alef': -90 });
        expect(data.masters[1].kerning_rtl).toEqual({ 'beh-ar:alef-ar': -20 });
        // The key was the only entry, so no empty map is left behind.
        expect(data.format_specific).toBeUndefined();
    });

    test('the flat map wins over a stale copy, and other keys stay', () => {
        // The editor's older saves kept both; a pair deleted from the flat
        // map since must not come back, and a changed one keeps its value.
        const data = fontData({
            format_specific: {
                seed: true,
                [KEY]: {
                    m1: {
                        '@MMK_R_reh': { '@MMK_L_alef': -90, '@MMK_L_reh': -40 }
                    }
                }
            }
        });
        data.masters[0].kerning_rtl = { '@reh:@alef': -60 };
        normalizeLegacyGlyphsRtlKerning(data);
        expect(data.masters[0].kerning_rtl).toEqual({
            '@reh:@alef': -60,
            '@reh:@reh': -40
        });
        expect(data.format_specific).toEqual({ seed: true });
    });

    test('kerning for a master the font does not have is kept', () => {
        const data = fontData({
            format_specific: {
                [KEY]: {
                    m1: { '@MMK_R_reh': { '@MMK_L_alef': -90 } },
                    gone: { '@MMK_R_reh': { '@MMK_L_alef': -70 } }
                }
            }
        });
        normalizeLegacyGlyphsRtlKerning(data);
        expect(data.format_specific).toEqual({
            [KEY]: { gone: { '@MMK_R_reh': { '@MMK_L_alef': -70 } } }
        });
    });

    test('a pair edit writes one key on the master, nothing font-wide', () => {
        const font = new Font(fontData());
        const recordChange = jest.fn();
        const recordRemove = jest.fn();
        const previous = window.patchSyncEngine;
        window.patchSyncEngine = { recordChange, recordRemove };
        try {
            const master = font.masters[0];
            setKerningPairValueOnMaster(master, '@reh', '@alef', -80, true);
            expect(recordChange).toHaveBeenCalledTimes(1);
            expect(recordChange).toHaveBeenCalledWith(
                ['masters', 0, 'kerning_rtl'],
                '@reh:@alef',
                undefined,
                -80
            );
            setKerningPairValueOnMaster(master, '@reh', '@alef', null, true);
            expect(recordRemove).toHaveBeenCalledTimes(1);
            expect(recordRemove).toHaveBeenCalledWith(
                ['masters', 0, 'kerning_rtl', '@reh:@alef'],
                -80
            );
            expect(master.kerning_rtl).toEqual({});
            expect(master.kerning).toEqual({});
            expect(font.format_specific?.[KEY]).toBeUndefined();
        } finally {
            window.patchSyncEngine = previous;
        }
    });

    test('a Glyphs save writes kerningRTL back, and opening moves it again', () => {
        const source = JSON.parse(
            fs.readFileSync(
                path.join(
                    __dirname,
                    '..',
                    'examples',
                    'ManufacturedKink.babelfont'
                ),
                'utf-8'
            )
        );
        source.masters[0].kerning_rtl = {
            '@reh:@alef': -90,
            'space:space': -5
        };
        const glyphsFile = saveFontAsGlyphs(JSON.stringify(source));

        // The Glyphs file has it font-wide, with Glyphs' group prefixes, and
        // no flat copy anywhere.
        expect(glyphsFile).toContain('kerningRTL = {');
        expect(glyphsFile).toContain('"@MMK_R_reh" = {');
        expect(glyphsFile).toContain('"@MMK_L_alef" = -90;');
        expect(glyphsFile).not.toContain('kerning_rtl');

        const reopened = JSON.parse(open_font_file('Kink.glyphs', glyphsFile));
        const master = reopened.masters.find(
            (candidate) => candidate.id === source.masters[0].id
        );
        expect(master.kerning_rtl).toEqual({
            '@reh:@alef': -90,
            'space:space': -5
        });
        expect(reopened.format_specific?.[KEY]).toBeUndefined();
    });

    test('compiling uses the flat RTL pairs', () => {
        const source = JSON.parse(
            fs.readFileSync(
                path.join(
                    __dirname,
                    '..',
                    'examples',
                    'ManufacturedKink.babelfont'
                ),
                'utf-8'
            )
        );
        const without = compileWithWasm(JSON.stringify(source));
        for (const master of source.masters) {
            master.kerning_rtl = { 'space:uniE000': -50 };
        }
        const withRtl = compileWithWasm(JSON.stringify(source));

        expect(tableTags(without)).not.toContain('GPOS');
        expect(tableTags(withRtl)).toContain('GPOS');
    });
});
