/**
 * Auto QA — Canonical Tests
 *
 * Locks down APP.md § Auto QA and strategy Use case 1:
 * identity (uniXXXX + suffix), corpus matching, Wilson confidence,
 * mark-system / role / within-font gates, and the property-panel widget.
 */

const fs = require('fs');
const path = require('path');
const { Font } = require('../../js/babelfont-model');
const {
    splitGlyphName,
    uniLabel,
    glyphIdentity,
    glyphsByNameMap,
    localNamesByIdentity,
    observeGlyph,
    observeFont
} = require('../../js/auto-qa/auto-qa-identity.ts');
const { wilsonLowerBound } = require('../../js/auto-qa/auto-qa-stats.ts');
const { qaCorpusIndex } = require('../../js/auto-qa/auto-qa-corpus.ts');
const {
    matchOpenFont,
    labelsForGlyph,
    formatQaLabel,
    invalidateQaMatchCache,
    markQaGlyphsChanged,
    matchObservations
} = require('../../js/auto-qa/auto-qa-matcher.ts');
const {
    buildAutoQaPopup,
    destroyAutoQaTippy,
    renderAutoQaWidget
} = require('../../js/auto-qa/auto-qa-widget.ts');

const WORK_SANS_FIXTURE = JSON.parse(
    fs.readFileSync(
        path.join(__dirname, '../fixtures/auto-qa-work-sans.json'),
        'utf8'
    )
);

function makeMaster() {
    return {
        id: 'master-1',
        name: { dflt: 'Regular' },
        location: {},
        guides: [],
        metrics: {},
        kerning: {},
        custom_ot_values: {},
        format_specific: {}
    };
}

function makeLayer(options = {}) {
    const {
        id = 'layer-1',
        components = [],
        anchors = [],
        shapes = []
    } = options;
    const componentShapes = components.map((reference) => ({
        reference,
        transform: {
            translation: [0, 0],
            scale: [1, 1],
            rotation: 0,
            skew: [0, 0],
            tCenter: [0, 0],
            order: 'RestOfTheWorld'
        }
    }));
    return {
        id,
        width: 500,
        master: { type: 'DefaultForMaster', master: 'master-1' },
        shapes: [...componentShapes, ...shapes],
        anchors: anchors.map((name) => ({ name, x: 0, y: 0 })),
        guides: [],
        format_specific: {}
    };
}

function makeGlyph(name, options = {}) {
    const { codepoints, components = [], anchors = [] } = options;
    return {
        name,
        category: 'Base',
        exported: true,
        codepoints,
        layers: [makeLayer({ id: `${name}-0`, components, anchors })],
        format_specific: {}
    };
}

function makeFont(glyphs) {
    return Font.fromData({
        upm: 1000,
        version: [1, 0],
        axes: [],
        instances: [],
        masters: [makeMaster()],
        glyphs,
        note: '',
        names: {},
        features: { classes: {}, prefixes: {}, features: [] }
    });
}

