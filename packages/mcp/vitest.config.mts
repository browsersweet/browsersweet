import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.spec.ts'],
    environment: 'node',
    // Each file gets its own process: host tests change the umask and spawn children.
    pool: 'forks',
    testTimeout: 20_000,
  },
});
