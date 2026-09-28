import { defineConfig } from '@playwright/test'

/**
 * End-to-end configuration (plan Task 6.1, spec section 13).
 *
 * The suite drives the built Electron app through `e2e/fixtures.ts`. There is
 * no browser project and no web server: this app has no HTTP backend at all
 * (spec sections 2 and 3.1), and the only thing Playwright launches is
 * `out/main/index.js`. `pnpm test:e2e` builds first, because that file is what
 * every test runs.
 *
 * One worker. Each test already gets its own temp workspace, but the fake Codex
 * and the real Electron runtime are both heavy, and a single worker keeps the
 * timings a state-sequence assertion depends on predictable.
 */
export default defineConfig({
  testDir: 'e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env['CI']),
  retries: 0,
  // An Electron start plus a fake run is seconds, not tens of seconds; a test
  // that needs longer is a test that is stuck.
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter: process.env['CI'] === undefined ? [['list']] : [['list'], ['html', { open: 'never' }]],
  use: { trace: 'retain-on-failure' }
})
