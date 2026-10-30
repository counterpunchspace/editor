const {
    AddAxisModel,
    listShort,
    namesOrCount
} = require('../js/add-axis-plan');
const {
    buildInterpolationRustBatchOperations
} = require('../js/babelfont-model');

const weightFont = {
    axes: [{ tag: 'wght', name: 'Weight' }],
    masters: [
        { id: 'm1', name: 'Light', location: { wght: 300 } },
        { id: 'm2', name: 'Regular', location: { wght: 400 } },
        { id: 'm3', name: 'Bold', location: { wght: 700 } }
    ],
    defaultMasterId: 'm2',
    glyphCount: 10,
    braceGlyphCount: 1,
    braceLayerCount: 2,
    instanceCount: 2
};

function masterRecord(id, name, wght) {
    return {
        id,
        name: { dflt: name },
        location: { wght },
        metrics: { ascender: 750 },
        kerning: { 'A//V': -40 },
        guides: [{ pos: { x: 0, y: 500 } }]
    };
}

const records = {
    axes: [
        {
            name: { dflt: 'Weight' },
            tag: 'wght',
            min: 300,
            default: 400,
            max: 700
        }
    ],
    masters: [
        masterRecord('m1', 'Light', 300),
        masterRecord('m2', 'Regular', 400),
        masterRecord('m3', 'Bold', 700)
    ],
    instances: [
        {
            id: 'i1',
            name: { dflt: 'Regular' },
            location: { wght: 400 },
            custom_names: { family_name: { dflt: 'x' } }
        },
        {
            id: 'i2',
            name: { dflt: 'Bold' },
            location: { wght: 700 },
            custom_names: {}
        }
    ]
};

let nextId = 0;
const newId = () => `new-${++nextId}`;

