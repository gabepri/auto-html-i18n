import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';
import { resolve } from 'path';

export default defineConfig({
  plugins: [
    dts({
      tsconfigPath: './tsconfig.build.json',
      rollupTypes: true,
    }),
  ],
  build: {
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      name: 'AutoDomI18n',
      formats: ['es', 'cjs'],
      fileName: (format) => {
        if (format === 'es') return 'auto-dom-i18n.js';
        return 'auto-dom-i18n.cjs';
      },
    },
    sourcemap: true,
    target: 'es2020',
    rollupOptions: {
      external: ['intl-messageformat'],
    },
  },
});
