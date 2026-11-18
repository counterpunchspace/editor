import {
    facetValueCounts,
    flattenSets,
    matchesFacets,
    matchesQuery
} from '../js/character-set-facets';

const tree = [
    {
        id: 'urd',
        label: 'Urdu',
        selectable: false,
        children: [
            {
                id: 'urd/0',
                label: 'Arabic',
                selectable: true,
                facets: { writing_script: ['Arabic'] }
            }
        ]
    },
    {
        id: 'srp',
        label: 'Serbian',
        selectable: false,
        children: [
            {
                id: 'srp/0',
                label: 'Cyrillic',
                selectable: true,
                facets: { writing_script: ['Cyrillic'] }
            },
            {
                id: 'srp/1',
                label: 'Latin',
                selectable: true,
                facets: { writing_script: ['Latin'] }
            }
        ]
    },
    {
        id: 'pol',
        label: 'Polish',
        selectable: false,
        children: [
            {
                id: 'pol/0',
                label: 'Latin',
                selectable: true,
                facets: { writing_script: ['Latin'] }
            }
        ]
    }
];

describe('character set facets', () => {
    test('flattens sets with their parents’ labels', () => {
        expect(flattenSets(tree).map((set) => set.label)).toEqual([
            'Urdu - Arabic',
            'Serbian - Cyrillic',
            'Serbian - Latin',
            'Polish - Latin'
        ]);
    });

    test('a chosen writing script and the search narrow the list together', () => {
        const sets = flattenSets(tree);
        const latin = sets.filter((set) =>
            matchesFacets(set, { writing_script: 'Latin' })
        );
        expect(latin.map((set) => set.id)).toEqual(['srp/1', 'pol/0']);
        expect(
            latin
                .filter((set) => matchesQuery(set, 'serb'))
                .map((set) => set.id)
        ).toEqual(['srp/1']);
        expect(sets.filter((set) => matchesFacets(set, {}))).toHaveLength(4);
    });

    test('counts follow the search but keep every value, most sets first', () => {
        const sets = flattenSets(tree);
        expect(facetValueCounts(sets, sets, 'writing_script')).toEqual([
            { value: 'Latin', count: 2 },
            { value: 'Arabic', count: 1 },
            { value: 'Cyrillic', count: 1 }
        ]);
        const searched = sets.filter((set) => matchesQuery(set, 'serb'));
        expect(facetValueCounts(sets, searched, 'writing_script')).toEqual([
            { value: 'Latin', count: 1 },
            { value: 'Arabic', count: 0 },
            { value: 'Cyrillic', count: 1 }
        ]);
        expect(facetValueCounts(sets, sets, 'status')).toEqual([]);
    });
});
