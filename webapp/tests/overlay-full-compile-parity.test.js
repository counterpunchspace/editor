/**
 * Overlay-to-Full-Compile 100% Point-Identity Proof Suite.
 *
 * Enforces the critical architecture rule (AGENTS.md / APP.md):
 * Direct binary/TTF splicing (fast_ttf_patch, HVAR splicing, GPOS/kerning
 * overlays) is strictly a live-preview overlay for mouse drags and keyboard
 * bursts. After commit, the full subsetted font compiles via authoritative
 * fontc, and the final live overlay render must be 100% point-identical
 * (glyph names, cluster indices, ax/ay/dx/dy positions, and hbFont.glyphToPath
 * point structure) to the full catch-up compile.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const Y = require('yjs');

const { open_font_file } = require('../wasm-dist/babelfont_fontc_web');
const { Font } = require('../js/babelfont-model');
const {
    jsonToYDoc,
    ensureCoreUpdateHasGlyphsMap
} = require('../js/change-bridge-ydoc');
const {
    computeDrawingRecompositionClosure
} = require('../js/recomposition-closure');
const { setKerningPairValueOnStation } = require('../js/kerning-utils');

jest.setTimeout(180000);

const RUNNER = path.join(__dirname, 'helpers/overlay-parity-runner.mjs');
const VARIATION_LOCATIONS = [
    { wght: 200 }, // default master (ExtraLight)
    { wght: 300 }, // interpolated
    { wght: 400 }, // non-default master (Regular)
    { wght: 600 }, // interpolated
    { wght: 800 } // extreme non-default master (ExtraBold)
];

let fustatBaseData;

beforeAll(() => {
    fustatBaseData = JSON.parse(
        open_font_file(
            'Fustat.glyphs',
            fs.readFileSync(
                path.join(__dirname, '../examples/Fustat.glyphs'),
                'utf8'
            )
        )
    );
});

function cloneBaseData() {
    return JSON.parse(JSON.stringify(fustatBaseData));
}

function findRegularMaster(fontModel) {
    return (
        fontModel.stations.find((s) => {
            const name =
                typeof s.name === 'string'
                    ? s.name
                    : s.name?.dflt || Object.values(s.name || {})[0] || '';
            return /regular/i.test(String(name));
        }) ||
        fontModel.stations[1] ||
        fontModel.stations[0]
    );
}

function findDrawingForMaster(fontModel, glyphName, masterId) {
    const glyph = fontModel.findGlyph(glyphName);
    if (!glyph) {
        throw new Error(`Glyph ${glyphName} not found`);
    }
    const drawing =
        glyph.drawings.find((d) => d.station?.master === masterId) ||
        glyph.drawings[0];
    if (!drawing) {
        throw new Error(`Drawing for ${glyphName}/${masterId} not found`);
    }
    return drawing;
}

function buildCommittedYDocState(fontData) {
    const doc = new Y.Doc();
    doc.transact(() => {
        jsonToYDoc(fontData, doc.getMap('font'));
    });
    return ensureCoreUpdateHasGlyphsMap(Y.encodeStateAsUpdate(doc));
}

function runParityScenarios(scenarios) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overlay-parity-'));
    try {
        const manifestScenarios = scenarios.map((scenario, idx) => {
            const stateFile = `s${idx}-base.bin`;
            fs.writeFileSync(path.join(dir, stateFile), scenario.baseState);
            const committedStateFile = `s${idx}-committed.bin`;
            fs.writeFileSync(
                path.join(dir, committedStateFile),
                scenario.committedState
            );
            return {
                name: scenario.name,
                stateFile,
                committedStateFile,
                subsetGlyphs: scenario.subsetGlyphs,
                selectedFeatures: scenario.selectedFeatures || [],
                baseOptions: scenario.baseOptions || {
                    skip_kerning: false,
                    skip_features: false,
                    skip_outlines: false,
                    produce_varc_table: false
                },
                overlayOptions: scenario.overlayOptions || {
                    skip_kerning: false,
                    skip_features: false,
                    skip_outlines: false,
                    produce_varc_table: false
                },
                fullOptions: scenario.fullOptions || {
                    skip_kerning: false,
                    skip_features: false,
                    skip_outlines: false,
                    produce_varc_table: false
                },
                overlay: scenario.overlay,
                shape: scenario.shape
            };
        });
        const manifestPath = path.join(dir, 'manifest.json');
        const outputPath = path.join(dir, 'output.json');
        fs.writeFileSync(
            manifestPath,
            JSON.stringify({ scenarios: manifestScenarios })
        );
        execFileSync(process.execPath, [RUNNER, manifestPath, outputPath], {
            stdio: 'pipe',
            maxBuffer: 32 * 1024 * 1024
        });
        return JSON.parse(fs.readFileSync(outputPath, 'utf8')).results;
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

describe('Overlay-to-Full-Compile 100% Point-Identity', () => {
    let resultsByName = new Map();
    let debugMeta = {};

    beforeAll(() => {
        const baseState = buildCommittedYDocState(cloneBaseData());

        // --- 1. Outline edit (node move on `a` in "lanä" at wght:400) ---
        const outlineData = cloneBaseData();
        const outlineModel = Font.fromData(outlineData);
        const wght400Master = findRegularMaster(outlineModel);
        const outlineDrawingA = findDrawingForMaster(
            outlineModel,
            'a',
            wght400Master.id
        );
        const firstPath = outlineDrawingA.paths[0];
        expect(firstPath?.nodes?.length).toBeGreaterThan(0);
        firstPath.nodes[0].x += 45;
        firstPath.nodes[0].y += 25;
        const outlineOverlayLayer = outlineDrawingA.toCompileJSON();
        const outlineScenario = {
            name: '1-outline-edit-wght400',
            baseState,
            committedState: buildCommittedYDocState(outlineModel.toJSON()),
            subsetGlyphs: ['l', 'a', 'n', 'adieresis', 'dieresiscomb'],
            overlayOptions: {
                skip_kerning: true,
                skip_features: true,
                skip_outlines: false,
                produce_varc_table: false
            },
            overlay: {
                layerUpdates: [
                    {
                        glyphName: 'a',
                        layerId: outlineDrawingA.id,
                        layerData: outlineOverlayLayer
                    }
                ],
                metadata: {
                    changedGlyphs: ['a'],
                    layerTargets: [
                        { glyphName: 'a', layerId: outlineDrawingA.id }
                    ]
                }
            },
            shape: {
                text: 'lanä',
                direction: 'ltr',
                variationsList: VARIATION_LOCATIONS
            }
        };

        // --- 2. Sidebearing + metrics-key & automatic composite cascade ("lanä", l RSB +40 at wght:400, HVAR) ---
        const sbData = cloneBaseData();
        const sbModel = Font.fromData(sbData);
        const sbMaster = findRegularMaster(sbModel);
        const sbDrawingL = findDrawingForMaster(sbModel, 'l', sbMaster.id);
        sbDrawingL.width += 40;
        const sbClosure = computeDrawingRecompositionClosure({
            fontModel: sbModel,
            sourceTargets: [{ glyphName: 'l', layerId: sbDrawingL.id }],
            activeDrawingId: sbDrawingL.id,
            editKinds: new Set(['sidebearing']),
            scope: 'all'
        });
        const sbLayerUpdates = sbClosure.allTargets.map(
            ({ glyphName, layerId }) => ({
                glyphName,
                layerId,
                layerData: sbModel
                    .findGlyph(glyphName)
                    .findDrawingById(layerId)
                    .toCompileJSON()
            })
        );
        debugMeta.sbTargets = sbLayerUpdates.map((u) => [
            u.glyphName,
            u.layerId,
            u.layerData.width
        ]);
        const sidebearingScenario = {
            name: '2-sidebearing-cascade-lana-hvar-wght400',
            baseState,
            committedState: buildCommittedYDocState(sbModel.toJSON()),
            subsetGlyphs: ['l', 'a', 'n', 'adieresis', 'dieresiscomb'],
            overlayOptions: {
                skip_kerning: true,
                skip_features: true,
                skip_outlines: false,
                produce_varc_table: false
            },
            overlay: {
                layerUpdates: sbLayerUpdates,
                metadata: {
                    changedGlyphs: Array.from(sbClosure.affectedGlyphNames),
                    layerTargets: sbClosure.allTargets
                }
            },
            shape: {
                text: 'lanä',
                direction: 'ltr',
                variationsList: VARIATION_LOCATIONS
            }
        };

        // --- 3. Anchor edit + automatic composite cascade ("lanä", a.top -> ä at wght:400) ---
        const anchorBaseData = cloneBaseData();
        const anchorBaseModel = Font.fromData(anchorBaseData);
        const anchorBaseMaster = findRegularMaster(anchorBaseModel);
        const anchorBaseAdieresis = findDrawingForMaster(
            anchorBaseModel,
            'adieresis',
            anchorBaseMaster.id
        );
        for (const comp of anchorBaseAdieresis.components || []) {
            comp.automaticAlignment = true;
        }
        expect(anchorBaseAdieresis.isAutomaticAlignedDrawing()).toBe(true);
        anchorBaseAdieresis.rebuildAutomaticComposition?.();
        const anchorBaseJson = anchorBaseModel.toJSON();
        const anchorBaseState = buildCommittedYDocState(anchorBaseJson);

        const anchorModel = Font.fromData(
            JSON.parse(JSON.stringify(anchorBaseJson))
        );
        const anchorMaster = findRegularMaster(anchorModel);
        const anchorDrawingA = findDrawingForMaster(
            anchorModel,
            'a',
            anchorMaster.id
        );
        const topAnchor = anchorDrawingA.anchors.find(
            (anc) => anc.name === 'top'
        );
        expect(topAnchor).toBeTruthy();
        topAnchor.x += 35;
        topAnchor.y += 55;
        const anchorClosure = computeDrawingRecompositionClosure({
            fontModel: anchorModel,
            sourceTargets: [{ glyphName: 'a', layerId: anchorDrawingA.id }],
            activeDrawingId: anchorDrawingA.id,
            editKinds: new Set(['anchor']),
            scope: 'all'
        });
        const anchorLayerUpdates = anchorClosure.allTargets.map(
            ({ glyphName, layerId }) => ({
                glyphName,
                layerId,
                layerData: anchorModel
                    .findGlyph(glyphName)
                    .findDrawingById(layerId)
                    .toCompileJSON()
            })
        );
        const anchorScenario = {
            name: '3-anchor-cascade-adieresis-wght400',
            baseState: anchorBaseState,
            committedState: buildCommittedYDocState(anchorModel.toJSON()),
            subsetGlyphs: ['l', 'a', 'n', 'adieresis', 'dieresiscomb'],
            overlayOptions: {
                skip_kerning: false,
                skip_features: false,
                skip_outlines: false,
                produce_varc_table: false
            },
            overlay: {
                layerUpdates: anchorLayerUpdates,
                metadata: {
                    changedGlyphs: Array.from(anchorClosure.affectedGlyphNames),
                    layerTargets: anchorClosure.allTargets
                }
            },
            shape: {
                text: 'lanä',
                direction: 'ltr',
                variationsList: VARIATION_LOCATIONS
            }
        };

        // --- 4. LTR kerning + group members ("TATAVAVA" at wght:400) ---
        const ltrKernData = cloneBaseData();
        const ltrKernModel = Font.fromData(ltrKernData);
        const ltrMaster = findRegularMaster(ltrKernModel);
        const glyphT = ltrKernModel.findGlyph('T');
        const glyphA = ltrKernModel.findGlyph('A');
        const ltrFirstKey = glyphT.rightKerningGroup
            ? `@${glyphT.rightKerningGroup}`
            : 'T';
        const ltrSecondKey = glyphA.leftKerningGroup
            ? `@${glyphA.leftKerningGroup}`
            : 'A';
        setKerningPairValueOnStation(
            ltrMaster,
            ltrFirstKey,
            ltrSecondKey,
            -120,
            false
        );
        const ltrKerningScenario = {
            name: '4-ltr-group-kerning-TATAVAVA-wght400',
            baseState,
            committedState: buildCommittedYDocState(ltrKernModel.toJSON()),
            subsetGlyphs: ['T', 'A', 'V'],
            overlayOptions: {
                skip_kerning: false,
                skip_features: false,
                skip_outlines: false,
                produce_varc_table: false
            },
            overlay: {
                kerningUpdates: [
                    {
                        masterId: ltrMaster.id,
                        isRtl: false,
                        firstKey: ltrFirstKey,
                        secondKey: ltrSecondKey,
                        value: -120
                    }
                ]
            },
            shape: {
                text: 'TATAVAVA',
                direction: 'ltr',
                variationsList: VARIATION_LOCATIONS
            }
        };

        // --- 5. RTL kerning + Arabic group members ("داراوارا" at wght:400) ---
        const rtlKernData = cloneBaseData();
        const rtlKernModel = Font.fromData(rtlKernData);
        const rtlMaster = findRegularMaster(rtlKernModel);
        const glyphDal = rtlKernModel.findGlyph('dal-ar');
        const glyphAlef = rtlKernModel.findGlyph('alef-ar');
        const rtlFirstKey = glyphDal?.leftKerningGroup
            ? `@${glyphDal.leftKerningGroup}`
            : 'dal-ar';
        const rtlSecondKey = glyphAlef?.rightKerningGroup
            ? `@${glyphAlef.rightKerningGroup}`
            : 'alef-ar';
        setKerningPairValueOnStation(
            rtlMaster,
            rtlFirstKey,
            rtlSecondKey,
            -95,
            true
        );
        const rtlKerningScenario = {
            name: '5-rtl-group-kerning-arabic-wght400',
            baseState,
            committedState: buildCommittedYDocState(rtlKernModel.toJSON()),
            subsetGlyphs: ['dal-ar', 'alef-ar', 'reh-ar', 'waw-ar'],
            overlayOptions: {
                skip_kerning: false,
                skip_features: false,
                skip_outlines: false,
                produce_varc_table: false
            },
            overlay: {
                kerningUpdates: [
                    {
                        masterId: rtlMaster.id,
                        isRtl: true,
                        firstKey: rtlFirstKey,
                        secondKey: rtlSecondKey,
                        value: -95
                    }
                ]
            },
            shape: {
                text: 'داراوارا',
                direction: 'rtl',
                variationsList: VARIATION_LOCATIONS
            }
        };

        const results = runParityScenarios([
            outlineScenario,
            sidebearingScenario,
            anchorScenario,
            ltrKerningScenario,
            rtlKerningScenario
        ]);
        resultsByName = new Map(results.map((r) => [r.name, r]));
    });

    test.each([
        '1-outline-edit-wght400',
        '2-sidebearing-cascade-lana-hvar-wght400',
        '3-anchor-cascade-adieresis-wght400',
        '4-ltr-group-kerning-TATAVAVA-wght400',
        '5-rtl-group-kerning-arabic-wght400'
    ])(
        '%s matches authoritative full fontc catch-up compile 100% point-for-point across wght 200/300/400/600/800',
        (name) => {
            const result = resultsByName.get(name);
            expect(result).toBeDefined();
            expect(result.overlayByLocation).toHaveLength(
                VARIATION_LOCATIONS.length
            );
            // Prove the edit actually changed the shaped output at wght:400 (no vacuous pass).
            const baseAt400 = result.baselineByLocation.find(
                (entry) => entry.variations.wght === 400
            );
            const overlayAt400 = result.overlayByLocation.find(
                (entry) => entry.variations.wght === 400
            );
            expect(overlayAt400.glyphs.length).toBeGreaterThan(0);
            expect(overlayAt400.glyphs).not.toEqual(baseAt400.glyphs);
            // Prove 100% point-identity between live overlay and full fontc
            // catch-up compile at EVERY variation location (default master,
            // interpolated, non-default master, extreme master).
            expect(result.overlayByLocation).toEqual(result.fullByLocation);
        }
    );
});