function workSansPriors() {
    return {
        version: 1,
        mark_anchor_names: ['top', '_top', 'bottom', 'ogonek', 'top_ring'],
        identities: {
            'uni0041': {
                n: 400,
                n_mark_system: 400,
                k_has_any_component: 8,
                k_has_any_anchor: 380,
                components: {},
                anchors: { top: 370, bottom: 360, ogonek: 340 }
            },
            'uni00C1': {
                n: 300,
                n_mark_system: 300,
                k_has_any_component: 280,
                k_has_any_anchor: 12,
                components: { 'uni0041': 275, 'uni0301.case': 270 },
                anchors: { top: 8 }
            },
            'uni0301.case': {
                n: 250,
                k_has_any_component: 4,
                k_has_any_anchor: 240,
                components: {},
                anchors: { _top: 230, top: 220 }
            },
            'uni00C9': {
                n: 280,
                k_has_any_component: 260,
                k_has_any_anchor: 10,
                components: { 'uni0045': 255, 'uni0301.case': 250 },
                anchors: {}
            },
            'uni00CD': {
                n: 260,
                k_has_any_component: 240,
                k_has_any_anchor: 8,
                components: { 'uni0049': 235, 'uni0301.case': 230 },
                anchors: {}
            },
            'uni00D3': {
                n: 260,
                k_has_any_component: 240,
                k_has_any_anchor: 8,
                components: { 'uni004F': 235, 'uni0301.case': 230 },
                anchors: {}
            },
            'uni00DA': {
                n: 260,
                k_has_any_component: 240,
                k_has_any_anchor: 8,
                components: { 'uni0055': 235, 'uni0301.case': 230 },
                anchors: {}
            },
            'uni00DD': {
                n: 240,
                k_has_any_component: 220,
                k_has_any_anchor: 6,
                components: { 'uni0059': 215, 'uni0301.case': 210 },
                anchors: {}
            },
            'uni00C0': {
                n: 240,
                k_has_any_component: 220,
                k_has_any_anchor: 6,
                components: { 'uni0041': 215, 'uni0300.case': 210 },
                anchors: {}
            },
            'uni00C8': {
                n: 240,
                k_has_any_component: 220,
                k_has_any_anchor: 6,
                components: { 'uni0045': 215, 'uni0300.case': 210 },
                anchors: {}
            },
            'uni00CC': {
                n: 240,
                k_has_any_component: 220,
                k_has_any_anchor: 6,
                components: { 'uni0049': 215, 'uni0300.case': 210 },
                anchors: {}
            }
        }
    };
}

describe('Auto QA identity', () => {
    test('splits names the same way as the Python extractor', () => {
        expect(splitGlyphName('.notdef')).toEqual(['.notdef', '']);
        expect(splitGlyphName('A')).toEqual(['A', '']);
        expect(splitGlyphName('A.ss04')).toEqual(['A', '.ss04']);
        expect(splitGlyphName('E.swsh.001')).toEqual(['E', '.swsh.001']);
        expect(splitGlyphName('Aacute.swsh')).toEqual(['Aacute', '.swsh']);
        expect(uniLabel(65)).toBe('uni0041');
        expect(uniLabel(193)).toBe('uni00C1');
        expect(uniLabel(0x1f600)).toBe('uni1F600');
    });

    test('Work Sans rows key Aacute to uni00C1 with A + acutecomb.case', () => {
        const font = Font.fromData(WORK_SANS_FIXTURE);
        const byName = glyphsByNameMap(font);
        const expected = {
            'A': ['uni0041', 65],
            'A.swsh': ['uni0041.swsh', 65],
            'Aacute': ['uni00C1', 193],
            'Aacute.swsh': ['uni00C1.swsh', 193],
            'acutecomb.case': ['uni0301.case', 769],
            'a.sc': ['uni0061.sc', 97],
            'E.swsh.001': ['uni0045.swsh.001', 69]
        };
        for (const [name, [identity, unicode]] of Object.entries(expected)) {
            expect(glyphIdentity(name, byName)).toEqual({ identity, unicode });
        }
        expect(localNamesByIdentity(byName).get('uni0301.case')).toBe(
            'acutecomb.case'
        );

        const aacute = observeGlyph(font.findGlyph('Aacute'), byName);
        expect(aacute.components).toEqual(['uni0041', 'uni0301.case']);
        expect(aacute.anchors).toEqual([]);

        const aswsh = observeGlyph(font.findGlyph('A.swsh'), byName);
        expect(aswsh.components).toEqual([]);

        const part = observeGlyph(font.findGlyph('_part.swsh_topleft'), byName);
        expect(part).toBeNull();
    });
});

