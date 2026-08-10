import { defineConfig } from 'vitest/config';

/**
 * E2E belongs to Playwright, so keep it out of vitest.
 * The default include also matches *.spec.ts, which drags tests/e2e/ in and fails.
 */
export default defineConfig({
  test: {
    include: ['tests/*.test.ts'],
  },
});
