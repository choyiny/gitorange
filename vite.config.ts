import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react-swc';
import path from 'path';
import { cloudflare } from '@cloudflare/vite-plugin';
import { licenseBanners } from './build/license-banners';

export default defineConfig({
  server: { host: '::', port: 8080 },
  plugins: [cloudflare(), react(), licenseBanners()],
  resolve: { alias: { '@': path.resolve(__dirname, './src') } },
  // Keep dependencies' /*! … */ and @license comments; MIT/BSD notices must ship with the code.
  esbuild: { legalComments: 'inline' },
});
