jest.mock('tippy.js', () =>
    jest.fn((element, props) => {
        const popper = global.document.createElement('div');
        if (typeof props.content === 'string') {
            popper.innerHTML = props.content;
        }
        const instance = {
            props,
            popper,
            state: { isVisible: false },
            setContent: jest.fn((content) => {
                if (typeof content === 'string') {
                    popper.innerHTML = content;
                }
            }),
            setProps: jest.fn((nextProps) => {
                instance.props = {
                    ...instance.props,
                    ...nextProps
                };
            }),
            show: jest.fn(() => {
                instance.state.isVisible = true;
                instance.props.onShow?.(instance);
                instance.props.onShown?.(instance);
            }),
            hide: jest.fn(() => {
                instance.state.isVisible = false;
                instance.props.onHide?.(instance);
            })
        };

        props.onCreate?.(instance);
        return instance;
    })
);

beforeAll(() => {
    if (!Element.prototype.animate) {
        Element.prototype.animate = jest.fn(() => ({
            pause: jest.fn(),
            play: jest.fn(),
            cancel: jest.fn(),
            finished: Promise.resolve()
        }));
    }
});

describe('FontInfo feature code compilation scheduling', () => {
    let originalReadyState;
    let originalAce;
    let fontCompilation;

    function loadFontInfoManager() {
        jest.resetModules();
        originalReadyState = document.readyState;
        originalAce = window.ace;
        Object.defineProperty(document, 'readyState', {
            configurable: true,
            value: 'loading'
        });
        window.ace = {
            require: jest.fn((moduleName) => {
                if (moduleName === 'ace/lib/oop') {
                    return { inherits: jest.fn() };
                }
                if (moduleName === 'ace/mode/text') {
                    return { Mode: function Mode() {} };
                }
                if (moduleName === 'ace/mode/text_highlight_rules') {
                    return {
                        TextHighlightRules: function TextHighlightRules() {}
                    };
                }
                throw new Error(`Unexpected Ace module: ${moduleName}`);
            }),
            define: jest.fn()
        };

        let fontInfoManager;
        let babelfontModel;
        jest.isolateModules(() => {
            ({ fontInfoManager } = require('../js/font-info'));
            ({ fontCompilation } = require('../js/font-compilation'));
            babelfontModel = require('../js/babelfont-model');
        });

        Object.defineProperty(document, 'readyState', {
            configurable: true,
            value: originalReadyState
        });
        window.ace = originalAce;

        fontInfoManager.__babelfontModel = babelfontModel;

        return fontInfoManager;
    }

    function createFeatureEditContext(nextCode, options = {}) {
        const codeData = {
            code: 'sub f i by fi;',
            automatic: options.automatic ?? false
        };
        const markDirty = jest.fn();
        const syncJsonFromModel = jest.fn();
        const compileEditingFont = jest.fn().mockResolvedValue(false);
        const compileFromJson = jest.fn().mockResolvedValue({ result: [] });
        const awaitWorkerDocumentSync = jest.fn().mockResolvedValue(undefined);
        const checkAndSchedule = jest.fn();
        const beginTransaction = jest.fn();
        const endTransaction = jest.fn();
        const applySyntheticChangeSet = jest.fn((_label, operations) => {
            for (const operation of operations) {
                const path = operation.path || [];
                if (path.join('.') === 'features.features.0.1.code') {
                    codeData.code = operation.newValue;
                }
                if (path.join('.') === 'features.features.0.1.automatic') {
                    codeData.automatic = operation.newValue;
                }
            }
        });

        fontCompilation.awaitWorkerDocumentSync = awaitWorkerDocumentSync;
        fontCompilation.compileFromJson = compileFromJson;

        window.currentFontModel = {
            features: {
                features: [['liga', codeData]]
            }
        };
        window.fontManager = {
            currentFont: {
                babelfontJson: '',
                markDirty,
                syncJsonFromModel
            },
            isReady: jest.fn(() => true),
            currentText: 'office',
            compileEditingFont,
            setEditingCompileContext: jest.fn(),
            clearEditingCompileContext: jest.fn()
        };
        window.glyphCanvas = {
            textRunEditor: {
                textBuffer: 'office'
            },
            featuresManager: {
                featureSettings: {
                    liga: true,
                    dlig: false
                }
            }
        };
        window.autoCompileManager = {
            checkAndSchedule
        };
        window.patchSyncEngine = {
            beginTransaction,
            endTransaction,
            applySyntheticChangeSet
        };

        if (options.disableBridge) {
            delete window.patchSyncEngine;
        }

        return {
            codeData,
            markDirty,
            syncJsonFromModel,
            compileEditingFont,
            compileFromJson,
            awaitWorkerDocumentSync,
            checkAndSchedule,
            beginTransaction,
            endTransaction,
            applySyntheticChangeSet,
            editor: {
                getValue: jest.fn(() => nextCode)
            }
        };
    }

    beforeEach(() => {
        jest.useFakeTimers();
        document.body.innerHTML = '';
        localStorage.clear();
        delete window.fontInfoManager;
        global.ResizeObserver =
            global.ResizeObserver ||
            class ResizeObserver {
                observe() {}
                disconnect() {}
            };
    });

    afterEach(() => {
        jest.runOnlyPendingTimers();
        jest.useRealTimers();
        document.body.innerHTML = '';
        delete window.fontInfoManager;
        delete window.currentFontModel;
        delete window.patchSyncEngine;
        delete window.autoCompileManager;
    });

    test('commits feature code locally without serializing when the bridge is unavailable', async () => {
        const fontInfoManager = loadFontInfoManager();
        const context = createFeatureEditContext('sub f f by ff;', {
            disableBridge: true
        });

        fontInfoManager.featuresEditor = context.editor;
        fontInfoManager.selectedItem = { type: 'feature', key: 0 };

        fontInfoManager.onFeatureCodeChanged();

        expect(fontInfoManager.featureCodeDirty).toBe(true);
        expect(context.compileEditingFont).not.toHaveBeenCalled();

        jest.advanceTimersByTime(4999);
        await Promise.resolve();
        expect(context.compileEditingFont).not.toHaveBeenCalled();

        jest.advanceTimersByTime(1);
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        expect(context.codeData.code).toBe('sub f f by ff;');
        expect(context.markDirty).toHaveBeenCalledTimes(1);
        expect(context.syncJsonFromModel).not.toHaveBeenCalled();
        expect(context.awaitWorkerDocumentSync).toHaveBeenCalledTimes(1);
        expect(context.checkAndSchedule).toHaveBeenCalledTimes(1);
        expect(context.beginTransaction).not.toHaveBeenCalled();
        expect(context.compileEditingFont).not.toHaveBeenCalled();
        expect(fontInfoManager.featureCodeDirty).toBe(false);
    });

    test('blur commits feature code locally without serializing when the bridge is unavailable', async () => {
        const fontInfoManager = loadFontInfoManager();
        const context = createFeatureEditContext('sub f l by fl;', {
            disableBridge: true
        });

        fontInfoManager.featuresEditor = context.editor;
        fontInfoManager.selectedItem = { type: 'feature', key: 0 };

        fontInfoManager.onFeatureCodeChanged();
        jest.advanceTimersByTime(2000);

        fontInfoManager.commitFeatureCodeChanges();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        expect(context.codeData.code).toBe('sub f l by fl;');
        expect(context.beginTransaction).not.toHaveBeenCalled();
        expect(context.endTransaction).not.toHaveBeenCalled();
        expect(context.syncJsonFromModel).not.toHaveBeenCalled();
        expect(context.awaitWorkerDocumentSync).toHaveBeenCalledTimes(1);
        expect(context.checkAndSchedule).toHaveBeenCalledTimes(1);
        expect(context.compileEditingFont).not.toHaveBeenCalled();

        jest.advanceTimersByTime(5000);
        await Promise.resolve();

        expect(context.checkAndSchedule).toHaveBeenCalledTimes(1);
        expect(context.compileEditingFont).not.toHaveBeenCalled();
    });

    test('bridge-backed feature code commits go only through the patch funnel', () => {
        const fontInfoManager = loadFontInfoManager();
        const context = createFeatureEditContext('sub f l by fl;');

        fontInfoManager.featuresEditor = context.editor;
        fontInfoManager.selectedItem = { type: 'feature', key: 0 };

        fontInfoManager.commitFeatureCodeChanges();

        expect(context.beginTransaction).toHaveBeenCalledWith(
            'Edit feature code',
            {
                type: 'feature',
                key: 'feature:liga:1',
                label: 'liga'
            },
            expect.objectContaining({
                compileChangeSource: 'feature-code',
                compileEditType: 'feature'
            })
        );
        expect(context.applySyntheticChangeSet).toHaveBeenCalledWith(
            'Edit feature code',
            [
                {
                    op: 'set',
                    path: ['features', 'features', 0, 1, 'code'],
                    oldValue: 'sub f i by fi;',
                    newValue: 'sub f l by fl;'
                }
            ],
            expect.objectContaining({
                compileChangeSource: 'feature-code',
                compileEditType: 'feature'
            })
        );
        expect(context.endTransaction).toHaveBeenCalledTimes(1);
        expect(context.syncJsonFromModel).not.toHaveBeenCalled();
        expect(context.markDirty).not.toHaveBeenCalled();
        expect(context.awaitWorkerDocumentSync).not.toHaveBeenCalled();
        expect(context.compileEditingFont).not.toHaveBeenCalled();
        expect(context.codeData.code).toBe('sub f l by fl;');
    });

    test('manual feature edits disable automatic generation through the patch funnel', () => {
        const fontInfoManager = loadFontInfoManager();
        const context = createFeatureEditContext('eature locl;', {
            automatic: true
        });

        document.body.innerHTML =
            '<input type="checkbox" id="feature-automatic-checkbox" checked />';
        fontInfoManager.featuresEditor = context.editor;
        fontInfoManager.selectedItem = { type: 'feature', key: 0 };

        fontInfoManager.commitFeatureCodeChanges();

        expect(context.applySyntheticChangeSet).toHaveBeenCalledWith(
            'Edit feature code',
            [
                {
                    op: 'set',
                    path: ['features', 'features', 0, 1, 'code'],
                    oldValue: 'sub f i by fi;',
                    newValue: 'eature locl;'
                },
                {
                    op: 'set',
                    path: ['features', 'features', 0, 1, 'automatic'],
                    oldValue: true,
                    newValue: false
                }
            ],
            expect.objectContaining({
                compileChangeSource: 'feature-code',
                compileEditType: 'feature'
            })
        );
        expect(context.codeData.automatic).toBe(false);
        expect(
            document.getElementById('feature-automatic-checkbox').checked
        ).toBe(false);
    });

    test('does not commit a stale feature draft after a feature reorder', () => {
        const fontInfoManager = loadFontInfoManager();
        const context = createFeatureEditContext('sub zero by zero.alt;');
        const fracCodeData = {
            code: 'sub slash by fraction;',
            automatic: true
        };

        window.currentFontModel.features.features = [
            ['frac', fracCodeData],
            ['zero', context.codeData]
        ];
        fontInfoManager.featuresEditor = context.editor;
        fontInfoManager.selectedItem = { type: 'feature', key: 0 };
        fontInfoManager.selectedFeatureTag = 'zero';
        fontInfoManager.featureCodeDirty = true;
        fontInfoManager.refreshVisibleFeatureContent = jest.fn();

        fontInfoManager.commitFeatureCodeChanges();

        expect(context.applySyntheticChangeSet).not.toHaveBeenCalled();
        expect(fracCodeData).toEqual({
            code: 'sub slash by fraction;',
            automatic: true
        });
        expect(fontInfoManager.featureCodeDirty).toBe(false);
    });

    test('fontModelSync refreshes a reordered feature list without discarding a focused draft', () => {
        const fontInfoManager = loadFontInfoManager();
        document.body.innerHTML = '<div id="features-list"></div>';
        const setValue = jest.fn();
        window.currentFontModel = {
            features: {
                features: [
                    ['dlig', { code: 'sub f f by f_f;', automatic: false }],
                    ['salt', { code: 'sub a by a.alt;', automatic: false }]
                ]
            },
            analyzeFeatureTables: jest.fn(() => ({
                hasGSUB: true,
                hasGPOS: false
            }))
        };
        fontInfoManager.currentTab = 'features';
        fontInfoManager.featuresEditor = {
            isFocused: jest.fn(() => true),
            setValue,
            session: {
                setUseWrapMode: jest.fn()
            }
        };
        fontInfoManager.selectedItem = { type: 'feature', key: 0 };
        fontInfoManager.selectedFeatureTag = 'salt';
        fontInfoManager.featureCodeDirty = true;

        const onFontModelSync = () => fontInfoManager.onFontModelSynced();
        window.addEventListener('fontModelSync', onFontModelSync);
        try {
            window.dispatchEvent(new CustomEvent('fontModelSync'));
        } finally {
            window.removeEventListener('fontModelSync', onFontModelSync);
        }

        expect(
            [...document.querySelectorAll('.feature-tag')].map(
                (element) => element.textContent
            )
        ).toEqual(['dlig', 'salt']);
        expect(fontInfoManager.selectedItem).toEqual({
            type: 'feature',
            key: 1
        });
        expect(setValue).not.toHaveBeenCalled();
        expect(fontInfoManager.featureCodeDirty).toBe(true);
        expect(fontInfoManager.pendingModelSyncRefresh).toBe(true);
    });

    test('automatic checkbox changes go through the patch funnel', () => {
        const fontInfoManager = loadFontInfoManager();
        const codeData = { code: 'sub f i by fi;', automatic: false };
        const beginTransaction = jest.fn();
        const endTransaction = jest.fn();
        const applySyntheticChangeSet = jest.fn((_label, operations) => {
            codeData.automatic = operations[0].newValue;
        });

        window.currentFontModel = {
            features: {
                features: [['liga', codeData]]
            }
        };
        window.patchSyncEngine = {
            beginTransaction,
            endTransaction,
            applySyntheticChangeSet
        };

        document.body.innerHTML =
            '<input type="checkbox" id="feature-automatic-checkbox" checked />';
        fontInfoManager.loadAllLists = jest.fn();
        fontInfoManager.selectedItem = { type: 'feature', key: 0 };

        fontInfoManager.onAutomaticCheckboxChanged();

        expect(beginTransaction).toHaveBeenCalledWith(
            'Toggle automatic generation',
            {
                type: 'feature',
                key: 'feature:liga:1',
                label: 'liga'
            },
            expect.objectContaining({
                compileChangeSource: 'feature-code',
                compileEditType: 'feature'
            })
        );
        expect(applySyntheticChangeSet).toHaveBeenCalledWith(
            'Toggle automatic generation',
            [
                {
                    op: 'set',
                    path: ['features', 'features', 0, 1, 'automatic'],
                    oldValue: false,
                    newValue: true
                }
            ],
            expect.objectContaining({
                compileChangeSource: 'feature-code',
                compileEditType: 'feature'
            })
        );
        expect(endTransaction).toHaveBeenCalledTimes(1);
        expect(codeData.automatic).toBe(true);
        expect(fontInfoManager.loadAllLists).toHaveBeenCalledTimes(1);
    });

    test('creates a section picker and toggles search visibility by section', () => {
        document.body.innerHTML = `
                <div id="view-fontinfo" class="view view-fontinfo focused">
                    <div class="view-title-bar">
                        <div class="view-title-right">
                            <div id="fontinfo-search-control" style="display: none;">
                                <input id="fontinfo-search-input" />
                            </div>
                        </div>
                    </div>
                    <div class="view-content">
                        <div id="browser-compat"></div>
                    </div>
                </div>
            `;
        const fontInfoManager = loadFontInfoManager();

        fontInfoManager.init();
        fontInfoManager.switchTab('names');

        expect(
            document.querySelector('.fontinfo-section-button-label').textContent
        ).toBe('Names');
        expect(
            document.getElementById('fontinfo-search-control').style.display
        ).toBe('none');

        fontInfoManager.switchTab('general');

        expect(
            document.querySelector('.fontinfo-section-button-label').textContent
        ).toBe('General');
        expect(
            document.getElementById('fontinfo-search-control').style.display
        ).toBe('none');

        fontInfoManager.switchTab('custom_ot_values');

        expect(
            document.querySelector('.fontinfo-section-button-label').textContent
        ).toBe('Custom OT Values');
        expect(
            document.getElementById('fontinfo-search-control').style.display
        ).toBe('none');

        fontInfoManager.switchTab('features');

        expect(
            document.querySelector('.fontinfo-section-button-label').textContent
        ).toBe('Features');
        expect(
            document.getElementById('fontinfo-search-control').style.display
        ).toBe('');
    });

    test('bridge-backed names commits use a precise names path', () => {
        const fontInfoManager = loadFontInfoManager();
        const beginTransaction = jest.fn();
        const endTransaction = jest.fn();
        const runWithoutRecording = jest.fn((fn) => fn());
        const applySyntheticChangeSet = jest.fn();
        const applyLocalGeneratedYjsUpdate = jest.fn((_update, operations) => {
            const mastersOperation = operations.find(
                (operation) =>
                    Array.isArray(operation.path) &&
                    operation.path[0] === 'masters'
            );
            if (mastersOperation) {
                window.currentFontModel.masters = mastersOperation.newValue;
            }
        });
        const markDirty = jest.fn();
        const syncJsonFromModel = jest.fn();

        window.currentFontModel = {
            names: {
                family_name: { en: 'Old Family' }
            }
        };
        window.patchSyncEngine = {
            beginTransaction,
            endTransaction,
            applySyntheticChangeSet,
            runWithoutRecording
        };
        window.fontManager = {
            currentFont: {
                markDirty,
                syncJsonFromModel
            }
        };

        fontInfoManager.commitNameFieldValue('family_name', {
            en: 'New Family'
        });

        expect(beginTransaction).toHaveBeenCalledWith(
            'Edit font name',
            null,
            expect.objectContaining({
                compileChangeSource: 'font-info',
                compileEditType: null
            })
        );
        expect(runWithoutRecording).toHaveBeenCalledTimes(1);
        expect(applySyntheticChangeSet).toHaveBeenCalledWith('Edit font name', [
            {
                compileChangeSource: 'font-info',
                compileEditType: null,
                op: 'set',
                path: ['names', 'family_name'],
                oldValue: { en: 'Old Family' },
                newValue: { en: 'New Family' }
            }
        ]);
        expect(endTransaction).toHaveBeenCalledTimes(1);
        expect(window.currentFontModel.names.family_name).toEqual({
            en: 'New Family'
        });
        expect(markDirty).not.toHaveBeenCalled();
        expect(syncJsonFromModel).not.toHaveBeenCalled();
    });

    test('empty names fields default to dflt on commit', () => {
        document.body.innerHTML = `
                <div id="view-fontinfo" class="view view-fontinfo focused">
                    <div class="view-title-bar">
                        <div class="view-title-right">
                            <div id="fontinfo-search-control" style="display: none;">
                                <input id="fontinfo-search-input" />
                            </div>
                        </div>
                    </div>
                    <div class="view-content">
                        <div id="browser-compat"></div>
                    </div>
                </div>
            `;

        const fontInfoManager = loadFontInfoManager();
        const beginTransaction = jest.fn();
        const endTransaction = jest.fn();
        const applySyntheticChangeSet = jest.fn();
        const runWithoutRecording = jest.fn((fn) => fn());

        window.currentFontModel = {
            names: {},
            features: {
                features: []
            }
        };
        window.patchSyncEngine = {
            beginTransaction,
            endTransaction,
            applySyntheticChangeSet,
            runWithoutRecording
        };

        fontInfoManager.init();
        fontInfoManager.switchTab('names');

        const familyField = document.querySelector(
            '[data-name-field="family_name"]'
        );
        const familyInput = familyField.querySelector(
            '.localized-string-input'
        );
        const familyHelper = familyField.querySelector(
            '.localized-string-helper'
        );

        expect(familyHelper.textContent).toBe(
            'Editing Default language system (dflt).'
        );

        familyInput.focus();
        familyInput.value = 'New Family';
        familyInput.dispatchEvent(
            new KeyboardEvent('keydown', {
                key: 'Enter',
                bubbles: true
            })
        );

        expect(applySyntheticChangeSet).toHaveBeenCalledWith('Edit font name', [
            {
                compileChangeSource: 'font-info',
                compileEditType: null,
                op: 'set',
                path: ['names', 'family_name'],
                oldValue: undefined,
                newValue: { dflt: 'New Family' }
            }
        ]);
        expect(window.currentFontModel.names.family_name).toEqual({
            dflt: 'New Family'
        });
    });

    test('inline names fields commit on enter', () => {
        document.body.innerHTML = `
                <div id="view-fontinfo" class="view view-fontinfo focused">
                    <div class="view-title-bar">
                        <div class="view-title-right">
                            <div id="fontinfo-search-control" style="display: none;">
                                <input id="fontinfo-search-input" />
                            </div>
                        </div>
                    </div>
                    <div class="view-content">
                        <div id="browser-compat"></div>
                    </div>
                </div>
            `;

        const fontInfoManager = loadFontInfoManager();
        const beginTransaction = jest.fn();
        const endTransaction = jest.fn();
        const applySyntheticChangeSet = jest.fn();
        const runWithoutRecording = jest.fn((fn) => fn());

        window.currentFontModel = {
            names: {
                family_name: { en: 'Old Family' }
            },
            features: {
                features: []
            }
        };
        window.patchSyncEngine = {
            beginTransaction,
            endTransaction,
            applySyntheticChangeSet,
            runWithoutRecording
        };

        fontInfoManager.init();
        fontInfoManager.switchTab('names');

        const familyInput = document.querySelector(
            '[data-name-field="family_name"] .localized-string-input'
        );

        familyInput.focus();
        familyInput.value = 'New Family';
        familyInput.dispatchEvent(
            new KeyboardEvent('keydown', {
                key: 'Enter',
                bubbles: true
            })
        );

        expect(beginTransaction).toHaveBeenCalledWith(
            'Edit font name',
            null,
            expect.objectContaining({
                compileChangeSource: 'font-info',
                compileEditType: null
            })
        );
        expect(applySyntheticChangeSet).toHaveBeenCalledWith('Edit font name', [
            {
                compileChangeSource: 'font-info',
                compileEditType: null,
                op: 'set',
                path: ['names', 'family_name'],
                oldValue: { en: 'Old Family' },
                newValue: { en: 'New Family' }
            }
        ]);
        expect(window.currentFontModel.names.family_name).toEqual({
            en: 'New Family'
        });
    });

    test('bridge-backed root field commits use a precise root path', () => {
        const fontInfoManager = loadFontInfoManager();
        const beginTransaction = jest.fn();
        const endTransaction = jest.fn();
        const applySyntheticChangeSet = jest.fn();
        const runWithoutRecording = jest.fn((fn) => fn());
        const markDirty = jest.fn();
        const syncJsonFromModel = jest.fn();

        window.currentFontModel = {
            upm: 1000,
            version: [1, 0],
            date: new Date('2024-01-01T00:00:00Z'),
            note: 'Old note',
            names: {},
            features: {
                features: []
            }
        };
        window.patchSyncEngine = {
            beginTransaction,
            endTransaction,
            applySyntheticChangeSet,
            runWithoutRecording
        };
        window.fontManager = {
            currentFont: {
                markDirty,
                syncJsonFromModel
            }
        };

        fontInfoManager.commitRootFontFieldValue('upm', 2048);

        expect(beginTransaction).toHaveBeenCalledWith(
            'Edit font property',
            null,
            expect.objectContaining({
                compileChangeSource: 'font-info',
                compileEditType: null
            })
        );
        expect(runWithoutRecording).toHaveBeenCalledTimes(1);
        expect(applySyntheticChangeSet).toHaveBeenCalledWith(
            'Edit font property',
            [
                {
                    op: 'set',
                    path: ['upm'],
                    oldValue: 1000,
                    newValue: 2048
                }
            ],
            expect.objectContaining({
                compileChangeSource: 'font-info',
                compileEditType: null
            })
        );
        expect(endTransaction).toHaveBeenCalledTimes(1);
        expect(window.currentFontModel.upm).toBe(2048);
        expect(markDirty).not.toHaveBeenCalled();
        expect(syncJsonFromModel).not.toHaveBeenCalled();
    });

    test('bridge-less root field commits stay local without serializing the model', () => {
        const fontInfoManager = loadFontInfoManager();
        const markDirty = jest.fn();
        const syncJsonFromModel = jest.fn();

        window.currentFontModel = {
            upm: 1000,
            version: [1, 0],
            date: new Date('2024-01-01T00:00:00Z'),
            note: 'Old note',
            names: {},
            features: {
                features: []
            }
        };
        window.fontManager = {
            currentFont: {
                markDirty,
                syncJsonFromModel
            }
        };

        fontInfoManager.commitRootFontFieldValue('upm', 2048);

        expect(window.currentFontModel.upm).toBe(2048);
        expect(markDirty).toHaveBeenCalledWith('font-info-root');
        expect(syncJsonFromModel).not.toHaveBeenCalled();
    });

    test('created now button stamps the current date through the root patch path', () => {
        jest.setSystemTime(new Date('2026-05-20T12:34:56Z'));

        document.body.innerHTML = `
                <div id="view-fontinfo" class="view view-fontinfo focused">
                    <div class="view-title-bar">
                        <div class="view-title-right">
                            <div id="fontinfo-search-control" style="display: none;">
                                <input id="fontinfo-search-input" />
                            </div>
                        </div>
                    </div>
                    <div class="view-content">
                        <div id="browser-compat"></div>
                    </div>
                </div>
            `;

        const fontInfoManager = loadFontInfoManager();
        const beginTransaction = jest.fn();
        const endTransaction = jest.fn();
        const applySyntheticChangeSet = jest.fn();
        const runWithoutRecording = jest.fn((fn) => fn());

        window.currentFontModel = {
            upm: 1000,
            version: [1, 0],
            date: new Date('2024-01-01T00:00:00Z'),
            names: {},
            features: {
                features: []
            }
        };
        window.patchSyncEngine = {
            beginTransaction,
            endTransaction,
            applySyntheticChangeSet,
            runWithoutRecording
        };

        fontInfoManager.init();
        jest.runOnlyPendingTimers();
        fontInfoManager.switchTab('general');

        const nowButton = Array.from(
            document.querySelectorAll('[data-font-field="date"] button')
        ).find((button) => button.textContent === 'Now');

        nowButton.click();

        expect(beginTransaction).toHaveBeenCalledWith(
            'Edit font property',
            null,
            expect.objectContaining({
                compileChangeSource: 'font-info',
                compileEditType: null
            })
        );
        const operations = applySyntheticChangeSet.mock.calls[0][1];
        expect(operations[0].path).toEqual(['date']);
        expect(operations[0].newValue).toBeInstanceOf(Date);
        expect(operations[0].newValue.getTime()).toBeGreaterThanOrEqual(
            new Date('2026-05-20T12:34:56Z').getTime()
        );
        expect(operations[0].newValue.getTime()).toBeLessThan(
            new Date('2026-05-20T12:34:57Z').getTime()
        );
    });

    test('bridge-backed custom OT commits use a precise nested path', () => {
        const fontInfoManager = loadFontInfoManager();
        const beginTransaction = jest.fn();
        const endTransaction = jest.fn();
        const applySyntheticChangeSet = jest.fn();
        const runWithoutRecording = jest.fn((fn) => fn());

        window.currentFontModel = {
            upm: 1000,
            version: [1, 0],
            date: new Date('2024-01-01T00:00:00Z'),
            names: {},
            features: {
                features: []
            },
            custom_ot_values: {
                os2_vendor_id: 'ABCD'
            }
        };
        window.patchSyncEngine = {
            beginTransaction,
            endTransaction,
            applySyntheticChangeSet,
            runWithoutRecording
        };

        fontInfoManager.commitCustomOTValue('os2_vendor_id', 'WXYZ');

        expect(beginTransaction).toHaveBeenCalledWith(
            'Edit custom OpenType value',
            null,
            expect.objectContaining({
                compileChangeSource: 'font-info',
                compileEditType: null
            })
        );
        expect(applySyntheticChangeSet).toHaveBeenCalledWith(
            'Edit custom OpenType value',
            [
                {
                    compileChangeSource: 'font-info',
                    compileEditType: null,
                    op: 'set',
                    path: ['custom_ot_values', 'os2_vendor_id'],
                    oldValue: 'ABCD',
                    newValue: 'WXYZ'
                }
            ],
            expect.objectContaining({
                compileChangeSource: 'font-info',
                compileEditType: null
            })
        );
        expect(endTransaction).toHaveBeenCalledTimes(1);
        expect(window.currentFontModel.custom_ot_values.os2_vendor_id).toBe(
            'WXYZ'
        );
    });

    test('custom OT panel omits the empty-state line and shows richer hints', () => {
        document.body.innerHTML = `
                <div id="view-fontinfo" class="view view-fontinfo focused">
                    <div class="view-title-bar">
                        <div class="view-title-right">
                            <div id="fontinfo-search-control" style="display: none;">
                                <input id="fontinfo-search-input" />
                            </div>
                        </div>
                    </div>
                    <div class="view-content">
                        <div id="browser-compat"></div>
                    </div>
                </div>
            `;

        window.currentFontModel = {
            upm: 1000,
            version: [1, 0],
            date: new Date('2024-01-01T00:00:00Z'),
            names: {},
            features: {
                features: []
            }
        };

        const fontInfoManager = loadFontInfoManager();
        fontInfoManager.init();
        jest.runOnlyPendingTimers();
        fontInfoManager.switchTab('custom_ot_values');

        expect(document.body.textContent).not.toContain(
            'No custom OpenType overrides are set yet.'
        );

        const vendorField = document.querySelector(
            '[data-font-field="custom_ot_values.os2_vendor_id"] .localized-string-input'
        );
        const vendorHelper = document.querySelector(
            '[data-font-field="custom_ot_values.os2_vendor_id"] .localized-string-helper'
        );

        expect(vendorField.placeholder).toBe(
            'Four-character vendor code, e.g. ABCD'
        );
        expect(vendorHelper.textContent).toContain('four-character vendor');
    });

    test('names UI shows language names with OpenType tags', () => {
        document.body.innerHTML = `
                <div id="view-fontinfo" class="view view-fontinfo focused">
                    <div class="view-title-bar">
                        <div class="view-title-right">
                            <div id="fontinfo-search-control" style="display: none;">
                                <input id="fontinfo-search-input" />
                            </div>
                        </div>
                    </div>
                    <div class="view-content">
                        <div id="browser-compat"></div>
                    </div>
                </div>
            `;

        window.currentFontModel = {
            names: {
                family_name: { en: 'Legacy Family' }
            },
            features: {
                features: []
            }
        };

        const fontInfoManager = loadFontInfoManager();
        fontInfoManager.init();
        fontInfoManager.switchTab('names');

        const familyField = document.querySelector(
            '[data-name-field="family_name"]'
        );
        const familyHelper = familyField.querySelector(
            '.localized-string-helper'
        );
        const localesButton = familyField.querySelector(
            '.localized-string-locales-button'
        );

        expect(familyHelper.textContent).toBe(
            'Editing English (ENG) because Default language system (dflt) is not defined.'
        );

        localesButton.click();

        const localeRowLabel = document.querySelector(
            '.localized-string-modal-locale'
        );
        const localeSelect = document.querySelector(
            '.localized-string-locale-select'
        );
        const germanOption = Array.from(localeSelect.options).find(
            (option) => option.value === 'DEU'
        );

        expect(localeRowLabel.textContent).toBe('English (ENG)');
        expect(localeSelect.options[0].textContent).toBe(
            'Default language system (dflt)'
        );
        expect(germanOption?.textContent).toBe('German (DEU)');
    });

    test('fontModelSync rebuilds names when active and defers while inactive', () => {
        document.body.innerHTML = `
                <div id="view-fontinfo" class="view view-fontinfo focused">
                    <div class="view-title-bar">
                        <div class="view-title-right">
                            <div id="fontinfo-search-control" style="display: none;">
                                <input id="fontinfo-search-input" />
                            </div>
                        </div>
                    </div>
                    <div class="view-content">
                        <div id="browser-compat"></div>
                    </div>
                </div>
            `;

        window.currentFontModel = {
            names: {
                family_name: { en: 'First Family' }
            },
            features: {
                features: []
            }
        };

        const fontInfoManager = loadFontInfoManager();
        fontInfoManager.init();
        fontInfoManager.switchTab('names');

        let familyInput = document.querySelector(
            '[data-name-field="family_name"] .localized-string-input'
        );
        expect(familyInput.value).toBe('First Family');

        window.currentFontModel.names.family_name = { en: 'Second Family' };
        window.dispatchEvent(new CustomEvent('fontModelSync'));
        jest.runOnlyPendingTimers();

        familyInput = document.querySelector(
            '[data-name-field="family_name"] .localized-string-input'
        );
        expect(familyInput.value).toBe('Second Family');

        fontInfoManager.switchTab('features');
        window.currentFontModel.names.family_name = { en: 'Third Family' };
        window.dispatchEvent(new CustomEvent('fontModelSync'));
        jest.runOnlyPendingTimers();

        fontInfoManager.switchTab('names');

        familyInput = document.querySelector(
            '[data-name-field="family_name"] .localized-string-input'
        );
        expect(familyInput.value).toBe('Third Family');
    });

    test('fontModelSync rebuilds general and custom OT panels when active', () => {
        document.body.innerHTML = `
                <div id="view-fontinfo" class="view view-fontinfo focused">
                    <div class="view-title-bar">
                        <div class="view-title-right">
                            <div id="fontinfo-search-control" style="display: none;">
                                <input id="fontinfo-search-input" />
                            </div>
                        </div>
                    </div>
                    <div class="view-content">
                        <div id="browser-compat"></div>
                    </div>
                </div>
            `;

        window.currentFontModel = {
            upm: 1000,
            version: [1, 0],
            date: new Date('2024-01-01T00:00:00Z'),
            note: 'First note',
            names: {},
            features: {
                features: []
            },
            custom_ot_values: {
                os2_vendor_id: 'ABCD'
            }
        };

        const fontInfoManager = loadFontInfoManager();
        fontInfoManager.init();
        jest.runOnlyPendingTimers();
        fontInfoManager.switchTab('general');

        let noteField = document.querySelector(
            '[data-font-field="note"] .localized-string-input'
        );
        expect(noteField.value).toBe('First note');

        window.currentFontModel.note = 'Second note';
        window.dispatchEvent(new CustomEvent('fontModelSync'));
        jest.runOnlyPendingTimers();

        noteField = document.querySelector(
            '[data-font-field="note"] .localized-string-input'
        );
        expect(noteField.value).toBe('Second note');

        fontInfoManager.switchTab('custom_ot_values');

        let vendorField = document.querySelector(
            '[data-font-field="custom_ot_values.os2_vendor_id"] .localized-string-input'
        );
        expect(vendorField.value).toBe('ABCD');

        window.currentFontModel.custom_ot_values.os2_vendor_id = 'WXYZ';
        window.dispatchEvent(new CustomEvent('fontModelSync'));
        jest.runOnlyPendingTimers();

        vendorField = document.querySelector(
            '[data-font-field="custom_ot_values.os2_vendor_id"] .localized-string-input'
        );
        expect(vendorField.value).toBe('WXYZ');
    });

    test('masters and instances panes hide internal ids, omit repeated panels, and commit precise nested paths', () => {
        document.body.innerHTML = `
                <div id="view-fontinfo" class="view view-fontinfo focused">
                    <div class="view-title-bar">
                        <div class="view-title-right">
                            <div id="fontinfo-search-control" style="display: none;">
                                <input id="fontinfo-search-input" />
                            </div>
                        </div>
                    </div>
                    <div class="view-content">
                        <div id="browser-compat"></div>
                    </div>
                </div>
            `;

        const fontInfoManager = loadFontInfoManager();
        const beginTransaction = jest.fn();
        const endTransaction = jest.fn();
        const applySyntheticChangeSet = jest.fn();
        const runWithoutRecording = jest.fn((fn) => fn());

        window.currentFontModel = {
            axes: [
                {
                    name: { dflt: 'Weight' },
                    tag: 'wght',
                    min: 100,
                    default: 400,
                    max: 900
                }
            ],
            names: {},
            features: {
                features: []
            },
            masters: [
                {
                    id: 'M1',
                    name: { dflt: 'Regular' },
                    location: { wght: 400 },
                    metrics: { ascender: 800 },
                    custom_ot_values: {
                        os2_vendor_id: 'ABCD'
                    }
                }
            ],
            instances: [
                {
                    id: 'I1',
                    name: { dflt: 'Regular' },
                    location: { wght: 400 },
                    custom_names: {
                        family_name: { dflt: 'Static Family' }
                    },
                    linked_style: 'Bold'
                }
            ]
        };
        window.patchSyncEngine = {
            beginTransaction,
            endTransaction,
            applySyntheticChangeSet,
            runWithoutRecording
        };

        fontInfoManager.init();
        jest.runOnlyPendingTimers();

        fontInfoManager.switchTab('masters');

        const masterSidebarText = document.querySelector(
            '.fontinfo-record-item-secondary'
        );
        expect(masterSidebarText.textContent).toBe('wght:400/400');
        expect(
            document.querySelector('[data-font-field="masters.0.id"]')
        ).toBeNull();
        expect(
            document.querySelector(
                '[data-font-field="masters.0.custom_ot_values.os2_vendor_id"]'
            )
        ).toBeNull();

        const masterMetricInput = document.querySelector(
            '[data-font-field="masters.0.metrics.ascender"] .localized-string-input'
        );
        masterMetricInput.focus();
        masterMetricInput.value = '825';
        masterMetricInput.dispatchEvent(
            new KeyboardEvent('keydown', {
                key: 'Enter',
                bubbles: true
            })
        );

        expect(applySyntheticChangeSet).toHaveBeenCalledWith(
            'Edit master metric',
            [
                {
                    op: 'set',
                    path: ['masters', 0, 'metrics', 'ascender'],
                    oldValue: 800,
                    newValue: 825
                }
            ],
            expect.objectContaining({
                compileChangeSource: 'font-info',
                compileEditType: null
            })
        );

        fontInfoManager.switchTab('instances');

        expect(
            document.querySelector('[data-font-field="instances.0.id"]')
        ).toBeNull();
        expect(
            document.querySelector(
                '[data-font-field="instances.0.custom_names.family_name"]'
            )
        ).toBeNull();

        const linkedStyleInput = document.querySelector(
            '[data-font-field="instances.0.linked_style"] .localized-string-input'
        );
        linkedStyleInput.focus();
        linkedStyleInput.value = 'Black';
        linkedStyleInput.dispatchEvent(
            new KeyboardEvent('keydown', {
                key: 'Enter',
                bubbles: true
            })
        );

        expect(applySyntheticChangeSet).toHaveBeenCalledWith(
            'Edit instance field',
            [
                {
                    op: 'set',
                    path: ['instances', 0, 'linked_style'],
                    oldValue: 'Bold',
                    newValue: 'Black'
                }
            ],
            expect.objectContaining({
                compileChangeSource: 'font-info',
                compileEditType: null
            })
        );
    });

    test('fontModelSync rebuilds masters and instances panels when active', () => {
        document.body.innerHTML = `
                <div id="view-fontinfo" class="view view-fontinfo focused">
                    <div class="view-title-bar">
                        <div class="view-title-right">
                            <div id="fontinfo-search-control" style="display: none;">
                                <input id="fontinfo-search-input" />
                            </div>
                        </div>
                    </div>
                    <div class="view-content">
                        <div id="browser-compat"></div>
                    </div>
                </div>
            `;

        window.currentFontModel = {
            axes: [
                {
                    name: { dflt: 'Weight' },
                    tag: 'wght',
                    min: 100,
                    default: 400,
                    max: 900
                }
            ],
            names: {},
            features: {
                features: []
            },
            masters: [
                {
                    id: 'M1',
                    name: { dflt: 'Regular' },
                    location: { wght: 400 },
                    metrics: { ascender: 800 }
                }
            ],
            instances: [
                {
                    id: 'I1',
                    name: { dflt: 'Regular' },
                    location: { wght: 400 },
                    custom_names: {},
                    linked_style: 'Bold'
                }
            ]
        };

        const fontInfoManager = loadFontInfoManager();
        fontInfoManager.init();
        jest.runOnlyPendingTimers();

        fontInfoManager.switchTab('masters');

        let masterMetricInput = document.querySelector(
            '[data-font-field="masters.0.metrics.ascender"] .localized-string-input'
        );
        expect(masterMetricInput.value).toBe('800');

        window.currentFontModel.masters[0].metrics.ascender = 825;
        window.dispatchEvent(new CustomEvent('fontModelSync'));
        jest.runOnlyPendingTimers();

        masterMetricInput = document.querySelector(
            '[data-font-field="masters.0.metrics.ascender"] .localized-string-input'
        );
        expect(masterMetricInput.value).toBe('825');

        fontInfoManager.switchTab('instances');

        let linkedStyleInput = document.querySelector(
            '[data-font-field="instances.0.linked_style"] .localized-string-input'
        );
        expect(linkedStyleInput.value).toBe('Bold');

        window.currentFontModel.instances[0].linked_style = 'Black';
        window.dispatchEvent(new CustomEvent('fontModelSync'));
        jest.runOnlyPendingTimers();

        linkedStyleInput = document.querySelector(
            '[data-font-field="instances.0.linked_style"] .localized-string-input'
        );
        expect(linkedStyleInput.value).toBe('Black');
    });

    test('masters and instances sidebars use dedicated split panes and editor-style lists', () => {
        document.body.innerHTML = `
                <div id="view-fontinfo" class="view view-fontinfo focused">
                    <div class="view-title-bar">
                        <div class="view-title-right">
                            <div id="fontinfo-search-control" style="display: none;">
                                <input id="fontinfo-search-input" />
                            </div>
                        </div>
                    </div>
                    <div class="view-content">
                        <div id="browser-compat"></div>
                    </div>
                </div>
            `;

        window.currentFontModel = {
            axes: [
                {
                    name: { dflt: 'Weight' },
                    tag: 'wght',
                    min: 100,
                    default: 400,
                    max: 900
                }
            ],
            names: {},
            features: {
                features: []
            },
            masters: [
                {
                    id: 'M1',
                    name: { dflt: 'Regular' },
                    location: { wght: 400 },
                    metrics: { ascender: 800 }
                }
            ],
            instances: [
                {
                    id: 'I1',
                    name: { dflt: 'Regular' },
                    location: { wght: 400 },
                    custom_names: {},
                    linked_style: 'Bold'
                }
            ]
        };

        const fontInfoManager = loadFontInfoManager();
        fontInfoManager.init();
        jest.runOnlyPendingTimers();

        fontInfoManager.switchTab('masters');
        const masterPane = document.getElementById('fontinfo-masters-fields');
        const masterSidebar = document.querySelector(
            '#fontinfo-masters-content .fontinfo-records-sidebar'
        );
        const masterList = document.querySelector(
            '#fontinfo-masters-content .fontinfo-records-list'
        );
        const masterItem = document.querySelector(
            '#fontinfo-masters-content .fontinfo-record-item'
        );
        expect(masterPane.classList.contains('fontinfo-records-pane')).toBe(
            true
        );
        expect(masterSidebar.classList.contains('features-sidebar')).toBe(
            false
        );
        expect(masterList.classList.contains('editor-layers-list')).toBe(true);
        expect(masterItem.classList.contains('editor-layer-item')).toBe(true);

        fontInfoManager.switchTab('instances');
        const instancePane = document.getElementById(
            'fontinfo-instances-fields'
        );
        const instanceSidebar = document.querySelector(
            '#fontinfo-instances-content .fontinfo-records-sidebar'
        );
        const instanceList = document.querySelector(
            '#fontinfo-instances-content .fontinfo-records-list'
        );
        const instanceItem = document.querySelector(
            '#fontinfo-instances-content .fontinfo-record-item'
        );
        expect(instancePane.classList.contains('fontinfo-records-pane')).toBe(
            true
        );
        expect(instanceSidebar.classList.contains('features-sidebar')).toBe(
            false
        );
        expect(instanceList.classList.contains('editor-layers-list')).toBe(
            true
        );
        expect(instanceItem.classList.contains('editor-layer-item')).toBe(true);
    });

    test('masters list controls add, remove, and reorder through the patch funnel', async () => {
        document.body.innerHTML = `
                <div id="view-fontinfo" class="view view-fontinfo focused">
                    <div class="view-title-bar">
                        <div class="view-title-right">
                            <div id="fontinfo-search-control" style="display: none;">
                                <input id="fontinfo-search-input" />
                            </div>
                        </div>
                    </div>
                    <div class="view-content">
                        <div id="browser-compat"></div>
                    </div>
                </div>
            `;

        const fontInfoManager = loadFontInfoManager();
        const beginTransaction = jest.fn();
        const endTransaction = jest.fn();
        const updatePropertiesUI = jest.fn().mockResolvedValue(undefined);
        const applySyntheticChangeSet = jest.fn((_label, operations) => {
            const mastersOperation = operations.find(
                (operation) =>
                    Array.isArray(operation.path) &&
                    operation.path[0] === 'masters'
            );
            if (mastersOperation) {
                window.currentFontModel.masters = mastersOperation.newValue;
            }
        });
        const addMaster = jest.fn(async function () {
            const createdMaster = {
                id: 'master-3',
                name: { dflt: 'Master 3' },
                location: { wght: 400 },
                metrics: { ascender: 820 },
                kerning: {}
            };
            this.masters = [...this.masters, createdMaster];
            return createdMaster;
        });
        const removeMastersByIds = jest.fn(async function (masterIds) {
            this.masters = this.masters.filter(
                (master) => !masterIds.includes(master.id)
            );
            return true;
        });

        window.currentFontModel = {
            axes: [
                {
                    name: { dflt: 'Weight' },
                    tag: 'wght',
                    min: 100,
                    default: 400,
                    max: 900
                }
            ],
            names: {},
            features: {
                features: []
            },
            masters: [
                {
                    id: 'M1',
                    name: { dflt: 'Regular' },
                    location: { wght: 400 },
                    metrics: { ascender: 800 },
                    kerning: {}
                },
                {
                    id: 'M2',
                    name: { dflt: 'Bold' },
                    location: { wght: 700 },
                    metrics: { ascender: 820 },
                    kerning: {}
                }
            ],
            addMaster,
            removeMastersByIds
        };
        window.patchSyncEngine = {
            beginTransaction,
            endTransaction,
            applySyntheticChangeSet
        };
        window.glyphCanvas = {
            ...window.glyphCanvas,
            updatePropertiesUI
        };

        fontInfoManager.init();
        jest.runOnlyPendingTimers();
        fontInfoManager.switchTab('masters');

        const selectedMasterItems = document.querySelectorAll(
            '#fontinfo-masters-content .fontinfo-record-item'
        );
        selectedMasterItems[1].click();

        const addMasterButton = document.querySelector(
            '[data-fontinfo-list-action="masters-add"]'
        );
        addMasterButton.focus();
        addMasterButton.click();

        const modal = document.querySelector('.fontinfo-master-location-modal');
        expect(modal).toBeTruthy();
        const createButton = modal.querySelector(
            '.fontinfo-master-location-create'
        );
        createButton.click();
        await Promise.resolve();
        await Promise.resolve();
        jest.runOnlyPendingTimers();
        await Promise.resolve();

        expect(addMaster).toHaveBeenCalledWith(
            undefined,
            expect.objectContaining({
                metricTemplateMasterId: 'M2',
                location: { wght: 700 }
            })
        );
        expect(window.currentFontModel.masters).toHaveLength(3);

        const removeMasterButton = document.querySelector(
            '[data-fontinfo-list-action="masters-remove"]'
        );
        removeMasterButton.focus();
        fontInfoManager.setDeleteConfirmationHandler(true);
        removeMasterButton.click();

        await Promise.resolve();

        expect(removeMastersByIds).toHaveBeenCalledWith(['master-3']);
        expect(window.currentFontModel.masters).toHaveLength(2);

        const masterItems = document.querySelectorAll(
            '#fontinfo-masters-content .fontinfo-record-item'
        );
        masterItems[1].focus();
        masterItems[0].getBoundingClientRect = () => ({
            top: 0,
            height: 20
        });
        fontInfoManager.onMasterDragStart(
            {
                currentTarget: masterItems[1],
                dataTransfer: {}
            },
            1
        );
        fontInfoManager.onMasterDragOver(
            {
                preventDefault: jest.fn(),
                currentTarget: masterItems[0],
                dataTransfer: {},
                clientY: 0
            },
            0
        );
        expect(
            masterItems[0].classList.contains('feature-drop-target-before')
        ).toBe(true);
        fontInfoManager.onMasterDrop(
            {
                preventDefault: jest.fn()
            },
            0
        );

        expect(applySyntheticChangeSet).toHaveBeenCalledWith(
            'Reorder masters',
            [
                {
                    op: 'set',
                    path: ['masters'],
                    oldValue: expect.any(Array),
                    newValue: [
                        expect.objectContaining({ id: 'M2' }),
                        expect.objectContaining({ id: 'M1' })
                    ]
                }
            ],
            expect.objectContaining({
                compileChangeSource: 'font-info',
                compileEditType: null
            })
        );
        expect(updatePropertiesUI).toHaveBeenCalledWith({
            skipAutoSelectMatchingLayer: true
        });
        expect(
            document.querySelector(
                '#fontinfo-masters-content .fontinfo-record-item-primary'
            ).textContent
        ).toBe('Bold');
    });

    test('masters reorder rebuilds the visible list while a detail input remains focused', () => {
        document.body.innerHTML = `
                <div id="view-fontinfo" class="view view-fontinfo focused">
                    <div class="view-title-bar">
                        <div class="view-title-right">
                            <div id="fontinfo-search-control" style="display: none;">
                                <input id="fontinfo-search-input" />
                            </div>
                        </div>
                    </div>
                    <div class="view-content">
                        <div id="browser-compat"></div>
                    </div>
                </div>
            `;

        const fontInfoManager = loadFontInfoManager();
        const beginTransaction = jest.fn();
        const endTransaction = jest.fn();
        const applySyntheticChangeSet = jest.fn();
        const runWithoutRecording = jest.fn((fn) => fn());

        window.currentFontModel = {
            axes: [
                {
                    name: { dflt: 'Weight' },
                    tag: 'wght',
                    min: 100,
                    default: 400,
                    max: 900
                }
            ],
            names: {},
            features: {
                features: []
            },
            masters: [
                {
                    id: 'M1',
                    name: { dflt: 'Regular' },
                    location: { wght: 400 },
                    metrics: { ascender: 800 },
                    kerning: {}
                },
                {
                    id: 'M2',
                    name: { dflt: 'Bold' },
                    location: { wght: 700 },
                    metrics: { ascender: 820 },
                    kerning: {}
                }
            ]
        };
        window.patchSyncEngine = {
            beginTransaction,
            endTransaction,
            applySyntheticChangeSet,
            runWithoutRecording
        };

        fontInfoManager.init();
        jest.runOnlyPendingTimers();
        fontInfoManager.switchTab('masters');

        const masterMetricInput = document.querySelector(
            '[data-font-field="masters.0.metrics.ascender"] .localized-string-input'
        );
        masterMetricInput.focus();

        const masterItems = document.querySelectorAll(
            '#fontinfo-masters-content .fontinfo-record-item'
        );
        masterItems[0].getBoundingClientRect = () => ({
            top: 0,
            height: 20
        });

        fontInfoManager.onMasterDragStart(
            {
                currentTarget: masterItems[1],
                dataTransfer: {}
            },
            1
        );
        fontInfoManager.onMasterDragOver(
            {
                preventDefault: jest.fn(),
                currentTarget: masterItems[0],
                dataTransfer: {},
                clientY: 0
            },
            0
        );
        fontInfoManager.onMasterDrop(
            {
                preventDefault: jest.fn()
            },
            0
        );

        const reorderedItems = document.querySelectorAll(
            '#fontinfo-masters-content .fontinfo-record-item-primary'
        );
        expect(reorderedItems[0].textContent).toBe('Bold');
        expect(reorderedItems[1].textContent).toBe('Regular');
    });

    test('masters reorder commits from dragend when drop is not delivered', () => {
        document.body.innerHTML = `
                <div id="view-fontinfo" class="view view-fontinfo focused">
                    <div class="view-title-bar">
                        <div class="view-title-right">
                            <div id="fontinfo-search-control" style="display: none;">
                                <input id="fontinfo-search-input" />
                            </div>
                        </div>
                    </div>
                    <div class="view-content">
                        <div id="browser-compat"></div>
                    </div>
                </div>
            `;

        const fontInfoManager = loadFontInfoManager();
        const beginTransaction = jest.fn();
        const endTransaction = jest.fn();
        const applySyntheticChangeSet = jest.fn();
        const runWithoutRecording = jest.fn((fn) => fn());

        window.currentFontModel = {
            axes: [
                {
                    name: { dflt: 'Weight' },
                    tag: 'wght',
                    min: 100,
                    default: 400,
                    max: 900
                }
            ],
            names: {},
            features: {
                features: []
            },
            masters: [
                {
                    id: 'M1',
                    name: { dflt: 'Regular' },
                    location: { wght: 400 },
                    metrics: { ascender: 800 },
                    kerning: {}
                },
                {
                    id: 'M2',
                    name: { dflt: 'Bold' },
                    location: { wght: 700 },
                    metrics: { ascender: 820 },
                    kerning: {}
                }
            ]
        };
        window.patchSyncEngine = {
            beginTransaction,
            endTransaction,
            applySyntheticChangeSet,
            runWithoutRecording
        };

        fontInfoManager.init();
        jest.runOnlyPendingTimers();
        fontInfoManager.switchTab('masters');

        const masterItems = document.querySelectorAll(
            '#fontinfo-masters-content .fontinfo-record-item'
        );
        masterItems[0].getBoundingClientRect = () => ({
            top: 0,
            height: 20
        });

        fontInfoManager.onMasterDragStart(
            {
                currentTarget: masterItems[1],
                dataTransfer: {
                    effectAllowed: 'all',
                    setData: jest.fn()
                }
            },
            1
        );
        fontInfoManager.onMasterDragOver(
            {
                preventDefault: jest.fn(),
                currentTarget: masterItems[0],
                dataTransfer: {},
                clientY: 0
            },
            0
        );
        fontInfoManager.onMasterDragEnd();

        expect(applySyntheticChangeSet).toHaveBeenCalledWith(
            'Reorder masters',
            [
                {
                    op: 'set',
                    path: ['masters'],
                    oldValue: expect.any(Array),
                    newValue: [
                        expect.objectContaining({ id: 'M2' }),
                        expect.objectContaining({ id: 'M1' })
                    ]
                }
            ],
            expect.objectContaining({
                compileChangeSource: 'font-info',
                compileEditType: null
            })
        );
    });

    test('instances list controls add, remove, and reorder through the patch funnel', () => {
        document.body.innerHTML = `
                <div id="view-fontinfo" class="view view-fontinfo focused">
                    <div class="view-title-bar">
                        <div class="view-title-right">
                            <div id="fontinfo-search-control" style="display: none;">
                                <input id="fontinfo-search-input" />
                            </div>
                        </div>
                    </div>
                    <div class="view-content">
                        <div id="browser-compat"></div>
                    </div>
                </div>
            `;

        const fontInfoManager = loadFontInfoManager();
        const beginTransaction = jest.fn();
        const endTransaction = jest.fn();
        const applySyntheticChangeSet = jest.fn();
        const runWithoutRecording = jest.fn((fn) => fn());

        window.currentFontModel = {
            axes: [
                {
                    name: { dflt: 'Weight' },
                    tag: 'wght',
                    min: 100,
                    default: 400,
                    max: 900
                }
            ],
            names: {},
            features: {
                features: []
            },
            instances: [
                {
                    id: 'I1',
                    name: { dflt: 'Regular' },
                    location: { wght: 400 },
                    custom_names: {},
                    linked_style: 'Bold'
                },
                {
                    id: 'I2',
                    name: { dflt: 'Bold' },
                    location: { wght: 700 },
                    custom_names: {},
                    linked_style: 'Regular'
                }
            ]
        };
        window.patchSyncEngine = {
            beginTransaction,
            endTransaction,
            applySyntheticChangeSet,
            runWithoutRecording
        };

        fontInfoManager.init();
        jest.runOnlyPendingTimers();
        fontInfoManager.switchTab('instances');

        const addInstanceButton = document.querySelector(
            '[data-fontinfo-list-action="instances-add"]'
        );
        addInstanceButton.focus();
        addInstanceButton.click();

        expect(applySyntheticChangeSet).toHaveBeenCalledWith(
            'Add instance',
            [
                {
                    op: 'set',
                    path: ['instances'],
                    oldValue: expect.any(Array),
                    newValue: expect.arrayContaining([
                        expect.objectContaining({
                            name: { dflt: 'Instance 3' }
                        })
                    ])
                }
            ],
            expect.objectContaining({
                compileChangeSource: 'font-info',
                compileEditType: null
            })
        );
        expect(
            document.querySelectorAll(
                '#fontinfo-instances-content .fontinfo-record-item'
            )
        ).toHaveLength(3);

        const removeInstanceButton = document.querySelector(
            '[data-fontinfo-list-action="instances-remove"]'
        );
        removeInstanceButton.focus();
        fontInfoManager.setDeleteConfirmationHandler(true);
        removeInstanceButton.click();

        expect(applySyntheticChangeSet).toHaveBeenCalledWith(
            'Remove instance',
            [
                {
                    op: 'set',
                    path: ['instances'],
                    oldValue: expect.any(Array),
                    newValue: expect.arrayContaining([
                        expect.objectContaining({ id: 'I1' }),
                        expect.objectContaining({ id: 'I2' })
                    ])
                }
            ],
            expect.objectContaining({
                compileChangeSource: 'font-info',
                compileEditType: null
            })
        );
        expect(
            document.querySelectorAll(
                '#fontinfo-instances-content .fontinfo-record-item'
            )
        ).toHaveLength(2);

        const instanceItems = document.querySelectorAll(
            '#fontinfo-instances-content .fontinfo-record-item'
        );
        instanceItems[1].focus();
        instanceItems[0].getBoundingClientRect = () => ({
            top: 0,
            height: 20
        });
        fontInfoManager.onInstanceDragStart(
            {
                currentTarget: instanceItems[1],
                dataTransfer: {}
            },
            1
        );
        fontInfoManager.onInstanceDragOver(
            {
                preventDefault: jest.fn(),
                currentTarget: instanceItems[0],
                dataTransfer: {},
                clientY: 0
            },
            0
        );
        expect(
            instanceItems[0].classList.contains('feature-drop-target-before')
        ).toBe(true);
        fontInfoManager.onInstanceDrop(
            {
                preventDefault: jest.fn()
            },
            0
        );

        expect(applySyntheticChangeSet).toHaveBeenCalledWith(
            'Reorder instances',
            [
                {
                    op: 'set',
                    path: ['instances'],
                    oldValue: expect.any(Array),
                    newValue: [
                        expect.objectContaining({ id: 'I2' }),
                        expect.objectContaining({ id: 'I1' })
                    ]
                }
            ],
            expect.objectContaining({
                compileChangeSource: 'font-info',
                compileEditType: null
            })
        );
        expect(
            document.querySelector(
                '#fontinfo-instances-content .fontinfo-record-item-primary'
            ).textContent
        ).toBe('Bold');
    });

    test('visible masters and instances lists rebuild on fontModelSync structural changes', () => {
        document.body.innerHTML = `
                <div id="view-fontinfo" class="view view-fontinfo focused">
                    <div class="view-title-bar">
                        <div class="view-title-right">
                            <div id="fontinfo-search-control" style="display: none;">
                                <input id="fontinfo-search-input" />
                            </div>
                        </div>
                    </div>
                    <div class="view-content">
                        <div id="browser-compat"></div>
                    </div>
                </div>
            `;

        window.currentFontModel = {
            axes: [
                {
                    name: { dflt: 'Weight' },
                    tag: 'wght',
                    min: 100,
                    default: 400,
                    max: 900
                }
            ],
            names: {},
            features: {
                features: []
            },
            masters: [
                {
                    id: 'M1',
                    name: { dflt: 'Regular' },
                    location: { wght: 400 },
                    metrics: { ascender: 800 }
                },
                {
                    id: 'M2',
                    name: { dflt: 'Bold' },
                    location: { wght: 700 },
                    metrics: { ascender: 820 }
                }
            ],
            instances: [
                {
                    id: 'I1',
                    name: { dflt: 'Regular' },
                    location: { wght: 400 },
                    custom_names: {},
                    linked_style: 'Bold'
                },
                {
                    id: 'I2',
                    name: { dflt: 'Bold' },
                    location: { wght: 700 },
                    custom_names: {},
                    linked_style: 'Regular'
                }
            ]
        };

        const fontInfoManager = loadFontInfoManager();
        fontInfoManager.init();
        jest.runOnlyPendingTimers();

        fontInfoManager.switchTab('masters');
        const masterMetricInput = document.querySelector(
            '[data-font-field="masters.0.metrics.ascender"] .localized-string-input'
        );
        masterMetricInput.focus();

        window.currentFontModel.masters = [
            window.currentFontModel.masters[1],
            window.currentFontModel.masters[0]
        ];
        window.dispatchEvent(new CustomEvent('fontModelSync'));
        jest.runOnlyPendingTimers();

        let reorderedMasterItems = document.querySelectorAll(
            '#fontinfo-masters-content .fontinfo-record-item-primary'
        );
        expect(reorderedMasterItems[0].textContent).toBe('Bold');
        expect(reorderedMasterItems[1].textContent).toBe('Regular');

        fontInfoManager.switchTab('instances');
        const instanceNameInput = document.querySelector(
            '[data-font-field="instances.0.name"] .localized-string-input'
        );
        instanceNameInput.focus();

        window.currentFontModel.instances = [
            window.currentFontModel.instances[1],
            window.currentFontModel.instances[0]
        ];
        window.dispatchEvent(new CustomEvent('fontModelSync'));
        jest.runOnlyPendingTimers();

        const reorderedInstanceItems = document.querySelectorAll(
            '#fontinfo-instances-content .fontinfo-record-item-primary'
        );
        expect(reorderedInstanceItems[0].textContent).toBe('Bold');
        expect(reorderedInstanceItems[1].textContent).toBe('Regular');
    });

    test('instances reorder commits from dragend when drop is not delivered', () => {
        document.body.innerHTML = `
                <div id="view-fontinfo" class="view view-fontinfo focused">
                    <div class="view-title-bar">
                        <div class="view-title-right">
                            <div id="fontinfo-search-control" style="display: none;">
                                <input id="fontinfo-search-input" />
                            </div>
                        </div>
                    </div>
                    <div class="view-content">
                        <div id="browser-compat"></div>
                    </div>
                </div>
            `;

        const fontInfoManager = loadFontInfoManager();
        const beginTransaction = jest.fn();
        const endTransaction = jest.fn();
        const applySyntheticChangeSet = jest.fn();
        const runWithoutRecording = jest.fn((fn) => fn());

        window.currentFontModel = {
            axes: [
                {
                    name: { dflt: 'Weight' },
                    tag: 'wght',
                    min: 100,
                    default: 400,
                    max: 900
                }
            ],
            names: {},
            features: {
                features: []
            },
            instances: [
                {
                    id: 'I1',
                    name: { dflt: 'Regular' },
                    location: { wght: 400 },
                    custom_names: {},
                    linked_style: 'Bold'
                },
                {
                    id: 'I2',
                    name: { dflt: 'Bold' },
                    location: { wght: 700 },
                    custom_names: {},
                    linked_style: 'Regular'
                }
            ]
        };
        window.patchSyncEngine = {
            beginTransaction,
            endTransaction,
            applySyntheticChangeSet,
            runWithoutRecording
        };

        fontInfoManager.init();
        jest.runOnlyPendingTimers();
        fontInfoManager.switchTab('instances');

        const instanceItems = document.querySelectorAll(
            '#fontinfo-instances-content .fontinfo-record-item'
        );
        instanceItems[0].getBoundingClientRect = () => ({
            top: 0,
            height: 20
        });

        fontInfoManager.onInstanceDragStart(
            {
                currentTarget: instanceItems[1],
                dataTransfer: {
                    effectAllowed: 'all',
                    setData: jest.fn()
                }
            },
            1
        );
        fontInfoManager.onInstanceDragOver(
            {
                preventDefault: jest.fn(),
                currentTarget: instanceItems[0],
                dataTransfer: {},
                clientY: 0
            },
            0
        );
        fontInfoManager.onInstanceDragEnd();

        expect(applySyntheticChangeSet).toHaveBeenCalledWith(
            'Reorder instances',
            [
                {
                    op: 'set',
                    path: ['instances'],
                    oldValue: expect.any(Array),
                    newValue: [
                        expect.objectContaining({ id: 'I2' }),
                        expect.objectContaining({ id: 'I1' })
                    ]
                }
            ],
            expect.objectContaining({
                compileChangeSource: 'font-info',
                compileEditType: null
            })
        );
    });

    test('masters and instances sidebar summaries refresh after local name and location commits', () => {
        document.body.innerHTML = `
                <div id="view-fontinfo" class="view view-fontinfo focused">
                    <div class="view-title-bar">
                        <div class="view-title-right">
                            <div id="fontinfo-search-control" style="display: none;">
                                <input id="fontinfo-search-input" />
                            </div>
                        </div>
                    </div>
                    <div class="view-content">
                        <div id="browser-compat"></div>
                    </div>
                </div>
            `;

        const fontInfoManager = loadFontInfoManager();
        const beginTransaction = jest.fn();
        const endTransaction = jest.fn();
        const applySyntheticChangeSet = jest.fn();
        const runWithoutRecording = jest.fn((fn) => fn());

        window.currentFontModel = {
            axes: [
                {
                    name: { dflt: 'Weight' },
                    tag: 'wght',
                    min: 100,
                    default: 400,
                    max: 900
                }
            ],
            names: {},
            features: {
                features: []
            },
            masters: [
                {
                    id: 'M1',
                    name: { dflt: 'Regular' },
                    location: { wght: 400 },
                    metrics: { ascender: 800 },
                    kerning: {}
                }
            ],
            instances: [
                {
                    id: 'I1',
                    name: { dflt: 'Regular' },
                    location: { wght: 400 },
                    custom_names: {},
                    variable: false
                }
            ]
        };
        window.patchSyncEngine = {
            beginTransaction,
            endTransaction,
            applySyntheticChangeSet,
            runWithoutRecording
        };

        fontInfoManager.init();
        jest.runOnlyPendingTimers();

        fontInfoManager.switchTab('masters');

        const masterNameInput = document.querySelector(
            '[data-font-field="masters.0.name"] .localized-string-input'
        );
        masterNameInput.focus();
        masterNameInput.value = 'Text';
        masterNameInput.dispatchEvent(
            new KeyboardEvent('keydown', {
                key: 'Enter',
                bubbles: true
            })
        );

        const masterLocationInput = document.querySelector(
            '[data-font-field="masters.0.location.wght"] .localized-string-input'
        );
        masterLocationInput.focus();
        masterLocationInput.value = '650';
        masterLocationInput.dispatchEvent(
            new KeyboardEvent('keydown', {
                key: 'Enter',
                bubbles: true
            })
        );

        expect(
            document.querySelector(
                '#fontinfo-masters-content .fontinfo-record-item-primary'
            ).textContent
        ).toBe('Text');
        expect(
            document.querySelector(
                '#fontinfo-masters-content .fontinfo-record-item-secondary'
            ).textContent
        ).toBe('wght:650/650');

        fontInfoManager.switchTab('instances');

        const instanceNameInput = document.querySelector(
            '[data-font-field="instances.0.name"] .localized-string-input'
        );
        instanceNameInput.focus();
        instanceNameInput.value = 'Display';
        instanceNameInput.dispatchEvent(
            new KeyboardEvent('keydown', {
                key: 'Enter',
                bubbles: true
            })
        );

        const instanceLocationInput = document.querySelector(
            '[data-font-field="instances.0.location.wght"] .localized-string-input'
        );
        instanceLocationInput.focus();
        instanceLocationInput.value = '720';
        instanceLocationInput.dispatchEvent(
            new KeyboardEvent('keydown', {
                key: 'Enter',
                bubbles: true
            })
        );

        expect(
            document.querySelector(
                '#fontinfo-instances-content .fontinfo-record-item-primary'
            ).textContent
        ).toBe('Display');
        expect(
            document.querySelector(
                '#fontinfo-instances-content .fontinfo-record-item-secondary'
            ).textContent
        ).toBe('wght:720/720');
    });

    test('axes list controls add, remove, and reorder through the patch funnel', () => {
        document.body.innerHTML = `
                <div id="view-fontinfo" class="view view-fontinfo focused">
                    <div class="view-title-bar">
                        <div class="view-title-right">
                            <div id="fontinfo-search-control" style="display: none;">
                                <input id="fontinfo-search-input" />
                            </div>
                        </div>
                    </div>
                    <div class="view-content">
                        <div id="browser-compat"></div>
                    </div>
                </div>
            `;

        const fontInfoManager = loadFontInfoManager();
        const beginTransaction = jest.fn();
        const endTransaction = jest.fn();
        const applySyntheticChangeSet = jest.fn();
        const runWithoutRecording = jest.fn((fn) => fn());

        window.currentFontModel = {
            axes: [
                {
                    name: { dflt: 'Weight' },
                    tag: 'wght',
                    min: 100,
                    default: 400,
                    max: 900
                },
                {
                    name: { dflt: 'Width' },
                    tag: 'wdth',
                    min: 50,
                    default: 100,
                    max: 200
                }
            ],
            names: {},
            features: { features: [] }
        };
        window.patchSyncEngine = {
            beginTransaction,
            endTransaction,
            applySyntheticChangeSet,
            runWithoutRecording
        };

        fontInfoManager.init();
        jest.runOnlyPendingTimers();
        fontInfoManager.switchTab('axes');

        const addAxesButton = document.querySelector(
            '[data-fontinfo-list-action="axes-add"]'
        );
        addAxesButton.focus();
        addAxesButton.click();

        expect(applySyntheticChangeSet).toHaveBeenCalledWith(
            'Add axis',
            [
                {
                    op: 'set',
                    path: ['axes'],
                    oldValue: expect.any(Array),
                    newValue: expect.arrayContaining([
                        expect.objectContaining({
                            name: { dflt: 'Axis 3' }
                        })
                    ])
                }
            ],
            expect.objectContaining({
                compileChangeSource: 'font-info',
                compileEditType: null
            })
        );
        expect(
            document.querySelectorAll(
                '#fontinfo-axes-content .fontinfo-record-item'
            )
        ).toHaveLength(3);

        const removeAxesButton = document.querySelector(
            '[data-fontinfo-list-action="axes-remove"]'
        );
        removeAxesButton.focus();
        fontInfoManager.setDeleteConfirmationHandler(true);
        removeAxesButton.click();

        expect(applySyntheticChangeSet).toHaveBeenCalledWith(
            'Remove axis',
            [
                {
                    op: 'set',
                    path: ['axes'],
                    oldValue: expect.any(Array),
                    newValue: expect.arrayContaining([
                        expect.objectContaining({ tag: 'wght' }),
                        expect.objectContaining({ tag: 'wdth' })
                    ])
                }
            ],
            expect.objectContaining({
                compileChangeSource: 'font-info',
                compileEditType: null
            })
        );
        expect(
            document.querySelectorAll(
                '#fontinfo-axes-content .fontinfo-record-item'
            )
        ).toHaveLength(2);

        const axisItems = document.querySelectorAll(
            '#fontinfo-axes-content .fontinfo-record-item'
        );
        axisItems[1].focus();
        axisItems[0].getBoundingClientRect = () => ({
            top: 0,
            height: 20
        });
        fontInfoManager.onAxisDragStart(
            {
                currentTarget: axisItems[1],
                dataTransfer: {}
            },
            1
        );
        fontInfoManager.onAxisDragOver(
            {
                preventDefault: jest.fn(),
                currentTarget: axisItems[0],
                dataTransfer: {},
                clientY: 0
            },
            0
        );
        expect(
            axisItems[0].classList.contains('feature-drop-target-before')
        ).toBe(true);
        fontInfoManager.onAxisDrop(
            {
                preventDefault: jest.fn()
            },
            0
        );

        expect(applySyntheticChangeSet).toHaveBeenCalledWith(
            'Reorder axes',
            [
                {
                    op: 'set',
                    path: ['axes'],
                    oldValue: expect.any(Array),
                    newValue: [
                        expect.objectContaining({ tag: 'wdth' }),
                        expect.objectContaining({ tag: 'wght' })
                    ]
                }
            ],
            expect.objectContaining({
                compileChangeSource: 'font-info',
                compileEditType: null
            })
        );
        expect(
            document.querySelector(
                '#fontinfo-axes-content .fontinfo-record-item-primary'
            ).textContent
        ).toBe('Width');
    });

    test('axes reorder commits from dragend when drop is not delivered', () => {
        document.body.innerHTML = `
                <div id="view-fontinfo" class="view view-fontinfo focused">
                    <div class="view-title-bar">
                        <div class="view-title-right">
                            <div id="fontinfo-search-control" style="display: none;">
                                <input id="fontinfo-search-input" />
                            </div>
                        </div>
                    </div>
                    <div class="view-content">
                        <div id="browser-compat"></div>
                    </div>
                </div>
            `;

        const fontInfoManager = loadFontInfoManager();
        const beginTransaction = jest.fn();
        const endTransaction = jest.fn();
        const applySyntheticChangeSet = jest.fn();
        const runWithoutRecording = jest.fn((fn) => fn());

        window.currentFontModel = {
            axes: [
                {
                    name: { dflt: 'Weight' },
                    tag: 'wght',
                    min: 100,
                    default: 400,
                    max: 900
                },
                {
                    name: { dflt: 'Width' },
                    tag: 'wdth',
                    min: 50,
                    default: 100,
                    max: 200
                }
            ],
            names: {},
            features: { features: [] }
        };
        window.patchSyncEngine = {
            beginTransaction,
            endTransaction,
            applySyntheticChangeSet,
            runWithoutRecording
        };

        fontInfoManager.init();
        jest.runOnlyPendingTimers();
        fontInfoManager.switchTab('axes');

        const axisItems = document.querySelectorAll(
            '#fontinfo-axes-content .fontinfo-record-item'
        );
        axisItems[0].getBoundingClientRect = () => ({
            top: 0,
            height: 20
        });

        fontInfoManager.onAxisDragStart(
            {
                currentTarget: axisItems[1],
                dataTransfer: {
                    effectAllowed: 'all',
                    setData: jest.fn()
                }
            },
            1
        );
        fontInfoManager.onAxisDragOver(
            {
                preventDefault: jest.fn(),
                currentTarget: axisItems[0],
                dataTransfer: {},
                clientY: 0
            },
            0
        );
        fontInfoManager.onAxisDragEnd();

        expect(applySyntheticChangeSet).toHaveBeenCalledWith(
            'Reorder axes',
            [
                {
                    op: 'set',
                    path: ['axes'],
                    oldValue: expect.any(Array),
                    newValue: [
                        expect.objectContaining({ tag: 'wdth' }),
                        expect.objectContaining({ tag: 'wght' })
                    ]
                }
            ],
            expect.objectContaining({
                compileChangeSource: 'font-info',
                compileEditType: null
            })
        );
    });

    test('visible axes list rebuilds on fontModelSync structural changes', () => {
        document.body.innerHTML = `
                <div id="view-fontinfo" class="view view-fontinfo focused">
                    <div class="view-title-bar">
                        <div class="view-title-right">
                            <div id="fontinfo-search-control" style="display: none;">
                                <input id="fontinfo-search-input" />
                            </div>
                        </div>
                    </div>
                    <div class="view-content">
                        <div id="browser-compat"></div>
                    </div>
                </div>
            `;

        window.currentFontModel = {
            axes: [
                {
                    name: { dflt: 'Weight' },
                    tag: 'wght',
                    min: 100,
                    default: 400,
                    max: 900
                },
                {
                    name: { dflt: 'Width' },
                    tag: 'wdth',
                    min: 50,
                    default: 100,
                    max: 200
                }
            ],
            names: {},
            features: { features: [] }
        };

        const fontInfoManager = loadFontInfoManager();
        fontInfoManager.init();
        jest.runOnlyPendingTimers();

        fontInfoManager.switchTab('axes');
        const axisTagInput = document.querySelector(
            '[data-font-field="axes.0.tag"] .localized-string-input'
        );
        axisTagInput.focus();

        window.currentFontModel.axes = [
            window.currentFontModel.axes[1],
            window.currentFontModel.axes[0]
        ];
        window.dispatchEvent(new CustomEvent('fontModelSync'));
        jest.runOnlyPendingTimers();

        const reorderedAxisItems = document.querySelectorAll(
            '#fontinfo-axes-content .fontinfo-record-item-primary'
        );
        expect(reorderedAxisItems[0].textContent).toBe('Width');
        expect(reorderedAxisItems[1].textContent).toBe('Weight');
    });

    test('axes sidebar summaries refresh after local name and tag commits', () => {
        document.body.innerHTML = `
                <div id="view-fontinfo" class="view view-fontinfo focused">
                    <div class="view-title-bar">
                        <div class="view-title-right">
                            <div id="fontinfo-search-control" style="display: none;">
                                <input id="fontinfo-search-input" />
                            </div>
                        </div>
                    </div>
                    <div class="view-content">
                        <div id="browser-compat"></div>
                    </div>
                </div>
            `;

        window.currentFontModel = {
            axes: [
                {
                    name: { dflt: 'Weight' },
                    tag: 'wght',
                    min: 100,
                    default: 400,
                    max: 900
                }
            ],
            names: {},
            features: { features: [] }
        };
        const beginTransaction = jest.fn();
        const endTransaction = jest.fn();
        const applySyntheticChangeSet = jest.fn();
        const runWithoutRecording = jest.fn((fn) => fn());

        window.patchSyncEngine = {
            beginTransaction,
            endTransaction,
            applySyntheticChangeSet,
            runWithoutRecording
        };

        const fontInfoManager = loadFontInfoManager();
        fontInfoManager.init();
        jest.runOnlyPendingTimers();
        fontInfoManager.switchTab('axes');

        const nameInput = document.querySelector(
            '[data-font-field="axes.0.name"] .localized-string-input'
        );
        nameInput.focus();
        nameInput.value = 'Custom Weight';
        nameInput.dispatchEvent(
            new KeyboardEvent('keydown', {
                key: 'Enter',
                bubbles: true
            })
        );

        expect(
            document.querySelector(
                '#fontinfo-axes-content .fontinfo-record-item-primary'
            ).textContent
        ).toBe('Custom Weight');
    });

    test('adding and removing axes syncs master and instance location fields', () => {
        document.body.innerHTML = `
                <div id="view-fontinfo" class="view view-fontinfo focused">
                    <div class="view-title-bar">
                        <div class="view-title-right">
                            <div id="fontinfo-search-control" style="display: none;">
                                <input id="fontinfo-search-input" />
                            </div>
                        </div>
                    </div>
                    <div class="view-content">
                        <div id="browser-compat"></div>
                    </div>
                </div>
            `;

        const fontInfoManager = loadFontInfoManager();
        const beginTransaction = jest.fn();
        const endTransaction = jest.fn();
        const applySyntheticChangeSet = jest.fn();
        const runWithoutRecording = jest.fn((fn) => fn());

        window.currentFontModel = {
            axes: [
                {
                    name: { dflt: 'Weight' },
                    tag: 'wght',
                    min: 100,
                    default: 400,
                    max: 900
                }
            ],
            names: {},
            features: { features: [] },
            masters: [
                {
                    id: 'M1',
                    name: { dflt: 'Regular' },
                    location: { wght: 400 },
                    metrics: { ascender: 800 },
                    kerning: {}
                }
            ],
            instances: [
                {
                    id: 'I1',
                    name: { dflt: 'Regular' },
                    location: { wght: 400 },
                    custom_names: {}
                }
            ]
        };
        window.patchSyncEngine = {
            beginTransaction,
            endTransaction,
            applySyntheticChangeSet,
            runWithoutRecording
        };

        fontInfoManager.init();
        jest.runOnlyPendingTimers();
        fontInfoManager.switchTab('axes');

        // Add a second axis — should insert location entry in master + instance
        const addAxesButton = document.querySelector(
            '[data-fontinfo-list-action="axes-add"]'
        );
        addAxesButton.focus();
        addAxesButton.click();

        const addCall = applySyntheticChangeSet.mock.calls.find(
            ([label]) => label === 'Add axis'
        );
        expect(addCall).toBeDefined();
        const addChanges = addCall[1];

        // Must include the axes change
        expect(addChanges).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ path: ['axes'] })
            ])
        );

        // Must include a location update for master 0 with the new axis tag
        const masterLocationChange = addChanges.find(
            (c) =>
                c.path.length === 3 &&
                c.path[0] === 'masters' &&
                c.path[1] === 0 &&
                c.path[2] === 'location'
        );
        expect(masterLocationChange).toBeDefined();
        expect(masterLocationChange.newValue).toMatchObject({ wght: 400 });
        expect(Object.keys(masterLocationChange.newValue)).toHaveLength(2); // wght + new tag

        // Must include a location update for instance 0
        const instanceLocationChange = addChanges.find(
            (c) =>
                c.path.length === 3 &&
                c.path[0] === 'instances' &&
                c.path[1] === 0 &&
                c.path[2] === 'location'
        );
        expect(instanceLocationChange).toBeDefined();
        expect(Object.keys(instanceLocationChange.newValue)).toHaveLength(2);

        // Now select and remove the new axis (index 1), which was auto-selected
        applySyntheticChangeSet.mockClear();

        const removeAxesButton = document.querySelector(
            '[data-fontinfo-list-action="axes-remove"]'
        );
        removeAxesButton.focus();
        fontInfoManager.setDeleteConfirmationHandler(true);
        removeAxesButton.click();

        const removeCall = applySyntheticChangeSet.mock.calls.find(
            ([label]) => label === 'Remove axis'
        );
        expect(removeCall).toBeDefined();
        const removeChanges = removeCall[1];

        // Master and instance locations should have the removed tag stripped
        const masterRemoveChange = removeChanges.find(
            (c) =>
                c.path.length === 3 &&
                c.path[0] === 'masters' &&
                c.path[2] === 'location'
        );
        expect(masterRemoveChange).toBeDefined();
        expect(Object.keys(masterRemoveChange.newValue ?? {})).toHaveLength(1);
        expect(masterRemoveChange.newValue).toHaveProperty('wght');
    });

    // ── Layer sync + multi-select tests ─────────────────────────────────────

    test('adding a master delegates creation to the object model', async () => {
        document.body.innerHTML = `
            <div id="view-fontinfo" class="view view-fontinfo focused">
                <div class="view-title-bar">
                    <div class="view-title-right">
                        <div id="fontinfo-search-control" style="display: none;">
                            <input id="fontinfo-search-input" />
                        </div>
                    </div>
                </div>
                <div class="view-content">
                    <div id="browser-compat"></div>
                </div>
            </div>
        `;

        const fontInfoManager = loadFontInfoManager();
        const addMaster = jest.fn(async function () {
            const createdMaster = {
                id: 'M2',
                name: { dflt: 'Master 2' },
                location: {},
                metrics: { ascender: 800 },
                kerning: {}
            };
            this.masters = [...this.masters, createdMaster];
            return createdMaster;
        });
        window.currentFontModel = {
            axes: [],
            names: {},
            features: { features: [] },
            masters: [
                {
                    id: 'M1',
                    name: { dflt: 'Regular' },
                    location: {},
                    metrics: { ascender: 800 },
                    kerning: {}
                }
            ],
            glyphs: [],
            addMaster
        };

        fontInfoManager.init();
        jest.runOnlyPendingTimers();
        fontInfoManager.switchTab('masters');

        const addMasterButton = document.querySelector(
            '[data-fontinfo-list-action="masters-add"]'
        );
        addMasterButton.click();

        await Promise.resolve();

        expect(addMaster).toHaveBeenCalledTimes(1);
        expect(window.currentFontModel.masters).toHaveLength(2);
    });

    test('adding a master prompts for location and passes it to the object model', async () => {
        document.body.innerHTML = `
            <div id="view-fontinfo" class="view view-fontinfo focused">
                <div class="view-title-bar">
                    <div class="view-title-right">
                        <div id="fontinfo-search-control" style="display: none;">
                            <input id="fontinfo-search-input" />
                        </div>
                    </div>
                </div>
                <div class="view-content">
                    <div id="browser-compat"></div>
                </div>
            </div>
        `;

        const fontInfoManager = loadFontInfoManager();
        const addMaster = jest.fn(async function (_master, options) {
            const createdMaster = {
                id: 'M3',
                name: { dflt: 'Master 3' },
                location: options?.location ?? {},
                metrics: { ascender: 800 },
                kerning: {}
            };
            this.masters = [...this.masters, createdMaster];
            return createdMaster;
        });

        window.currentFontModel = {
            axes: [
                {
                    name: { dflt: 'Weight' },
                    tag: 'wght',
                    min: 100,
                    default: 400,
                    max: 900
                },
                {
                    name: { dflt: 'Width' },
                    tag: 'wdth',
                    min: 50,
                    default: 100,
                    max: 200
                }
            ],
            names: {},
            features: { features: [] },
            masters: [
                {
                    id: 'M1',
                    name: { dflt: 'Regular' },
                    location: { wght: 400, wdth: 100 },
                    metrics: { ascender: 800 },
                    kerning: {}
                },
                {
                    id: 'M2',
                    name: { dflt: 'Bold' },
                    location: { wght: 700, wdth: 120 },
                    metrics: { ascender: 820 },
                    kerning: {}
                }
            ],
            glyphs: [],
            addMaster
        };

        fontInfoManager.init();
        jest.runOnlyPendingTimers();
        fontInfoManager.switchTab('masters');

        const addMasterButton = document.querySelector(
            '[data-fontinfo-list-action="masters-add"]'
        );
        addMasterButton.click();

        expect(addMaster).not.toHaveBeenCalled();

        const modal = document.querySelector('.fontinfo-master-location-modal');
        expect(modal).toBeTruthy();

        const wghtInput = modal.querySelector(
            '[data-master-location-axis="wght"]'
        );
        const wdthInput = modal.querySelector(
            '[data-master-location-axis="wdth"]'
        );
        expect(wghtInput.value).toBe('700');
        expect(wdthInput.value).toBe('120');

        wghtInput.value = '650';
        wdthInput.value = '110';

        const createButton = modal.querySelector(
            '.fontinfo-master-location-create'
        );
        createButton.click();
        await Promise.resolve();
        await Promise.resolve();

        expect(addMaster).toHaveBeenCalledWith(
            undefined,
            expect.objectContaining({
                location: { wght: 650, wdth: 110 }
            })
        );
    });

    test('canceling the master location modal aborts master creation', async () => {
        document.body.innerHTML = `
            <div id="view-fontinfo" class="view view-fontinfo focused">
                <div class="view-title-bar">
                    <div class="view-title-right">
                        <div id="fontinfo-search-control" style="display: none;">
                            <input id="fontinfo-search-input" />
                        </div>
                    </div>
                </div>
                <div class="view-content">
                    <div id="browser-compat"></div>
                </div>
            </div>
        `;

        const fontInfoManager = loadFontInfoManager();
        const addMaster = jest.fn();

        window.currentFontModel = {
            axes: [
                {
                    name: { dflt: 'Weight' },
                    tag: 'wght',
                    min: 100,
                    default: 400,
                    max: 900
                }
            ],
            names: {},
            features: { features: [] },
            masters: [
                {
                    id: 'M1',
                    name: { dflt: 'Regular' },
                    location: { wght: 400 },
                    metrics: { ascender: 800 },
                    kerning: {}
                }
            ],
            glyphs: [],
            addMaster
        };

        fontInfoManager.init();
        jest.runOnlyPendingTimers();
        fontInfoManager.switchTab('masters');

        const addMasterButton = document.querySelector(
            '[data-fontinfo-list-action="masters-add"]'
        );
        addMasterButton.click();

        const modal = document.querySelector('.fontinfo-master-location-modal');
        expect(modal).toBeTruthy();

        const cancelButton = modal.querySelector(
            '.fontinfo-master-location-cancel'
        );
        cancelButton.click();
        await Promise.resolve();

        expect(addMaster).not.toHaveBeenCalled();
        expect(
            document.querySelector('.fontinfo-master-location-modal')
        ).toBeNull();
    });

    test('removing a master delegates deletion to the object model', async () => {
        document.body.innerHTML = `
            <div id="view-fontinfo" class="view view-fontinfo focused">
                <div class="view-title-bar">
                    <div class="view-title-right">
                        <div id="fontinfo-search-control" style="display: none;">
                            <input id="fontinfo-search-input" />
                        </div>
                    </div>
                </div>
                <div class="view-content">
                    <div id="browser-compat"></div>
                </div>
            </div>
        `;

        const fontInfoManager = loadFontInfoManager();
        const removeMastersByIds = jest.fn(async function (masterIds) {
            this.masters = this.masters.filter(
                (master) => !masterIds.includes(master.id)
            );
            return true;
        });
        window.currentFontModel = {
            axes: [],
            names: {},
            features: { features: [] },
            masters: [
                {
                    id: 'M1',
                    name: { dflt: 'Regular' },
                    location: {},
                    metrics: { ascender: 800 },
                    kerning: {}
                },
                {
                    id: 'M2',
                    name: { dflt: 'Bold' },
                    location: {},
                    metrics: { ascender: 820 },
                    kerning: {}
                }
            ],
            glyphs: [],
            removeMastersByIds
        };

        fontInfoManager.init();
        jest.runOnlyPendingTimers();
        fontInfoManager.switchTab('masters');

        // Select M2 (index 1)
        const masterItems = document.querySelectorAll(
            '#fontinfo-masters-content .fontinfo-record-item'
        );
        masterItems[1].click();

        fontInfoManager.setDeleteConfirmationHandler(true);
        document
            .querySelector('[data-fontinfo-list-action="masters-remove"]')
            .click();

        await Promise.resolve();

        expect(removeMastersByIds).toHaveBeenCalledWith(['M2']);
        expect(window.currentFontModel.masters).toHaveLength(1);
    });

    test('confirmation cancel aborts master deletion', () => {
        document.body.innerHTML = `
            <div id="view-fontinfo" class="view view-fontinfo focused">
                <div class="view-title-bar">
                    <div class="view-title-right">
                        <div id="fontinfo-search-control" style="display: none;">
                            <input id="fontinfo-search-input" />
                        </div>
                    </div>
                </div>
                <div class="view-content">
                    <div id="browser-compat"></div>
                </div>
            </div>
        `;

        const fontInfoManager = loadFontInfoManager();
        const beginTransaction = jest.fn();
        const endTransaction = jest.fn();
        const applySyntheticChangeSet = jest.fn();
        const runWithoutRecording = jest.fn((fn) => fn());

        window.currentFontModel = {
            axes: [],
            names: {},
            features: { features: [] },
            masters: [
                {
                    id: 'M1',
                    name: { dflt: 'Regular' },
                    location: {},
                    metrics: { ascender: 800 },
                    kerning: {}
                }
            ],
            glyphs: []
        };
        window.patchSyncEngine = {
            beginTransaction,
            endTransaction,
            applySyntheticChangeSet,
            runWithoutRecording
        };

        fontInfoManager.init();
        jest.runOnlyPendingTimers();
        fontInfoManager.switchTab('masters');

        // Cancel the deletion
        fontInfoManager.setDeleteConfirmationHandler(false);
        document
            .querySelector('[data-fontinfo-list-action="masters-remove"]')
            .click();

        // No transaction should have been started
        expect(beginTransaction).not.toHaveBeenCalledWith('Remove master');
        expect(applySyntheticChangeSet).not.toHaveBeenCalledWith(
            'Remove master',
            expect.anything()
        );
        // List is unchanged
        expect(
            document.querySelectorAll(
                '#fontinfo-masters-content .fontinfo-record-item'
            )
        ).toHaveLength(1);
    });

    test('multi-select: Ctrl+click adds to master selection, delete removes both', async () => {
        document.body.innerHTML = `
            <div id="view-fontinfo" class="view view-fontinfo focused">
                <div class="view-title-bar">
                    <div class="view-title-right">
                        <div id="fontinfo-search-control" style="display: none;">
                            <input id="fontinfo-search-input" />
                        </div>
                    </div>
                </div>
                <div class="view-content">
                    <div id="browser-compat"></div>
                </div>
            </div>
        `;

        const fontInfoManager = loadFontInfoManager();
        const beginTransaction = jest.fn();
        const endTransaction = jest.fn();
        const applySyntheticChangeSet = jest.fn();
        const runWithoutRecording = jest.fn((fn) => fn());
        const removeMastersByIds = jest.fn(async function (masterIds) {
            this.masters = this.masters.filter(
                (master) => !masterIds.includes(master.id)
            );
            return true;
        });

        window.currentFontModel = {
            axes: [],
            names: {},
            features: { features: [] },
            masters: [
                {
                    id: 'M1',
                    name: { dflt: 'Regular' },
                    location: {},
                    metrics: { ascender: 800 },
                    kerning: {}
                },
                {
                    id: 'M2',
                    name: { dflt: 'Bold' },
                    location: {},
                    metrics: { ascender: 820 },
                    kerning: {}
                },
                {
                    id: 'M3',
                    name: { dflt: 'ExtraBold' },
                    location: {},
                    metrics: { ascender: 830 },
                    kerning: {}
                }
            ],
            glyphs: [],
            removeMastersByIds
        };
        window.patchSyncEngine = {
            beginTransaction,
            endTransaction,
            applySyntheticChangeSet,
            runWithoutRecording
        };

        fontInfoManager.init();
        jest.runOnlyPendingTimers();
        fontInfoManager.switchTab('masters');

        const masterItems = () =>
            document.querySelectorAll(
                '#fontinfo-masters-content .fontinfo-record-item'
            );

        // Click M1 (index 0) to select it
        masterItems()[0].click();

        // Ctrl+click M3 (index 2) to add to selection
        masterItems()[2].dispatchEvent(
            new MouseEvent('click', { bubbles: true, metaKey: true })
        );

        // Both 0 and 2 should be selected
        expect(masterItems()[0].classList.contains('selected')).toBe(true);
        expect(masterItems()[1].classList.contains('selected')).toBe(false);
        expect(masterItems()[2].classList.contains('selected')).toBe(true);

        // Delete the selection
        fontInfoManager.setDeleteConfirmationHandler(true);
        document
            .querySelector('[data-fontinfo-list-action="masters-remove"]')
            .click();

        await Promise.resolve();

        // Only M2 (index 1) should remain
        expect(removeMastersByIds).toHaveBeenCalledWith(['M1', 'M3']);
        expect(masterItems()).toHaveLength(1);
    });

    test('confirmation cancel aborts instance deletion', () => {
        document.body.innerHTML = `
            <div id="view-fontinfo" class="view view-fontinfo focused">
                <div class="view-title-bar">
                    <div class="view-title-right">
                        <div id="fontinfo-search-control" style="display: none;">
                            <input id="fontinfo-search-input" />
                        </div>
                    </div>
                </div>
                <div class="view-content">
                    <div id="browser-compat"></div>
                </div>
            </div>
        `;

        const fontInfoManager = loadFontInfoManager();
        const beginTransaction = jest.fn();
        const endTransaction = jest.fn();
        const applySyntheticChangeSet = jest.fn();
        const runWithoutRecording = jest.fn((fn) => fn());

        window.currentFontModel = {
            axes: [],
            names: {},
            features: { features: [] },
            masters: [
                {
                    id: 'M1',
                    name: { dflt: 'Regular' },
                    location: {},
                    metrics: { ascender: 800 },
                    kerning: {}
                }
            ],
            instances: [
                {
                    id: 'I1',
                    name: { dflt: 'Regular' },
                    location: {}
                }
            ],
            glyphs: []
        };
        window.patchSyncEngine = {
            beginTransaction,
            endTransaction,
            applySyntheticChangeSet,
            runWithoutRecording
        };

        fontInfoManager.init();
        jest.runOnlyPendingTimers();
        fontInfoManager.switchTab('instances');

        fontInfoManager.setDeleteConfirmationHandler(false);
        document
            .querySelector('[data-fontinfo-list-action="instances-remove"]')
            .click();

        expect(applySyntheticChangeSet).not.toHaveBeenCalledWith(
            'Remove instance',
            expect.anything()
        );
        expect(
            document.querySelectorAll(
                '#fontinfo-instances-content .fontinfo-record-item'
            )
        ).toHaveLength(1);
    });

    test('confirmation cancel aborts axis deletion', () => {
        document.body.innerHTML = `
            <div id="view-fontinfo" class="view view-fontinfo focused">
                <div class="view-title-bar">
                    <div class="view-title-right">
                        <div id="fontinfo-search-control" style="display: none;">
                            <input id="fontinfo-search-input" />
                        </div>
                    </div>
                </div>
                <div class="view-content">
                    <div id="browser-compat"></div>
                </div>
            </div>
        `;

        const fontInfoManager = loadFontInfoManager();
        const beginTransaction = jest.fn();
        const endTransaction = jest.fn();
        const applySyntheticChangeSet = jest.fn();
        const runWithoutRecording = jest.fn((fn) => fn());

        window.currentFontModel = {
            axes: [
                {
                    name: { dflt: 'Weight' },
                    tag: 'wght',
                    min: 100,
                    default: 400,
                    max: 900
                }
            ],
            names: {},
            features: { features: [] },
            masters: [
                {
                    id: 'M1',
                    name: { dflt: 'Regular' },
                    location: { wght: 400 },
                    metrics: { ascender: 800 },
                    kerning: {}
                }
            ],
            instances: [],
            glyphs: []
        };
        window.patchSyncEngine = {
            beginTransaction,
            endTransaction,
            applySyntheticChangeSet,
            runWithoutRecording
        };

        fontInfoManager.init();
        jest.runOnlyPendingTimers();
        fontInfoManager.switchTab('axes');

        fontInfoManager.setDeleteConfirmationHandler(false);
        document
            .querySelector('[data-fontinfo-list-action="axes-remove"]')
            .click();

        expect(applySyntheticChangeSet).not.toHaveBeenCalledWith(
            'Remove axis',
            expect.anything()
        );
        expect(
            document.querySelectorAll(
                '#fontinfo-axes-content .fontinfo-record-item'
            )
        ).toHaveLength(1);
    });
});
