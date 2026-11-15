const {
    validateFeatureTag,
    REGISTERED_FEATURE_TAGS
} = require('../js/opentype-features');
const {
    validateFeaName,
    uniqueFeaName,
    renameClassReferences,
    planClassReferenceRename
} = require('../js/features-structure');

describe('validateFeatureTag', () => {
    test.each([
        ['', 'error', 'Enter a feature tag.'],
        ['ligat', 'error', 'Feature tags have at most 4 characters.'],
        [
            'li a',
            'error',
            'Feature tags can contain only letters, digits, “_”, “.” and “-”.'
        ],
        [
            'lig;',
            'error',
            'Feature tags can contain only letters, digits, “_”, “.” and “-”.'
        ],
        ['liga', 'ok', 'Standard Ligatures'],
        ['ss07', 'ok', 'Stylistic Set 7'],
        ['cv99', 'ok', 'Character Variant 99'],
        ['size', 'ok', 'Registered feature'],
        ['ABCD', 'ok', 'Custom feature'],
        ['Liga', 'ok', 'Custom feature'],
        [
            'hngl',
            'warning',
            '“hngl” is deprecated in the OpenType specification.'
        ]
    ])('%p is %s', (tag, level, message) => {
        expect(validateFeatureTag(tag)).toEqual({ level, message });
    });

    test('suggests the one registered tag a typo is close to', () => {
        expect(validateFeatureTag('ligs')).toEqual({
            level: 'warning',
            message: '“ligs” isn’t a registered feature.',
            suggestion: 'liga'
        });
        expect(validateFeatureTag('kenr').suggestion).toBe('kern');
        expect(validateFeatureTag('lgia').suggestion).toBe('liga');
    });

    test('offers no suggestion when several registered tags are close', () => {
        // “ss2” is one edit from both “ss20” and “ss02”, among others.
        const check = validateFeatureTag('ss2');
        expect(check.level).toBe('warning');
        expect(check.suggestion).toBeUndefined();
    });

    test('never looks at the tags the font already uses', () => {
        // Several features may share a tag, so a duplicate is not flagged.
        expect(validateFeatureTag.length).toBe(1);
        expect(validateFeatureTag('kern').level).toBe('ok');
    });

    test('the registry lists the numbered stylistic sets and character variants', () => {
        expect(REGISTERED_FEATURE_TAGS.has('ss20')).toBe(true);
        expect(REGISTERED_FEATURE_TAGS.has('ss21')).toBe(false);
        expect(REGISTERED_FEATURE_TAGS.has('cv01')).toBe(true);
        expect(REGISTERED_FEATURE_TAGS.has('cv00')).toBe(false);
    });
});

describe('validateFeaName', () => {
    test('accepts FEA names and rejects the rest', () => {
        expect(validateFeaName('Uppercase', 'class', [])).toBeNull();
        expect(validateFeaName('_a.b-c', 'prefix', [])).toBeNull();
        expect(validateFeaName('', 'class', [])).toBe('Enter a name.');
        expect(validateFeaName('@caps', 'class', [])).toBe(
            'Leave out the “@”. Counterpunch adds it.'
        );
        expect(validateFeaName('1st', 'class', [])).toMatch(/^A name starts/);
        expect(validateFeaName('a b', 'prefix', [])).toMatch(/^A name starts/);
        expect(validateFeaName('x'.repeat(64), 'class', [])).toMatch(
            /at most 63/
        );
    });

    test('rejects a name another item of the same kind has, but not its own', () => {
        expect(validateFeaName('caps', 'class', ['caps', 'lc'])).toBe(
            'A class named “caps” already exists.'
        );
        expect(validateFeaName('caps', 'class', ['caps'], 'caps')).toBeNull();
    });
});

describe('uniqueFeaName', () => {
    test('returns the first unused numbered name', () => {
        expect(uniqueFeaName('class', [])).toBe('class1');
        expect(uniqueFeaName('class', ['class1', 'class2'])).toBe('class3');
    });
});

describe('renameClassReferences', () => {
    test('renames whole-word references and leaves comments alone', () => {
        const code = [
            'sub @lc by @lc.sc; # @lc stays here',
            'pos @lcx @lc 10;',
            '@lc2 = [@lc];'
        ].join('\n');
        expect(renameClassReferences(code, 'lc', 'lower')).toEqual({
            code: [
                'sub @lower by @lc.sc; # @lc stays here',
                'pos @lcx @lower 10;',
                '@lc2 = [@lower];'
            ].join('\n'),
            count: 3
        });
    });

    test('treats regular expression characters in names literally', () => {
        expect(renameClassReferences('@a.b @aXb', 'a.b', 'c').code).toBe(
            '@c @aXb'
        );
    });
});

describe('planClassReferenceRename', () => {
    test('collects edits in prefixes, other classes and features', () => {
        const plan = planClassReferenceRename(
            {
                prefixes: {
                    lookups: { code: 'lookup x { sub @lc by a; } x;' }
                },
                classes: {
                    lc: { code: 'a b' },
                    all: { code: '@lc @uc' },
                    uc: { code: 'A B' }
                },
                features: [
                    ['smcp', { code: 'sub @lc by @lc_sc;' }],
                    ['liga', { code: 'sub f i by fi;' }]
                ]
            },
            'lc',
            'lower'
        );
        expect(plan.count).toBe(3);
        expect(plan.edits).toEqual([
            {
                type: 'prefix',
                key: 'lookups',
                code: 'lookup x { sub @lower by a; } x;'
            },
            { type: 'class', key: 'all', code: '@lower @uc' },
            { type: 'feature', key: 0, code: 'sub @lower by @lc_sc;' }
        ]);
    });
});
