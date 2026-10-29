/**
 * File → Export binary font against the real compiler.
 *
 * Runs the real export path (residency check, shard selection, worker
 * seeding) on a real sync bridge built from examples/Fustat.glyphs. Only the
 * worker transport is replaced: the `seedYdoc` and `compileCached` messages
 * it would receive are replayed against the committed WASM in a Node child
 * process (tests/helpers/compile-worker-seed.mjs), since Jest cannot load it.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const Y = require('yjs');

jest.mock('idb-keyval', () => {
    const store = new Map();
    return {
        get: async (key) => store.get(key),
        set: async (key, value) => {
            store.set(key, value);
        },
        del: async (key) => {
            store.delete(key);
        }
    };
});

const { open_font_file } = require('../wasm-dist/babelfont_fontc_web');
const { PatchSyncEngine } = require('../js/patch-sync-engine');
const { Font } = require('../js/babelfont-model');
const { ensureCoreUpdateHasGlyphsMap } = require('../js/change-bridge-ydoc');
const fontManager = require('../js/font-manager').default;
const {
    fontCompilation,
    fullFontCompilation
} = require('../js/font-compilation');
const { exportBinaryFont } = require('../js/binary-font-export');
const { cmapGlyph, numGlyphs } = require('./helpers/truetype-tables');

jest.setTimeout(180000);

const RUNNER = path.join(__dirname, 'helpers/compile-worker-seed.mjs');

let fustatJson;

beforeAll(() => {
    fustatJson = JSON.parse(
        open_font_file(
            'Fustat.glyphs',
            fs.readFileSync(
                path.join(__dirname, '../examples/Fustat.glyphs'),
                'utf8'
            )
        )
    );
});

function cloneFustat() {
    return JSON.parse(JSON.stringify(fustatJson));
}

/** Compile a captured seed message the way the fontc worker would. */
function compileWithRealWasm(seedMessage, options) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-compile-'));
    try {
        const seed = { options };
        // The worker re-applies ensureCoreUpdateHasGlyphsMap to font-core.
        if (seedMessage.documents?.length) {
            seed.documents = seedMessage.documents.map((document, index) => {
                const file = `shard-${index}.bin`;
                const raw = new Uint8Array(document.state);
                fs.writeFileSync(
                    path.join(dir, file),
                    document.documentId === 'font-core'
                        ? ensureCoreUpdateHasGlyphsMap(raw)
                        : raw
                );
                return { documentId: document.documentId, file };
            });
        } else {
            seed.stateFile = 'state.bin';
            fs.writeFileSync(
                path.join(dir, seed.stateFile),
                ensureCoreUpdateHasGlyphsMap(new Uint8Array(seedMessage.state))
            );
        }
        fs.writeFileSync(path.join(dir, 'seed.json'), JSON.stringify(seed));
        const outputPath = path.join(dir, 'font.ttf');
        try {
            execFileSync(process.execPath, [RUNNER, dir, outputPath], {
                stdio: 'pipe',
                maxBuffer: 50 * 1024 * 1024
            });
        } catch (error) {
            throw new Error(String(error.stderr || error.message).trim());
        }
        return new Uint8Array(fs.readFileSync(outputPath));
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

/** Answer fullFontCompilation's worker messages through the real WASM. */
function installRealCompilerWorker() {
    const received = [];
    let lastSeed = null;
    fullFontCompilation.isInitialized = true;
    fullFontCompilation.worker = {
        postMessage(message) {
            received.push(message);
            let reply = { success: true };
            if (message.type === 'seedYdoc') {
                lastSeed = message;
            } else if (message.type === 'compileCached') {
                try {
                    if (message.featureOverlay) {
                        throw new Error('feature overlays are not replayed');
                    }
                    reply = {
                        result: compileWithRealWasm(lastSeed, message.options),
                        time_taken: 0
                    };
                } catch (error) {
                    reply = { error: error.message };
                }
            }
            queueMicrotask(() =>
                fullFontCompilation.handleWorkerMessage({
                    data: { id: message.id, ...reply }
                })
            );
        }
    };
    return received;
}

/**
 * Open a font the way the editor holds it. With `glyphOrder`, the core keeps
 * the whole font's order while only `fontJson.glyphs` have bodies: the state
 * of a sparse cloud session.
 */
function openInEditor(fontJson, glyphOrder = null) {
    const bridge = new PatchSyncEngine('binary-font-export-compile');
    bridge.initFromJson(fontJson);
    if (glyphOrder) {
        bridge.yDoc.transact(() => {
            const order = new Y.Array();
            order.push(glyphOrder);
            bridge.fontMap.set('glyphOrder', order);
        });
    }
    window.patchSyncEngine = bridge;
    fontManager.openedFonts.set('fustat', {
        path: '/user/Fustat.glyphs',
        changeVersion: 0,
        babelfontData: fontJson,
        fontModel: Font.fromData(fontJson)
    });
    fontManager.currentFontId = 'fustat';
    window.fontManager = fontManager;
    return bridge;
}

function componentClosure(fontJson, names) {
    const byName = new Map(fontJson.glyphs.map((glyph) => [glyph.name, glyph]));
    const keep = new Set(names);
    const queue = [...keep];
    while (queue.length) {
        const glyph = byName.get(queue.pop());
        for (const layer of glyph?.layers || []) {
            for (const shape of layer.shapes || []) {
                if (
                    typeof shape.reference === 'string' &&
                    !keep.has(shape.reference)
                ) {
                    keep.add(shape.reference);
                    queue.push(shape.reference);
                }
            }
        }
    }
    return keep;
}

async function waitFor(predicate) {
    for (let attempt = 0; attempt < 500; attempt++) {
        const value = predicate();
        if (value) {
            return value;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('Timed out waiting for condition');
}

describe('binary font export with the real compiler', () => {
    let written;
    let alertSpy;
    let postMessageSpy;

    beforeEach(() => {
        written = null;
        alertSpy = jest.spyOn(window, 'alert').mockImplementation();
        postMessageSpy = jest.spyOn(window, 'postMessage').mockImplementation();
        window.showSaveFilePicker = async () => ({
            name: 'Fustat.ttf',
            createWritable: async () => ({
                write: async (buffer) => {
                    written = new Uint8Array(buffer);
                },
                close: async () => {}
            })
        });
        fontCompilation.setWorkerCacheDocumentReady(true);
    });

    afterEach(() => {
        alertSpy.mockRestore();
        postMessageSpy.mockRestore();
        delete window.showSaveFilePicker;
        delete window.patchSyncEngine;
        document.body.innerHTML = '';
    });

    test('exports every glyph of a fully loaded font', async () => {
        const fontJson = cloneFustat();
        openInEditor(fontJson);
        const received = installRealCompilerWorker();

        await exportBinaryFont();

        expect(alertSpy).not.toHaveBeenCalled();
        const seed = received.find((message) => message.type === 'seedYdoc');
        expect(
            seed.documents.filter((document) =>
                document.documentId.startsWith('glyph:')
            )
        ).toHaveLength(fontJson.glyphs.length);
        expect(written).not.toBeNull();
        expect(numGlyphs(written)).toBe(
            fontJson.glyphs.filter((glyph) => glyph.exported !== false).length
        );
        expect(cmapGlyph(written, 0x41)).not.toBe(0);
        expect(cmapGlyph(written, 0x0645)).not.toBe(0);
    });

    test('exports only the loaded glyphs of a partially loaded font after confirmation', async () => {
        const fullJson = cloneFustat();
        const loaded = componentClosure(fullJson, ['A', 'Adieresis', 'a']);
        openInEditor(
            {
                ...fullJson,
                glyphs: fullJson.glyphs.filter((glyph) =>
                    loaded.has(glyph.name)
                )
            },
            fullJson.glyphs.map((glyph) => glyph.name)
        );
        installRealCompilerWorker();

        const exportPromise = exportBinaryFont();
        const proceed = await waitFor(() =>
            document.querySelector('[data-action="proceed"]')
        );
        expect(document.querySelector('.confirm-dialog').textContent).toContain(
            `Only ${loaded.size} of ${fullJson.glyphs.length} glyphs are loaded`
        );
        proceed.click();
        await exportPromise;

        expect(alertSpy).not.toHaveBeenCalled();
        expect(written).not.toBeNull();
        expect(numGlyphs(written)).toBeLessThan(fullJson.glyphs.length);
        expect(cmapGlyph(written, 0x41)).not.toBe(0);
        expect(cmapGlyph(written, 0xc4)).not.toBe(0);
        expect(cmapGlyph(written, 0x42)).toBe(0);
    });

    test('blocks exporting a font without glyphs', async () => {
        openInEditor({ ...cloneFustat(), glyphs: [] });
        const received = installRealCompilerWorker();

        await exportBinaryFont();

        expect(alertSpy).toHaveBeenCalledWith(
            'Unable to export binary font: The font has no glyphs to export.'
        );
        expect(received).toHaveLength(0);
        expect(written).toBeNull();
    });

    test('the font-core snapshot alone cannot compile, so export must send the shards', () => {
        const bridge = openInEditor(cloneFustat());

        expect(() =>
            compileWithRealWasm(
                { state: bridge.encodeBridgeState() },
                { skip_kerning: false, skip_features: false }
            )
        ).toThrow(/unreachable|No master at default location/);
    });
});
