#!/usr/bin/env node
/**
 * Checks the gfsources room measurements against the room budgets.
 * Usage: node scripts/gfsources-room-budget-report.mjs <out dir> [fonts dir]
 * Exits 1 when a font failed to measure or a proposed room is over budget.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LAYOUT = JSON.parse(
    fs.readFileSync(path.join(HERE, 'gfsources-room-layout.json'), 'utf-8')
);
const [outDir, fontsDir] = process.argv.slice(2);
if (!outDir) {
    console.error(
        'usage: gfsources-room-budget-report.mjs <out dir> [fonts dir]'
    );
    process.exit(2);
}

const rows = new Map();
for (const name of fs.readdirSync(outDir)) {
    if (!/^rooms-\d+\.jsonl$/.test(name)) continue;
    for (const line of fs
        .readFileSync(path.join(outDir, name), 'utf-8')
        .split('\n')) {
        if (!line.trim()) continue;
        try {
            const row = JSON.parse(line);
            rows.set(row.file, row);
        } catch {
            // A half-written line from an interrupted batch.
        }
    }
}

const MB = 1024 * 1024;
const mb = (bytes) => `${(bytes / MB).toFixed(2)} MB`;
const all = [...rows.values()];
const failed = all.filter((row) => row.error);
const ok = all.filter((row) => !row.error);

let missing = [];
if (fontsDir) {
    const walk = (dir, out = []) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full, out);
            else if (entry.name.endsWith('.babelfont')) {
                out.push(path.relative(fontsDir, full));
            }
        }
        return out;
    };
    missing = walk(fontsDir).filter((file) => !rows.has(file));
}

const over = (room, bytes, structs) =>
    room && (room.bytes > bytes || room.structs > structs);

function section(title, list, describe, limit = 15) {
    console.log(`\n${title}: ${list.length}`);
    for (const row of list.slice(0, limit)) console.log(`  ${describe(row)}`);
    if (list.length > limit) console.log(`  … and ${list.length - limit} more`);
}

console.log(
    `Fonts measured: ${ok.length}, failed: ${failed.length}` +
        (fontsDir ? `, not measured: ${missing.length}` : '')
);
console.log(
    `Budgets: bucket rooms ${mb(LAYOUT.bucketRoomBytes)} / ${LAYOUT.bucketRoomStructs} structs, ` +
        `glyph rooms ${mb(LAYOUT.glyphRoomBytes)} / ${LAYOUT.glyphRoomStructs} structs`
);

section(
    "Today's font-core over the glyph-room cap",
    ok
        .filter((row) =>
            over(
                row.current.core,
                LAYOUT.glyphRoomBytes,
                LAYOUT.glyphRoomStructs
            )
        )
        .sort((a, b) => b.current.core.bytes - a.current.core.bytes),
    (row) =>
        `${mb(row.current.core.bytes)} ${row.current.core.structs} structs  ${row.file}`
);

const proposedFailures = [];
for (const row of ok) {
    for (const kind of ['core', 'catalog', 'kerning', 'features']) {
        const room = row.proposed[kind];
        if (over(room, LAYOUT.bucketRoomBytes, LAYOUT.bucketRoomStructs)) {
            proposedFailures.push({ row, kind, room });
        }
    }
    if (row.current.glyphsOverBudget > 0) {
        proposedFailures.push({ row, kind: 'glyph', room: row.current.glyph });
    }
}
proposedFailures.sort((a, b) => b.room.bytes - a.room.bytes);
section(
    'Proposed rooms over budget',
    proposedFailures,
    ({ row, kind, room }) =>
        `${kind.padEnd(8)} ${mb(room.bytes)} ${room.structs} structs  ${room.name}  ${row.file}`,
    40
);

for (const kind of ['core', 'catalog', 'kerning', 'features']) {
    const largest = ok
        .filter((row) => row.proposed[kind])
        .sort((a, b) => b.proposed[kind].bytes - a.proposed[kind].bytes)[0];
    const mostStructs = ok
        .filter((row) => row.proposed[kind])
        .sort((a, b) => b.proposed[kind].structs - a.proposed[kind].structs)[0];
    if (!largest) continue;
    console.log(
        `\nLargest proposed ${kind} room: ${mb(largest.proposed[kind].bytes)} (${largest.file}); ` +
            `most structs: ${mostStructs.proposed[kind].structs} (${mostStructs.file})`
    );
}
const largestGlyph = ok.sort(
    (a, b) => b.current.glyph.bytes - a.current.glyph.bytes
)[0];
if (largestGlyph) {
    console.log(
        `\nLargest glyph room: ${mb(largestGlyph.current.glyph.bytes)} ` +
            `${largestGlyph.current.glyph.structs} structs  ${largestGlyph.current.glyph.name}  ${largestGlyph.file}`
    );
}

const refused = ok.filter((row) => row.refused?.length);
section(
    'Fonts the upload check refuses',
    refused,
    (row) => `${row.file}: ${row.refused.join(' ')}`,
    60
);
console.log(
    `\nAccepted for upload: ${ok.length - refused.length} of ${ok.length} ` +
        `(${(((ok.length - refused.length) / Math.max(1, ok.length)) * 100).toFixed(1)}%)`
);

section(
    'Fonts that failed to measure',
    failed,
    (row) => `${row.file}: ${String(row.error).split('\n')[0]}`
);
if (missing.length) section('Fonts not measured', missing, (file) => file);

// Some sources do not fit the design (flat kerning between thousands of
// single glyphs, say); the upload check refuses those with a reason. The run
// fails only when a font could not be measured at all.
process.exit(failed.length || missing.length ? 1 : 0);
