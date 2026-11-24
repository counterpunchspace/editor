/**
 * A `localOnly` committed change (a drawing-snapshot sync that wrote
 * nothing) sent no packet: it is not traced as a local change, and the
 * compile refresh still gets it.
 */

const {
    traceCommittedLocalChange,
    takeCommittedUiRefresh
} = require('../js/change-bridge-init');
const { createLogEntry } = require('../js/change-log');

function entry() {
    return createLogEntry({
        timestamp: 1,
        windowId: 'w-1',
        windowRoleLabel: 'Main',
        transactionLabel: 'Arrow key',
        transactionId: null,
        op: 'set',
        path: 'glyphs.q:layers.M1',
        oldValue: 'q',
        newValue: 'Arrow key',
        workerReplayTargets: [{ glyphName: 'q', layerId: 'M1' }]
    });
}

let previousTrace;
beforeEach(() => {
    previousTrace = window.__collabTrace;
    window.__collabTrace = { enabled: true, entries: [], sequence: 0 };
});
afterEach(() => {
    window.__collabTrace = previousTrace;
});

const localChanges = () =>
    window.__collabTrace.entries.filter((item) =>
        String(item.kind).startsWith('local-')
    );

test('a localOnly notice records no local change', () => {
    expect(
        traceCommittedLocalChange([entry()], {
            documentId: 'glyph:q',
            localOnly: true
        })
    ).toBe(false);
    expect(localChanges()).toEqual([]);
});

test('a committed local change is still traced', () => {
    expect(
        traceCommittedLocalChange([entry()], { documentId: 'glyph:q' })
    ).toBe(true);
    expect(localChanges()).toEqual([
        expect.objectContaining({ kind: 'local-change' })
    ]);
});

test('nothing is traced while the trace is off', () => {
    window.__collabTrace = { enabled: false, entries: [], sequence: 0 };
    expect(
        traceCommittedLocalChange([entry()], { documentId: 'glyph:q' })
    ).toBe(false);
});

test('the compile refresh still takes a localOnly notice (no UI batch)', () => {
    const entries = [entry()];
    const forward = Promise.resolve();
    const refresh = takeCommittedUiRefresh(
        entries,
        'local',
        undefined,
        forward,
        undefined
    );
    expect(refresh).toEqual({
        entries,
        origin: 'local',
        workerForwards: [forward]
    });
});
