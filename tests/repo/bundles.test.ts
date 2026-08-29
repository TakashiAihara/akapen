import { existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

/**
 * The browser bundles, and the one of them that can silently gain a megabyte.
 *
 * `dbml.js` turns DBML into DOT and nothing else: the layout is graphviz's, and graphviz
 * is already shipped once as `graphviz.js`. But the DBML renderer requires `@viz-js/viz`
 * at module scope — it only reaches it for SVG, which this entry never asks for — so
 * bundling it plainly pulls a second copy of the engine in. That costs 1.37MB instead of
 * 97KB for an engine that is never called, and nothing about the product looks or
 * behaves any differently, which is why it needs a test rather than a comment.
 *
 * `packages/web/build.ts` resolves that import to a stub. This is what notices when the
 * stub stops being applied.
 *
 * The numbers are ceilings with room to grow, not the measurements themselves. A bundle
 * drifting up by a few KB is ordinary; the failure being guarded against is an order of
 * magnitude.
 */
const CEILINGS: Record<string, number> = {
  'app.js': 200 * 1024,
  'dbml.js': 200 * 1024,
  'graphviz.js': 1.5 * 1024 * 1024,
  'mermaid.js': 5 * 1024 * 1024,
};

const dist = fileURLToPath(new URL('../../packages/web/dist/', import.meta.url));

describe('browser bundles', () => {
  test.each(Object.entries(CEILINGS))('%s stays under its ceiling', (name, ceiling) => {
    const path = `${dist}${name}`;
    // Built by `bun run build:web`, which the pre-push hook and CI both run before this.
    // Skipping when absent would make a missing build look like a passing check.
    expect(existsSync(path), `${name} is not built; run bun run build:web`).toBe(true);
    expect(statSync(path).size).toBeLessThan(ceiling);
  });
});
