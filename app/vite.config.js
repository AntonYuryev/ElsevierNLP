import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: 'dist/renderer',
  },
  // scan only the app's own entry: by default Vite scans EVERY .html file under the project (the generated reports of tools/bce/out are megabytes each) and the dev server then hangs
  optimizeDeps: { entries: ['index.html'] },
  server: {
    host: '127.0.0.1',  // the same address Electron and wait-on use (see main.js)
    port: 5173,
    strictPort: true,   // fail loudly if 5173 is taken: Electron waits for exactly this port, a silent move to 5174 leaves the app waiting forever
  },
});
