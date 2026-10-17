import { fileURLToPath, URL } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const publicBase = process.env.VITE_BASE ?? './';

// The panel talks to the Qelay Cloud Control API (packages/control-api, default :8080).
// In dev, requests to `/api/*` are proxied there so there is no CORS setup; point
// VITE_PROXY_TARGET at another origin to use a different one. In prod, set
// VITE_QELAY_URL to the API origin (see src/lib/api.ts) or serve the built assets behind
// the same origin as the API. `bun run dev:stub` needs no API at all: it serves fixture data.
export default defineConfig({
  // Relative chunk URLs keep lazy imports anchored to their entry module, so an arbitrary
  // mount works without rewriting JavaScript. A static deployment can still set an explicit
  // VITE_BASE.
  base: publicBase,
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  build: {
    // Emit dist/.vite/manifest.json: it names the INITIAL load (entry chunk + its static
    // imports) apart from the lazy routes and features (demo shim, AI copilot).
    manifest: true,
    rollupOptions: {
      output: {
        // Split the React runtime (react, react-dom, react-router[-dom]) into
        // its own chunk so app-only changes don't bust the vendor cache on
        // returning visitors. `react-router` must match too: in React Router 7
        // it holds the entire router implementation (react-router-dom is a
        // tiny re-export shim). Function form is required — Vite 8 / Rolldown
        // rejects the object form of manualChunks.
        manualChunks(id) {
          if (id.includes('node_modules') && /[\\/]react(-dom|-router(-dom)?)?[\\/]/.test(id)) {
            return 'react-vendor';
          }
        },
      },
    },
  },
  server: {
    port: 5273,
    // Fail fast when 5273 is taken (a leftover dev server) instead of silently serving on
    // 5274 and leaving the operator on a stale instance whose edits "have no effect".
    strictPort: true,
    proxy: {
      '/api': {
        target: process.env.VITE_PROXY_TARGET ?? 'http://localhost:8080',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
});
