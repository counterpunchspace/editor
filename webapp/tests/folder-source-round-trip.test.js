// Round trips of folder sources (.glyphspackage, .ufo) through the real WASM
// serializers: whole saves reproduce the source, partial saves write only the
// edited glyph's files, and single glyph files load like a whole open does.

const fs = require('fs');
const path = require('path');
const {
    open_font_file,
    save_font_source_entries,
    ufo_glyph_files_for_paths,
    load_ufo_glyphs,
    load_glyphspackage_glyphs
} = require('../wasm-dist/babelfont_fontc_web');

const EXAMPLES_DIR = path.join(__dirname, '..', 'examples');

/** The real WASM's `save_font_as_glyphs`; Jest's module is a stub. */
function saveFontAsGlyphs(babelfontJson) {
    const os = require('os');
    const { execFileSync } = require('child_process');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glyphs-save-'));
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
const PACKAGE = 'YanoneKaffeesatz.glyphspackage';
const UFO = 'YanoneKaffeesatz-Bold.ufo';

/** Every file below `root`, by path relative to it. */
function readTree(root) {
    const entries = {};
    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(fullPath);
            } else if (!entry.name.startsWith('.')) {
                entries[path.relative(root, fullPath).replace(/\\/g, '/')] =
                    fs.readFileSync(fullPath, 'utf-8');
            }
        }
    };
    walk(root);
    return entries;
}

function open(name, entries) {
    return JSON.parse(open_font_file(name, JSON.stringify(entries)));
}

function save(format, font, request = {}) {
    return JSON.parse(
        save_font_source_entries(
            format,
            JSON.stringify(font),
            JSON.stringify(request)
        )
    );
}

function layoutEntries(entries) {
    return Object.fromEntries(
        Object.entries(entries).filter(
            ([file]) =>
                file === 'layercontents.plist' ||
                file.endsWith('/contents.plist')
        )
    );
}

