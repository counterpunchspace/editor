const {
    cloudPluginCatchUpMethods
} = require('../js/filesystem-plugins/plugins/cloud-plugin-catch-up');

function settleHost() {
    return {
        _glyphCatchUpAgain: new Set(),
        _glyphCatchUpAttempts: new Map(),
        _glyphCatchUpForceBody: new Set(),
        _glyphCatchUpInFlight: new Set(),
        _scheduleGlyphCatchUpRetry: jest.fn(),
        _scheduleResidentClosureHydration: jest.fn(),
        _surfaceCatchUpFailure: jest.fn()
    };
}

function absentGlyphBridge() {
    return {
        glyphNameForId: () => 'fuzz.g1',
        hasResidentGlyphDocument: () => false,
        catalogGlyphIsInModel: () => false,
        hasSparseWorkingSet: () => false
    };
}

describe('glyph catch-up settle', () => {
    let surface;

    beforeEach(() => {
        surface = jest
            .spyOn(cloudPluginCatchUpMethods, '_surfaceCatchUpFailure')
            .mockImplementation(() => {});
    });

    afterEach(() => {
        surface.mockRestore();
    });

    test('a new glyph whose rows have not reached the room waits quietly', () => {
        // A collaborator’s new glyph is in the catalog before its rows reach
        // the room. With no revision naming a write, an empty room is not a
        // failure: the revision stamp that follows the rows starts the
        // catch-up again.
        const host = settleHost();
        const bridge = absentGlyphBridge();
        const target = { documentId: 'glyph:g1' };
        for (let attempt = 1; attempt <= 8; attempt += 1) {
            cloudPluginCatchUpMethods._settleGlyphCatchUp.call(
                host,
                bridge,
                [target],
                new Set()
            );
        }
        expect(surface).not.toHaveBeenCalled();
        expect(host._glyphCatchUpAttempts.has('glyph:g1')).toBe(false);
        // Seven retries were scheduled; the eighth attempt stops waiting.
        expect(host._scheduleGlyphCatchUpRetry).toHaveBeenCalledTimes(7);
    });

    test('a loaded glyph that font-core does not show yet waits quietly', () => {
        const host = settleHost();
        const bridge = {
            ...absentGlyphBridge(),
            hasResidentGlyphDocument: () => true,
            catalogGlyphIsInModel: () => false
        };
        const target = { documentId: 'glyph:g1' };
        for (let attempt = 1; attempt <= 8; attempt += 1) {
            cloudPluginCatchUpMethods._settleGlyphCatchUp.call(
                host,
                bridge,
                [target],
                new Set()
            );
        }
        expect(surface).not.toHaveBeenCalled();
        expect(host._glyphCatchUpAttempts.has('glyph:g1')).toBe(false);
    });

    test('a named revision that never arrives still shows the failure', () => {
        const host = settleHost();
        const bridge = {
            ...absentGlyphBridge(),
            glyphHasCatchUpRevision: () => false
        };
        const target = { documentId: 'glyph:g1', expectedRevision: 'w:7' };
        for (let attempt = 1; attempt <= 8; attempt += 1) {
            cloudPluginCatchUpMethods._settleGlyphCatchUp.call(
                host,
                bridge,
                [target],
                new Set()
            );
        }
        expect(surface).toHaveBeenCalledTimes(1);
        expect(surface.mock.calls[0][0].message).toContain(
            'did not reach revision w:7 after 8 catch-ups'
        );
    });
    test('one glyph that cannot be modelled never stalls the rest of the batch', () => {
        // A, B and C caught up together; modelling A throws. B and C still
        // leave the in-flight set and are marked fetched, the again-list
        // drains and the retries are scheduled.
        const host = settleHost();
        host._glyphCatchUpInFlight = new Set(['glyph:a', 'glyph:b', 'glyph:c']);
        host._glyphCatchUpAgain = new Set(['glyph:d']);
        const fetched = [];
        const markDocumentBroken = jest.fn();
        const bridge = {
            glyphNameForId: (id) => id,
            hasResidentGlyphDocument: () => true,
            catalogGlyphIsInModel: () => true,
            hasSparseWorkingSet: () => false,
            materializeResidentCatalogGlyph: (documentId) => {
                if (documentId === 'glyph:a') {
                    throw new Error('stored value missing');
                }
            },
            noteGlyphRevisionFetched: (glyphId) => fetched.push(glyphId),
            markDocumentBroken
        };
        const targets = ['a', 'b', 'c'].map((id) => ({
            documentId: `glyph:${id}`
        }));
        expect(() =>
            cloudPluginCatchUpMethods._settleGlyphCatchUp.call(
                host,
                bridge,
                targets,
                new Set()
            )
        ).not.toThrow();
        expect([...host._glyphCatchUpInFlight]).toEqual([]);
        expect(fetched).toEqual(['b', 'c']);
        // Not at the room's tail: A may be partly applied, so it is fetched
        // again with its body, and nothing is marked broken.
        expect(markDocumentBroken).not.toHaveBeenCalled();
        expect(host._glyphCatchUpForceBody.has('a')).toBe(true);
        expect(host._glyphCatchUpAgain.size).toBe(0);
        expect(host._scheduleGlyphCatchUpRetry).toHaveBeenCalledWith([
            'a',
            'd'
        ]);
    });

    test('a glyph at the room’s tail that cannot be modelled is marked broken', () => {
        const host = settleHost();
        host._glyphCatchUpInFlight = new Set(['glyph:a', 'glyph:b']);
        const markDocumentBroken = jest.fn();
        const failure = new Error('id/order pairs disagree');
        const bridge = {
            glyphNameForId: (id) => id,
            hasResidentGlyphDocument: () => true,
            catalogGlyphIsInModel: () => true,
            hasSparseWorkingSet: () => false,
            materializeResidentCatalogGlyph: (documentId) => {
                if (documentId === 'glyph:a') {
                    throw failure;
                }
            },
            noteGlyphRevisionFetched: jest.fn(),
            markDocumentBroken
        };
        cloudPluginCatchUpMethods._settleGlyphCatchUp.call(
            host,
            bridge,
            [{ documentId: 'glyph:a' }, { documentId: 'glyph:b' }],
            new Set(['glyph:a', 'glyph:b'])
        );
        expect(markDocumentBroken).toHaveBeenCalledWith('glyph:a', failure);
        expect(surface).toHaveBeenCalledWith(failure);
        expect(bridge.noteGlyphRevisionFetched).toHaveBeenCalledWith(
            'b',
            undefined
        );
        expect(host._scheduleGlyphCatchUpRetry).not.toHaveBeenCalled();
        expect([...host._glyphCatchUpInFlight]).toEqual([]);
    });

    test('a settle step that throws for one glyph is shown and the others settle', () => {
        const host = settleHost();
        const bridge = {
            glyphNameForId: (id) => id,
            hasResidentGlyphDocument: (documentId) => {
                if (documentId === 'glyph:a') {
                    throw new Error('engine refused');
                }
                return true;
            },
            catalogGlyphIsInModel: () => true,
            hasSparseWorkingSet: () => false,
            noteGlyphRevisionFetched: jest.fn()
        };
        cloudPluginCatchUpMethods._settleGlyphCatchUp.call(
            host,
            bridge,
            [{ documentId: 'glyph:a' }, { documentId: 'glyph:b' }],
            new Set()
        );
        expect(surface).toHaveBeenCalledTimes(1);
        expect(bridge.noteGlyphRevisionFetched).toHaveBeenCalledWith(
            'b',
            undefined
        );
    });
});
