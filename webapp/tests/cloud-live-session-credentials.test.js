// Every socket of a live session asks for a fresh room token when it
// reconnects, and they reconnect together (their shared token expires, or
// the network drops). One request to the website serves them all.

const {
    CloudLiveSession,
    roomTokenExpiresAt
} = require('../js/cloud-live-session');

function token(expMs) {
    const encode = (value) =>
        Buffer.from(JSON.stringify(value)).toString('base64url');
    return `${encode({ alg: 'HS256' })}.${encode({ exp: expMs })}.sig`;
}

function session(refreshCredentials) {
    return new CloudLiveSession({
        assetId: 'asset-1',
        websiteBaseUrl: 'https://editor.example',
        token: token(Date.now() + 60_000),
        roomUrl: 'wss://rooms.example/room/asset-1',
        bridge: {},
        bootstrapMode: 'skip',
        refreshCredentials
    });
}

test('reads a room token’s expiry', () => {
    const exp = Date.now() + 900_000;
    expect(roomTokenExpiresAt(token(exp))).toBe(exp);
    expect(roomTokenExpiresAt('not-a-token')).toBe(0);
    expect(roomTokenExpiresAt(null)).toBe(0);
});

test('sockets reconnecting at once share one room-token request', async () => {
    let release;
    const refresh = jest.fn(
        () =>
            new Promise((resolve) => {
                release = () =>
                    resolve({
                        token: token(Date.now() + 900_000),
                        roomUrl: 'wss://rooms.example/room/asset-1'
                    });
            })
    );
    const live = session(refresh);
    const asks = Array.from({ length: 12 }, () =>
        live._refreshCredentialsOnce()
    );
    expect(refresh).toHaveBeenCalledTimes(1);
    release();
    expect(await Promise.all(asks)).toEqual(Array(12).fill(true));

    // Right after, a token that was just fetched is reused.
    expect(await live._refreshCredentialsOnce()).toBe(true);
    expect(refresh).toHaveBeenCalledTimes(1);
});

test('a refused token is never reused, and an old one is replaced', async () => {
    const refresh = jest.fn(async () => ({
        token: token(Date.now() + 900_000),
        roomUrl: 'wss://rooms.example/room/asset-1'
    }));
    const live = session(refresh);
    await live._refreshCredentialsOnce();
    expect(refresh).toHaveBeenCalledTimes(1);
    // The room refused the current token: fetch another.
    await live._refreshCredentialsOnce({ force: true });
    expect(refresh).toHaveBeenCalledTimes(2);
    // Thirty seconds later a reconnect fetches a new one again.
    const realNow = Date.now;
    try {
        const later = realNow() + 31_000;
        Date.now = () => later;
        await live._refreshCredentialsOnce();
        expect(refresh).toHaveBeenCalledTimes(3);
    } finally {
        Date.now = realNow;
    }
});

test('the session’s first token is not reused: a reconnect asks for a new one', async () => {
    const refresh = jest.fn(async () => ({
        token: token(Date.now() + 900_000),
        roomUrl: 'wss://rooms.example/room/asset-1'
    }));
    const live = session(refresh);
    await live._refreshCredentialsOnce();
    expect(refresh).toHaveBeenCalledTimes(1);
});
