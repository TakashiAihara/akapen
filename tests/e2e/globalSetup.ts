import { spawnSync } from 'node:child_process';

/**
 * Each E2E test starts its own server, but the browser build (packages/web/dist) is shared.
 * Building per test would be waste, so build once before the run.
 * Playwright runs on node, so Bun's APIs are unavailable here.
 */
export default function globalSetup(): void {
  const build = spawnSync('bun', ['run', 'build:web'], { encoding: 'utf8' });
  if (build.status !== 0) {
    throw new Error(`build:web failed\n${build.stderr}`);
  }
}
