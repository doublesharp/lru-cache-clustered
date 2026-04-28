import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'node22',
  outDir: 'dist',
  splitting: false,
  shims: false,
  cjsInterop: true,
});
