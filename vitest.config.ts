import { defineConfig } from 'vitest/config';

/**
 * Tests live with the package they test (`packages/<name>/tests/`), so a package can
 * be read without jumping back to the repository root to find out what protects it.
 *
 * `tests/e2e/` is the exception and stays at the root: it drives the whole product
 * through a browser, so it belongs to no single package. It is Playwright's, and the
 * default vitest include would match its *.spec.ts and fail.
 */
export default defineConfig({
  test: {
    include: ['packages/*/tests/*.test.ts'],
  },
});
