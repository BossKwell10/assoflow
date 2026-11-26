import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { '/v1': 'http://localhost:3000', '/health': 'http://localhost:3000' } },
  build: { sourcemap: true, chunkSizeWarningLimit: 600 },
  test: { environment: 'jsdom', setupFiles: ['./src/test-setup.ts'], css: false, testTimeout: 20_000 },
});
