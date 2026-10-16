import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import path from 'path';

export default defineConfig({
  root: __dirname,
  publicDir: 'public',
  plugins: [vue()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
  },
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, '../shared/src'),
      '/wasm/eauth/index.js': path.resolve(__dirname, '../node_modules/eauth-wasm/index.js'),
      '/wasm/crabs/index.js': path.resolve(__dirname, '../node_modules/crabs-wasm/index.js'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/ws': { target: 'ws://localhost:9000', ws: true },
      '/api': 'http://localhost:9000',
    },
  },
});
