import { defineConfig } from 'vite';
import path from 'path';

export default defineConfig({
  root: __dirname,
  publicDir: 'public',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
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
      '/ws': { target: 'ws://localhost:3000', ws: true },
      '/api': 'http://localhost:3000',
    },
  },
});
