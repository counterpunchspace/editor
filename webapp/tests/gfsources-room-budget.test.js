/**
 * Room budget check against the Google Fonts sources (local only).
 *
 * Seeds every `.babelfont` under GFSOURCES_DIR into the editor's real cloud
 * documents, then measures two layouts:
 *   - today's rooms (font-core, font-deps, one room per glyph);
 *   - the proposed layout: a small font-core, the glyph catalog in buckets,
 *     kerning in buckets per master, features in their own room.
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
const crypto = require('crypto');
const Y = require('yjs');
const { open_font_file } = require('../wasm-dist/babelfont_fontc_web');
const {
    canonicalizeImportedFontData
} = require('../js/font-import-canonicalization');
const {
    CloudDocumentSet
} = require('../js/filesystem-plugins/cloud-document-set');
const { toYType } = require('../js/change-bridge-ydoc');
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

function roomStats(doc) {
    const bytes = Y.encodeStateAsUpdate(doc);
    return {
        bytes: bytes.byteLength,
        structs: Y.decodeUpdate(bytes).structs.length,
        update: bytes
    };
}

function seededDoc(rootName, fill) {
    const doc = new Y.Doc({ gc: true });
    doc.transact(() => fill(doc.getMap(rootName)));
    return doc;
}

function bucketOf(key, buckets) {
    if (buckets <= 1) return 0;
    const digest = crypto.createHash('sha1').update(String(key)).digest();
    return digest.readUInt32BE(0) % buckets;
}

/** Plain text values become shared text, as the layout stores features. */
function toSharedText(value) {
    if (typeof value === 'string') return new Y.Text(value);
    if (Array.isArray(value)) {
        const array = new Y.Array();
        array.push(value.map(toSharedText));
        return array;
    }
    if (value && typeof value === 'object') {
        const map = new Y.Map();
        for (const [key, child] of Object.entries(value)) {
            map.set(key, toSharedText(child));
        }
        return map;
    }
    return value;
}

function largest(rooms) {
    return rooms.reduce(
        (best, room) => (room.bytes > best.bytes ? room : best),
        {
            bytes: 0,
            structs: 0
        }
    );
}

