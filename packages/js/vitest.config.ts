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
        //
        // branches was lowered 99.17 -> 98.69 by maintainer decision: the tests
        // that held the difference reached defensive guards only by stubbing
        // internals (Translator.ts:180/1306, Observer.ts:228/266) — unreachable
        // from real DOM behavior. They exercised the metric, not the code, and
        // were removed. The remaining gap is those guards.
        autoUpdate: true,
        branches: 98.69,
        functions: 100,
        lines: 99.92,
        statements: 99.85,
      },
    },
  },
});