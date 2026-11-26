const {
    activeCompileFilterIds,
    discoverCompileFilters,
    linkedCompileFilterIds,
    linkedCompileFilters,
    setLinkedCompileFilters
} = require('../js/compile-filter-host.ts');

const KEY = 'com.counterpunch.compile-filters';

describe('compile filter links', () => {
    test('stores a newly linked filter inactive', () => {
        const font = { format_specific: {} };
        setLinkedCompileFilters(font, [
            { id: 'de.yanone.harakat', active: false }
        ]);

        expect(font.format_specific[KEY]).toEqual([
            { id: 'de.yanone.harakat', active: false }
        ]);
        expect(linkedCompileFilterIds(font)).toEqual(['de.yanone.harakat']);
        expect(activeCompileFilterIds(font)).toEqual([]);
    });

    test('activation keeps the link and canonicalizes the id', () => {
        const font = { format_specific: {} };
        setLinkedCompileFilters(font, [{ id: 'harakat', active: true }]);

        expect(linkedCompileFilters(font)).toEqual([
            { id: 'de.yanone.harakat', active: true }
        ]);
        expect(activeCompileFilterIds(font)).toEqual(['de.yanone.harakat']);
    });

    test('skips values that are not link records', () => {
        const font = {
            format_specific: {
                [KEY]: [
                    'de.yanone.harakat',
                    { id: 'de.yanone.harakat', active: true },
                    { active: true },
                    { id: '', active: true }
                ]
            }
        };

        expect(linkedCompileFilters(font)).toEqual([
            { id: 'de.yanone.harakat', active: true }
        ]);
    });

    test('discoverCompileFilters skips Python when fonteditor.py helpers are not yet defined in globals', async () => {
        const runPythonAsync = jest.fn();
        const globals = new Map();
        window.pyodide = {
            runPythonAsync,
            globals: {
                has: (name) => globals.has(name),
                get: (name) => globals.get(name)
            }
        };
        try {
            const result = await discoverCompileFilters();
            expect(result).toEqual([]);
            expect(runPythonAsync).not.toHaveBeenCalled();
        } finally {
            delete window.pyodide;
        }
    });

    test('discoverCompileFilters runs Python once _cp_compile_filters_discover is defined in globals', async () => {
        const runPythonAsync = jest.fn().mockResolvedValue(
            JSON.stringify([
                {
                    id: 'de.yanone.harakat',
                    name: 'Harakat',
                    description: 'Positions Arabic marks',
                    hasDrawing: false,
                    hasPropagated: false,
                    hasFont: true,
                    hasSetup: false,
                    hasTakedown: false,
                    hasGuide: false
                }
            ])
        );
        const globals = new Map([['_cp_compile_filters_discover', () => '[]']]);
        window.pyodide = {
            runPythonAsync,
            globals: {
                has: (name) => globals.has(name),
                get: (name) => globals.get(name)
            }
        };
        try {
            const result = await discoverCompileFilters();
            expect(runPythonAsync).toHaveBeenCalledWith(
                '_cp_compile_filters_discover()'
            );
            expect(result).toHaveLength(1);
            expect(result[0].id).toBe('de.yanone.harakat');
        } finally {
            delete window.pyodide;
        }
    });
});
