import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Property-based tests (fast-check) run a minimum of 100 iterations and can
    // take longer than the default; give them room.
    testTimeout: 30_000,
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    environment: 'node',
    globals: false,
  },
});
