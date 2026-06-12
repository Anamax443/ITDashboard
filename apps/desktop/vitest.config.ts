import { defineConfig } from 'vitest/config';

// Standalone test config so the unit tests for pure logic don't pull in the
// Electron/Vite app build. Tests live next to the code as *.test.ts.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
