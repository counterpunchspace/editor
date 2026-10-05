const { commonSuffix } = require('../js/rename-glyphs-dialog');
const {
    planRenameRewires,
    proposeRewiredReference
} = require('../js/rename-glyphs-rewire');

describe('rename dialog common suffix', () => {
    test('prefills shared dot-endings from the last token', () => {
        expect(commonSuffix(['a-lat.sc', 'aDieresis-lat.sc'])).toBe('.sc');
        expect(commonSuffix(['a.001', 'aDieresis.001'])).toBe('.001');
        expect(commonSuffix(['A.alt', 'B.alt', 'C.alt'])).toBe('.alt');
        expect(commonSuffix(['a.alt.sc', 'b.alt.sc'])).toBe('.alt.sc');
        expect(commonSuffix(['a.alt.sc', 'b.sc'])).toBe('.sc');
    });

    test('ignores the glyph name and mismatched endings', () => {
        expect(commonSuffix(['a.sc'])).toBe('.sc');
        expect(commonSuffix(['a-lat', 'b-lat'])).toBe('');
        expect(commonSuffix(['a.sc', 'b.ss01'])).toBe('');
        expect(commonSuffix(['a', 'b'])).toBe('');
        expect(commonSuffix([])).toBe('');
    });
});

function plan(search, replace, renames, references, components, names) {
    return planRenameRewires(search, replace, renames, {
        postRenameNames: new Set(names),
        referencesOf: (glyphName) => references[glyphName] || [],
        componentsOf: (glyphName) => components[glyphName] || []
    });
}

describe('proposeRewiredReference', () => {
    test('substitutes when the reference contains the search string', () => {
        expect(proposeRewiredReference('a.001', '.001', '.sc')).toBe('a.sc');
    });

    test('appends the replacement when the reference has no search string', () => {
        expect(proposeRewiredReference('a', '.001', '.sc')).toBe('a.sc');
    });

    test('returns null when the reference would not change', () => {
        expect(proposeRewiredReference('a', '.001', '')).toBeNull();
        expect(proposeRewiredReference('a', '', '.sc')).toBeNull();
    });
});

describe('planRenameRewires', () => {
    test('rewires a duplicated composite base onto the renamed counterpart', () => {
        const rewires = plan(
            '.001',
            '.sc',
            new Map([
                ['a.001', 'a.sc'],
                ['aDieresis.001', 'aDieresis.sc']
            ]),
            {
                'a.001': [],
                'aDieresis.001': ['a', 'dieresiscomb']
            },
            {
                'a.001': [],
                'aDieresis.001': ['a', 'dieresiscomb']
            },
            ['a', 'dieresiscomb', 'a.sc', 'aDieresis.sc']
        );

        expect(rewires.get('aDieresis.001')).toEqual(new Map([['a', 'a.sc']]));
        expect(rewires.has('a.001')).toBe(false);
    });

    test('substitutes a base that already contains the search string', () => {
        const rewires = plan(
            '.001',
            '.sc',
            new Map([['aDieresis.001', 'aDieresis.sc']]),
            { 'aDieresis.001': ['a.001'] },
            { 'aDieresis.001': ['a.001'] },
            ['a.001', 'a.sc', 'aDieresis.sc']
        );

        expect(rewires.get('aDieresis.001')).toEqual(
            new Map([['a.001', 'a.sc']])
        );
    });

    test('uses a counterpart that already exists', () => {
        const rewires = plan(
            '.001',
            '.sc',
            new Map([['aDieresis.001', 'aDieresis.sc']]),
            { 'aDieresis.001': ['a'] },
            { 'aDieresis.001': ['a'] },
            ['a', 'a.sc', 'aDieresis.sc']
        );

        expect(rewires.get('aDieresis.001')).toEqual(new Map([['a', 'a.sc']]));
    });

    test('adds, swaps, and removes the search string', () => {
        expect(
            plan(
                '.001',
                '.001.sc',
                new Map([['aDieresis.001', 'aDieresis.001.sc']]),
                { 'aDieresis.001': ['a.001'] },
                { 'aDieresis.001': ['a.001'] },
                ['a.001', 'a.001.sc', 'aDieresis.001.sc']
            ).get('aDieresis.001')
        ).toEqual(new Map([['a.001', 'a.001.sc']]));

        expect(
            plan(
                '.sc',
                '.alt',
                new Map([['aDieresis.sc', 'aDieresis.alt']]),
                { 'aDieresis.sc': ['a.sc'] },
                { 'aDieresis.sc': ['a.sc'] },
                ['a.sc', 'a.alt', 'aDieresis.alt']
            ).get('aDieresis.sc')
        ).toEqual(new Map([['a.sc', 'a.alt']]));

        expect(
            plan(
                '.001',
                '',
                new Map([['aDieresis.001', 'aDieresis']]),
                { 'aDieresis.001': ['a.001'] },
                { 'aDieresis.001': ['a.001'] },
                ['a.001', 'a', 'aDieresis']
            ).get('aDieresis.001')
        ).toEqual(new Map([['a.001', 'a']]));
    });

    test('skips a counterpart that does not exist', () => {
        const rewires = plan(
            '.001',
            '.sc',
            new Map([['aDieresis.001', 'aDieresis.sc']]),
            { 'aDieresis.001': ['a', 'dieresiscomb'] },
            { 'aDieresis.001': ['a', 'dieresiscomb'] },
            ['a', 'dieresiscomb', 'aDieresis.sc']
        );

        expect(rewires.size).toBe(0);
    });

    test('leaves a reference that is itself being renamed to the global pass', () => {
        const rewires = plan(
            '.001',
            '.sc',
            new Map([
                ['a.001', 'a.sc'],
                ['aDieresis.001', 'aDieresis.sc']
            ]),
            { 'aDieresis.001': ['a.001'] },
            { 'aDieresis.001': ['a.001'] },
            ['a.sc', 'aDieresis.sc']
        );

        expect(rewires.size).toBe(0);
    });

    test('does not rewire a glyph onto itself', () => {
        const rewires = plan(
            '.001',
            '.sc',
            new Map([['a.001', 'a.sc']]),
            { 'a.001': ['a'] },
            { 'a.001': ['a'] },
            ['a', 'a.sc']
        );

        expect(rewires.size).toBe(0);
    });

    test('drops a component rewire that would cycle', () => {
        const rewires = plan(
            '.001',
            '.sc',
            new Map([
                ['a.001', 'a.sc'],
                ['b.001', 'b.sc']
            ]),
            {
                'a.001': ['b'],
                'b.001': ['a']
            },
            {
                'a.001': ['b'],
                'b.001': ['a']
            },
            ['a', 'b', 'a.sc', 'b.sc']
        );

        expect(rewires.get('a.001')).toEqual(new Map([['b', 'b.sc']]));
        expect(rewires.has('b.001')).toBe(false);
    });
});
