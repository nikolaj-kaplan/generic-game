import os from 'os';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * This machine's address on the local network, for the join QR code when the
 * host opens the app as localhost (which means nothing on a phone). Only when
 * the app is reachable from the network: `vite --host` in dev, or a build
 * (the server listens on all interfaces).
 */
function lanHost(): string {
  const exposed = process.argv.includes('--host') || process.argv.includes('build');
  if (!exposed) return '';
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return '';
}

export default defineConfig({
  plugins: [react()],
  define: {
    __LAN_HOST__: JSON.stringify(lanHost()),
  },
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
