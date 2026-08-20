import { defineConfig } from 'vitest/config';

/**
 * Tests live with the package they test (`packages/<name>/tests/`), so a package can
 * be read without jumping back to the repository root to find out what protects it.
 *
 * `tests/repo/` is for what belongs to no package: the checks that hold the repository
 * itself together, like the one that keeps dependabot.yml pointed at the lockfiles we
 * actually have.
 *
 * `tests/e2e/` is the other exception: it drives the whole product through a browser, so it
 * belongs to no single package either. It is Playwright's, and the default vitest include
 * would match its *.spec.ts and fail.
 */
export default defineConfig({
  test: {
    include: ['packages/*/tests/*.test.ts', 'tests/repo/*.test.ts'],
  },
});
