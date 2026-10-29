const fontManager = require('../js/font-manager').default;

describe('FontManager sparse hydration', () => {
    const previousBridge = window.patchSyncEngine;

    afterEach(() => {
        window.patchSyncEngine = previousBridge;
    });

    test('treats an empty glyph array with a live catalog as sparse', () => {
        window.patchSyncEngine = undefined;
        const residency = fontManager.getGlyphResidency.call({
            getHydratedGlyphNames() {
                return [];
            },
            currentFont: {
                fontModel: { glyphs: [] },
                babelfontData: {
                    glyphCatalog: {
                        a: { glyphId: 'a', name: 'a', deleted: false },
                        gone: { glyphId: 'gone', name: 'gone', deleted: true }
                    }
                }
            }
        });
        expect(residency).toEqual({ resident: 0, total: 1 });
    });

    test('is not sparse when every live catalog glyph is hydrated', () => {
        window.patchSyncEngine = undefined;
        const residency = fontManager.getGlyphResidency.call({
            getHydratedGlyphNames() {
                return ['a'];
            },
            currentFont: {
                fontModel: { glyphs: [{ name: 'a' }] },
                babelfontData: {
                    glyphCatalog: {
                        a: { glyphId: 'a', name: 'a', deleted: false }
                    }
                }
            }
        });
        expect(residency).toEqual({ resident: 1, total: 1 });
    });

    test('deriveSubsetGlyphsFromText includes catalog cmap glyphs that are not hydrated yet', () => {
        const names = fontManager.deriveSubsetGlyphsFromText.call(
            {
                currentFont: {
                    fontModel: {
                        findGlyph(name) {
                            return name === '.notdef'
                                ? { name: '.notdef' }
                                : null;
                        },
                        findGlyphByCodepoint() {
                            return null;
                        }
                    },
                    babelfontData: {
                        glyphCatalog: {
                            'id-a': { glyphId: 'id-a', name: 'a' },
                            'id-adi': { glyphId: 'id-adi', name: 'adieresis' },
                            'id-comb': {
                                glyphId: 'id-comb',
                                name: 'dieresiscomb'
                            }
                        },
                        codepointIndex: {
                            97: ['id-a'],
                            228: ['id-adi'],
                            776: ['id-comb']
                        },
                        features: {
                            features: [
                                ['ccmp', 'sub a dieresiscomb by adieresis;']
                            ]
                        }
                    }
                }
            },
            'ä'
        );
        expect(names).toEqual(expect.arrayContaining(['adieresis']));
    });

    test('needsEditingCompileForText is true when a hydrated cmap glyph is missing from the compiled snapshot', () => {
        const needs = fontManager.needsEditingCompileForText.call(
            {
                deriveSubsetGlyphsFromText() {
                    return ['.notdef', 'a', 'adieresis'];
                },
                constrainSubsetToHydratedGlyphs(names) {
                    return names.filter((name) => name !== '.notdef');
                },
                getEditingSubsetSnapshot() {
                    return ['a', '.notdef'];
                }
            },
            'hä'
        );
        expect(needs).toBe(true);
    });

    test('needsEditingCompileForText is true while catalog-mapped names are not hydrated yet', () => {
        const needs = fontManager.needsEditingCompileForText.call(
            {
                deriveSubsetGlyphsFromText() {
                    return ['.notdef', 'a', 'adieresis'];
                },
                constrainSubsetToHydratedGlyphs() {
                    return ['a', '.notdef'];
                },
                getEditingSubsetSnapshot() {
                    return ['a', '.notdef'];
                }
            },
            'hä'
        );
        expect(needs).toBe(true);
    });

    test('needsEditingCompileForText is false when the compiled snapshot already has the constrained subset', () => {
        const needs = fontManager.needsEditingCompileForText.call(
            {
                deriveSubsetGlyphsFromText() {
                    return ['.notdef', 'a', 'adieresis'];
                },
                constrainSubsetToHydratedGlyphs(names) {
                    return names.filter((name) => name !== '.notdef');
                },
                getEditingSubsetSnapshot() {
                    return ['a', 'adieresis'];
                }
            },
            'hä'
        );
        expect(needs).toBe(false);
    });

    test('ensureSparseHydrationForCompile passes typed text and current glyph names', async () => {
        const plugin = {
            activeAssetId: 'asset-1',
            ensureSparseHydration: jest.fn(async () => ['adieresis'])
        };
        window.cloudPlugin = plugin;
        await fontManager.ensureSparseHydrationForCompile.call({
            isHydrationSparse() {
                return true;
            },
            resolveEditingTextForCompile() {
                return 'ä';
            },
            getLiveVisibleGlyphNames() {
                return [];
            }
        });
        expect(plugin.ensureSparseHydration).toHaveBeenCalledWith({
            text: 'ä',
            glyphNames: [],
            purpose: 'ui'
        });
    });
});
