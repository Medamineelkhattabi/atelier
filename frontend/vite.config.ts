import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// The backend serves dist/ itself in production (same origin, relative /api calls).
// In development, Vite proxies /api to the backend started with `pae.cli serve --port 8600`.
const BACKEND = process.env.PAE_BACKEND_URL ?? 'http://127.0.0.1:8600';

export default defineConfig({
  plugins: [react()],
  server: {
    // Same loopback address as the backend (and its session cookie); "localhost" may resolve to IPv6 only.
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: BACKEND,
        changeOrigin: false,
        // Server-Sent Events must reach the browser as they are produced.
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq, req) => {
            if (req.headers.accept?.includes('text/event-stream')) {
              proxyReq.setHeader('accept-encoding', 'identity');
            }
          });
          proxy.on('proxyRes', (proxyRes, _req, res) => {
            if (proxyRes.headers['content-type']?.includes('text/event-stream')) {
              // Send the status and the upstream headers now, so the browser gets text/event-stream before
              // the first event. (Once headers are sent, http-proxy skips its own header copy: flushing
              // without writing them first used to drop Content-Type and EventSource refused the stream.)
              res.writeHead(proxyRes.statusCode ?? 200, {
                ...proxyRes.headers,
                'cache-control': 'no-cache',
                'x-accel-buffering': 'no',
              });
              res.flushHeaders?.();
            }
          });
        },
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 800,
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: false,
    restoreMocks: true,
    unstubGlobals: true,
  },
});
