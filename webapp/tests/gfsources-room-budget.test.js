/**
 * Room budget check against the Google Fonts sources (local only).
 *
 * Loads every `.babelfont` under GFSOURCES_DIR into the editor's engine the
 * way a cloud upload does, then measures:
 *   - layout 1's font-core (catalog, kerning and features inside it);
 *   - the room layout 2 rooms the upload would really use, and whether the
 *     upload check (cloud-room-fit.ts) would refuse the font, with why.
 * One JSON line per font goes to GF_OUT. `scripts/gfsources-room-budget.sh`
 * runs this in batches; `scripts/gfsources-room-budget-report.mjs` checks the
 * lines against the budgets below.
 *
 * GF_DUMP_DIR writes the largest room of each kind per font as a Yjs
 * checkpoint, for the compactor benchmark in the collab repo
 * (`scripts/real-room-bench.mjs`).
 *
 * Skipped unless GFSOURCES_DIR is set; the fonts are not in CI.
 */
const fs = require('fs');
const path = require('path');
const Y = require('yjs');
const { open_font_file } = require('../wasm-dist/babelfont_fontc_web');
const {
    canonicalizeImportedFontData
} = require('../js/font-import-canonicalization');
const { PatchSyncEngine } = require('../js/patch-sync-engine');
const {
    applyCloudOwnedData
} = require('../js/filesystem-plugins/cloud-glyph-catalog');
const {
    chooseRoomLayout,
    layoutDocumentKind,
    roomLayoutCounts
} = require('../js/filesystem-plugins/cloud-room-layout');
const {
    findRoomsThatDoNotFit
} = require('../js/filesystem-plugins/cloud-room-fit');
// Read, not required: Jest's transform pattern also matches `.json`.
const LAYOUT = JSON.parse(
    fs.readFileSync(
        path.join(__dirname, '..', 'scripts', 'gfsources-room-layout.json'),
        'utf-8'
    )
);

const ROOT = process.env.GFSOURCES_DIR || '';
const OUT = process.env.GF_OUT || '/tmp/gfsources-room-budget.jsonl';
const DUMP_DIR = process.env.GF_DUMP_DIR || '';
const ONLY = process.env.GF_ONLY || '';
const MAX = Number(process.env.GF_MAX || Infinity);
const SHARD = Number(process.env.GF_SHARD || 0);
const SHARDS = Number(process.env.GF_SHARDS || 1);

function listFonts() {
    const out = [];
    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.name.endsWith('.babelfont')) {
                out.push({ path: full, size: fs.statSync(full).size });
            }
        }
    };
    walk(ROOT);
    out.sort((a, b) => b.size - a.size);
    return out;
}

// `.babelfont` files store outlines as compact node strings; the cloud
// documents need the expanded node objects the editor's import produces.
const NODE_TYPES = {
    m: 'Move',
    l: 'Line',
    c: 'Curve',
    q: 'QCurve',
    o: 'OffCurve'
};

function nodeTokens(text) {
    const tokens = [];
    let i = 0;
    while (i < text.length) {
        while (i < text.length && /\s/.test(text[i])) i += 1;
        if (i >= text.length) break;
        let end = i;
        if (text[i] === '{') {
            let depth = 0;
            let inString = false;
            for (; end < text.length; end += 1) {
                const ch = text[end];
                if (inString) {
                    if (ch === '\\') end += 1;
                    else if (ch === '"') inString = false;
                } else if (ch === '"') inString = true;
                else if (ch === '{') depth += 1;
                else if (ch === '}' && --depth === 0) {
                    end += 1;
                    break;
                }
            }
        } else {
            while (end < text.length && !/\s/.test(text[end])) end += 1;
        }
        tokens.push(text.slice(i, end));
        i = end;
    }
    return tokens;
}

function expandNodes(text) {
    const tokens = nodeTokens(text);
    const nodes = [];
    for (let i = 0; i + 2 < tokens.length;) {
        const type = tokens[i + 2];
        const smooth = type.length > 1 && type.endsWith('s');
        const base = smooth ? type.slice(0, -1) : type;
        const node = {
            x: Number(tokens[i]),
            y: Number(tokens[i + 1]),
            nodetype: NODE_TYPES[base] || base
        };
        if (smooth) node.smooth = true;
        i += 3;
        if (i < tokens.length && tokens[i].startsWith('{')) {
            node.format_specific = JSON.parse(tokens[i]);
            i += 1;
        }
        nodes.push(node);
    }
    return nodes;
}

function expandFont(font) {
    for (const glyph of font.glyphs || []) {
        for (const layer of glyph.layers || []) {
            for (const shape of layer.shapes || []) {
                if (shape && typeof shape.nodes === 'string') {
                    shape.nodes = expandNodes(shape.nodes);
                }
            }
        }
    }
}

/** Plain text values become shared text, as the layout stores features. */
/** The proposed layout, built from today's font-core and font-deps. */
function slug(file) {
    return file.replace(/\.babelfont$/, '').replace(/[^A-Za-z0-9]+/g, '_');
}

function dump(font, kind, room) {
    if (!DUMP_DIR || !room || room.bytes < LAYOUT.dumpMinBytes) return;
    const name = `${slug(font)}__${kind}.yjs`;
    fs.writeFileSync(path.join(DUMP_DIR, name), room.update);
    fs.appendFileSync(
        path.join(DUMP_DIR, 'index.jsonl'),
        JSON.stringify({
            file: name,
            font,
            kind,
            room: room.name,
            bytes: room.bytes,
            structs: room.structs
        }) + '\n'
    );
}

function summary(room) {
    return room
        ? { name: room.name, bytes: room.bytes, structs: room.structs }
        : null;
}

