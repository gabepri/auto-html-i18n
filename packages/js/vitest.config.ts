import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'happy-dom',
    globals: true,
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      experimentalAstAwareRemapping: true,
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts', 'src/types.ts'],
      thresholds: {
        // Coverage must not regress: autoUpdate ratchets these up to current on
        // passing runs, and a drop below the recorded numbers fails the run.
        // Never hand-lower these without the maintainer's sign-off.
        autoUpdate: true,
        branches: 91.24,
        functions: 99.54,
        lines: 98.88,
        statements: 98.19,
      },
    },
  },
});