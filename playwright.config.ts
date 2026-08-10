import { defineConfig } from '@playwright/test';

/**
 * E2E runs a real server and drives a real browser.
 *
 * Everything that broke here — focus, IME, ranges, re-rendering — is only visible in
 * real DOM behaviour; the storage-layer tests caught none of it.
 *
 * fixtures.ts starts a server per test (no webServer): sharing one mixes comments
 * between tests.
 */
export default defineConfig({
  testDir: 'tests/e2e',
  globalSetup: './tests/e2e/globalSetup.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],
  use: { trace: process.env.CI ? 'retain-on-failure' : 'off' },
});