/** The proposed layout, built from today's font-core and font-deps. */
function projectLayout(coreJson, depsJson) {
    const rooms = {};
    const {
        glyphCatalog = {},
        codepointIndex,
        glyphOrder = [],
        features,
        masters = [],
        ...rest
    } = coreJson;
    void codepointIndex;

    // font-core keeps the font-wide data, with kerning moved out.
    const slimMasters = masters.map((master) => {
        const { kerning, kerning_rtl, ...keep } = master || {};
        void kerning;
        void kerning_rtl;
        return keep;
    });
    const core = seededDoc('font', (font) => {
        for (const [key, value] of Object.entries(rest)) {
            font.set(key, toYType(value));
        }
        font.set('masters', toYType(slimMasters));
    });
    rooms.core = [{ name: 'font-core', doc: core }];

    // Catalog: one atomic value per glyph, with its sort key and edges.
    const order = new Map(glyphOrder.map((name, index) => [name, index]));
    const edges = depsJson.edges || {};
    const entries = Object.values(glyphCatalog);
    const catalogBuckets = Math.max(
        1,
        Math.ceil(entries.length / LAYOUT.catalogBucketGlyphs)
    );
    const catalogDocs = Array.from(
        { length: catalogBuckets },
        () => new Y.Doc({ gc: true })
    );
    for (const doc of catalogDocs) doc.transact(() => {});
    const byBucket = new Map();
    for (const entry of entries) {
        const index = bucketOf(entry.glyphId, catalogBuckets);
        if (!byBucket.has(index)) byBucket.set(index, []);
        byBucket.get(index).push(entry);
    }
    for (const [index, list] of byBucket) {
        const doc = catalogDocs[index];
        doc.transact(() => {
            const map = doc.getMap('catalog');
            for (const entry of list) {
                const { latestGlyphRevision, generation, ...value } = entry;
                void latestGlyphRevision;
                void generation;
                const position = order.get(entry.name);
                value.sortKey = (position ?? order.size).toString(36);
                if (edges[entry.glyphId]) value.edges = edges[entry.glyphId];
                map.set(entry.glyphId, value);
            }
        });
    }
    rooms.catalog = catalogDocs.map((doc, index) => ({
        name: `catalog:${index}`,
        doc
    }));

    // Kerning: one key per pair, bucketed per master by the first side.
    rooms.kerning = [];
    for (const master of masters) {
        const pairs = [
            ...Object.entries(master?.kerning || {}).map(([pair, value]) => [
                `l|${pair}`,
                value
            ]),
            ...Object.entries(master?.kerning_rtl || {}).map(
                ([pair, value]) => [`r|${pair}`, value]
            )
        ];
        if (!pairs.length) continue;
        const buckets = Math.max(
            1,
            Math.ceil(pairs.length / LAYOUT.kerningBucketPairs)
        );
        const grouped = Array.from({ length: buckets }, () => []);
        for (const [key, value] of pairs) {
            const first = key.slice(2).split(':')[0];
            grouped[bucketOf(first, buckets)].push([key, value]);
        }
        grouped.forEach((list, index) => {
            rooms.kerning.push({
                name: `kerning:${master.id}:${index}`,
                doc: seededDoc('kerning', (map) => {
                    for (const [key, value] of list) map.set(key, value);
                })
            });
        });
    }

    // Features: shared text per feature, class and prefix.
    rooms.features = features
        ? [
              {
                  name: 'features',
                  doc: seededDoc('features', (map) => {
                      for (const [key, value] of Object.entries(features)) {
                          map.set(key, toSharedText(value));
                      }
                  })
              }
          ]
        : [];

    const measured = {};
    for (const [kind, list] of Object.entries(rooms)) {
        measured[kind] = list.map((room) => {
            const stats = roomStats(room.doc);
            room.doc.destroy();
            return { name: room.name, ...stats };
        });
    }
    measured.counts = {
        catalogBuckets,
        kerningRooms: rooms.kerning.length
    };
    return measured;
}

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

    const set = new CloudDocumentSet();
    set.initFromFontJson(data);
    const core = { name: 'font-core', ...roomStats(set.coreDoc) };
    const deps = { name: 'font-deps', ...roomStats(set.depsDoc) };
    let glyph = { bytes: 0, structs: 0 };
    let glyphStructs = { bytes: 0, structs: 0 };
    let glyphsOverBudget = 0;
    for (const [id, doc] of set.glyphDocs) {
        const stats = roomStats(doc);
        const name = doc.getMap('glyph').get('name') || id;
        const room = { name: `glyph:${name}`, ...stats };
        if (
            stats.bytes > LAYOUT.glyphRoomBytes ||
            stats.structs > LAYOUT.glyphRoomStructs
        ) {
            glyphsOverBudget += 1;
        }
        if (stats.bytes > glyph.bytes) glyph = room;
        if (stats.structs > glyphStructs.structs) glyphStructs = room;
    }
    const coreJson = set.coreDoc.getMap('font').toJSON();
    const depsJson = set.depsDoc.getMap('deps').toJSON();
    set.destroy();

    const proposed = projectLayout(coreJson, depsJson);
    const proposedLargest = {
        core: largest(proposed.core),
        catalog: largest(proposed.catalog),
        kerning: largest(proposed.kerning),
        features: largest(proposed.features)
    };

    dump(relative, 'current-font-core', core);
    dump(relative, 'current-font-deps', deps);
    dump(relative, 'glyph', glyph);
    for (const [kind, room] of Object.entries(proposedLargest)) {
        dump(relative, `proposed-${kind}`, room);
    }

    return {
        file: relative,
        fileBytes: file.size,
        glyphs: glyphCount,
        masters: (data.masters || []).length,
        current: {
            core: summary(core),
            deps: summary(deps),
            glyph: summary(glyph),
            glyphStructs: summary(glyphStructs),
            glyphsOverBudget
        },
        proposed: {
            core: summary(proposedLargest.core),
            catalog: summary(proposedLargest.catalog),
            kerning: summary(proposedLargest.kerning),
            features: summary(proposedLargest.features),
            counts: proposed.counts
        },
        ms: Date.now() - started
    };
}

const maybe = ROOT ? test : test.skip;

maybe(
    'gfsources fonts fit the room budgets',
    () => {
        if (DUMP_DIR) fs.mkdirSync(DUMP_DIR, { recursive: true });
        const done = new Set();
        if (fs.existsSync(OUT)) {
            for (const line of fs.readFileSync(OUT, 'utf-8').split('\n')) {
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
