import { chromium } from 'playwright';

const APP_URL = process.env.APP_URL || 'https://localhost:8000/';
const logs = [];
const push = (kind, text) => {
    const line = `[${kind}] ${String(text).slice(0, 2000)}`;
    logs.push(line);
    console.log(line);
};

const browser = await chromium.launch({
    channel: 'chrome',
    headless: false,
    args: [
        '--enable-features=SharedArrayBuffer',
        '--ignore-certificate-errors',
        '--allow-insecure-localhost'
    ]
});
const context = await browser.newContext({ ignoreHTTPSErrors: true });
const page = await context.newPage();
page.setDefaultTimeout(120000);
page.on('console', (msg) => {
    const text = msg.text();
    if (text.includes('[webpack-dev-server] Server started')) {
        return;
    }
    push(`console.${msg.type()}`, text);
});
page.on('pageerror', (err) => push('pageerror', err.stack || err.message));
page.on('requestfailed', (req) =>
    push('requestfailed', `${req.failure()?.errorText} ${req.url()}`)
);

await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });

await page.waitForFunction(
    () => typeof window.openFont === 'function' && !!window.fontManager,
    null,
    { timeout: 60000 }
);

await page
    .waitForFunction(
        () =>
            String(
                window.stateManager?.getStateSnapshot?.()?.state?.editor_file ||
                    ''
            ).includes('Fustat.glyphs'),
        null,
        { timeout: 90000 }
    )
    .catch(() => {});

const alreadyOpen = await page.evaluate(() =>
    String(window.stateManager?.getStateSnapshot?.()?.state?.editor_file || '')
);
if (!alreadyOpen.includes('Fustat.glyphs')) {
    await page.evaluate(async () => {
        await window.showFontFileDialog?.({ mode: 'open' });
    });
    await page.locator('#font-file-dialog').waitFor({ state: 'visible' });
    await page.waitForFunction(
        () => document.querySelectorAll('#file-tree .file-item').length > 0
    );
    await page.evaluate(async () => {
        await window.locatePathInFileDialog?.('memory', '/user/Fustat.glyphs');
    });
    const fileItem = page
        .locator('.file-item[data-name="Fustat.glyphs"]')
        .first();
    await fileItem.dblclick();
}

await page.waitForFunction(
    () => {
        const editorFile =
            window.stateManager?.getStateSnapshot?.()?.state?.editor_file || '';
        return String(editorFile).includes('Fustat.glyphs');
    },
    null,
    { timeout: 60000 }
);

await page
    .waitForFunction(
        () => {
            const startupReleased =
                performance.getEntriesByName('cp:font.lifecycle.startupReleased')
                    .length > 0;
            const startupBlocked =
                window.autoCompileManager?.getStatus?.()?.isStartupBlocked;
            return startupReleased && startupBlocked === false;
        },
        null,
        { timeout: 90000 }
    )
    .catch(() => push('wait', 'startupReleased timed out'));

await page.waitForTimeout(4000);

const snapshot = await page.evaluate(() => {
    const compile = window.autoCompileManager?.getStatus?.() || null;
    const font = window.fontManager?.currentFont;
    return {
        editorFile: window.stateManager?.getStateSnapshot?.()?.state?.editor_file,
        glyphCount: window.currentFontModel?.glyphs?.length || 0,
        hasCurrentFont: Boolean(font),
        fontName: font?.name || font?.familyName || null,
        compile,
        errorBanner:
            document.querySelector(
                '.compile-error, #compile-error, .error-banner'
            )?.textContent || null,
        compileErrorText:
            document.querySelector('[data-compile-error], .compilation-error')
                ?.textContent || null
    };
});

const noisy = logs.filter(
    (line) =>
        line.includes('console.error') ||
        line.includes('console.warning') ||
        line.includes('pageerror') ||
        line.includes('seedYdoc') ||
        line.includes('missing field') ||
        line.includes('Invalid access')
);

console.log('SNAPSHOT ' + JSON.stringify(snapshot, null, 2));
console.log('NOISY_COUNT ' + noisy.length);
for (const line of noisy) {
    console.log('NOISY ' + line);
}

if (process.env.KEEP_OPEN === '0') {
    await browser.close();
} else {
    console.log('Chrome left open for local testing. Close the window when done.');
}
