import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    // Browser tests build into an isolated throwaway directory so they never
    // replace assets served by an already-running local SessionDeck instance.
    outDir: process.env.SESSIONDECK_CLIENT_DIR || 'dist/client',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('/node_modules/@xterm/')) return 'terminal';
          if (id.includes('/node_modules/react/') || id.includes('/node_modules/react-dom/')) return 'react';
        },
      },
    },
  },
  server: { host: '127.0.0.1' },
});
