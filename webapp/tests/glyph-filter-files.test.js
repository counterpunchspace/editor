jest.mock('tippy.js', () => ({
    __esModule: true,
    default: jest.fn(() => ({
        destroy: jest.fn(),
        setProps: jest.fn(),
        show: jest.fn(),
        hide: jest.fn()
    }))
}));
jest.mock('tippy.js/dist/tippy.css', () => ({}), { virtual: true });

const {
    readFilterDescription,
    writeFilterDescription
} = require('../js/glyph-filter-description');
const {
    validateFilterName,
    nextFreeFilterName
} = require('../js/glyph-filter-names');
const { createGlyphFilterTemplate } = require('../js/glyph-filter-template');
const {
    renderGlyphFilterLegend,
    buildGlyphFilterLegendGroups
} = require('../js/glyph-filter-legend');
const { GlyphOverviewFilterManager } = require('../js/glyph-overview-filters');
const { settingsFolder } = require('../js/settings-folder');

describe('filter description docstring', () => {
    test('reads a missing docstring as empty', () => {
        expect(readFilterDescription('EVENT_TYPES = []\n')).toBe('');
        expect(readFilterDescription('# only a comment\nx = "a"\n')).toBe('');
        expect(readFilterDescription('"a".upper()\n')).toBe('');
    });

    test('reads triple-quote styles, prefixes and escapes after comments', () => {
        expect(
            readFilterDescription('# header\n\n"""\n    Show encoded.\n"""\n')
        ).toBe('Show encoded.');
        expect(readFilterDescription("'''One\n    two'''\n")).toBe('One\ntwo');
        expect(readFilterDescription('"Short"  # note\n')).toBe('Short');
        expect(readFilterDescription('"""Say \\"""hi\\""" \\\\o/"""')).toBe(
            'Say """hi""" \\o/'
        );
        expect(readFilterDescription('r"""a\\nb"""')).toBe('a\\nb');
    });

    test('template starts with an empty description', () => {
        const template = createGlyphFilterTemplate('X');
        expect(readFilterDescription(template)).toBe('');
        expect(template.startsWith('"""')).toBe(true);
    });

    test('writes and round-trips text, keeping the rest of the file', () => {
        const template = createGlyphFilterTemplate('X');
        const text = 'Glyphs with """quotes""" and C:\\path\nSecond line';
        const written = writeFilterDescription(template, text);
        expect(readFilterDescription(written)).toBe(text);
        expect(written.slice(written.indexOf('# "X" Filter'))).toBe(
            template.slice(template.indexOf('# "X" Filter'))
        );
        expect(
            readFilterDescription(writeFilterDescription(written, 'New'))
        ).toBe('New');
        expect(readFilterDescription(writeFilterDescription(written, ''))).toBe(
            ''
        );
    });

    test('keeps the quote style and adds a docstring after a coding line', () => {
        expect(writeFilterDescription("'''Old'''\nx = 1\n", 'New')).toBe(
            "'''\nNew\n'''\nx = 1\n"
        );
        const added = writeFilterDescription(
            '# -*- coding: utf-8 -*-\nx = 1\n',
            'Hi'
        );
        expect(added).toBe('# -*- coding: utf-8 -*-\n"""\nHi\n"""\nx = 1\n');
        expect(readFilterDescription(added)).toBe('Hi');
    });
});

describe('filter names', () => {
    test('rejects forbidden characters, empty names and clashes ignoring case', () => {
        for (const bad of [
            'a/b',
            'a\\b',
            'a:b',
            'a*',
            'a?',
            'a"',
            '<a>',
            'a|b'
        ]) {
            expect(validateFilterName(bad, [])).toMatch(/cannot contain/);
        }
        expect(validateFilterName('  ', [])).toBe('Enter a name.');
        expect(validateFilterName('.py', [])).toBe('Enter a name.');
        expect(validateFilterName('Encoded', ['encoded'])).toMatch(
            /already exists/
        );
        expect(validateFilterName('encoded.py', ['Encoded.py'])).toMatch(
            /already exists/
        );
        expect(validateFilterName('Other', ['Encoded'])).toBeNull();
        // A case-only rename of the file itself is allowed.
        expect(
            validateFilterName('encoded', ['Encoded', 'Other'], 'Encoded')
        ).toBeNull();
    });

    test('picks the next free "New Filter" name', () => {
        expect(nextFreeFilterName([])).toBe('New Filter');
        expect(nextFreeFilterName(['new filter', 'New Filter 2'])).toBe(
            'New Filter 3'
        );
    });
});

