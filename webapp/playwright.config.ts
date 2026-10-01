/// <reference types="node" />

import { defineConfig, devices } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { getWorktreeAppUrl } = require('./scripts/worktree-config.cjs');

const LOCAL_APP_URL = getWorktreeAppUrl();

/**
 * Cloud-collab launch browser selection.
 *
 * Prefer the installed Google Chrome channel when present: Playwright's
 * bundled Chrome-for-Testing often cannot reach public CDNs (jsDelivr) in
 * nested agent / filtered network environments, which leaves `page.goto`
 * waiting forever on `load` while blocking `<script src="https://cdn…">`
 * tags never finish. System Chrome reaches those hosts normally.
 *
 * Fall back to full Chromium-for-Testing (not chrome-headless-shell): nested
 * macOS seatbelt SIGSEGVs headless_shell on launch (SEGV_ACCERR); the full
 * browser still works with chromiumSandbox:false. Override with
 * PLAYWRIGHT_CHROMIUM_EXECUTABLE if needed.
 */
function resolveCloudCollabChromiumExecutable(): string | undefined {
    if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE) {
        return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
    }
    const browsersRoot =
        process.env.PLAYWRIGHT_BROWSERS_PATH ||
        path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright');
    const candidates: string[] = [];
    try {
        for (const entry of fs.readdirSync(browsersRoot)) {
            if (!entry.startsWith('chromium-') || entry.includes('headless')) {
                continue;
            }
            const base = path.join(browsersRoot, entry);
            candidates.push(
                path.join(
                    base,
                    'chrome-mac-arm64',
                    'Google Chrome for Testing.app',
                    'Contents',
                    'MacOS',
                    'Google Chrome for Testing'
                ),
                path.join(
                    base,
                    'chrome-mac-x64',
                    'Google Chrome for Testing.app',
                    'Contents',
                    'MacOS',
                    'Google Chrome for Testing'
                ),
                path.join(base, 'chrome-linux', 'chrome'),
                path.join(base, 'chrome-win64', 'chrome.exe')
            );
        }
    } catch {
        /* browsers path missing */
    }
    return candidates.find((candidate) => {
        try {
            return fs.existsSync(candidate);
        } catch {
            return false;
        }
    });
}

function systemChromeAvailable(): boolean {
    return (
        fs.existsSync(
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
        ) ||
        fs.existsSync('/usr/bin/google-chrome') ||
        fs.existsSync('/usr/bin/google-chrome-stable')
    );
}

const CLOUD_COLLAB_USE_SYSTEM_CHROME = process.env
    .PLAYWRIGHT_CHROMIUM_EXECUTABLE
    ? false
    : process.env.CLOUD_COLLAB_USE_SYSTEM_CHROME === '0'
      ? false
      : systemChromeAvailable();

const CLOUD_COLLAB_CHROMIUM_EXECUTABLE = CLOUD_COLLAB_USE_SYSTEM_CHROME
    ? undefined
    : resolveCloudCollabChromiumExecutable();

const CLOUD_COLLAB_LAUNCH_BROWSER = CLOUD_COLLAB_USE_SYSTEM_CHROME
    ? { channel: 'chrome' as const }
    : CLOUD_COLLAB_CHROMIUM_EXECUTABLE
      ? { executablePath: CLOUD_COLLAB_CHROMIUM_EXECUTABLE }
      : {};
/**
 * Playwright Configuration for Context Font Editor
 *
 * See https://playwright.dev/docs/test-configuration
 */
