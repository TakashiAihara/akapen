import { defineConfig } from 'vitest/config';

/**
 * E2E は playwright が持つので vitest からは外す。
 * 既定の include は *.spec.ts も拾うため、tests/e2e/ を巻き込んで落ちる。
 */
export default defineConfig({
  test: {
    include: ['tests/*.test.ts'],
  },
});