describe('filter group legend', () => {
    test('renders dot, name and count and reports clicks', () => {
        const container = document.createElement('div');
        const groups = buildGlyphFilterLegendGroups(
            {
                Lower: { description: 'Lower', color: 'red' },
                Plain: { description: 'Plain', color: '' }
            },
            ['Lower', 'Plain', 'Unknown'],
            [{ groups: ['Lower'] }, { groups: ['Lower', 'Plain'] }]
        );
        const onClick = jest.fn();
        const items = renderGlyphFilterLegend(container, groups, onClick);
        expect([...items.keys()]).toEqual(['Lower', 'Plain']);
        const lower = items.get('Lower');
        expect(
            lower.querySelector('.glyph-filter-legend-circle')
        ).not.toBeNull();
        expect(
            items.get('Plain').querySelector('.glyph-filter-legend-circle')
        ).toBeNull();
        expect(
            lower.querySelector('.glyph-filter-legend-count').textContent
        ).toBe('2');
        lower.click();
        expect(onClick).toHaveBeenCalledWith('Lower', lower, expect.anything());

        renderGlyphFilterLegend(container, [], onClick);
        expect(container.style.display).toBe('none');
    });
});

function makeFakePyodide(classifications, syntaxError = '') {
    const globals = new Map();
    return {
        globals,
        pyodide: {
            globals: { set: (name, value) => globals.set(name, value) },
            runPython: jest.fn((code) => {
                if (code.includes('_cp_filter_syntax_error')) {
                    return syntaxError;
                }
                if (code.includes('exec(__glyph_filter_source')) {
                    return false;
                }
                if (code.includes('_cp_classify_filter_glyphs')) {
                    return {
                        toJs: () =>
                            new Map(
                                globals
                                    .get('__glyph_filter_glyphs')
                                    .map((glyph) => [
                                        glyph.name,
                                        classifications[glyph.name] ?? false
                                    ])
                            )
                    };
                }
                return undefined;
            })
        }
    };
}

const VALID_FILTER = `EVENT_TYPES = ["glyph.unicode.changed"]

def classify_glyph(glyph):
    return True
`;

describe('EVENT_TYPES check', () => {
    // The Python syntax step needs Pyodide; this checks EVENT_TYPES only.
    let savedPyodide;
    beforeEach(() => {
        savedPyodide = window.pyodide;
        delete window.pyodide;
    });
    afterEach(() => {
        window.pyodide = savedPyodide;
    });

    const check = (eventTypes) =>
        new GlyphOverviewFilterManager().validateFilterSource(
            `EVENT_TYPES = ${eventTypes}\n\ndef classify_glyph(glyph):\n    return glyph.name.endswith(".sc")\n`
        );

    test('an empty list is valid for a filter that only reads names', () => {
        for (const empty of [
            '[]',
            '()',
            '{}',
            'set()',
            '[\n    # names only\n]'
        ]) {
            expect(check(empty)).toEqual({ eventTypes: [], errors: [] });
        }
    });

    test('listed events are kept and comments are allowed', () => {
        expect(
            check('[\n    "glyph.unicode.changed",  # encoding\n]').eventTypes
        ).toEqual(['glyph.unicode.changed']);
    });

    test('unknown, lifecycle or non-literal entries are still rejected', () => {
        for (const bad of ['[FOO]', '["glyph.renamed"]', '["nope"]']) {
            expect(check(bad).errors[0]).toMatchObject({ kind: 'contract' });
        }
    });
});

describe('GlyphOverviewFilterManager.previewFilter', () => {
    let manager;

    beforeEach(() => {
        manager = new GlyphOverviewFilterManager();
        manager.glyphOverview = {
            setActiveFilter: jest.fn(),
            showFilterError: jest.fn(),
            showFilterNotice: jest.fn()
        };
        window.currentFontModel = {
            glyphs: [{ name: 'a' }, { name: 'b' }, { name: 'c' }]
        };
    });

    afterEach(() => {
        delete window.pyodide;
        delete window.currentFontModel;
    });

    test('returns matches, groups and colors without touching the manager', async () => {
        const fake = makeFakePyodide({
            c: { groups: [{ name: 'Round', color: 'red' }] },
            a: {
                groups: [
                    { name: 'Round', color: 'red' },
                    { name: 'Low', color: 'blue' }
                ]
            },
            b: false
        });
        window.pyodide = fake.pyodide;
        const active = { keyword: 'x' };
        manager.activeFilter = active;
        manager.userFilters = [];

        const preview = await manager.previewFilter(VALID_FILTER);

        expect(preview.ok).toBe(true);
        expect(preview.errors).toEqual([]);
        expect(preview.glyphNames).toEqual(['a', 'c']);
        expect(preview.results[0]).toMatchObject({
            glyph_name: 'a',
            groups: ['Round', 'Low'],
            colors: ['red', 'blue']
        });
        expect(preview.groups).toEqual([
            { name: 'Round', color: 'red', count: 2 },
            { name: 'Low', color: 'blue', count: 1 }
        ]);
        expect(preview.eventTypes).toEqual(['glyph.unicode.changed']);
        expect(manager.activeFilter).toBe(active);
        expect(manager.userFilters).toEqual([]);
        expect(manager.glyphOverview.setActiveFilter).not.toHaveBeenCalled();
        expect(
            fake.pyodide.runPython.mock.calls.some(([code]) =>
                code.includes('globals().pop(__glyph_filter_namespace')
            )
        ).toBe(true);
    });

    test('reports syntax and contract errors before running', async () => {
        const fake = makeFakePyodide({}, '3\ninvalid syntax');
        window.pyodide = fake.pyodide;

        const preview = await manager.previewFilter('def classify_glyph(:\n');

        expect(preview.ok).toBe(false);
        expect(preview.errors).toEqual([
            { kind: 'syntax', message: 'invalid syntax', line: 3 },
            { kind: 'contract', message: 'Missing literal EVENT_TYPES.' }
        ]);
        expect(
            fake.pyodide.runPython.mock.calls.some(([code]) =>
                code.includes('_cp_classify_filter_glyphs')
            )
        ).toBe(false);
    });

    test('reports a classification error as a runtime error', async () => {
        window.pyodide = makeFakePyodide({ a: 'nonsense' }).pyodide;

        const preview = await manager.previewFilter(VALID_FILTER);

        expect(preview.ok).toBe(false);
        expect(preview.errors[0].kind).toBe('runtime');
        expect(preview.errors[0].message).toMatch(
            /classify_glyph\(\) must return/
        );
    });
});

