const {
    compilationPlan,
    readCommittedCompileStamp,
    assertCompileStamp
} = require('../../js/edit-intent');

describe('EditIntent stamps', () => {
    test('a missing compileChangeSource compiles full and does not infer from the label', () => {
        const stamp = readCommittedCompileStamp(
            [
                {
                    transactionLabel: 'Set sidebearing',
                    path: 'glyphs.a:layers.layer-1.nodes',
                    compileEditType: 'outline'
                }
            ],
            'change-bridge-local'
        );
        expect(stamp).toEqual({
            changeSource: 'change-bridge-local',
            editType: null,
            unstamped: true,
            unknownStamp: false
        });
    });

    test('an explicit null edit type is a full stamp', () => {
        const stamp = readCommittedCompileStamp(
            [
                {
                    compileChangeSource: 'keyboard-sidebearing',
                    compileEditType: null
                }
            ],
            'change-bridge-local'
        );
        expect(stamp.unstamped).toBe(false);
        expect(stamp.editType).toBeNull();
        expect(stamp.changeSource).toBe('keyboard-sidebearing');
    });

    test('writers throw when the stamp is omitted', () => {
        expect(() => assertCompileStamp(undefined, null)).toThrow(
            /compileChangeSource/
        );
        expect(() => assertCompileStamp('keyboard-outline', undefined)).toThrow(
            /compileEditType/
        );
        expect(assertCompileStamp('keyboard-outline', null)).toEqual({
            compileChangeSource: 'keyboard-outline',
            compileEditType: null
        });
        expect(() => assertCompileStamp('keyboard-outline', 'outlne')).toThrow(
            /Unknown compileEditType/
        );
    });

    test('an unknown stamp on a packet compiles full', () => {
        const stamp = readCommittedCompileStamp(
            [
                {
                    compileChangeSource: 'keyboard-outline',
                    compileEditType: 'outlne'
                }
            ],
            'change-bridge-local'
        );
        expect(stamp.unknownStamp).toBe(true);
        expect(stamp.editType).toBeNull();
        expect(stamp.unstamped).toBe(false);
    });

    test('live sidebearing stays sidebearing and uses outline-only flags', () => {
        const plan = compilationPlan({
            changeSource: 'mouse-drag-sidebearing',
            editType: 'sidebearing',
            dataFreshnessMode: 'live-drag-worker-preview'
        });
        expect(plan.compilationMode).toBe('outline-only');
        expect(plan.optionOverrides).toEqual({
            skip_features: true,
            skip_kerning: true,
            produce_varc_table: false
        });
        expect(plan.armDeferredFull).toBe(false);
    });

    test('a null commit stamp is one full compile with no deferred second pass', () => {
        const plan = compilationPlan({
            changeSource: 'mouse-drag-anchor',
            editType: null,
            dataFreshnessMode: 'authoritative-worker-yjs'
        });
        expect(plan.compilationMode).toBe('full');
        expect(plan.optionOverrides).toBeUndefined();
        expect(plan.armDeferredFull).toBe(false);
        expect(plan.skipCompile).toBe(false);
    });

    test('guide does not compile', () => {
        expect(
            compilationPlan({
                changeSource: 'keyboard-guide',
                editType: 'guide',
                dataFreshnessMode: 'authoritative-worker-yjs'
            }).skipCompile
        ).toBe(true);
    });

    test('a committed local outline stamp is full', () => {
        const plan = compilationPlan({
            changeSource: 'keyboard-outline',
            editType: 'outline',
            dataFreshnessMode: 'authoritative-worker-yjs'
        });
        expect(plan.compilationMode).toBe('full');
        expect(plan.optionOverrides).toBeUndefined();
        expect(plan.armDeferredFull).toBe(false);
    });

    test('kerning-only does not skip outlines', () => {
        const plan = compilationPlan({
            changeSource: 'keyboard-kerning-value',
            editType: 'kerning-value',
            dataFreshnessMode: 'authoritative-worker-yjs'
        });
        expect(plan.compilationMode).toBe('kerning-only');
        expect(plan.optionOverrides).toEqual({ produce_varc_table: false });
        expect(plan.optionOverrides.skip_outlines).toBeUndefined();
        expect(plan.armDeferredFull).toBe(true);
    });
});