function statsOfBytes(name, bytes) {
    return {
        name,
        bytes: bytes.byteLength,
        structs: Y.decodeUpdate(bytes).structs.length,
        update: bytes
    };
}

function measureFont(file) {
    const relative = path.relative(ROOT, file.path);
    const started = Date.now();
    let data = JSON.parse(
        open_font_file(
            path.basename(file.path),
            fs.readFileSync(file.path, 'utf-8')
        )
    );
    expandFont(data);
    data = canonicalizeImportedFontData(data, { clone: false }).fontData;
    const glyphCount = (data.glyphs || []).length;
    const counts = roomLayoutCounts(data);

    // What a cloud upload does: catalog projection, then layout 2.
    const engine = new PatchSyncEngine(`gf-${glyphCount}`);
    engine.initFromJson(data);
    engine.syncCloudOwnedProjection(
        applyCloudOwnedData(engine.getFontJsonSnapshot())
    );
    const layoutOneCore = engine
        .encodeDocumentSetForSeed()
        .find((shard) => shard.documentId === 'font-core');
    const layoutOneCoreStats = statsOfBytes('font-core', layoutOneCore.bytes);
    const layout = chooseRoomLayout(counts);
    engine.adoptRoomLayout(layout, { seedsWholeAsset: true });
    const shards = engine.encodeDocumentSetForSeed();

    const byKind = {};
    let glyphsOverBudget = 0;
    const glyphNames = new Map();
    for (const shard of shards) {
        const kind = layoutDocumentKind(shard.documentId) || 'other';
        const room = statsOfBytes(shard.documentId, shard.bytes);
        if (kind === 'glyph') {
            const doc = new Y.Doc();
            Y.applyUpdate(doc, shard.bytes);
            const name = doc.getMap('glyph').get('name') || shard.documentId;
            glyphNames.set(shard.documentId, name);
            room.name = `glyph:${name}`;
            doc.destroy();
            if (
                room.bytes > LAYOUT.glyphRoomBytes ||
                room.structs > LAYOUT.glyphRoomStructs
            ) {
                glyphsOverBudget += 1;
            }
        }
        const list = (byKind[kind] ??= []);
        list.push(room);
    }
    const problems = findRoomsThatDoNotFit(shards, {
        glyphName: (documentId) => glyphNames.get(documentId) || null
    });
    const largestOf = (kind, by = 'bytes') =>
        (byKind[kind] || []).reduce(
            (best, room) => (room[by] > (best?.[by] ?? -1) ? room : best),
            null
        ) || { name: kind, bytes: 0, structs: 0 };

    dump(relative, 'current-font-core', layoutOneCoreStats);
    dump(relative, 'current-font-deps', largestOf('deps'));
    dump(relative, 'glyph', largestOf('glyph'));
    for (const kind of ['core', 'catalog', 'kerning', 'features']) {
        dump(relative, `proposed-${kind}`, largestOf(kind));
    }

    return {
        file: relative,
        fileBytes: file.size,
        glyphs: glyphCount,
        masters: (data.masters || []).length,
        kerningPairs: counts.kerningPairs,
        current: {
            core: summary(layoutOneCoreStats),
            deps: summary(largestOf('deps')),
            glyph: summary(largestOf('glyph')),
            glyphStructs: summary(largestOf('glyph', 'structs')),
            glyphsOverBudget
        },
        proposed: {
            core: summary(largestOf('core')),
            catalog: summary(largestOf('catalog')),
            kerning: summary(largestOf('kerning')),
            features: summary(largestOf('features')),
            counts: {
                catalogBuckets: layout.catalogBuckets,
                kerningRooms: layout.kerningBuckets
            }
        },
        refused: problems.map((problem) => problem.message),
        ms: Date.now() - started
    };
}

const maybe = ROOT ? test : test.skip;

maybe(
    'gfsources fonts fit the room budgets',
    () => {
        if (DUMP_DIR) fs.mkdirSync(DUMP_DIR, { recursive: true });
        // Fonts any shard already measured, so a rerun may use another
        // shard count.
        const done = new Set();
        const outDir = path.dirname(OUT);
        const outFiles = fs.existsSync(outDir)
            ? fs
                  .readdirSync(outDir)
                  .filter((name) => /^rooms-\d+\.jsonl$/.test(name))
                  .map((name) => path.join(outDir, name))
            : [];
        if (!outFiles.includes(OUT) && fs.existsSync(OUT)) outFiles.push(OUT);
        for (const outFile of outFiles) {
            for (const line of fs.readFileSync(outFile, 'utf-8').split('\n')) {
                if (!line.trim()) continue;
                try {
                    done.add(JSON.parse(line).file);
                } catch {
                    // A half-written line from an interrupted batch.
                }
            }
        }
        const fonts = listFonts().filter(
            (font, index) =>
                index % SHARDS === SHARD && (!ONLY || font.path.includes(ONLY))
        );
        const quiet = ['log', 'warn', 'info', 'debug'].map((level) =>
            jest.spyOn(console, level).mockImplementation(() => {})
        );
        try {
            let measured = 0;
            for (const font of fonts) {
                const relative = path.relative(ROOT, font.path);
                if (done.has(relative)) continue;
                if (measured >= MAX) break;
                measured += 1;
                let row;
                try {
                    row = measureFont(font);
                } catch (error) {
                    row = {
                        file: relative,
                        fileBytes: font.size,
                        error: String(error?.stack || error).slice(0, 500)
                    };
                }
                fs.appendFileSync(OUT, JSON.stringify(row) + '\n');
            }
        } finally {
            for (const spy of quiet) spy.mockRestore();
        }
    },
    24 * 60 * 60 * 1000
);