describe('.glyphspackage round trip', () => {
    const original = readTree(path.join(EXAMPLES_DIR, PACKAGE));
    const font = open(PACKAGE, original);

    test('a whole save reproduces the package Glyphs wrote', () => {
        const saved = save('glyphspackage', font);
        expect(Object.keys(saved.files).sort()).toEqual(
            Object.keys(original).sort()
        );
        const differing = Object.keys(saved.files).filter(
            (file) => saved.files[file] !== original[file]
        );
        // fontinfo.plist differs only in how master value arrays wrap.
        expect(differing).toEqual(['fontinfo.plist']);
        const originalLines = new Set(original['fontinfo.plist'].split('\n'));
        const extraLines = saved.files['fontinfo.plist']
            .split('\n')
            .filter((line) => !originalLines.has(line));
        for (const line of extraLines) {
            expect(line).toMatch(/^(axesValues|stemValues) = \(/);
        }
        expect(open(PACKAGE, saved.files).glyphs).toEqual(font.glyphs);
    });

    test('an edited glyph saves to its own file, as a whole save would', () => {
        const edited = JSON.parse(JSON.stringify(font));
        edited.glyphs.find((glyph) => glyph.name === 'A').layers[0].width += 10;
        const whole = save('glyphspackage', edited);
        const partial = save('glyphspackage', edited, { glyphs: ['A'] });
        expect(Object.keys(partial.files)).toEqual(['glyphs/A_.glyph']);
        expect(partial.files['glyphs/A_.glyph']).toBe(
            whole.files['glyphs/A_.glyph']
        );
        expect(partial.files['glyphs/A_.glyph']).not.toBe(
            original['glyphs/A_.glyph']
        );
        expect(partial.removed).toEqual([]);
    });

    test('a removed glyph is listed for deletion', () => {
        const edited = JSON.parse(JSON.stringify(font));
        edited.glyphs = edited.glyphs.filter((glyph) => glyph.name !== 'A');
        const partial = save('glyphspackage', edited, {
            glyphs: ['A'],
            fontLevel: true
        });
        // Files the package has no content for are listed too; saving
        // deletes only files that exist.
        expect(partial.removed.sort()).toEqual([
            'UIState.plist',
            'glyphs/A_.glyph',
            'kerning.plist',
            'note.md'
        ]);
        expect(partial.files['order.plist']).not.toContain('\nA,\n');
    });

    test('a glyph file loads alone as it loads with the package', () => {
        const loaded = JSON.parse(
            load_glyphspackage_glyphs(
                original['fontinfo.plist'],
                JSON.stringify({
                    'glyphs/A_.glyph': original['glyphs/A_.glyph']
                })
            )
        );
        expect(loaded.glyphs).toEqual([
            font.glyphs.find((glyph) => glyph.name === 'A')
        ]);
        expect(loaded.kernGroups.A).toEqual([
            expect.anything(),
            expect.anything()
        ]);
    });
});

describe('Glyphs 4 package round trip', () => {
    // Fustat, saved by Glyphs 4 (build 4108) as a package.
    const G4_PACKAGE = 'FustatG4.glyphspackage';
    const original = readTree(path.join(EXAMPLES_DIR, G4_PACKAGE));
    const font = open(G4_PACKAGE, original);

    test('a whole save reproduces the package Glyphs 4 wrote', () => {
        const saved = save('glyphspackage', font);
        expect(Object.keys(saved.files).sort()).toEqual(
            Object.keys(original).sort()
        );
        const differing = Object.keys(saved.files).filter(
            (file) => saved.files[file] !== original[file]
        );
        // The rest are formatting Glyphs 3 shares (number keys in quotes,
        // one-element arrays inline) and a width stored in single precision.
        expect(differing.sort()).toEqual([
            'fontinfo.plist',
            'glyphs/slash.shortcomb.glyph',
            'kerning.plist'
        ]);
        for (const file of Object.keys(original)) {
            if (file.startsWith('features/')) {
                expect(saved.files[file]).toBe(original[file]);
            }
        }
    });

    test('saved as Glyphs 3, it is a Glyphs 3 package', () => {
        const glyphs3 = {
            ...font,
            format_specific: {
                ...font.format_specific,
                'com.schriftgestalt.Glyphs.saveFormatVersion': 3
            }
        };
        const saved = save('glyphspackage', glyphs3);
        const files = Object.keys(saved.files);
        expect(files).not.toContain('kerning.plist');
        expect(files.some((file) => file.startsWith('features/'))).toBe(false);
        const fontinfo = saved.files['fontinfo.plist'];
        expect(fontinfo).toContain('.formatVersion = 3;');
        expect(fontinfo).toContain('kerningLTR = {');
        expect(fontinfo).toContain('familyName = Fustat;');
        expect(fontinfo).not.toContain('colorSpace');
        // No trailing commas, and Glyphs 3's stroke positions.
        expect(fontinfo).not.toMatch(/,\n\)/);
        const circle = saved.files['glyphs/mediumW_hiteC_ircle.glyph'];
        expect(circle).not.toMatch(/,\n\)/);
        expect(circle).toContain('strokePos = 1;');
        expect(circle).not.toContain('strokePos = -1;');
        expect(saved.files['order.plist'].endsWith('\n)')).toBe(true);
    });

    test('the flat file Glyphs 4 wrote saves as Glyphs 3 and back', () => {
        const flat = fs.readFileSync(
            path.join(EXAMPLES_DIR, 'FustatG4.glyphs'),
            'utf-8'
        );
        const fromFlat = JSON.parse(open_font_file('FustatG4.glyphs', flat));
        const glyphs3 = saveFontAsGlyphs(
            JSON.stringify({
                ...fromFlat,
                format_specific: {
                    ...fromFlat.format_specific,
                    'com.schriftgestalt.Glyphs.saveFormatVersion': 3
                }
            })
        );
        expect(glyphs3).toContain('.formatVersion = 3;');
        const back = JSON.parse(open_font_file('Fustat.glyphs', glyphs3));
        expect(back.glyphs.length).toBe(fromFlat.glyphs.length);
        expect(back.names.family_name).toEqual(fromFlat.names.family_name);
        expect(back.instances.map((i) => i.name)).toEqual(
            fromFlat.instances.map((i) => i.name)
        );
    });
});

