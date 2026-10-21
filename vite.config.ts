import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react-swc';
import path from 'path';
import { cloudflare } from '@cloudflare/vite-plugin';
import { licenseBanners } from './build/license-banners';

export default defineConfig({
  server: { host: '::', port: 8080 },
  plugins: [
    // The npm package is built from a placeholder config (scripts/gitorange/pack.mjs); a normal
    // build reads ./wrangler.jsonc.
    cloudflare({ configPath: process.env.GITORANGE_BUILD_CONFIG }),
    react(),
    licenseBanners(),
  ],
  resolve: { alias: { '@': path.resolve(__dirname, './src') } },
  // Keep dependencies' /*! … */ and @license comments; MIT/BSD notices must ship with the code.
  esbuild: { legalComments: 'inline' },
});
