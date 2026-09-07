/// <reference types="node" />

import { defineConfig, devices } from '@playwright/test';
import baseConfig from './playwright.config';

const { getWorktreeAppUrl } = require('./scripts/worktree-config.cjs');

const LOCAL_APP_URL = getWorktreeAppUrl();

/**
 * Isolated Playwright project for the Fustat shard GET/POST concurrency
 * bench. Not referenced by `npm test` or `npm run test:cloud-collab`.
 *
 * HTTP/2 stays enabled (the default cloud-collab project disables it).
 */
export default defineConfig({
    ...baseConfig,
    testDir: './tests',
    testMatch: '**/cloud-shard-concurrency.bench.ts',
    timeout: 5_400_000,
    globalSetup: './scripts/cloud-collab-global-setup.mjs',
    projects: [
        {
            name: 'cloud-shard-bench',
            use: {
                ...devices['Desktop Chrome'],
                baseURL: process.env.CI
                    ? 'http://localhost:9000'
                    : LOCAL_APP_URL,
                launchOptions: {
                    args: [
                        '--enable-features=SharedArrayBuffer',
                        '--disable-extensions',
                        '--disable-component-extensions-with-background-pages',
                        '--disable-background-networking',
                        '--disable-sync',
                        '--no-default-browser-check',
                        '--no-first-run'
                    ],
                    chromiumSandbox: true
                }
            }
        }
    ]
});
