const { timelineMark } = require('../js/perf-timeline');

describe('perf-timeline pruning', () => {
    test('retains cp:font.lifecycle.startupReleased after pruning >250 marks', () => {
        const storedMarks = [];
        const originalPerformance = globalThis.performance;
        const fakePerf = {
            mark(name) {
                storedMarks.push({ name, entryType: 'mark' });
            },
            getEntriesByType(type) {
                return type === 'mark' ? [...storedMarks] : [];
            },
            getEntriesByName(name) {
                return storedMarks.filter((entry) => entry.name === name);
            },
            clearMarks(name) {
                for (let i = storedMarks.length - 1; i >= 0; i--) {
                    if (storedMarks[i].name === name) {
                        storedMarks.splice(i, 1);
                    }
                }
            },
            clearMeasures() {}
        };
        Object.defineProperty(globalThis, 'performance', {
            configurable: true,
            value: fakePerf
        });

        try {
            timelineMark('font.lifecycle.startupReleased');
            for (let i = 0; i < 410; i++) {
                timelineMark(`test.ephemeral.mark.${i}`);
            }

            expect(
                fakePerf.getEntriesByName('cp:font.lifecycle.startupReleased')
            ).toHaveLength(1);
            expect(storedMarks.length).toBeLessThan(250);
        } finally {
            Object.defineProperty(globalThis, 'performance', {
                configurable: true,
                value: originalPerformance
            });
        }
    });
});
