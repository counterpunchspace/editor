const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Font, pathHasSubtractionFlag } = require('../js/babelfont-model');

function rectNodes(x0, y0, x1, y1) {
    return [
        { x: x0, y: y0, nodetype: 'Line' },
        { x: x1, y: y0, nodetype: 'Line' },
        { x: x1, y: y1, nodetype: 'Line' },
        { x: x0, y: y1, nodetype: 'Line' }
    ];
}

function makeBooleanFont() {
    return Font.fromData({
        upm: 1000,
        version: [1, 0],
        note: '',
        date: '2026-01-01T00:00:00.000Z',
        names: { family_name: { dflt: 'BooleanRoundtrip' } },
        features: { classes: {}, prefixes: {}, features: [] },
        first_kern_groups: {},
        second_kern_groups: {},
        format_specific: {},
        axes: [],
        instances: [],
        masters: [
            {
                name: { dflt: 'Regular' },
                id: 'master-regular',
                location: {},
                guides: [],
                metrics: {},
                kerning: {},
                custom_ot_values: {},
                format_specific: {}
            }
        ],
        glyphs: [
            {
                name: 'A',
                codepoints: [65],
                category: 'Base',
                exported: true,
                layers: [
                    {
                        id: 'layer-1',
                        master: {
                            type: 'DefaultForMaster',
                            master: 'master-regular'
                        },
                        width: 600,
                        shapes: [
                            {
                                nodes: rectNodes(0, 0, 400, 400),
                                closed: true
                            },
                            {
                                nodes: rectNodes(80, 80, 200, 200),
                                closed: true
                            }
                        ],
                        anchors: [],
                        guides: [],
                        format_specific: {}
                    }
                ],
                format_specific: {}
            }
        ]
    });
}

describe('fip001-boolean Glyphs save/open/compile chain', () => {
    test('model flag survives Glyphs save and changes compiled outlines', () => {
        const font = makeBooleanFont();
        const cutter = font.glyphs[0].drawings[0].paths[1];
        cutter.isSubtraction = true;

        expect(cutter.isSubtraction).toBe(true);
        expect(
            JSON.parse(font.toJSONString()).glyphs[0].layers[0].shapes[1]
                .format_specific['fip001-boolean']
        ).toBe('subtraction');

        const tempDir = fs.mkdtempSync(
            path.join(os.tmpdir(), 'fip001-boolean-chain-')
        );
        const inputPath = path.join(tempDir, 'input.babelfont.json');
        const outputPath = path.join(tempDir, 'report.json');
        fs.writeFileSync(inputPath, font.toJSONString(), 'utf-8');

        try {
            execFileSync(
                process.execPath,
                [
                    path.join(
                        __dirname,
                        'helpers/roundtrip-boolean-glyphs.mjs'
                    ),
                    inputPath,
                    outputPath
                ],
                {
                    stdio: 'pipe',
                    maxBuffer: 20 * 1024 * 1024,
                    timeout: 120000
                }
            );
            const report = JSON.parse(fs.readFileSync(outputPath, 'utf-8'));

            expect(report.glyphsHasQuotedBooleanKey).toBe(true);
            expect(
                pathHasSubtractionFlag(report.restoredShapes[1].format_specific)
            ).toBe(true);
            expect(report.compiledFontsDiffer).toBe(true);
            expect(report.ttfWithBooleanBytes).toBeGreaterThan(0);
            expect(report.ttfWithoutBooleanBytes).toBeGreaterThan(0);
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    }, 120000);
});
