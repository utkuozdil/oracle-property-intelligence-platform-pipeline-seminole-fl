import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * In production the SPA and the tRPC API share a CloudFront origin, so `/trpc` is a
 * relative path. `vite dev` reproduces that by proxying `/trpc` to whichever endpoint
 * `VITE_API_PROXY_TARGET` names — normally the deployed execute-api URL.
 */
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/trpc': {
        target: process.env.VITE_API_PROXY_TARGET ?? 'http://127.0.0.1:3000',
        changeOrigin: true,
      },
    },
  },
});
