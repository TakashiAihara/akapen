import { spawnSync } from 'node:child_process';

/**
 * Build packages/web/dist once before a run, for vitest and Playwright alike (#200).
 *
 * Server tests import @akapen/web/dist/app.js and E2E tests serve it, so on a fresh
 * checkout every one of them fails to resolve the module. A global setup rather than a
 * `bun run build:web &&` in the npm script, because `bunx vitest` and editor runners do
 * not go through the script. Playwright runs on node, so Bun's APIs are unavailable here.
 */
export default function globalSetup(): void {
  const build = spawnSync('bun', ['run', 'build:web'], { encoding: 'utf8' });
  if (build.status !== 0) {
    throw new Error(`build:web failed\n${build.stderr}`);
  }
}