describe('Auto QA matcher', () => {
    afterEach(() => {
        qaCorpusIndex.resetForTests();
        invalidateQaMatchCache();
    });

    test('Wilson 2/2 is well below the default threshold', () => {
        expect(wilsonLowerBound(2, 2)).toBeLessThan(0.85);
        expect(wilsonLowerBound(370, 400)).toBeGreaterThanOrEqual(0.85);
    });

    test('Work Sans priors: A wants top/bottom/ogonek; Aacute wants components not top', () => {
        const font = Font.fromData(WORK_SANS_FIXTURE);
        qaCorpusIndex.loadTableForTests(workSansPriors());
        const labels = matchOpenFont(font);
        const aLabels = labels.filter((label) => label.glyph_name === 'A');
        const aacuteLabels = labels.filter(
            (label) => label.glyph_name === 'Aacute'
        );
        expect(aLabels.map((label) => label.missing).sort()).toEqual([]);
        expect(
            aacuteLabels.map((label) => `${label.kind}:${label.missing}`).sort()
        ).toEqual([]);
        expect(aacuteLabels.some((label) => label.missing === 'top')).toBe(
            false
        );
    });

    test('planted omissions fire above X', () => {
        const font = makeFont([
            makeGlyph('A', {
                codepoints: [0x41],
                anchors: ['bottom', 'ogonek']
            }),
            makeGlyph('Aacute', {
                codepoints: [0xc1],
                components: ['A']
            }),
            makeGlyph('acutecomb.case', {
                codepoints: [0x301],
                anchors: ['_top']
            }),
            makeGlyph('Eacute', {
                codepoints: [0xc9],
                components: ['E', 'acutecomb.case']
            }),
            makeGlyph('E', { codepoints: [0x45], anchors: ['top'] }),
            makeGlyph('Iacute', {
                codepoints: [0xcd],
                components: ['I', 'acutecomb.case']
            }),
            makeGlyph('I', { codepoints: [0x49] }),
            makeGlyph('Oacute', {
                codepoints: [0xd3],
                components: ['O', 'acutecomb.case']
            }),
            makeGlyph('O', { codepoints: [0x4f] }),
            makeGlyph('Uacute', {
                codepoints: [0xda],
                components: ['U', 'acutecomb.case']
            }),
            makeGlyph('U', { codepoints: [0x55] }),
            makeGlyph('Yacute', {
                codepoints: [0xdd],
                components: ['Y', 'acutecomb.case']
            }),
            makeGlyph('Y', { codepoints: [0x59] }),
            makeGlyph('Agrave', {
                codepoints: [0xc0],
                components: ['A', 'gravecomb.case']
            }),
            makeGlyph('gravecomb.case', { codepoints: [0x300] }),
            makeGlyph('Egrave', {
                codepoints: [0xc8],
                components: ['E', 'gravecomb.case']
            }),
            makeGlyph('Igrave', {
                codepoints: [0xcc],
                components: ['I', 'gravecomb.case']
            })
        ]);
        const table = workSansPriors();
        const labels = matchOpenFont(font, table);
        const planted = labels.map(
            (label) => `${label.glyph_name}:${label.kind}:${label.missing}`
        );
        expect(planted).toEqual(
            expect.arrayContaining([
                'A:missing_anchor:top',
                'Aacute:missing_component:uni0301.case'
            ])
        );
        expect(
            labels.find(
                (label) =>
                    label.glyph_name === 'Aacute' &&
                    label.missing === 'uni0301.case'
            )?.displayName
        ).toBe('acutecomb.case');
        expect(
            labels.find(
                (label) =>
                    label.glyph_name === 'Aacute' && label.missing === 'top'
            )
        ).toBeUndefined();
        for (const X of [0.7, 0.8, 0.85]) {
            const swept = matchOpenFont(font, table, { X });
            expect(
                swept.some(
                    (label) =>
                        label.glyph_name === 'A' && label.missing === 'top'
                )
            ).toBe(true);
            expect(
                swept.some(
                    (label) =>
                        label.glyph_name === 'Aacute' &&
                        label.missing === 'uni0301.case'
                )
            ).toBe(true);
        }
    });

    test('mark-before-base component order is labeled', () => {
        const font = makeFont([
            makeGlyph('A', { codepoints: [0x41] }),
            makeGlyph('acutecomb.case', { codepoints: [0x301] }),
            makeGlyph('Aacute', {
                codepoints: [0xc1],
                components: ['acutecomb.case', 'A']
            }),
            makeGlyph('E', { codepoints: [0x45] }),
            makeGlyph('Eacute', {
                codepoints: [0xc9],
                components: ['E', 'acutecomb.case']
            }),
            makeGlyph('I', { codepoints: [0x49] }),
            makeGlyph('Iacute', {
                codepoints: [0xcd],
                components: ['I', 'acutecomb.case']
            })
        ]);
        const labels = matchOpenFont(font, workSansPriors());
        const order = labels.find(
            (label) =>
                label.glyph_name === 'Aacute' &&
                label.kind === 'wrong_component_order'
        );
        expect(order?.displayName).toBe('acutecomb.case');
        expect(order?.relatedDisplayName).toBe('A');
        expect(formatQaLabel(order)).toMatch(/usually comes after/);
        expect(
            labels.some(
                (label) =>
                    label.glyph_name === 'Eacute' &&
                    label.kind === 'wrong_component_order'
            )
        ).toBe(false);
    });

    test('Glyph.qa exposes Auto QA messages as dicts', () => {
        const font = makeFont([
            makeGlyph('A', { codepoints: [0x41] }),
            makeGlyph('acutecomb.case', { codepoints: [0x301] }),
            makeGlyph('Aacute', {
                codepoints: [0xc1],
                components: ['acutecomb.case', 'A']
            }),
            makeGlyph('E', { codepoints: [0x45] }),
            makeGlyph('Eacute', {
                codepoints: [0xc9],
                components: ['E', 'acutecomb.case']
            }),
            makeGlyph('I', { codepoints: [0x49] }),
            makeGlyph('Iacute', {
                codepoints: [0xcd],
                components: ['I', 'acutecomb.case']
            })
        ]);
        qaCorpusIndex.loadTableForTests(workSansPriors());
        const messages = font.findGlyph('Aacute').qa;
        expect(messages.length).toBeGreaterThan(0);
        expect(messages[0]).toEqual(
            expect.objectContaining({
                sourceId: 'auto-qa',
                severity: 'warning',
                checkId: 'wrong_component_order',
                messageId: 'wrong_component_order:uni0301.case>uni0041'
            })
        );
        expect(messages[0].message).toMatch(/acutecomb\.case/);
        expect(messages[0].message).not.toMatch(/`/);
        expect(font.findGlyph('Eacute').qa).toEqual([]);
        expect(() => font.findGlyph('Aacute').qa.push({})).toThrow(
            /read-only snapshot/
        );
    });

    test('uppercase .case mark components fire with fewer than eight peers', () => {
        const letters = [
            ['A', 0x41, 'Adieresis', 0xc4],
            ['E', 0x45, 'Edieresis', 0xcb],
            ['I', 0x49, 'Idieresis', 0xcf],
            ['O', 0x4f, 'Odieresis', 0xd6],
            ['U', 0x55, 'Udieresis', 0xdc],
            ['W', 0x57, 'Wdieresis', 0x1e84],
            ['Y', 0x59, 'Ydieresis', 0x178]
        ];
        const font = makeFont([
            makeGlyph('dieresiscomb.case', { codepoints: [0x308] }),
            ...letters.flatMap(([base, baseCp, accent, accentCp]) => [
                makeGlyph(base, { codepoints: [baseCp] }),
                makeGlyph(accent, {
                    codepoints: [accentCp],
                    components:
                        accent === 'Adieresis'
                            ? [base]
                            : [base, 'dieresiscomb.case']
                })
            ])
        ]);
        const identities = {};
        for (const [base, baseCp, accent, accentCp] of letters) {
            identities[
                `uni${baseCp.toString(16).toUpperCase().padStart(4, '0')}`
            ] = {
                n: 400,
                n_mark_system: 350,
                k_has_any_component: 10,
                k_has_any_anchor: 20,
                components: {},
                anchors: {}
            };
            identities[
                `uni${accentCp.toString(16).toUpperCase().padStart(4, '0')}`
            ] = {
                n: 1500,
                n_mark_system: 1350,
                k_has_any_component: 1150,
                k_has_any_anchor: 80,
                components: {
                    [`uni${baseCp.toString(16).toUpperCase().padStart(4, '0')}`]: 1140,
                    'uni0308.case': 535
                },
                anchors: {}
            };
        }
        const labels = matchOpenFont(font, {
            version: 1,
            mark_anchor_names: ['top', '_top'],
            identities
        });
        expect(
            labels.some(
                (label) =>
                    label.glyph_name === 'Adieresis' &&
                    label.missing === 'uni0308.case' &&
                    label.displayName === 'dieresiscomb.case'
            )
        ).toBe(true);
    });

    test('marks-free fonts do not nag A for top', () => {
        const font = makeFont([
            makeGlyph('A', { codepoints: [0x41], anchors: ['bottom'] })
        ]);
        const labels = matchOpenFont(font, workSansPriors());
        expect(labels.filter((label) => label.missing === 'top')).toEqual([]);
    });

    test('decomposed families do not mass-flag missing mark components', () => {
        const accents = [
            ['Aacute', 0xc1],
            ['Eacute', 0xc9],
            ['Iacute', 0xcd],
            ['Oacute', 0xd3],
            ['Uacute', 0xda],
            ['Yacute', 0xdd],
            ['Agrave', 0xc0],
            ['Egrave', 0xc8],
            ['Igrave', 0xcc]
        ];
        const font = makeFont([
            makeGlyph('A', { codepoints: [0x41], anchors: ['top'] }),
            makeGlyph('E', { codepoints: [0x45] }),
            makeGlyph('I', { codepoints: [0x49] }),
            makeGlyph('O', { codepoints: [0x4f] }),
            makeGlyph('U', { codepoints: [0x55] }),
            makeGlyph('Y', { codepoints: [0x59] }),
            ...accents.map(([name, cp]) =>
                makeGlyph(name, { codepoints: [cp] })
            )
        ]);
        const labels = matchOpenFont(font, workSansPriors());
        expect(
            labels.filter(
                (label) =>
                    label.kind === 'missing_component' &&
                    label.missing === 'uni0301.case'
            )
        ).toEqual([]);
    });

    test('labelsForGlyph returns only the current glyph', () => {
        const font = makeFont([
            makeGlyph('A', { codepoints: [0x41] }),
            makeGlyph('acutecomb', { codepoints: [0x301] })
        ]);
        const labels = labelsForGlyph(font, 'A', workSansPriors());
        expect(labels.every((label) => label.glyph_name === 'A')).toBe(true);
        expect(labels.some((label) => label.missing === 'top')).toBe(true);
    });

    test('does not rescan rare corpus slots against every glyph', () => {
        const junkAnchors = {};
        for (let i = 0; i < 80; i += 1) {
            junkAnchors[`rare${i}`] = 1;
        }
        const table = {
            version: 1,
            mark_anchor_names: ['top'],
            identities: {
                uni0041: {
                    n: 400,
                    n_mark_system: 400,
                    k_has_any_component: 0,
                    k_has_any_anchor: 380,
                    components: {},
                    anchors: { top: 370, ...junkAnchors }
                }
            }
        };
        const glyphs = [
            makeGlyph('A', { codepoints: [0x41] }),
            makeGlyph('acutecomb', { codepoints: [0x301] })
        ];
        for (let i = 0; i < 120; i += 1) {
            glyphs.push(
                makeGlyph(`B${i}`, {
                    codepoints: [0x42],
                    anchors: ['top']
                })
            );
        }
        const font = makeFont(glyphs);
        const started = Date.now();
        const labels = labelsForGlyph(font, 'A', table);
        expect(Date.now() - started).toBeLessThan(250);
        expect(labels.some((label) => label.missing === 'top')).toBe(true);
        expect(labels.some((label) => label.missing.startsWith('rare'))).toBe(
            false
        );
    });

    test('shipped corpus flags planted Work Sans omissions and not marks-free A', () => {
        const corpusPath = path.join(__dirname, '../../data/qa-corpus.json.gz');
        if (!fs.existsSync(corpusPath)) {
            return;
        }
        const zlib = require('zlib');
        const table = JSON.parse(
            zlib.gunzipSync(fs.readFileSync(corpusPath)).toString('utf8')
        );
        const clean = Font.fromData(WORK_SANS_FIXTURE);
        const cleanAacute = matchOpenFont(clean, table).filter(
            (label) => label.glyph_name === 'Aacute'
        );
        expect(
            cleanAacute.some(
                (label) =>
                    label.missing === 'uni0041' ||
                    label.missing === 'uni0301.case'
            )
        ).toBe(false);

        const latinCaps = [
            ['B', 0x42],
            ['C', 0x43],
            ['D', 0x44],
            ['G', 0x47],
            ['H', 0x48],
            ['N', 0x4e],
            ['P', 0x50],
            ['R', 0x52]
        ];
        const planted = makeFont([
            makeGlyph('A', {
                codepoints: [0x41],
                anchors: ['bottom', 'ogonek']
            }),
            ...latinCaps.map(([name, cp]) =>
                makeGlyph(name, {
                    codepoints: [cp],
                    anchors: ['top', 'bottom']
                })
            ),
            makeGlyph('Aacute', { codepoints: [0xc1], components: ['A'] }),
            makeGlyph('acutecomb', {
                codepoints: [0x301],
                anchors: ['_top']
            }),
            makeGlyph('acutecomb.case', {
                codepoints: [0x301],
                anchors: ['_top']
            }),
            makeGlyph('E', { codepoints: [0x45], anchors: ['top'] }),
            makeGlyph('Eacute', {
                codepoints: [0xc9],
                components: ['E', 'acutecomb.case']
            }),
            makeGlyph('I', { codepoints: [0x49], anchors: ['top'] }),
            makeGlyph('Iacute', {
                codepoints: [0xcd],
                components: ['I', 'acutecomb.case']
            }),
            makeGlyph('O', { codepoints: [0x4f], anchors: ['top'] }),
            makeGlyph('Oacute', {
                codepoints: [0xd3],
                components: ['O', 'acutecomb.case']
            }),
            makeGlyph('U', { codepoints: [0x55], anchors: ['top'] }),
            makeGlyph('Uacute', {
                codepoints: [0xda],
                components: ['U', 'acutecomb.case']
            }),
            makeGlyph('Y', { codepoints: [0x59], anchors: ['top'] }),
            makeGlyph('Yacute', {
                codepoints: [0xdd],
                components: ['Y', 'acutecomb.case']
            }),
            makeGlyph('Agrave', {
                codepoints: [0xc0],
                components: ['A', 'gravecomb.case']
            }),
            makeGlyph('gravecomb', { codepoints: [0x300] }),
            makeGlyph('gravecomb.case', { codepoints: [0x300] }),
            makeGlyph('Egrave', {
                codepoints: [0xc8],
                components: ['E', 'gravecomb.case']
            }),
            makeGlyph('Igrave', {
                codepoints: [0xcc],
                components: ['I', 'gravecomb.case']
            }),
            makeGlyph('Cacute', {
                codepoints: [0x106],
                components: ['C', 'acutecomb.case']
            }),
            makeGlyph('Nacute', {
                codepoints: [0x143],
                components: ['N', 'acutecomb.case']
            }),
            makeGlyph('Sacute', {
                codepoints: [0x15a],
                components: ['S', 'acutecomb.case']
            }),
            makeGlyph('Zacute', {
                codepoints: [0x179],
                components: ['Z', 'acutecomb.case']
            })
        ]);
        const plantedLabels = matchOpenFont(planted, table);
        expect(
            plantedLabels.some(
                (label) => label.glyph_name === 'A' && label.missing === 'top'
            )
        ).toBe(true);
        expect(
            plantedLabels.some(
                (label) =>
                    label.glyph_name === 'Aacute' &&
                    label.missing === 'uni0301.case'
            )
        ).toBe(true);

        const marksFree = makeFont([
            makeGlyph('A', { codepoints: [0x41], anchors: ['bottom'] })
        ]);
        expect(
            matchOpenFont(marksFree, table).filter(
                (label) => label.missing === 'top'
            )
        ).toEqual([]);
    });
});

describe('Auto QA property-panel widget', () => {
    afterEach(() => {
        destroyAutoQaTippy();
    });

    test('hides entirely when clean and shows a QA label plus warning icon when labels exist', () => {
        expect(renderAutoQaWidget([])).toBeNull();
        const widget = renderAutoQaWidget([
            {
                glyph_name: 'Aacute',
                identity: 'uni00C1',
                kind: 'missing_component',
                missing: 'uni0301.case',
                displayName: 'acutecomb.case',
                n: 300,
                k: 270,
                confidence: 0.87
            },
            {
                glyph_name: 'A',
                identity: 'uni0041',
                kind: 'missing_anchor',
                missing: 'top',
                displayName: 'top',
                n: 400,
                k: 370,
                confidence: 0.9
            }
        ]);
        expect(widget.className).toContain('glyph-auto-qa-widget');
        expect(widget.className).toContain('glyph-property-control');
        expect(
            widget.querySelector('.glyph-property-control-label').textContent
        ).toBe('QA');
        const icon = widget.querySelector('.glyph-auto-qa-icon');
        expect(icon.textContent).toBe('warning');
        expect(icon.getAttribute('aria-label')).toBe('Auto QA warnings');

        const popup = buildAutoQaPopup([
            {
                glyph_name: 'Aacute',
                identity: 'uni00C1',
                kind: 'missing_component',
                missing: 'uni0301.case',
                displayName: 'acutecomb.case',
                n: 300,
                k: 270,
                confidence: 0.87
            }
        ]);
        expect(popup.className).toContain('info-popup-content');
        const explainer = popup.querySelector('.glyph-auto-qa-explainer');
        const item = popup.querySelector('.glyph-auto-qa-item');
        expect(explainer.textContent).toMatch(/open-source fonts/);
        expect(explainer.textContent).not.toMatch(
            /uniXXXX|lower bound|Wilson/i
        );
        expect(
            item.compareDocumentPosition(explainer) &
                Node.DOCUMENT_POSITION_FOLLOWING
        ).toBeTruthy();
        expect(item.textContent).toMatch(
            /Similar fonts usually include the component/
        );
        expect(item.textContent).not.toMatch(/%|lower bound|\d+\/\d+/);
        const name = item.querySelector('pre');
        expect(name.textContent).toBe('acutecomb.case');
        expect(
            formatQaLabel({
                glyph_name: 'Aacute',
                identity: 'uni00C1',
                kind: 'missing_component',
                missing: 'uni0301.case',
                displayName: 'acutecomb.case',
                n: 300,
                k: 270,
                confidence: 0.87
            })
        ).toContain('`acutecomb.case`');
    });
});

describe('incremental observation refresh', () => {
    const corpusPath = path.join(__dirname, '../../data/qa-corpus.json.gz');
    const loadTable = () =>
        JSON.parse(
            require('zlib')
                .gunzipSync(fs.readFileSync(corpusPath))
                .toString('utf8')
        );
    // What a full pass over the font's current data gives, without the cache.
    const fullPass = (font, table) =>
        matchObservations(font, observeFont(font), table);

    test('labels after edited glyphs match a full pass', () => {
        if (!fs.existsSync(corpusPath)) {
            return;
        }
        const table = loadTable();
        const data = JSON.parse(JSON.stringify(WORK_SANS_FIXTURE));
        const font = Font.fromData(data);
        const glyph = (name) => data.glyphs.find((g) => g.name === name);
        invalidateQaMatchCache();
        expect(matchOpenFont(font, table)).toEqual(fullPass(font, table));

        const edits = [
            ['A', (g) => (g.layers[0].anchors = [])],
            ['Aacute', (g) => g.layers[0].shapes.pop()],
            ['A', (g) => g.layers[0].anchors.push({ name: 'top', x: 0, y: 0 })],
            // A codepoint change alters identities: falls back to a full pass.
            ['Aacute', (g) => (g.codepoints = [0x00c2])]
        ];
        for (const [name, edit] of edits) {
            edit(glyph(name));
            markQaGlyphsChanged([name]);
            expect(matchOpenFont(font, table)).toEqual(fullPass(font, table));
        }
        invalidateQaMatchCache();
    });

    test('an unmarked edit of the shown glyph refreshes that glyph', () => {
        if (!fs.existsSync(corpusPath)) {
            return;
        }
        const table = loadTable();
        const data = JSON.parse(JSON.stringify(WORK_SANS_FIXTURE));
        const font = Font.fromData(data);
        invalidateQaMatchCache();
        labelsForGlyph(font, 'Aacute', table);
        data.glyphs.find((g) => g.name === 'Aacute').layers[0].shapes = [
            { reference: 'A' }
        ];
        expect(labelsForGlyph(font, 'Aacute', table)).toEqual(
            fullPass(font, table).filter(
                (label) => label.glyph_name === 'Aacute'
            )
        );
        expect(matchOpenFont(font, table)).toEqual(fullPass(font, table));
        invalidateQaMatchCache();
    });
});
