const { LatestSamplePump } = require('../js/latest-sample-pump');

describe('LatestSamplePump', () => {
    let now;
    let handled;
    let workMs;
    let pump;

    beforeEach(() => {
        jest.useFakeTimers();
        now = 0;
        handled = [];
        workMs = 10;
        pump = new LatestSamplePump(
            (sample) => {
                handled.push(sample);
                // The handler takes `workMs` of main-thread time.
                now += workMs;
            },
            { now: () => now }
        );
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    const advance = (ms) => {
        now += ms;
        jest.advanceTimersByTime(ms);
    };

    test('handles a sample at once when the thread has rested', () => {
        pump.push('a');
        expect(handled).toEqual(['a']);
    });

    test('rests as long as the work took, then handles the latest sample', () => {
        pump.push('a');
        // A fast pointer: samples arrive while the thread should rest.
        pump.push('b');
        pump.push('c');
        expect(handled).toEqual(['a']);

        advance(9);
        expect(handled).toEqual(['a']);
        advance(1);

        // Only the latest position matters.
        expect(handled).toEqual(['a', 'c']);
    });

    test('a continuous stream leaves at least half the time free', () => {
        const start = now;
        // A sample every 4 ms for a while.
        for (let tick = 0; tick < 200; tick += 1) {
            pump.push(tick);
            advance(4);
        }
        const total = now - start;
        const worked = handled.length * workMs;

        expect(handled.length).toBeGreaterThan(10);
        expect(worked / total).toBeLessThanOrEqual(0.5);
    });

    test('cheap work needs no rest', () => {
        workMs = 0.5;
        pump.push('a');
        pump.push('b');
        expect(handled).toEqual(['a', 'b']);
    });

    test('the rest is capped for very slow work', () => {
        workMs = 400;
        pump.push('a');
        pump.push('b');

        advance(50);

        expect(handled).toEqual(['a', 'b']);
    });

    test('flush handles the waiting sample now', () => {
        pump.push('a');
        pump.push('b');

        // Mouse up must see the last pointer position.
        pump.flush();

        expect(handled).toEqual(['a', 'b']);
        advance(100);
        expect(handled).toEqual(['a', 'b']);
    });

    test('cancel drops the waiting sample', () => {
        pump.push('a');
        pump.push('b');

        pump.cancel();
        advance(100);

        expect(handled).toEqual(['a']);
    });

    test('a handler that throws does not block later samples', () => {
        const failing = new LatestSamplePump(
            (sample) => {
                handled.push(sample);
                if (sample === 'bad') {
                    throw new Error('boom');
                }
            },
            { now: () => now }
        );

        expect(() => failing.push('bad')).toThrow('boom');
        failing.push('good');

        expect(handled).toEqual(['bad', 'good']);
    });
});