describe('.ufo round trip', () => {
    const original = readTree(path.join(EXAMPLES_DIR, UFO));
    const font = open(UFO, original);
    const layout = layoutEntries(original);

    test('a whole save keeps every file name and is stable', () => {
        const saved = save('ufo', font, { layoutEntries: layout });
        for (const file of Object.keys(original).filter((f) =>
            f.endsWith('.glif')
        )) {
            expect(saved.files).toHaveProperty([file]);
        }
        const reloaded = open(UFO, saved.files);
        expect(reloaded.glyphs.map((glyph) => glyph.name)).toEqual(
            font.glyphs.map((glyph) => glyph.name)
        );
        const savedAgain = save('ufo', reloaded, {
            layoutEntries: layoutEntries(saved.files)
        });
        expect(savedAgain.files).toEqual(saved.files);
    });

    test('an edited glyph saves to its own .glif files only', () => {
        const edited = JSON.parse(JSON.stringify(font));
        edited.glyphs.find((glyph) => glyph.name === 'A').layers[0].width += 10;
        const whole = save('ufo', edited, { layoutEntries: layout });
        const partial = save('ufo', edited, {
            glyphs: ['A'],
            layoutEntries: layout
        });
        expect(Object.keys(partial.files)).toEqual(['glyphs/A_.glif']);
        expect(partial.files['glyphs/A_.glif']).toBe(
            whole.files['glyphs/A_.glif']
        );
    });

    test('a new glyph needs a whole save', () => {
        const edited = JSON.parse(JSON.stringify(font));
        const copy = JSON.parse(
            JSON.stringify(edited.glyphs.find((glyph) => glyph.name === 'A'))
        );
        copy.name = 'A.copy';
        edited.glyphs.push(copy);
        expect(
            save('ufo', edited, { glyphs: ['A.copy'], layoutEntries: layout })
        ).toEqual({ needsFullSave: expect.any(String) });
    });

    test('a .glif loads alone as it loads with the UFO', () => {
        const located = JSON.parse(
            ufo_glyph_files_for_paths(
                JSON.stringify(layout),
                JSON.stringify(['glyphs/A_.glif', 'images/x.png'])
            )
        );
        expect(located).toEqual({
            glyphs: { A: ['glyphs/A_.glif'] },
            unknown: ['images/x.png']
        });
        const glyphs = JSON.parse(
            load_ufo_glyphs(
                JSON.stringify(layout),
                JSON.stringify({
                    'glyphs/A_.glif': original['glyphs/A_.glif']
                }),
                JSON.stringify(['A']),
                font.masters[0].id
            )
        );
        const full = font.glyphs.find((glyph) => glyph.name === 'A');
        expect(glyphs[0].layers).toEqual(full.layers);
        expect(glyphs[0].codepoints).toEqual(full.codepoints);
    });
});

describe('.designspace round trip', () => {
    const DOCUMENT = 'YanoneKaffeesatz.designspace';
    const project = {
        [DOCUMENT]: fs.readFileSync(path.join(EXAMPLES_DIR, DOCUMENT), 'utf-8')
    };
    for (const ufo of [
        'YanoneKaffeesatz-ExtraLight.ufo',
        'YanoneKaffeesatz-Bold.ufo'
    ]) {
        for (const [file, text] of Object.entries(
            readTree(path.join(EXAMPLES_DIR, ufo))
        )) {
            project[`${ufo}/${file}`] = text;
        }
    }
    const font = open(DOCUMENT, project);
    const layouts = (entries) =>
        Object.fromEntries(
            Object.entries(entries).filter(
                ([file]) =>
                    file.endsWith('/layercontents.plist') ||
                    file.endsWith('/contents.plist')
            )
        );

    test('a whole save keeps every file and master, and is stable', () => {
        expect(font.masters).toHaveLength(2);
        const saved = save('designspace', font, {
            document: DOCUMENT,
            layoutEntries: layouts(project)
        });
        for (const file of Object.keys(project).filter((f) =>
            f.endsWith('.glif')
        )) {
            expect(saved.files).toHaveProperty([file]);
        }
        const reloaded = open(DOCUMENT, saved.files);
        expect(reloaded.glyphs).toEqual(font.glyphs);
        const again = save('designspace', reloaded, {
            document: DOCUMENT,
            layoutEntries: layouts(saved.files)
        });
        expect(again.files).toEqual(saved.files);
    });

    test('an edited glyph saves to its own .glif files, as a whole save would', () => {
        const edited = JSON.parse(JSON.stringify(font));
        edited.glyphs.find((glyph) => glyph.name === 'A').layers[0].width += 10;
        const request = { document: DOCUMENT, layoutEntries: layouts(project) };
        const whole = save('designspace', edited, request);
        const partial = save('designspace', edited, {
            ...request,
            glyphs: ['A']
        });
        expect(Object.keys(partial.files).length).toBeGreaterThan(0);
        for (const [file, text] of Object.entries(partial.files)) {
            expect(file).toMatch(/\/A_\.glif$/);
            expect(text).toBe(whole.files[file]);
        }
    });
});
