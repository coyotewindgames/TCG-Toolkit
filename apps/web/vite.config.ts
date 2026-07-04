import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Best-effort short build id so operators can confirm a fresh deploy shipped.
 * Prefer platform-provided commit hashes (Render, Vercel, GitHub Actions) and
 * fall back to a timestamp so we always have something to eyeball in the UI.
 */
function resolveBuildId(): string {
  const candidates = [
    process.env.RENDER_GIT_COMMIT,
    process.env.VERCEL_GIT_COMMIT_SHA,
    process.env.GITHUB_SHA,
    process.env.COMMIT_SHA,
    process.env.SOURCE_VERSION,
  ];
  for (const value of candidates) {
    if (value && value.length >= 7) return value.slice(0, 7);
  }
  return `dev-${new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 12)}`;
}

const BUILD_ID = resolveBuildId();
const BUILD_TIME = new Date().toISOString();

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_BUILD_ID__: JSON.stringify(BUILD_ID),
    __APP_BUILD_TIME__: JSON.stringify(BUILD_TIME),
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:3000', changeOrigin: true },
      '/socket.io': { target: 'http://localhost:3000', ws: true, changeOrigin: true },
    },
  },
  build: { outDir: 'dist', sourcemap: true },
});
