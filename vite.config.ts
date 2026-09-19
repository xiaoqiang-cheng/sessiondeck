import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist/client',
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
