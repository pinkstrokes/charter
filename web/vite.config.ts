import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { charterDev } from './plugins/charter-dev';

const webRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(webRoot, '..');

// The UI imports the module's own pure TypeScript (policy text, the skill
// interpreter and the hash function) so the browser checks exactly what the
// kernel runs. Those files import @noble/hashes, resolved from web/node_modules.
export default defineConfig({
  // The public build is served from a sub-path (GitHub Pages: /charter/).
  base: process.env.CHARTER_BASE ?? '/',
  plugins: [react(), charterDev({ repoRoot, webRoot })],
  resolve: {
    alias: [
      { find: '@module', replacement: path.join(repoRoot, 'module/spacetimedb/src') },
      { find: /^@noble\/hashes\/(.*)$/, replacement: path.join(webRoot, 'node_modules/@noble/hashes/$1') },
    ],
  },
  server: {
    host: '127.0.0.1',
    port: 5190,
    strictPort: true,
    fs: { allow: [repoRoot] },
  },
  preview: { host: '127.0.0.1', port: 4173 },
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
});
