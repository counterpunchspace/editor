jest.mock('../js/opentype-table-reader', () => ({
    ...jest.requireActual('../js/opentype-table-reader'),
    get_stylistic_set_names: jest.fn(() => JSON.stringify({})),
    get_font_features_with_tables: jest.fn(() => JSON.stringify({}))
}));

describe('FeaturesManager setEnabledFeatures', () => {
    let FeaturesManager;
    let originalRequestAnimationFrame;

    const flushUi = async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => setTimeout(resolve, 0));
    };

    beforeEach(() => {
        jest.resetModules();
        document.body.innerHTML = '';
        originalRequestAnimationFrame = window.requestAnimationFrame;
        window.requestAnimationFrame = (callback) => {
            callback(0);
            return 1;
        };
        window.currentFontModel = {
            features: {
                features: [
                    ['dlig', 'feature dlig { sub a by a.alt; } dlig;'],
                    ['liga', 'feature liga { sub f i by fi; } liga;']
                ]
            },
            analyzeFeatureTables: jest.fn((tag) => ({
                hasGSUB: tag === 'dlig' || tag === 'liga',
                hasGPOS: false
            }))
        };

        ({ FeaturesManager } = require('../js/glyph-canvas/features'));
    });

    afterEach(() => {
        window.requestAnimationFrame = originalRequestAnimationFrame;
        delete window.currentFontModel;
    });

    test('reuses feature button clicks for assistant-style bulk updates', async () => {
        const manager = new FeaturesManager();
        const changeSpy = jest.fn();
        manager.on('change', changeSpy);

        document.body.appendChild(manager.createFeaturesSection());

        await manager.updateFeaturesUI();
        await flushUi();

        const ligaButton = manager.featuresSection.querySelector(
            'button[data-feature-tag="liga"]'
        );
        const dligButton = manager.featuresSection.querySelector(
            'button[data-feature-tag="dlig"]'
        );

        expect(ligaButton.classList.contains('enabled')).toBe(true);
        expect(dligButton.classList.contains('enabled')).toBe(false);

        await manager.setEnabledFeatures(['dlig']);

        expect(manager.featureSettings.liga).toBe(false);
        expect(manager.featureSettings.dlig).toBe(true);
        expect(ligaButton.classList.contains('enabled')).toBe(false);
        expect(dligButton.classList.contains('enabled')).toBe(true);
        expect(changeSpy).toHaveBeenCalledTimes(1);
    });

    test('shows compiled stylistic set names instead of the generic label', async () => {
        window.currentFontModel.features.features.push([
            'ss03',
            'feature ss03 { sub a by a.ss03; } ss03;'
        ]);
        window.currentFontModel.analyzeFeatureTables.mockImplementation(
            (tag) => ({
                hasGSUB: tag === 'dlig' || tag === 'liga' || tag === 'ss03',
                hasGPOS: false
            })
        );

        const {
            get_stylistic_set_names,
            get_font_features_with_tables
        } = require('../js/opentype-table-reader');
        get_stylistic_set_names.mockReturnValue(
            JSON.stringify({ ss03: 'Geometric a g' })
        );
        get_font_features_with_tables.mockReturnValue(
            JSON.stringify({
                liga: ['GSUB'],
                dlig: ['GSUB'],
                ss03: ['GSUB']
            })
        );

        const manager = new FeaturesManager();
        manager.editingFontBytes = new Uint8Array([1, 2, 3]);
        document.body.appendChild(manager.createFeaturesSection());

        await manager.updateFeaturesUI();
        await flushUi();

        const ss03Row = manager.featuresSection.querySelector(
            'button[data-feature-tag="ss03"]'
        )?.parentElement;
        const ss03Name = ss03Row?.querySelector('.tag-description');

        expect(ss03Name?.textContent).toBe('Geometric a g');
        expect(ss03Name?.classList.contains('custom-name')).toBe(true);
    });

    test('uses source featureNames when the set is missing from the subset', async () => {
        window.currentFontModel.features.features.push([
            'ss03',
            {
                code: 'featureNames {\n  name 1 "Geometric a g";\n  name 3 "Geometric a g";\n};\nsub a by a.ss03;'
            }
        ]);
        window.currentFontModel.analyzeFeatureTables.mockImplementation(
            (tag) => ({
                hasGSUB: tag === 'dlig' || tag === 'liga' || tag === 'ss03',
                hasGPOS: false
            })
        );

        const {
            get_stylistic_set_names,
            get_font_features_with_tables
        } = require('../js/opentype-table-reader');
        get_stylistic_set_names.mockReturnValue(JSON.stringify({}));
        get_font_features_with_tables.mockReturnValue(
            JSON.stringify({
                liga: ['GSUB'],
                dlig: ['GSUB']
            })
        );

        const manager = new FeaturesManager();
        manager.editingFontBytes = new Uint8Array([1, 2, 3]);
        document.body.appendChild(manager.createFeaturesSection());

        await manager.updateFeaturesUI();
        await flushUi();

        const ss03Row = manager.featuresSection.querySelector(
            'button[data-feature-tag="ss03"]'
        )?.parentElement;
        const ss03Name = ss03Row?.querySelector('.tag-description');
        const ss03Button = ss03Row?.querySelector(
            'button[data-feature-tag="ss03"]'
        );

        expect(ss03Name?.textContent).toBe('Geometric a g');
        expect(ss03Name?.classList.contains('custom-name')).toBe(true);
        expect(ss03Button?.disabled).toBe(true);
        expect(ss03Row?.classList.contains('unavailable')).toBe(true);
    });

    test('uses Glyphs labels when featureNames are absent and the set is missing from the subset', async () => {
        window.currentFontModel.features.features.push([
            'ss01',
            {
                code: 'sub meem-ar by meem-ar.ss01;',
                format_specific: {
                    'com.schriftgestalt.Glyphs.labels': [
                        { language: 'ENG', value: 'Alternate meem' }
                    ]
                }
            }
        ]);
        window.currentFontModel.analyzeFeatureTables.mockImplementation(
            (tag) => ({
                hasGSUB: true,
                hasGPOS: false
            })
        );

        const {
            get_stylistic_set_names,
            get_font_features_with_tables
        } = require('../js/opentype-table-reader');
        get_stylistic_set_names.mockReturnValue(JSON.stringify({}));
        get_font_features_with_tables.mockReturnValue(
            JSON.stringify({
                liga: ['GSUB'],
                dlig: ['GSUB']
            })
        );

        const manager = new FeaturesManager();
        manager.editingFontBytes = new Uint8Array([1, 2, 3]);
        document.body.appendChild(manager.createFeaturesSection());

        await manager.updateFeaturesUI();
        await flushUi();

        const ss01Row = manager.featuresSection.querySelector(
            'button[data-feature-tag="ss01"]'
        )?.parentElement;
        const ss01Name = ss01Row?.querySelector('.tag-description');

        expect(ss01Name?.textContent).toBe('Alternate meem');
        expect(ss01Name?.classList.contains('custom-name')).toBe(true);
        expect(ss01Row?.classList.contains('unavailable')).toBe(true);
    });

    test('prefers compiled names for sets that are in the subset over source names', async () => {
        window.currentFontModel.features.features.push([
            'ss03',
            {
                code: 'featureNames {\n  name 3 "From source";\n};\nsub a by a.ss03;'
            }
        ]);
        window.currentFontModel.analyzeFeatureTables.mockImplementation(
            (tag) => ({
                hasGSUB: true,
                hasGPOS: false
            })
        );

        const {
            get_stylistic_set_names,
            get_font_features_with_tables
        } = require('../js/opentype-table-reader');
        get_stylistic_set_names.mockReturnValue(
            JSON.stringify({ ss03: 'From binary' })
        );
        get_font_features_with_tables.mockReturnValue(
            JSON.stringify({
                liga: ['GSUB'],
                dlig: ['GSUB'],
                ss03: ['GSUB']
            })
        );

        const manager = new FeaturesManager();
        manager.editingFontBytes = new Uint8Array([1, 2, 3]);
        document.body.appendChild(manager.createFeaturesSection());

        await manager.updateFeaturesUI();
        await flushUi();

        const ss03Name = manager.featuresSection
            .querySelector('button[data-feature-tag="ss03"]')
            ?.parentElement?.querySelector('.tag-description');

        expect(ss03Name?.textContent).toBe('From binary');
    });

    test('enables URL-restored features even when the subset button is disabled', async () => {
        const {
            get_font_features_with_tables
        } = require('../js/opentype-table-reader');
        get_font_features_with_tables.mockReturnValue(
            JSON.stringify({
                liga: ['GSUB']
            })
        );

        const manager = new FeaturesManager();
        manager.editingFontBytes = new Uint8Array([1, 2, 3]);
        const changeSpy = jest.fn();
        manager.on('change', changeSpy);
        document.body.appendChild(manager.createFeaturesSection());

        await manager.updateFeaturesUI();
        await flushUi();

        const dligButton = manager.featuresSection.querySelector(
            'button[data-feature-tag="dlig"]'
        );
        expect(dligButton.disabled).toBe(true);

        await manager.setEnabledFeatures(['dlig']);

        expect(manager.featureSettings.dlig).toBe(true);
        expect(dligButton.classList.contains('enabled')).toBe(true);
        expect(changeSpy).toHaveBeenCalledTimes(1);
    });
});
