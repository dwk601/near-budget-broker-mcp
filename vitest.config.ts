import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    passWithNoTests: false,
    clearMocks: true,
    restoreMocks: true,
    testTimeout: 10_000,
    hookTimeout: 10_000,
  },
});
