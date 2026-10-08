import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import preact from '@preact/preset-vite';

const shared = { '@shared': resolve('src/shared') };

export default defineConfig({
  main: { resolve: { alias: shared } },
  preload: {
    resolve: { alias: shared },
    // Sandboxed preloads must be a single CommonJS file.
    build: { rollupOptions: { output: { format: 'cjs', entryFileNames: '[name].cjs' } } },
  },
  renderer: {
    resolve: { alias: shared },
    plugins: [preact()],
  },
});
