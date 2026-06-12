import { defineConfig } from 'vitest/config';

// Tests cover the pure helpers in alerts-util.ts (no DB / native driver loaded).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
