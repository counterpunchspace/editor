const {
    encodeQueryComponent,
    formatUrl,
    readUrlState,
    serializeSearchParams,
    updateUrlState
} = require('../js/url-state');

describe('minimal query encoding', () => {
    afterEach(() => {
        window.history.replaceState(null, '', '/');
    });
    test('leaves :, /, comma, and Unicode unencoded', () => {
        expect(encodeQueryComponent('memory:///user/Fustat.glyphs')).toBe(
            'memory:///user/Fustat.glyphs'
        );
        expect(encodeQueryComponent('wght:200,wdth:100')).toBe(
            'wght:200,wdth:100'
        );
        expect(encodeQueryComponent('liga,kern')).toBe('liga,kern');
        expect(encodeQueryComponent('مَرْحَبًا')).toBe('مَرْحَبًا');
    });

    test('encodes space as + and a literal plus as %2B', () => {
        expect(encodeQueryComponent('hello world')).toBe('hello+world');
        expect(encodeQueryComponent('a+b')).toBe('a%2Bb');
        expect(encodeQueryComponent('a & b')).toBe('a+%26+b');
        expect(encodeQueryComponent('a#b')).toBe('a%23b');
        expect(encodeQueryComponent('100%')).toBe('100%25');
        expect(encodeQueryComponent('a=b', true)).toBe('a%3Db');
        expect(encodeQueryComponent('a=b')).toBe('a=b');
    });

    test('updateUrlState writes a readable query and readUrlState round-trips', () => {
        window.history.replaceState(null, '', '/');
        updateUrlState({
            file: 'memory:///user/Fustat.glyphs',
            text: 'hello مَرْحَبًا',
            cursor: 0,
            mode: 'text',
            location: 'wght:200',
            features: 'liga,kern'
        });

        expect(window.location.search).toContain(
            'file=memory:///user/Fustat.glyphs'
        );
        expect(window.location.search).toContain('text=hello+');
        expect(window.location.search).toContain('location=wght:200');
        expect(window.location.search).toContain('features=liga,kern');
        expect(window.location.search).not.toMatch(/%3A|%2F|%2C|%2520|%25D9/);

        const state = readUrlState();
        expect(state.file).toBe('memory:///user/Fustat.glyphs');
        expect(state.text).toBe('hello مَرْحَبًا');
        expect(state.cursor).toBe(0);
        expect(state.mode).toBe('text');
        expect(state.location).toBe('wght:200');
        expect(state.features).toBe('liga,kern');
    });

    test('sparse=true round-trips and empty text stays empty', () => {
        window.history.replaceState(null, '', '/');
        updateUrlState({
            file: 'cloud:///asset-1',
            sparse: true,
            text: 'na'
        });
        expect(window.location.search).toContain('sparse=true');
        expect(readUrlState().sparse).toBe(true);
        expect(readUrlState().text).toBe('na');

        updateUrlState({ sparse: false });
        expect(window.location.search).not.toContain('sparse=');
        expect(readUrlState().sparse).toBeUndefined();

        window.history.replaceState(
            null,
            '',
            '/?file=cloud:///asset-1&sparse=true'
        );
        expect(readUrlState().sparse).toBe(true);
        expect(readUrlState().text).toBeUndefined();
    });

    test('stores newlines as literal \\n and round-trips', () => {
        window.history.replaceState(null, '', '/');
        updateUrlState({
            text: 'Hello\nWorld',
            lineheight: 120,
            align: 'center'
        });

        expect(window.location.search).toContain('text=Hello\\nWorld');
        expect(window.location.search).not.toMatch(/%0A/);
        expect(window.location.search).toContain('lineheight=120');
        expect(window.location.search).toContain('align=center');

        const state = readUrlState();
        expect(state.text).toBe('Hello\nWorld');
        expect(state.lineheight).toBe(120);
        expect(state.align).toBe('center');
    });

    test('decodes a typed backslash-n after doubled backslashes', () => {
        window.history.replaceState(null, '', '/?text=a\\\\n b');
        expect(readUrlState().text).toBe('a\\n b');
    });

    test('readUrlState treats + as space and %2B as plus', () => {
        window.history.replaceState(null, '', '/?text=hello+world');
        expect(readUrlState().text).toBe('hello world');

        window.history.replaceState(null, '', '/?text=a%2Bb');
        expect(readUrlState().text).toBe('a+b');
    });

    test('formatUrl serializes searchParams with minimal encoding', () => {
        const url = new URL('https://localhost:8000/');
        url.searchParams.set('file', 'memory:///user/Fustat.glyphs');
        url.searchParams.set('text', 'hello world');
        url.searchParams.set('note', 'a+b');
        expect(formatUrl(url)).toBe(
            'https://localhost:8000/?file=memory:///user/Fustat.glyphs&text=hello+world&note=a%2Bb'
        );
        expect(
            serializeSearchParams(url.searchParams).startsWith(
                'file=memory:///'
            )
        ).toBe(true);
    });
});
