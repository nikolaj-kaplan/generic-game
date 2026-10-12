import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // VS Code port forwarding (dev tunnels) for testing on a phone
    allowedHosts: ['.devtunnels.ms'],
    proxy: {
      '/ws': {
        // 3101, not 3001: a VS Code extension listens on 127.0.0.1:3001 and swallows the proxy
        target: 'http://127.0.0.1:3101',
        ws: true,
        changeOrigin: true,
      },
    },
  },
});
