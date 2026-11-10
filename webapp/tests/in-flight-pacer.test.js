const { InFlightPacer } = require('../js/in-flight-pacer');

describe('InFlightPacer', () => {
    let now;
    let writes;
    let pacer;

    beforeEach(() => {
        jest.useFakeTimers();
        now = 0;
        writes = [];
        pacer = new InFlightPacer(
            (value, key) => writes.push(`${key}=${value}`),
            { minGapMs: 40, maxWaitMs: 300, now: () => now }
        );
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    const advance = (ms) => {
        now += ms;
        jest.advanceTimersByTime(ms);
    };

    test('writes at once when idle', () => {
        pacer.push('pair', 1);
        expect(writes).toEqual(['pair=1']);
        expect(pacer.busy).toBe(true);
    });

    test('keeps only the latest value while a write is in flight', () => {
        pacer.push('pair', 1);
        pacer.push('pair', 2);
        pacer.push('pair', 3);
        expect(writes).toEqual(['pair=1']);
        expect(pacer.pendingValue('pair')).toBe(3);

        advance(100);
        pacer.settle();

        expect(writes).toEqual(['pair=1', 'pair=3']);
    });

    test('keeps writes the minimum gap apart when results are fast', () => {
        pacer.push('pair', 1);
        advance(10);
        pacer.settle();
        pacer.push('pair', 2);
        expect(writes).toEqual(['pair=1']);

        advance(30);

        expect(writes).toEqual(['pair=1', 'pair=2']);
    });

    test('a write that never settles frees the next after the wait', () => {
        pacer.push('pair', 1);
        pacer.push('pair', 2);

        advance(299);
        expect(writes).toEqual(['pair=1']);
        advance(1);

        expect(writes).toEqual(['pair=1', 'pair=2']);
    });

    test('a value for another key writes the waiting one first', () => {
        pacer.push('first', 1);
        pacer.push('first', 2);
        pacer.push('second', 5);

        // The waiting value is not applied to the wrong pair or lost.
        expect(writes).toEqual(['first=1', 'first=2']);
        expect(pacer.pendingValue('second')).toBe(5);
        expect(pacer.pendingValue('first')).toBeUndefined();
    });

    test('flush writes the waiting value now', () => {
        pacer.push('pair', 1);
        pacer.push('pair', 2);

        pacer.flush();

        expect(writes).toEqual(['pair=1', 'pair=2']);
        expect(pacer.pendingValue('pair')).toBeUndefined();
    });

    test('cancel drops the waiting value', () => {
        pacer.push('pair', 1);
        pacer.push('pair', 2);

        pacer.cancel();
        advance(1000);

        expect(writes).toEqual(['pair=1']);
        expect(pacer.busy).toBe(false);
    });
});