export default defineConfig({
    testDir: './tests',

    // Only run Playwright spec files, not Jest test files
    testMatch: '**/*.spec.ts',

    globalTeardown: './scripts/playwright-global-teardown.mjs',
    globalSetup:
        process.env.CLOUD_COLLAB_E2E === '1'
            ? './scripts/cloud-collab-global-setup.mjs'
            : undefined,

    // The app under test keeps mutable browser-side state in memory, so
    // browser specs must not run concurrently across workers.
    workers: 1,

    // Maximum time one test can run
    // These browser integration specs load large fonts and multi-window
    // flows, and can exceed 120s on slower machines.
    timeout: 300000,

    // Keep tests in-order: the app under test holds mutable in-memory state
    fullyParallel: false,

    // Fail the build on CI if you accidentally left test.only
    forbidOnly: !!process.env.CI,

    // Retry on CI only
    retries: process.env.CI ? 2 : 0,

    // Reporter to use
    reporter: [
        ['html', { open: 'never' }],
        ['list'],
        ['./tests/reporters/step-timing-reporter.ts']
    ],

    // Shared settings for all projects
    use: {
        // Force non-interactive execution for automation and CI.
        headless: true,

        // Cloud collab e2e uses the HTTPS webpack stack on 8000, not serve:ci.
        baseURL:
            process.env.CLOUD_COLLAB_E2E === '1'
                ? process.env.CLOUD_E2E_EDITOR_URL || 'https://localhost:8000'
                : process.env.CI
                  ? 'http://localhost:9000'
                  : LOCAL_APP_URL,

        // Collect trace when retrying the failed test
        trace: 'on-first-retry',

        // Screenshot on failure
        screenshot: 'only-on-failure',

        // Video on failure
        video: 'retain-on-failure',

        // Accept self-signed certificates for dev server
        ignoreHTTPSErrors: true,

        // Set consistent viewport size for tests
        // Using larger size to account for browser chrome during recording
        viewport: { width: 1680, height: 1050 }

        // Slow down actions (helpful for debugging)
        // actionTimeout: 0,
        // navigationTimeout: 30000,
    },

    // Configure projects for major browsers
    projects: [
        {
            name: 'chromium',
            testIgnore: [
                '**/cloud-collab*.spec.ts',
                '**/cloud-wal-idb.spec.ts'
            ],
            use: {
                ...devices['Desktop Chrome'],
                // Enable SharedArrayBuffer (required for your WASM/Pyodide)
                launchOptions: {
                    args: [
                        '--enable-features=SharedArrayBuffer',
                        '--disable-extensions', // Don't load Chrome extensions
                        '--disable-component-extensions-with-background-pages',
                        '--disable-background-networking',
                        '--disable-sync', // Don't sync with Chrome profile
                        '--no-default-browser-check',
                        '--no-first-run'
                    ],
                    // Force clean browser context (no user data)
                    chromiumSandbox: true
                },
                // Each Playwright test gets a fresh browser context.
                contextOptions: {}
            }
        },
        {
            name: 'cloud-collab',
            testMatch: ['**/cloud-collab*.spec.ts', '**/cloud-wal-idb.spec.ts'],
            testIgnore: ['**/cloud-collab-preview-smoke.spec.ts'],
            timeout: 480000,
            use: {
                ...devices['Desktop Chrome'],
                launchOptions: {
                    ...CLOUD_COLLAB_LAUNCH_BROWSER,
                    args: [
                        '--enable-features=SharedArrayBuffer',
                        '--disable-http2',
                        '--disable-extensions',
                        '--disable-component-extensions-with-background-pages',
                        '--disable-background-networking',
                        '--disable-sync',
                        '--no-default-browser-check',
                        '--no-first-run'
                    ],
                    // Nested seatbelt (Cursor agent / some CI hosts) SIGSEGVs
                    // headless shell when Chrome's own sandbox is enabled.
                    chromiumSandbox: false
                },
                contextOptions: {}
            }
        },
        ...(process.env.CLOUD_COLLAB_PREVIEW_SMOKE === '1'
            ? [
                  {
                      name: 'cloud-collab-preview',
                      testMatch: ['**/cloud-collab-preview-smoke.spec.ts'],
                      timeout: 300000,
                      use: {
                          ...devices['Desktop Chrome'],
                          launchOptions: {
                              ...CLOUD_COLLAB_LAUNCH_BROWSER,
                              args: [
                                  '--enable-features=SharedArrayBuffer',
                                  '--disable-extensions',
                                  '--disable-component-extensions-with-background-pages',
                                  '--disable-background-networking',
                                  '--disable-sync',
                                  '--no-default-browser-check',
                                  '--no-first-run'
                              ],
                              chromiumSandbox: false
                          }
                      }
                  }
              ]
            : [])
        // {
        //     name: 'webkit',
        //     use: {
        //         ...devices['Desktop Safari']
        //     },
        //     timeout: 600000 // 10 minutes for WebKit (slower initialization)
        // }
    ],

    // Cloud collab e2e starts the editor via ensure-cloud-collab-stack.
    webServer:
        process.env.CLOUD_COLLAB_E2E === '1'
            ? undefined
            : {
                  command: process.env.CI
                      ? 'npm run serve:ci'
                      : 'npm run serve',
                  url: process.env.CI ? 'http://localhost:9000' : LOCAL_APP_URL,
                  reuseExistingServer: !process.env.CI,
                  gracefulShutdown: {
                      signal: 'SIGTERM',
                      timeout: 5000
                  },
                  timeout: 120000,
                  ignoreHTTPSErrors: true,
                  env: {
                      PLAYWRIGHT_TEST: 'true'
                  }
              }
});
