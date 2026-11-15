// Shared cloud fonts take edits offline only for a short while. Past the
// limit, editing pauses, and reconnecting reloads instead of merging.

const {
    OfflineEditLimit
} = require('../js/filesystem-plugins/offline-edit-limit');

function setup(limitMs = 1000) {
    let now = 0;
    const timers = [];
    const events = [];
    const limit = new OfflineEditLimit({
        limitMs,
        now: () => now,
        setTimer: (run, ms) => {
            const timer = { run, at: now + ms, cleared: false };
            timers.push(timer);
            return timer;
        },
        clearTimer: (timer) => {
            timer.cleared = true;
        },
        onPause: () => events.push('pause'),
        onReconnectAfterPause: () => events.push('reload')
    });
    const advance = (ms) => {
        now += ms;
        for (const timer of timers) {
            if (!timer.cleared && !timer.fired && timer.at <= now) {
                timer.fired = true;
                timer.run();
            }
        }
    };
    return { limit, events, advance };
}

test('a short drop merges as before: no pause, no reload', () => {
    const { limit, events, advance } = setup();
    limit.noteStatus('connected');
    limit.noteStatus('disconnected');
    advance(999);
    expect(limit.paused).toBe(false);
    limit.noteStatus('connecting');
    limit.noteStatus('connected');
    advance(5000);
    expect(events).toEqual([]);
    expect(limit.paused).toBe(false);
});

test('a long disconnect pauses editing, and reconnecting reloads', () => {
    const { limit, events, advance } = setup();
    limit.noteStatus('connected');
    limit.noteStatus('disconnected');
    limit.noteStatus('connecting'); // retries don't restart the clock
    advance(600);
    limit.noteStatus('disconnected');
    advance(400);
    expect(limit.paused).toBe(true);
    expect(events).toEqual(['pause']);
    limit.noteStatus('connected');
    expect(events).toEqual(['pause', 'reload']);
});

test('a computer that slept past the limit reloads on reconnect', () => {
    const events = [];
    let now = 0;
    const slept = new OfflineEditLimit({
        limitMs: 1000,
        now: () => now,
        setTimer: () => ({}), // the timer never fires while asleep
        clearTimer: () => {},
        onPause: () => events.push('pause'),
        onReconnectAfterPause: () => events.push('reload')
    });
    slept.noteStatus('connected');
    slept.noteStatus('disconnected');
    now = 60_000;
    slept.noteStatus('connected');
    expect(events).toEqual(['reload']);
});

test('opening a font is not a disconnect', () => {
    const { limit, events, advance } = setup();
    limit.noteStatus('connecting');
    advance(10_000);
    expect(limit.paused).toBe(false);
    limit.noteStatus('connected');
    expect(events).toEqual([]);
});

test('reset forgets a running disconnect', () => {
    const { limit, events, advance } = setup();
    limit.noteStatus('connected');
    limit.noteStatus('disconnected');
    limit.reset();
    advance(5000);
    expect(events).toEqual([]);
    expect(limit.paused).toBe(false);
});

describe('offline levels', () => {
    function withLevels(limitMs = 60_000) {
        const levels = [];
        let now = 0;
        const timers = [];
        const limit = new OfflineEditLimit({
            limitMs,
            noticeDelayMs: 5000,
            now: () => now,
            setTimer: (run, ms) => {
                const timer = { run, at: now + ms };
                timers.push(timer);
                return timer;
            },
            clearTimer: (timer) => {
                timer.cleared = true;
            },
            onReconnectAfterPause: () => levels.push('reload'),
            onLevelChange: (level) => levels.push(level)
        });
        const advance = (ms) => {
            now += ms;
            for (const timer of timers) {
                if (!timer.cleared && !timer.fired && timer.at <= now) {
                    timer.fired = true;
                    timer.run();
                }
            }
        };
        return { limit, levels, advance };
    }

    test('a drop shorter than the delay shows nothing', () => {
        const { limit, levels, advance } = withLevels();
        limit.noteStatus('connected');
        limit.noteStatus('disconnected');
        advance(2000);
        limit.noteStatus('connected');
        advance(10_000);
        expect(levels).toEqual([]);
        expect(limit.level).toBe('none');
    });

    test('a longer drop shows offline, and reconnecting clears it', () => {
        const { limit, levels, advance } = withLevels();
        limit.noteStatus('connected');
        limit.noteStatus('disconnected');
        advance(5000);
        expect(limit.level).toBe('offline');
        expect(limit.paused).toBe(false);
        limit.noteStatus('connected');
        expect(levels).toEqual(['offline', 'none']);
    });

    test('the limit turns offline into paused, and reconnecting reloads', () => {
        const { limit, levels, advance } = withLevels();
        limit.noteStatus('connected');
        limit.noteStatus('disconnected');
        advance(60_000);
        expect(limit.level).toBe('paused');
        limit.noteStatus('connected');
        expect(levels).toEqual(['offline', 'paused', 'reload']);
    });

    test('the browser’s offline event starts the clock before the socket notices', () => {
        const { limit, levels, advance } = withLevels();
        limit.noteStatus('connected');
        limit.noteBrowserOffline();
        advance(3000);
        // The socket notices later; the clock keeps its start.
        limit.noteStatus('disconnected');
        advance(2000);
        expect(levels).toEqual(['offline']);
    });

    test('reset clears the level', () => {
        const { limit, levels, advance } = withLevels();
        limit.noteStatus('connected');
        limit.noteStatus('disconnected');
        advance(5000);
        limit.reset();
        expect(levels).toEqual(['offline', 'none']);
    });
});
