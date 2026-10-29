import { defineConfig } from 'vite';

const backend = `http://localhost:${process.env.PORT ?? 3000}`;

export default defineConfig({
  root: 'client',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    host: '0.0.0.0',
    proxy: {
      '/socket.io': { target: backend, ws: true },
      '/media': backend,
      '/api': backend,
    },
  },
});
