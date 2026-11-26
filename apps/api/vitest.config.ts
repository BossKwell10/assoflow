import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// SWC émet les métadonnées de décorateurs dont l'injection NestJS a besoin.
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: { include: ['test/**/*.test.ts'], environment: 'node', testTimeout: 20000 },
});