describe('creating filter files', () => {
    let manager;
    let adapter;
    let files;

    beforeEach(() => {
        files = {
            'New Filter.py': {},
            'Encoded.py': {},
            'Sub': { is_dir: true }
        };
        adapter = {
            hasDirectory: () => true,
            initialize: jest.fn(),
            fileExists: jest.fn(async () => true),
            listFilesRecursive: jest.fn(async () => []),
            readFile: jest.fn(),
            scanDirectory: jest.fn(async () =>
                Object.fromEntries(
                    Object.entries(files).map(([name, info]) => [
                        name,
                        { path: `/Filters/${name}`, is_dir: !!info.is_dir }
                    ])
                )
            ),
            writeFile: jest.fn(async () => {})
        };
        jest.spyOn(settingsFolder, 'getAdapter').mockReturnValue(adapter);
        manager = new GlyphOverviewFilterManager();
        jest.spyOn(manager, 'discoverUserFilters').mockResolvedValue();
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('writes straight into Filters with a free name, no file picker', async () => {
        window.showSaveFilePicker = jest.fn();
        const name = await manager.getFreeFilterName();
        expect(name).toBe('New Filter 2');

        await manager.createFilterFile(name, createGlyphFilterTemplate(name));

        expect(window.showSaveFilePicker).not.toHaveBeenCalled();
        expect(adapter.writeFile).toHaveBeenCalledWith(
            '/Filters/New Filter 2.py',
            createGlyphFilterTemplate('New Filter 2')
        );
        expect(manager.discoverUserFilters).toHaveBeenCalled();
        delete window.showSaveFilePicker;
    });

    test('saveFilterFile renames, writes and refreshes like a sidebar rename', async () => {
        adapter.renameItem = jest.fn(async () => {});
        // The sidebar refresh is covered elsewhere; only the event matters here.
        // The module's shared manager listens too, so stub it on the prototype.
        jest.spyOn(
            GlyphOverviewFilterManager.prototype,
            'queueUserFilterFileChangeRefresh'
        ).mockImplementation(() => {});
        const events = [];
        const listener = (event) => events.push(event.detail);
        window.addEventListener('managedFileChanged', listener);

        await expect(
            manager.saveFilterFile(
                '/Filters/New Filter.py',
                'x = 2\n',
                'encoded'
            )
        ).rejects.toThrow(/already exists/);
        expect(adapter.renameItem).not.toHaveBeenCalled();

        await expect(
            manager.saveFilterFile(
                '/Filters/New Filter.py',
                'x = 2\n',
                'Renamed'
            )
        ).resolves.toBe('/Filters/Renamed.py');
        expect(adapter.renameItem).toHaveBeenCalledWith(
            '/Filters/New Filter.py',
            'Renamed.py',
            false
        );
        expect(adapter.writeFile).toHaveBeenCalledWith(
            '/Filters/Renamed.py',
            'x = 2\n'
        );
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
            source: 'glyph-filter-editor',
            paths: ['/Filters/Renamed.py'],
            internalWrite: true
        });
        expect(events[0].records[0]).toMatchObject({
            type: 'moved',
            relativePathMovedFrom: ['New Filter.py']
        });
        window.removeEventListener('managedFileChanged', listener);
    });

    test('createFilterFile rejects a taken name ignoring case', async () => {
        await expect(
            manager.createFilterFile('encoded', 'x = 1\n')
        ).rejects.toThrow(/already exists/);
        expect(adapter.writeFile).not.toHaveBeenCalled();
        await expect(
            manager.createFilterFile('Fresh.py', 'x = 1\n')
        ).resolves.toBe('/Filters/Fresh.py');
    });
});
