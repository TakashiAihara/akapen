import { defineConfig } from '@playwright/test';

/**
 * E2E は本物のサーバを立てて実ブラウザで叩く。
 * このセッションで壊した箇所 (フォーカス / IME / 範囲 / 再描画) はどれも DOM の
 * 実挙動でしか捕まらず、store 層のテストでは 1 件も検出できなかった。
 *
 * サーバはテストごとに fixtures.ts が立てる (webServer は使わない)。
 * 1 台を共有するとコメントが混ざる。
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
