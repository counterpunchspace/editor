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
        (global.__fontInfoTippyInstances ||= []).push(instance);
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

async function addAxisThroughDialog(addButton, buttonRole) {
    addButton.click();
    jest.advanceTimersByTime(20);
    const dialog = document.querySelector('.add-axis-dialog');
    expect(dialog).not.toBeNull();
    dialog.querySelector(`[data-role="${buttonRole}"]`).click();
    // Let the dialog promise and the commit that follows settle.
    for (let i = 0; i < 5; i += 1) {
        await Promise.resolve();
    }
}

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

    test('replaces a removed feature with its neighbor and clears the editor when none remain', () => {
        const fontInfoManager = loadFontInfoManager();
        document.body.innerHTML = `
            <div id="features-list"></div>
            <div id="feature-code-editor"></div>
            <input type="checkbox" id="feature-automatic-checkbox" />
        `;
        const setValue = jest.fn();
        const editor = {
            isFocused: jest.fn(() => false),
            setValue,
            session: {
                setUseWrapMode: jest.fn(),
                removeMarker: jest.fn()
            }
        };
        fontInfoManager.featuresEditor = editor;
        fontInfoManager.currentTab = 'features';
        window.currentFontModel = {
            features: {
                features: [
                    ['liga', { code: 'sub f i by fi;', automatic: false }],
                    ['ccmp', { code: 'sub a by a;', automatic: true }]
                ]
            },
            analyzeFeatureTables: jest.fn(() => ({
                hasGSUB: true,
                hasGPOS: false
            }))
        };
        fontInfoManager.selectedItem = { type: 'feature', key: 1 };
        fontInfoManager.selectedFeatureTag = 'ccmp';
        fontInfoManager.featureCodeDirty = true;

        window.currentFontModel.features.features = [
            ['liga', { code: 'sub f i by fi;', automatic: false }]
        ];
        fontInfoManager.loadFeaturesList();

        expect(fontInfoManager.selectedFeatureTag).toBe('liga');
        expect(fontInfoManager.selectedItem).toEqual({
            type: 'feature',
            key: 0
        });
        expect(setValue).toHaveBeenCalledWith('sub f i by fi;', -1);
        expect(
            document.querySelector(
                '#features-list .feature-list-item.selected .feature-tag'
            ).textContent
        ).toBe('liga');

        setValue.mockClear();
        window.currentFontModel.features.features = [];
        fontInfoManager.loadFeaturesList();

        expect(fontInfoManager.selectedItem).toBeNull();
        expect(fontInfoManager.selectedFeatureTag).toBeNull();
        expect(setValue).toHaveBeenCalledWith('', -1);
        expect(document.getElementById('feature-code-editor')).not.toBeNull();
        expect(
            document.getElementById('feature-automatic-checkbox').disabled
        ).toBe(true);
    });

    test('replaces a removed class with its neighbor', () => {
        const fontInfoManager = loadFontInfoManager();
        document.body.innerHTML = '<div id="classes-list"></div>';
        const setValue = jest.fn();
        fontInfoManager.featuresEditor = {
            setValue,
            session: { setUseWrapMode: jest.fn(), removeMarker: jest.fn() }
        };
        window.currentFontModel = {
            features: {
                classes: {
                    vowels: { code: '[a e i];', automatic: false },
                    consonants: { code: '[b c d];', automatic: false }
                }
            }
        };
        fontInfoManager.loadClassesList();
        fontInfoManager.selectedItem = { type: 'class', key: 'vowels' };

        window.currentFontModel.features.classes = {
            consonants: { code: '[b c d];', automatic: false }
        };
        fontInfoManager.loadClassesList();

        expect(fontInfoManager.selectedItem).toEqual({
            type: 'class',
            key: 'consonants'
        });
        expect(setValue).toHaveBeenCalledWith('[b c d];', -1);
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
        const titleBarRight = document.querySelector(
            '#view-fontinfo .view-title-right'
        );
        expect(
            titleBarRight.lastElementChild.classList.contains(
                'fontinfo-section-button'
            )
        ).toBe(true);
        expect(titleBarRight.lastElementChild.previousElementSibling.id).toBe(
            'fontinfo-search-control'
        );
    });

    test('bridge-backed names commits use a precise names path', () => {
        const fontInfoManager = loadFontInfoManager();
        const beginTransaction = jest.fn();
        const endTransaction = jest.fn();
        const runWithoutRecording = jest.fn((fn) => fn());
        const applySyntheticChangeSet = jest.fn();
        const applyLocalGeneratedYjsUpdate = jest.fn((_update, operations) => {
            const stationsOperation = operations.find(
                (operation) =>
                    Array.isArray(operation.path) &&
                    operation.path[0] === 'masters'
            );
            if (stationsOperation) {
                window.currentFontModel.stations = stationsOperation.newValue;
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
            stations: [
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

        const stationSidebarText = document.querySelector(
            '.fontinfo-record-item-secondary'
        );
        expect(stationSidebarText.textContent).toBe('wght:400/400');
        expect(
            document.querySelector('[data-font-field="masters.0.id"]')
        ).toBeNull();
        expect(
            document.querySelector(
                '[data-font-field="masters.0.custom_ot_values.os2_vendor_id"]'
            )
        ).toBeNull();

        const stationMetricInput = document.querySelector(
            '[data-font-field="masters.0.metrics.ascender"] .localized-string-input'
        );
        stationMetricInput.focus();
        stationMetricInput.value = '825';
        stationMetricInput.dispatchEvent(
            new KeyboardEvent('keydown', {
                key: 'Enter',
                bubbles: true
            })
        );

        expect(applySyntheticChangeSet).toHaveBeenCalledWith(
            'Edit station metric',
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
            stations: [
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

        let stationMetricInput = document.querySelector(
            '[data-font-field="masters.0.metrics.ascender"] .localized-string-input'
        );
        expect(stationMetricInput.value).toBe('800');

        window.currentFontModel.stations[0].metrics.ascender = 825;
        window.dispatchEvent(new CustomEvent('fontModelSync'));
        jest.runOnlyPendingTimers();

        stationMetricInput = document.querySelector(
            '[data-font-field="masters.0.metrics.ascender"] .localized-string-input'
        );
        expect(stationMetricInput.value).toBe('825');

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
            stations: [
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
        const stationPane = document.getElementById('fontinfo-stations-fields');
        const stationSidebar = document.querySelector(
            '#fontinfo-stations-content .fontinfo-records-sidebar'
        );
        const stationList = document.querySelector(
            '#fontinfo-stations-content .fontinfo-records-list'
        );
        const stationItem = document.querySelector(
            '#fontinfo-stations-content .fontinfo-record-item'
        );
        expect(stationPane.classList.contains('fontinfo-records-pane')).toBe(
            true
        );
        expect(stationSidebar.classList.contains('features-sidebar')).toBe(
            false
        );
        expect(stationList.classList.contains('editor-drawings-list')).toBe(
            true
        );
        expect(stationItem.classList.contains('editor-drawing-item')).toBe(
            true
        );

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
        expect(instanceList.classList.contains('editor-drawings-list')).toBe(
            true
        );
        expect(instanceItem.classList.contains('editor-drawing-item')).toBe(
            true
        );
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
            const stationsOperation = operations.find(
                (operation) =>
                    Array.isArray(operation.path) &&
                    operation.path[0] === 'masters'
            );
            if (stationsOperation) {
                window.currentFontModel.stations = stationsOperation.newValue;
            }
        });
        const addStation = jest.fn(async function () {
            const createdStation = {
                id: 'master-3',
                name: { dflt: 'Master 3' },
                location: { wght: 400 },
                metrics: { ascender: 820 },
                kerning: {}
            };
            this.stations = [...this.stations, createdStation];
            return createdStation;
        });
        const removeStationsByIds = jest.fn(async function (stationIds) {
            this.stations = this.stations.filter(
                (station) => !stationIds.includes(station.id)
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
            stations: [
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
            addStation,
            removeStationsByIds
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

        const selectedStationItems = document.querySelectorAll(
            '#fontinfo-stations-content .fontinfo-record-item'
        );
        selectedStationItems[1].click();

        const addStationButton = document.querySelector(
            '[data-fontinfo-list-action="stations-add"]'
        );
        addStationButton.focus();
        addStationButton.click();

        const modal = document.querySelector(
            '.fontinfo-station-location-modal'
        );
        expect(modal).toBeTruthy();
        const createButton = modal.querySelector(
            '.fontinfo-station-location-create'
        );
        createButton.click();
        await Promise.resolve();
        await Promise.resolve();
        jest.runOnlyPendingTimers();
        await Promise.resolve();

        expect(addStation).toHaveBeenCalledWith(
            undefined,
            expect.objectContaining({
                metricTemplateStationId: 'M2',
                location: { wght: 700 }
            })
        );
        expect(window.currentFontModel.stations).toHaveLength(3);

        const removeStationButton = document.querySelector(
            '[data-fontinfo-list-action="stations-remove"]'
        );
        removeStationButton.focus();
        fontInfoManager.setDeleteConfirmationHandler(true);
        removeStationButton.click();

        await Promise.resolve();

        expect(removeStationsByIds).toHaveBeenCalledWith(['master-3']);
        expect(window.currentFontModel.stations).toHaveLength(2);

        const stationItems = document.querySelectorAll(
            '#fontinfo-stations-content .fontinfo-record-item'
        );
        stationItems[1].focus();
        stationItems[0].getBoundingClientRect = () => ({
            top: 0,
            height: 20
        });
        fontInfoManager.onStationDragStart(
            {
                currentTarget: stationItems[1],
                dataTransfer: {}
            },
            1
        );
        fontInfoManager.onStationDragOver(
            {
                preventDefault: jest.fn(),
                currentTarget: stationItems[0],
                dataTransfer: {},
                clientY: 0
            },
            0
        );
        expect(
            stationItems[0].classList.contains('feature-drop-target-before')
        ).toBe(true);
        fontInfoManager.onStationDrop(
            {
                preventDefault: jest.fn()
            },
            0
        );

        expect(applySyntheticChangeSet).toHaveBeenCalledWith(
            'Reorder stations',
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
            skipAutoSelectMatchingDrawing: true
        });
        expect(
            document.querySelector(
                '#fontinfo-stations-content .fontinfo-record-item-primary'
            ).textContent
        ).toBe('Bold');
    });

    test('masters add, remove, and reinterpolate are disabled while the font is partly downloaded', async () => {
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
        const reason =
            'This font is only partly downloaded. Reopen it with all glyphs to add, remove, or reinterpolate masters.';
        let gate = { allowed: false, reason, canReopenWithAllGlyphs: true };
        const addStation = jest.fn();
        const removeStationsByIds = jest.fn();
        const reopenWithAllGlyphs = jest.fn().mockResolvedValue(true);
        const previousCloudPlugin = window.cloudPlugin;
        window.cloudPlugin = { reopenWithAllGlyphs };

        window.currentFontModel = {
            axes: [],
            names: {},
            features: { features: [] },
            stations: [
                {
                    id: 'M1',
                    name: { dflt: 'Regular' },
                    location: {},
                    metrics: {},
                    kerning: {}
                }
            ],
            addStation,
            removeStationsByIds,
            getStationTopologyGate: () => gate
        };

        try {
            fontInfoManager.init();
            jest.runOnlyPendingTimers();
            fontInfoManager.switchTab('masters');

            const addButton = document.querySelector(
                '[data-fontinfo-list-action="stations-add"]'
            );
            const removeButton = document.querySelector(
                '[data-fontinfo-list-action="stations-remove"]'
            );
            expect(addButton.disabled).toBe(true);
            expect(removeButton.disabled).toBe(true);
            expect(addButton.title).toBe(reason);
            expect(removeButton.title).toBe(reason);
            addButton.click();
            removeButton.click();
            expect(addStation).not.toHaveBeenCalled();
            expect(removeStationsByIds).not.toHaveBeenCalled();

            const notice = document.querySelector(
                '[data-fontinfo-stations-blocked="true"]'
            );
            expect(notice.textContent).toContain(reason);
            const reopenButton = document.querySelector(
                '[data-fontinfo-list-action="stations-reopen-all-glyphs"]'
            );
            expect(reopenButton.textContent).toBe('Reopen with all glyphs');
            reopenButton.click();
            await Promise.resolve();
            expect(reopenWithAllGlyphs).toHaveBeenCalledTimes(1);

            const stationItem = document.querySelector(
                '#fontinfo-stations-content .fontinfo-record-item'
            );
            stationItem.dispatchEvent(
                new MouseEvent('contextmenu', {
                    bubbles: true,
                    cancelable: true
                })
            );
            const menuInstance = (global.__fontInfoTippyInstances || [])
                .filter((instance) =>
                    String(instance.props?.content || '').includes(
                        'data-action="reinterpolate"'
                    )
                )
                .pop();
            expect(menuInstance.state.isVisible).toBe(true);
            const reinterpolateItem = menuInstance.popper.querySelector(
                '.plugin-menu-item[data-action="reinterpolate"]'
            );
            expect(reinterpolateItem.title).toBe(reason);
            reinterpolateItem.click();
            expect(menuInstance.state.isVisible).toBe(true);
            expect(
                reinterpolateItem.classList.contains(
                    'plugin-menu-item-disabled'
                )
            ).toBe(true);
            expect(reinterpolateItem.getAttribute('aria-disabled')).toBe(
                'true'
            );

            gate = { allowed: true };
            window.dispatchEvent(
                new CustomEvent('cloudSparseResidencyChanged')
            );
            expect(
                document.querySelector(
                    '[data-fontinfo-list-action="stations-add"]'
                ).disabled
            ).toBe(false);
            expect(
                document.querySelector(
                    '[data-fontinfo-list-action="stations-remove"]'
                ).disabled
            ).toBe(false);
            expect(
                document.querySelector(
                    '[data-fontinfo-stations-blocked="true"]'
                )
            ).toBeNull();
        } finally {
            window.cloudPlugin = previousCloudPlugin;
        }
    });

    test('masters header shows no reopen action when reopening cannot help', () => {
        document.body.innerHTML = `
                <div id="view-fontinfo" class="view view-fontinfo focused">
                    <div class="view-content">
                        <div id="browser-compat"></div>
                    </div>
                </div>
            `;

        const fontInfoManager = loadFontInfoManager();
        window.currentFontModel = {
            axes: [],
            names: {},
            features: { features: [] },
            stations: [],
            getStationTopologyGate: () => ({
                allowed: false,
                reason: 'Masters cannot be added, removed, or reinterpolated while some glyphs stay on the server.',
                canReopenWithAllGlyphs: false
            })
        };

        fontInfoManager.init();
        jest.runOnlyPendingTimers();
        fontInfoManager.switchTab('masters');

        expect(
            document.querySelector('[data-fontinfo-stations-blocked="true"]')
                .textContent
        ).toContain('stay on the server');
        expect(
            document.querySelector(
                '[data-fontinfo-list-action="stations-reopen-all-glyphs"]'
            )
        ).toBeNull();
        expect(
            document.querySelector('[data-fontinfo-list-action="stations-add"]')
                .disabled
        ).toBe(true);
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
            stations: [
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

        const stationMetricInput = document.querySelector(
            '[data-font-field="masters.0.metrics.ascender"] .localized-string-input'
        );
        stationMetricInput.focus();

        const stationItems = document.querySelectorAll(
            '#fontinfo-stations-content .fontinfo-record-item'
        );
        stationItems[0].getBoundingClientRect = () => ({
            top: 0,
            height: 20
        });

        fontInfoManager.onStationDragStart(
            {
                currentTarget: stationItems[1],
                dataTransfer: {}
            },
            1
        );
        fontInfoManager.onStationDragOver(
            {
                preventDefault: jest.fn(),
                currentTarget: stationItems[0],
                dataTransfer: {},
                clientY: 0
            },
            0
        );
        fontInfoManager.onStationDrop(
            {
                preventDefault: jest.fn()
            },
            0
        );

        const reorderedItems = document.querySelectorAll(
            '#fontinfo-stations-content .fontinfo-record-item-primary'
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
            stations: [
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

        const stationItems = document.querySelectorAll(
            '#fontinfo-stations-content .fontinfo-record-item'
        );
        stationItems[0].getBoundingClientRect = () => ({
            top: 0,
            height: 20
        });

        fontInfoManager.onStationDragStart(
            {
                currentTarget: stationItems[1],
                dataTransfer: {
                    effectAllowed: 'all',
                    setData: jest.fn()
                }
            },
            1
        );
        fontInfoManager.onStationDragOver(
            {
                preventDefault: jest.fn(),
                currentTarget: stationItems[0],
                dataTransfer: {},
                clientY: 0
            },
            0
        );
        fontInfoManager.onStationDragEnd();

        expect(applySyntheticChangeSet).toHaveBeenCalledWith(
            'Reorder stations',
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
            stations: [
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
        const stationMetricInput = document.querySelector(
            '[data-font-field="masters.0.metrics.ascender"] .localized-string-input'
        );
        stationMetricInput.focus();

        window.currentFontModel.stations = [
            window.currentFontModel.stations[1],
            window.currentFontModel.stations[0]
        ];
        window.dispatchEvent(new CustomEvent('fontModelSync'));
        jest.runOnlyPendingTimers();

        let reorderedStationItems = document.querySelectorAll(
            '#fontinfo-stations-content .fontinfo-record-item-primary'
        );
        expect(reorderedStationItems[0].textContent).toBe('Bold');
        expect(reorderedStationItems[1].textContent).toBe('Regular');

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
            stations: [
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

        const stationNameInput = document.querySelector(
            '[data-font-field="masters.0.name"] .localized-string-input'
        );
        stationNameInput.focus();
        stationNameInput.value = 'Text';
        stationNameInput.dispatchEvent(
            new KeyboardEvent('keydown', {
                key: 'Enter',
                bubbles: true
            })
        );

        const stationLocationInput = document.querySelector(
            '[data-font-field="masters.0.location.wght"] .localized-string-input'
        );
        stationLocationInput.focus();
        stationLocationInput.value = '650';
        stationLocationInput.dispatchEvent(
            new KeyboardEvent('keydown', {
                key: 'Enter',
                bubbles: true
            })
        );

        expect(
            document.querySelector(
                '#fontinfo-stations-content .fontinfo-record-item-primary'
            ).textContent
        ).toBe('Text');
        expect(
            document.querySelector(
                '#fontinfo-stations-content .fontinfo-record-item-secondary'
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

    test('axes list controls add, remove, and reorder through the patch funnel', async () => {
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
        await addAxisThroughDialog(addAxesButton, 'commit');

        expect(applySyntheticChangeSet).toHaveBeenCalledWith(
            'Add Optical Size axis',
            [
                {
                    op: 'set',
                    path: ['axes'],
                    oldValue: expect.any(Array),
                    newValue: expect.arrayContaining([
                        expect.objectContaining({
                            name: { dflt: 'Optical Size' },
                            tag: 'opsz'
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

    test('adding an axis with masters sends one plan to the model', async () => {
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
            stations: [
                {
                    id: 'M1',
                    name: { dflt: 'Regular' },
                    location: { wght: 400 },
                    metrics: { ascender: 800 },
                    kerning: {}
                }
            ],
            addAxisWithStationCopies: jest.fn(async () => {}),
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

        const addAxesButton = document.querySelector(
            '[data-fontinfo-list-action="axes-add"]'
        );
        await addAxisThroughDialog(addAxesButton, 'commit');

        const addAxisWithStationCopies =
            window.currentFontModel.addAxisWithStationCopies;
        expect(addAxisWithStationCopies).toHaveBeenCalledTimes(1);
        const [plan, label] = addAxisWithStationCopies.mock.calls[0];
        expect(label).toBe('Add Width axis with 1 station');
        expect(plan.axisTag).toBe('wdth');
        expect(plan.existingValue).toBe(100);
        expect(plan.axes.map((axis) => axis.tag)).toEqual(['wght', 'wdth']);
        expect(plan.masters).toHaveLength(2);
        expect(plan.masters[0].location).toEqual({ wght: 400, wdth: 100 });
        expect(plan.masters[1]).toMatchObject({
            name: { dflt: 'Expanded' },
            location: { wght: 400, wdth: 125 },
            metrics: { ascender: 800 }
        });
        expect(plan.copies).toEqual([
            {
                sourceMasterId: 'M1',
                newMasterId: plan.masters[1].id,
                value: 125
            }
        ]);
        expect(plan.instances[0].location).toEqual({ wght: 400, wdth: 100 });
        expect(applySyntheticChangeSet).not.toHaveBeenCalled();
    });

    test('adding and removing axes syncs master and instance location fields', async () => {
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
            stations: [
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
        await addAxisThroughDialog(addAxesButton, 'axis-only');

        const addCall = applySyntheticChangeSet.mock.calls.find(
            ([label]) => label === 'Add Width axis'
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
        const stationLocationChange = addChanges.find(
            (c) =>
                c.path.length === 3 &&
                c.path[0] === 'masters' &&
                c.path[1] === 0 &&
                c.path[2] === 'location'
        );
        expect(stationLocationChange).toBeDefined();
        expect(stationLocationChange.newValue).toMatchObject({ wght: 400 });
        expect(Object.keys(stationLocationChange.newValue)).toHaveLength(2); // wght + new tag

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
        const stationRemoveChange = removeChanges.find(
            (c) =>
                c.path.length === 3 &&
                c.path[0] === 'masters' &&
                c.path[2] === 'location'
        );
        expect(stationRemoveChange).toBeDefined();
        expect(Object.keys(stationRemoveChange.newValue ?? {})).toHaveLength(1);
        expect(stationRemoveChange.newValue).toHaveProperty('wght');
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
        const addStation = jest.fn(async function () {
            const createdStation = {
                id: 'M2',
                name: { dflt: 'Master 2' },
                location: {},
                metrics: { ascender: 800 },
                kerning: {}
            };
            this.stations = [...this.stations, createdStation];
            return createdStation;
        });
        window.currentFontModel = {
            axes: [],
            names: {},
            features: { features: [] },
            stations: [
                {
                    id: 'M1',
                    name: { dflt: 'Regular' },
                    location: {},
                    metrics: { ascender: 800 },
                    kerning: {}
                }
            ],
            glyphs: [],
            addStation
        };

        fontInfoManager.init();
        jest.runOnlyPendingTimers();
        fontInfoManager.switchTab('masters');

        const addStationButton = document.querySelector(
            '[data-fontinfo-list-action="stations-add"]'
        );
        addStationButton.click();

        await Promise.resolve();

        expect(addStation).toHaveBeenCalledTimes(1);
        expect(window.currentFontModel.stations).toHaveLength(2);
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
        const addStation = jest.fn(async function (_station, options) {
            const createdStation = {
                id: 'M3',
                name: { dflt: 'Master 3' },
                location: options?.location ?? {},
                metrics: { ascender: 800 },
                kerning: {}
            };
            this.stations = [...this.stations, createdStation];
            return createdStation;
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
            stations: [
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
            addStation
        };

        fontInfoManager.init();
        jest.runOnlyPendingTimers();
        fontInfoManager.switchTab('masters');

        const addStationButton = document.querySelector(
            '[data-fontinfo-list-action="stations-add"]'
        );
        addStationButton.click();

        expect(addStation).not.toHaveBeenCalled();

        const modal = document.querySelector(
            '.fontinfo-station-location-modal'
        );
        expect(modal).toBeTruthy();

        const wghtInput = modal.querySelector(
            '[data-station-location-axis="wght"]'
        );
        const wdthInput = modal.querySelector(
            '[data-station-location-axis="wdth"]'
        );
        expect(wghtInput.value).toBe('700');
        expect(wdthInput.value).toBe('120');

        wghtInput.value = '650';
        wdthInput.value = '110';

        const createButton = modal.querySelector(
            '.fontinfo-station-location-create'
        );
        createButton.click();
        await Promise.resolve();
        await Promise.resolve();

        expect(addStation).toHaveBeenCalledWith(
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
        const addStation = jest.fn();

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
            stations: [
                {
                    id: 'M1',
                    name: { dflt: 'Regular' },
                    location: { wght: 400 },
                    metrics: { ascender: 800 },
                    kerning: {}
                }
            ],
            glyphs: [],
            addStation
        };

        fontInfoManager.init();
        jest.runOnlyPendingTimers();
        fontInfoManager.switchTab('masters');

        const addStationButton = document.querySelector(
            '[data-fontinfo-list-action="stations-add"]'
        );
        addStationButton.click();

        const modal = document.querySelector(
            '.fontinfo-station-location-modal'
        );
        expect(modal).toBeTruthy();

        const cancelButton = modal.querySelector(
            '.fontinfo-station-location-cancel'
        );
        cancelButton.click();
        await Promise.resolve();

        expect(addStation).not.toHaveBeenCalled();
        expect(
            document.querySelector('.fontinfo-station-location-modal')
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
        const removeStationsByIds = jest.fn(async function (stationIds) {
            this.stations = this.stations.filter(
                (station) => !stationIds.includes(station.id)
            );
            return true;
        });
        window.currentFontModel = {
            axes: [],
            names: {},
            features: { features: [] },
            stations: [
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
            removeStationsByIds
        };

        fontInfoManager.init();
        jest.runOnlyPendingTimers();
        fontInfoManager.switchTab('masters');

        // Select M2 (index 1)
        const stationItems = document.querySelectorAll(
            '#fontinfo-stations-content .fontinfo-record-item'
        );
        stationItems[1].click();

        fontInfoManager.setDeleteConfirmationHandler(true);
        document
            .querySelector('[data-fontinfo-list-action="stations-remove"]')
            .click();

        await Promise.resolve();

        expect(removeStationsByIds).toHaveBeenCalledWith(['M2']);
        expect(window.currentFontModel.stations).toHaveLength(1);
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
            stations: [
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
            .querySelector('[data-fontinfo-list-action="stations-remove"]')
            .click();

        // No transaction should have been started
        expect(beginTransaction).not.toHaveBeenCalledWith('Remove station');
        expect(applySyntheticChangeSet).not.toHaveBeenCalledWith(
            'Remove station',
            expect.anything()
        );
        // List is unchanged
        expect(
            document.querySelectorAll(
                '#fontinfo-stations-content .fontinfo-record-item'
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
        const removeStationsByIds = jest.fn(async function (stationIds) {
            this.stations = this.stations.filter(
                (station) => !stationIds.includes(station.id)
            );
            return true;
        });

        window.currentFontModel = {
            axes: [],
            names: {},
            features: { features: [] },
            stations: [
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
            removeStationsByIds
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

        const stationItems = () =>
            document.querySelectorAll(
                '#fontinfo-stations-content .fontinfo-record-item'
            );

        // Click M1 (index 0) to select it
        stationItems()[0].click();

        // Ctrl+click M3 (index 2) to add to selection
        stationItems()[2].dispatchEvent(
            new MouseEvent('click', { bubbles: true, metaKey: true })
        );

        // Both 0 and 2 should be selected
        expect(stationItems()[0].classList.contains('selected')).toBe(true);
        expect(stationItems()[1].classList.contains('selected')).toBe(false);
        expect(stationItems()[2].classList.contains('selected')).toBe(true);

        // Delete the selection
        fontInfoManager.setDeleteConfirmationHandler(true);
        document
            .querySelector('[data-fontinfo-list-action="stations-remove"]')
            .click();

        await Promise.resolve();

        // Only M2 (index 1) should remain
        expect(removeStationsByIds).toHaveBeenCalledWith(['M1', 'M3']);
        expect(stationItems()).toHaveLength(1);
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
            stations: [
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
            stations: [
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

describe('FontInfo features: add, delete and rename', () => {
    const GENERATOR_STAMP = {
        'com.counterpunch.generator': {
            generator: 'space.counterpunch.test',
            capability: 'test',
            block: 'test'
        }
    };

    let modules;

    function loadFeaturesPanel(model) {
        jest.resetModules();
        const originalReadyState = document.readyState;
        const originalAce = window.ace;
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
                return {
                    TextHighlightRules: function TextHighlightRules() {}
                };
            }),
            define: jest.fn()
        };
        jest.isolateModules(() => {
            modules = {
                fontInfoManager: require('../js/font-info').fontInfoManager,
                PatchSyncEngine: require('../js/patch-sync-engine')
                    .PatchSyncEngine,
                Font: require('../js/babelfont-model').Font,
                fromYType: require('../js/change-bridge-ydoc').fromYType
            };
        });
        Object.defineProperty(document, 'readyState', {
            configurable: true,
            value: originalReadyState
        });
        window.ace = originalAce;

        document.body.innerHTML = `
            <div id="view-fontinfo" class="view view-fontinfo focused">
                <div class="view-title-bar"><div class="view-title-right">
                    <div id="fontinfo-search-control"><input id="fontinfo-search-input" /></div>
                </div></div>
                <div class="view-content"><div id="browser-compat"></div></div>
            </div>`;
        window.currentFontModel = model;
        const manager = modules.fontInfoManager;
        manager.init();
        manager.switchTab('features');
        let editorValue = '';
        manager.featuresEditor = {
            isFocused: jest.fn(() => false),
            setValue: jest.fn((value) => {
                editorValue = value;
            }),
            getValue: jest.fn(() => editorValue),
            focus: jest.fn(),
            session: { setUseWrapMode: jest.fn(), removeMarker: jest.fn() }
        };
        manager.loadAllLists();
        return manager;
    }

    function plainModel(features, extra = {}) {
        return {
            features: { prefixes: {}, classes: {}, features: [], ...features },
            analyzeFeatureTables: jest.fn(() => ({
                hasGSUB: true,
                hasGPOS: false
            })),
            analyzePrefix: jest.fn(() => ({ hasGSUB: false, hasGPOS: false })),
            ...extra
        };
    }

    function mockBridge() {
        window.patchSyncEngine = {
            beginTransaction: jest.fn(),
            endTransaction: jest.fn(),
            applySyntheticChangeSet: jest.fn()
        };
        return window.patchSyncEngine;
    }

    async function settle() {
        for (let i = 0; i < 5; i += 1) {
            await Promise.resolve();
        }
    }

    function row(listId, text) {
        return [
            ...document.querySelectorAll(`#${listId} .feature-list-item`)
        ].find((item) => item.textContent.includes(text));
    }

    function sectionButton(action, type) {
        return document.querySelector(
            `[data-features-action="${action}"][data-features-type="${type}"]`
        );
    }

    function typeInto(input, value) {
        input.value = value;
        input.dispatchEvent(new Event('input'));
    }

    function pressKey(element, key) {
        element.dispatchEvent(
            new KeyboardEvent('keydown', { key, bubbles: true })
        );
    }

    beforeEach(() => {
        global.ResizeObserver =
            global.ResizeObserver ||
            class ResizeObserver {
                observe() {}
                disconnect() {}
            };
        Element.prototype.scrollIntoView = jest.fn();
        // Earlier tests can leave open menus and modal Escape bindings, which
        // take Escape first, and a font manager.
        for (const instance of global.__fontInfoTippyInstances || []) {
            instance.state.isVisible = false;
        }
        if (window.__modalEscapeRuntime) {
            window.__modalEscapeRuntime.stack = [];
        }
        window.fontManager = {
            currentFont: { markDirty: jest.fn() },
            isReady: jest.fn(() => false),
            setEditingCompileContext: jest.fn()
        };
    });

    afterEach(() => {
        document.body.innerHTML = '';
        delete window.fontManager;
        delete window.currentFontModel;
        delete window.patchSyncEngine;
        delete window.changeBridge;
        delete window.fontInfoManager;
    });

    test.each([
        ['prefix', 'Lookups'],
        ['class', 'vowels']
    ])(
        '%s code edits record the key the panel undo scope uses',
        (type, key) => {
            const bridge = mockBridge();
            const manager = loadFeaturesPanel(
                plainModel({
                    prefixes: { Lookups: { code: 'lookup a {} a;' } },
                    classes: { vowels: { code: 'a e' } }
                })
            );
            manager.selectItem(type, key);
            manager.featuresEditor.getValue = jest.fn(() => 'edited');

            manager.commitFeatureCodeChanges();

            const scopeKey = manager.getHistoryScopeTarget().key;
            expect(scopeKey).toBe(`${type}:${key}`);
            expect(bridge.beginTransaction).toHaveBeenCalledWith(
                'Edit feature code',
                { type, key: scopeKey, label: key },
                expect.anything()
            );
        }
    );

    test('the add button adds a uniquely named class in one step and opens its name for editing', () => {
        const bridge = mockBridge();
        const model = plainModel({ classes: { class1: { code: 'a' } } });
        const manager = loadFeaturesPanel(model);

        sectionButton('add', 'class').click();

        expect(model.features.classes.class2).toEqual({
            code: '',
            automatic: false
        });
        expect(bridge.beginTransaction).toHaveBeenCalledWith(
            'Add class',
            { type: 'class', key: 'class:class2', label: 'class2' },
            { compileChangeSource: 'feature-code', compileEditType: 'feature' }
        );
        expect(bridge.endTransaction).toHaveBeenCalledTimes(1);
        const input = document.querySelector('.feature-rename-input');
        expect(input.value).toBe('class2');

        typeInto(input, 'caps');
        pressKey(input, 'Enter');

        expect(Object.keys(model.features.classes)).toEqual(['class1', 'caps']);
        expect(bridge.beginTransaction).toHaveBeenLastCalledWith(
            'Rename class',
            { type: 'class', key: 'class:caps', label: 'caps' },
            expect.anything()
        );
        expect(manager.selectedItem).toEqual({ type: 'class', key: 'caps' });
        expect(sectionButton('remove', 'class').disabled).toBe(false);
        expect(sectionButton('remove', 'prefix').disabled).toBe(true);
    });

    test('inline rename shows name errors and Escape keeps the old name', () => {
        const bridge = mockBridge();
        const model = plainModel({
            classes: { lc: { code: 'a' }, uc: { code: 'A' } }
        });
        loadFeaturesPanel(model);

        row('classes-list', 'lc').dispatchEvent(
            new MouseEvent('dblclick', { bubbles: true })
        );
        const input = document.querySelector('.feature-rename-input');
        typeInto(input, 'uc');
        expect(
            document.querySelector('.feature-rename-error').textContent
        ).toBe('A class named “uc” already exists.');
        pressKey(input, 'Enter');
        expect(document.querySelector('.feature-rename-input')).toBe(input);

        typeInto(input, '@lc');
        expect(
            document.querySelector('.feature-rename-error').textContent
        ).toBe('Leave out the “@”. Counterpunch adds it.');
        pressKey(input, 'Escape');

        expect(document.querySelector('.feature-rename-input')).toBeNull();
        expect(document.querySelector('.feature-rename-error')).toBeNull();
        expect(Object.keys(model.features.classes)).toEqual(['lc', 'uc']);
        expect(bridge.beginTransaction).not.toHaveBeenCalled();
    });

    test('renaming a class can update its references in the same step', async () => {
        const bridge = mockBridge();
        const model = plainModel({
            classes: { lc: { code: 'a b' }, all: { code: '@lc @uc' } },
            features: [['smcp', { code: 'sub @lc by @lc.sc; # @lc' }]]
        });
        const manager = loadFeaturesPanel(model);

        manager.startRenameItem('class', 'lc');
        const input = document.querySelector('.feature-rename-input');
        typeInto(input, 'lower');
        pressKey(input, 'Enter');
        await settle();

        expect(document.querySelector('.confirm-dialog p').textContent).toBe(
            'Update 2 references to “@lc” in 2 items?'
        );
        document.querySelector('[data-choice="update"]').click();
        await settle();

        expect(model.features.classes.lower).toEqual({ code: 'a b' });
        expect(model.features.classes.lc).toBeUndefined();
        expect(model.features.classes.all.code).toBe('@lower @uc');
        expect(model.features.features[0][1].code).toBe(
            'sub @lower by @lc.sc; # @lc'
        );
        expect(bridge.beginTransaction).toHaveBeenCalledTimes(1);
    });

    test('deleting a feature asks first and selects its neighbor', async () => {
        const bridge = mockBridge();
        const model = plainModel({
            features: [
                ['liga', { code: 'a' }],
                ['kern', { code: 'b' }],
                ['calt', { code: 'c' }]
            ]
        });
        const manager = loadFeaturesPanel(model);
        manager.selectItem('feature', 1);

        manager.setDeleteConfirmationHandler(false);
        sectionButton('remove', 'feature').click();
        await settle();
        expect(model.features.features).toHaveLength(3);

        manager.setDeleteConfirmationHandler(true);
        sectionButton('remove', 'feature').click();
        await settle();

        expect(model.features.features.map(([tag]) => tag)).toEqual([
            'liga',
            'calt'
        ]);
        expect(manager.selectedItem).toEqual({ type: 'feature', key: 1 });
        expect(manager.selectedFeatureTag).toBe('calt');
        // Recorded under the feature now selected, so undo here reaches it.
        expect(bridge.beginTransaction).toHaveBeenCalledWith(
            'Delete feature',
            { type: 'feature', key: 'feature:calt:1', label: 'calt' },
            expect.anything()
        );
    });

    test('deleting a generated feature that Counterpunch manages offers to turn automatic off', async () => {
        const bridge = mockBridge();
        const model = plainModel(
            {
                features: [
                    [
                        'ccmp',
                        {
                            code: 'sub a by a;',
                            automatic: true,
                            format_specific: GENERATOR_STAMP
                        }
                    ]
                ]
            },
            { counterpunchManagesFeatures: true }
        );
        const manager = loadFeaturesPanel(model);

        const done = manager.deleteFeatureItem('feature', 0);
        await settle();
        expect(document.querySelector('.confirm-dialog h3').textContent).toBe(
            'Delete Generated Code'
        );
        document.querySelector('[data-choice="turn-off"]').click();
        await done;

        expect(model.features.features).toHaveLength(1);
        expect(bridge.applySyntheticChangeSet).toHaveBeenCalledWith(
            'Turn off automatic generation',
            [
                {
                    op: 'set',
                    path: ['features', 'features', 0, 1, 'automatic'],
                    oldValue: true,
                    newValue: false
                }
            ],
            expect.anything()
        );
    });

    test('adding a feature checks the tag and inserts it after the selection', async () => {
        mockBridge();
        const model = plainModel({
            features: [
                ['kern', { code: 'a' }],
                ['calt', { code: 'b' }]
            ]
        });
        const manager = loadFeaturesPanel(model);
        manager.selectItem('feature', 0);

        sectionButton('add', 'feature').click();
        const input = document.querySelector('#feature-tag-input');
        const status = document.querySelector('.feature-tag-status');
        const confirm = document.querySelector('[data-role="confirm"]');

        expect(confirm.disabled).toBe(true);
        typeInto(input, 'ligatures');
        expect(status.dataset.level).toBe('error');
        expect(confirm.disabled).toBe(true);

        typeInto(input, 'ligs');
        expect(status.dataset.level).toBe('warning');
        expect(confirm.textContent).toBe('Add anyway');
        document.querySelector('.feature-tag-suggestion').click();
        expect(input.value).toBe('liga');
        expect(status.textContent).toBe('Standard Ligatures');
        expect(confirm.textContent).toBe('Add');

        // A tag the font already uses is fine.
        typeInto(input, 'kern');
        expect(status.dataset.level).toBe('ok');
        confirm.click();
        await settle();

        expect(model.features.features).toEqual([
            ['kern', { code: 'a' }],
            ['kern', { code: '', automatic: false }],
            ['calt', { code: 'b' }]
        ]);
        expect(manager.selectedItem).toEqual({ type: 'feature', key: 1 });
        expect(document.querySelector('.feature-tag-dialog')).toBeNull();
    });

    test('renaming a feature changes only its tag', async () => {
        const bridge = mockBridge();
        const model = plainModel({
            features: [['liga', { code: 'sub f i by fi;' }]]
        });
        const manager = loadFeaturesPanel(model);

        const done = manager.renameFeature(0);
        const input = document.querySelector('#feature-tag-input');
        expect(input.value).toBe('liga');
        typeInto(input, 'dlig');
        pressKey(input, 'Enter');
        await done;

        expect(model.features.features).toEqual([
            ['dlig', { code: 'sub f i by fi;' }]
        ]);
        expect(bridge.beginTransaction).toHaveBeenCalledWith(
            'Rename feature',
            { type: 'feature', key: 'feature:dlig:1', label: 'dlig' },
            expect.anything()
        );
        expect(manager.selectedFeatureTag).toBe('dlig');
    });

    test('flags invalid and unregistered tags but not duplicate ones', () => {
        mockBridge();
        const manager = loadFeaturesPanel(
            plainModel({
                features: [
                    ['ligs', { code: '' }],
                    ['kern', { code: '' }],
                    ['kern', { code: '' }],
                    ['ABCD', { code: '' }]
                ]
            })
        );

        const ligs = row('features-list', 'ligs');
        expect(ligs.querySelector('.feature-name').textContent).toBe(
            'Unregistered tag'
        );
        expect(
            ligs.querySelector('.feature-tag-issue-icon.is-warning').title
        ).toBe('“ligs” isn’t a registered feature.');
        expect(
            document.querySelectorAll(
                '#features-list .feature-list-item .feature-tag-issue-icon'
            )
        ).toHaveLength(1);
        expect(
            row('features-list', 'ABCD').querySelector('.feature-name')
                .textContent
        ).toBe('Custom feature');

        manager.selectItem('feature', 0);
        const issue = document.getElementById('feature-tag-issue');
        expect(issue.hidden).toBe(false);
        expect(issue.textContent).toContain(
            '“ligs” isn’t a registered feature.'
        );
        manager.selectItem('feature', 1);
        expect(issue.hidden).toBe(true);
    });

    test('the automatic checkbox appears only for generated code', () => {
        const bridge = mockBridge();
        const manager = loadFeaturesPanel(
            plainModel({
                features: [
                    ['liga', { code: 'a', automatic: true }],
                    [
                        'ccmp',
                        {
                            code: 'b',
                            automatic: true,
                            format_specific: GENERATOR_STAMP
                        }
                    ],
                    ['kern', { code: 'c' }]
                ]
            })
        );
        const label = document.getElementById('feature-automatic-label');
        const notice = document.getElementById('feature-automatic-notice');
        const keep = document.getElementById('feature-keep-code-button');

        manager.selectItem('feature', 0);
        expect(label.hidden).toBe(true);
        expect(notice.hidden).toBe(false);
        expect(notice.textContent).toContain(
            'Marked automatic in the source file.'
        );
        expect(keep.hidden).toBe(false);

        manager.selectItem('feature', 1);
        expect(label.hidden).toBe(false);
        expect(notice.hidden).toBe(true);

        manager.selectItem('feature', 2);
        expect(label.hidden).toBe(true);
        expect(notice.hidden).toBe(true);

        manager.selectItem('feature', 0);
        keep.click();
        expect(bridge.applySyntheticChangeSet).toHaveBeenCalledWith(
            'Keep my code',
            [
                {
                    op: 'set',
                    path: ['features', 'features', 0, 1, 'automatic'],
                    oldValue: true,
                    newValue: false
                }
            ],
            expect.anything()
        );
    });

    test('the code editor is read-only with nothing selected or for automatic code', () => {
        mockBridge();
        const manager = loadFeaturesPanel(
            plainModel({
                features: [
                    ['liga', { code: 'a', automatic: true }],
                    [
                        'ccmp',
                        {
                            code: 'b',
                            automatic: true,
                            format_specific: GENERATOR_STAMP
                        }
                    ],
                    ['kern', { code: 'c' }]
                ]
            })
        );
        const setReadOnly = jest.fn();
        manager.featuresEditor.setReadOnly = setReadOnly;
        const editorElement = document.getElementById('features-editor');
        const readOnly = () => setReadOnly.mock.calls.at(-1)[0];

        manager.clearEditor();
        expect(readOnly()).toBe(true);
        expect(editorElement.classList.contains('is-read-only')).toBe(true);

        manager.selectItem('feature', 2);
        expect(readOnly()).toBe(false);
        expect(editorElement.classList.contains('is-read-only')).toBe(false);

        manager.selectItem('feature', 0);
        expect(readOnly()).toBe(true);
        manager.selectItem('feature', 1);
        expect(readOnly()).toBe(true);

        // “Keep my code” clears the flag, which makes the code editable.
        manager.selectItem('feature', 0);
        document.getElementById('feature-keep-code-button').click();
        expect(readOnly()).toBe(false);
    });

    test('the context menu offers “Mark as automatic for Glyphs” only for plain code', () => {
        const bridge = mockBridge();
        loadFeaturesPanel(
            plainModel({
                features: [
                    ['liga', { code: 'a' }],
                    ['kern', { code: 'b', automatic: true }]
                ]
            })
        );
        const menu = global.__fontInfoTippyInstances.at(-1);
        const openMenu = (text) =>
            row('features-list', text).dispatchEvent(
                new MouseEvent('contextmenu', { bubbles: true })
            );

        openMenu('kern');
        expect(
            menu.popper.querySelector('[data-action="mark-automatic"]')
        ).toBeNull();

        openMenu('liga');
        const actions = [
            ...menu.popper.querySelectorAll('.plugin-menu-item')
        ].map((item) => item.dataset.action);
        expect(actions).toEqual([
            'rename',
            'duplicate',
            'delete',
            'mark-automatic'
        ]);
        menu.popper.querySelector('[data-action="mark-automatic"]').click();
        expect(bridge.applySyntheticChangeSet).toHaveBeenCalledWith(
            'Mark as automatic for Glyphs',
            [expect.objectContaining({ newValue: true })],
            expect.anything()
        );
    });

    test('structural changes reach the sync document as granular operations', async () => {
        const json = {
            upm: 1000,
            names: { familyName: 'StructureTest' },
            axes: [],
            instances: [],
            masters: [{ id: 'm1', name: { dflt: 'Regular' }, location: {} }],
            glyphs: [],
            features: {
                classes: { vowels: { code: 'a e' } },
                prefixes: {},
                features: [['liga', { code: 'sub f i by fi;' }]]
            }
        };
        mockBridge();
        const manager = loadFeaturesPanel(plainModel({}));
        const bridge = new modules.PatchSyncEngine('features-structure');
        bridge.initFromJson(json);
        window.patchSyncEngine = bridge;
        window.currentFontModel = modules.Font.fromData(json);
        manager.loadAllLists();
        manager.setDeleteConfirmationHandler(true);
        const syncedFeatures = () =>
            modules.fromYType(bridge.fontMap.get('features'));

        await manager.renameNamedItem('class', 'vowels', 'vow');
        manager.duplicateFeatureItem('feature', 0);
        await manager.deleteFeatureItem('feature', 0);

        expect(syncedFeatures()).toEqual(
            expect.objectContaining({
                classes: { vow: { code: 'a e' } },
                features: [
                    ['liga', { code: 'sub f i by fi;', automatic: false }]
                ]
            })
        );
        const paths = bridge
            .getChangeLog()
            .map(
                (entry) =>
                    `${entry.transactionLabel}: ${entry.op} ${entry.path}`
            );
        expect(paths).toEqual(
            expect.arrayContaining([
                'Rename class: remove features.classes.vowels',
                'Rename class: set features.classes.vow'
            ])
        );
        expect(
            paths.filter((path) => path.startsWith('Rename class'))
        ).toHaveLength(2);
        bridge.destroy();
    });
});
