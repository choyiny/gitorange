import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react-swc';
import path from 'path';
import { cloudflare } from '@cloudflare/vite-plugin';

export default defineConfig({
  server: { host: '::', port: 8080 },
  plugins: [cloudflare(), react()],
  resolve: { alias: { '@': path.resolve(__dirname, './src') } },
});
