/**
 * Refused edits reach the user: a read-only font shows its reason once,
 * not once per keystroke, and other refusals show their own message. A
 * whole drawing always carries its shapes.
 */

const {
    isReadOnlyFontError,
    noticeReadOnlyRefusal,
    reportRefusedEdit,
    installReadOnlyRefusalNotices,
    resetReadOnlyRefusalNoticesForTests
} = require('../js/glyph-canvas/edit-refusal-notice');
const { ReadOnlyFontError } = require('../js/patch-sync-engine');
const { Font, StationEditRefusedError } = require('../js/babelfont-model');

const notices = () =>
    [
        ...document.querySelectorAll('.font-window-notice > span:first-child')
    ].map((span) => span.textContent);

beforeEach(() => {
    document
        .querySelectorAll('.font-window-notice')
        .forEach((notice) => notice.remove());
    resetReadOnlyRefusalNoticesForTests();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
    jest.restoreAllMocks();
    delete window.patchSyncEngine;
});

describe('read-only refusals', () => {
    test('the reason is shown once for many refused edits', () => {
        window.patchSyncEngine = {};
        const reason = 'You were removed from this font.';
        for (let i = 0; i < 5; i++) {
            expect(
                noticeReadOnlyRefusal(new ReadOnlyFontError(reason, 'edit'))
            ).toBe(true);
        }
        expect(notices()).toEqual([
            `This font is read-only: ${reason} Your edit was not made.`
        ]);
    });

    test('a new reason or another font shows it again', () => {
        const first = {};
        window.patchSyncEngine = first;
        noticeReadOnlyRefusal(new ReadOnlyFontError('Reason one.', 'edit'));
        noticeReadOnlyRefusal(new ReadOnlyFontError('Reason two.', 'edit'));
        window.patchSyncEngine = {};
        noticeReadOnlyRefusal(new ReadOnlyFontError('Reason two.', 'edit'));
        expect(notices()).toHaveLength(3);
    });

    test('other errors are not read-only refusals', () => {
        expect(isReadOnlyFontError(new Error('x'))).toBe(false);
        expect(noticeReadOnlyRefusal(new Error('x'))).toBe(false);
        expect(notices()).toEqual([]);
    });

    test('an uncaught refusal from an event handler is shown', () => {
        installReadOnlyRefusalNotices();
        installReadOnlyRefusalNotices();
        window.patchSyncEngine = {};
        const error = new ReadOnlyFontError('Read only.', 'edit');
        window.dispatchEvent(new ErrorEvent('error', { error }));
        window.dispatchEvent(new ErrorEvent('error', { error }));
        expect(notices()).toHaveLength(1);
    });
});

describe('reportRefusedEdit', () => {
    test('a refused station edit shows its message every time', () => {
        const error = new StationEditRefusedError(
            'remove the station',
            new Error('the font has no such drawing')
        );
        reportRefusedEdit(error);
        reportRefusedEdit(error);
        expect(notices()).toEqual([
            'Couldn’t remove the station, so nothing was changed: the font has no such drawing',
            'Couldn’t remove the station, so nothing was changed: the font has no such drawing'
        ]);
    });
});

describe('Drawing.toJSON', () => {
    function font(layer) {
        return Font.fromData({
            upm: 1000,
            version: [1, 0],
            axes: [],
            cross_axis_mappings: [],
            instances: [],
            masters: [
                {
                    name: { dflt: 'Regular' },
                    id: 'm1',
                    location: {},
                    guides: [],
                    metrics: {},
                    kerning: {}
                }
            ],
            glyphs: [
                {
                    name: 'space',
                    category: 'Base',
                    exported: true,
                    layers: [layer]
                }
            ],
            note: '',
            date: new Date('2020-01-01T00:00:00.000Z'),
            names: {},
            features: { classes: {}, prefixes: {}, features: [] }
        });
    }
    const station = { type: 'DefaultForMaster', master: 'm1' };

    test('a drawing Babelfont stored without shapes has an empty list', () => {
        const drawing = font({ id: 'd1', width: 250, master: station })
            .findGlyph('space')
            .findDrawingById('d1');
        expect(drawing.toJSON().shapes).toEqual([]);
    });

    test('shapes that are not a list are refused', () => {
        const drawing = font({
            id: 'd1',
            width: 250,
            master: station,
            shapes: [{ nodes: [], closed: true }]
        })
            .findGlyph('space')
            .findDrawingById('d1');
        drawing.toJSON().shapes = 'garbage';
        expect(() => drawing.toJSON()).toThrow(/aren’t a list/);
    });
});
