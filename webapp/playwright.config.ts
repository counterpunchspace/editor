import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright Configuration for Context Font Editor
 *
 * See https://playwright.dev/docs/test-configuration
 */
export default defineConfig({
    testDir: './tests',

    // Only run Playwright spec files, not Jest test files
    testMatch: '**/*.spec.ts',

    // Maximum time one test can run (5 minutes for complex interactions)
    timeout: 300000,

    // Run tests in parallel
    fullyParallel: true,

    // Fail the build on CI if you accidentally left test.only
    forbidOnly: !!process.env.CI,

    // Retry on CI only
    retries: process.env.CI ? 2 : 0,

    // Reporter to use
    reporter: [['html'], ['list']],

    // Shared settings for all projects
    use: {
        // Base URL for navigation
        baseURL: process.env.CI
            ? 'http://localhost:9000'
            : 'https://localhost:8000',

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
                // Ensure isolated context
                contextOptions: {
                    clearCookies: true,
                    clearCache: true
                }
            }
        }

        // {
        //     name: 'webkit',
        //     use: {
        //         ...devices['Desktop Safari']
        //     },
        //     timeout: 600000 // 10 minutes for WebKit (slower initialization)
        // }
    ],

    // Run your local dev server before starting the tests
    webServer: {
        command: process.env.CI ? 'npm run serve:ci' : 'npm run serve',
        url: process.env.CI
            ? 'http://localhost:9000'
            : 'https://localhost:8000',
        reuseExistingServer: !process.env.CI,
        timeout: 120000, // 2 minutes to start dev server
        ignoreHTTPSErrors: true, // Self-signed cert for dev server
        env: {
            PLAYWRIGHT_TEST: 'true' // Disable webpack HMR/overlay during tests
        }
    }
});