describe('AddAxisModel', () => {
    beforeEach(() => {
        nextId = 0;
    });

    test('opens on Width with one wider copy per master', () => {
        const model = new AddAxisModel(weightFont);
        expect(model.tag).toBe('wdth');
        expect(model.direction).toBe('above');
        expect(model.existingAt).toBe(100);
        expect(model.columnValue('max')).toBe(125);
        expect(model.newMasters().map((m) => m.name)).toEqual([
            'Light Expanded',
            'Expanded',
            'Bold Expanded'
        ]);
        expect(model.validate().errors).toEqual({ 1: [], 2: [], 3: [] });
    });

    test('drops "Regular" from names, also inside longer names', () => {
        const model = new AddAxisModel({
            ...weightFont,
            masters: [
                { id: 'a', name: 'Regular Text', location: { wght: 400 } }
            ],
            defaultMasterId: 'a'
        });
        expect(model.newMasters()[0].name).toBe('Text Expanded');
    });

    test('skips axes the font already has and disables impossible directions', () => {
        const model = new AddAxisModel(weightFont);
        expect(model.isTagInFont('wght')).toBe(true);
        model.loadAxis('ital');
        expect(model.directionAllowed('below')).toBe(false);
        expect(model.direction).toBe('above');
        expect(model.suffix('max')).toBe('Italic');
        model.loadAxis('slnt');
        expect(model.direction).toBe('below');
        expect(model.columnValue('min')).toBe(-12);
    });

    test('both sides gives two copies per master and a symmetric range', () => {
        const model = new AddAxisModel(weightFont);
        model.setDirection('both');
        expect(model.newMasters()).toHaveLength(6);
        expect(model.deriveAxis()).toMatchObject({
            min: 75,
            max: 125,
            default: 100
        });
    });

    test('reports copies on the wrong side and names the step', () => {
        const model = new AddAxisModel(weightFont);
        model.newAt.max = 90;
        const notes = model.validate();
        expect(notes.errors[2]).toEqual([
            'Light SemiExpanded, SemiExpanded and Bold SemiExpanded: wider copies need a position over 100.'
        ]);
        expect(notes.bad.has('m1:max')).toBe(true);
    });

    test('warns about unticked masters in one grouped message', () => {
        const model = new AddAxisModel(weightFont);
        model.cell('m1', 'max').on = false;
        model.cell('m3', 'max').on = false;
        expect(model.validate().warnings[2][0]).toMatch(
            /^Light and Bold get no wider copy\. Those masters are filled in/
        );
    });

    test('choosing a copy as default moves the axis default to it', () => {
        const model = new AddAxisModel(weightFont);
        model.defaultChoice = 'max';
        expect(model.deriveAxis().default).toBe(125);
        model.cell('m2', 'max').on = false;
        expect(model.effectiveDefaultChoice()).toBe('existing');
        expect(model.deriveAxis().default).toBe(100);
    });

    test('separate userspace values produce an axis map and stay ordered', () => {
        const model = new AddAxisModel(weightFont);
        model.setSeparate(true);
        model.existingAt = 412;
        model.newAt.max = 560;
        model.setMapUser('existing', 100);
        model.setMapUser('col:max', 125);
        expect(model.axisRecord(true)).toMatchObject({
            min: 100,
            default: 100,
            max: 125,
            map: [
                [100, 412],
                [125, 560]
            ]
        });
        model.setMapUser('col:max', 90);
        expect(model.validate().errors[3][0]).toMatch(
            /must rise in the same order/
        );
    });

    test('builds a plan: existing masters get the new tag, copies clone their source', () => {
        const model = new AddAxisModel(weightFont);
        model.cell('m3', 'max').on = false;
        const { plan, masterCount } = model.buildPlan(
            records.axes,
            records.masters,
            records.instances,
            newId
        );
        expect(masterCount).toBe(2);
        expect(plan.axes[1]).toMatchObject({
            tag: 'wdth',
            min: 100,
            default: 100,
            max: 125
        });
        expect(plan.masters.slice(0, 3).map((m) => m.location)).toEqual([
            { wght: 300, wdth: 100 },
            { wght: 400, wdth: 100 },
            { wght: 700, wdth: 100 }
        ]);
        expect(plan.masters[3]).toMatchObject({
            id: 'new-1',
            name: { dflt: 'Light Expanded' },
            location: { wght: 300, wdth: 125 },
            metrics: { ascender: 750 },
            kerning: { 'A//V': -40 }
        });
        expect(plan.copies).toEqual([
            { sourceMasterId: 'm1', newMasterId: 'new-1', value: 125 },
            { sourceMasterId: 'm2', newMasterId: 'new-2', value: 125 }
        ]);
        expect(plan.instances.map((i) => i.location)).toEqual([
            { wght: 400, wdth: 100 },
            { wght: 700, wdth: 100 }
        ]);
        // Records passed in are not mutated.
        expect(records.masters[0].location).toEqual({ wght: 300 });
    });

    test('kerning and guides are left out when not copied; instances copied on request', () => {
        const model = new AddAxisModel(weightFont);
        model.copyKerning = false;
        model.copyInstances = true;
        const { plan } = model.buildPlan(
            records.axes,
            records.masters,
            records.instances,
            newId
        );
        expect(plan.masters[3].kerning).toEqual({});
        expect(plan.masters[3].guides).toEqual([]);
        expect(plan.masters[3].metrics).toEqual({ ascender: 750 });
        expect(
            plan.instances
                .slice(2)
                .map((i) => [i.name.dflt, i.location.wdth, i.custom_names])
        ).toEqual([
            ['Expanded', 125, {}],
            ['Bold Expanded', 125, {}]
        ]);
    });

    test('a static font gets one copy and an axis-only record spans the chosen positions', () => {
        const model = new AddAxisModel({
            ...weightFont,
            axes: [],
            masters: [{ id: 'r', name: 'Regular', location: {} }],
            defaultMasterId: 'r'
        });
        expect(model.newMasters().map((m) => m.name)).toEqual(['Expanded']);
        expect(model.axisRecord(false)).toMatchObject({
            min: 100,
            default: 100,
            max: 125
        });
    });
});

describe('list shortening', () => {
    test('lists up to four names, then summarizes', () => {
        expect(listShort(['A', 'B', 'C', 'D'])).toBe('A, B, C and D');
        expect(listShort(['A', 'B', 'C', 'D', 'E', 'F'])).toBe(
            'A, B, C and 3 more'
        );
        expect(namesOrCount(['A', 'B'], 'masters')).toBe('A and B');
        expect(namesOrCount(['1', '2', '3', '4', '5', '6'], 'masters')).toBe(
            '6 masters'
        );
    });
});

describe('buildInterpolationRustBatchOperations', () => {
    test('turns an instances operation into a set on instances', () => {
        const operations = buildInterpolationRustBatchOperations({
            changedGlyphs: [],
            layerTargets: [],
            layerOperations: [],
            instancesOperation: { oldValue: [], newValue: [{ id: 'i' }] }
        });
        expect(operations).toEqual([
            {
                op: 'set',
                path: ['instances'],
                oldValue: [],
                newValue: [{ id: 'i' }]
            }
        ]);
    });
});
