import path from 'path';
import dotenv from 'dotenv';

// Load .env from project root — __dirname at runtime is dist/server/src, so 4 levels up
dotenv.config({ path: path.join(__dirname, '../../../../.env') });

import Fastify from 'fastify';
import fastifyCors from '@fastify/cors';
import fastifyWebSocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import fs from 'fs';
import { handleConnection } from './ws-handler';

const PORT = parseInt(process.env.PORT ?? '3001', 10);
const CLIENT_DIST = path.join(__dirname, '../../../../client/dist');

async function start(): Promise<void> {
  const app = Fastify({ logger: { level: 'info' } });

  // ── Plugins ────────────────────────────────────────────────────────────────
  await app.register(fastifyCors, { origin: '*' });
  await app.register(fastifyWebSocket);

  // Serve built client assets in production
  if (fs.existsSync(CLIENT_DIST)) {
    await app.register(fastifyStatic, {
      root: CLIENT_DIST,
      prefix: '/',
    });
    // SPA fallback — serve index.html for any non-asset route
    app.setNotFoundHandler((_req, reply) => {
      reply.sendFile('index.html');
    });
  }

  // ── WebSocket endpoint ─────────────────────────────────────────────────────
  app.get('/ws', { websocket: true }, (socket) => {
    handleConnection(socket);
  });

  // ── Health check ───────────────────────────────────────────────────────────
  app.get('/health', async () => ({ status: 'ok' }));

  // ── Start ──────────────────────────────────────────────────────────────────
  await app.listen({ port: PORT, host: '0.0.0.0' });
  console.log(`[server] Listening on http://0.0.0.0:${PORT}`);
}

start().catch((err) => {
  console.error(err);
  process.exit(1);
});
