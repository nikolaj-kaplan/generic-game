import dotenv from 'dotenv';
import { CLIENT_DIST, ENV_FILE } from './paths';

// Variables already set in the environment win over .env (the playtest
// harness relies on this to force a local model).
dotenv.config({ path: ENV_FILE });

import Fastify from 'fastify';
import fastifyCors from '@fastify/cors';
import fastifyWebSocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import fs from 'fs';
import { handleConnection } from './ws-handler';
import { allSessions } from './store';
import { recoverInterruptedGames } from './llm/orchestrator';
import { recoverGames } from './engine/host';

const PORT = parseInt(process.env.PORT ?? '3101', 10);

async function start(): Promise<void> {
  // Program games re-arm their timers; AI-per-turn games get a Retry button.
  recoverGames(allSessions());
  recoverInterruptedGames(allSessions().filter((s) => !s.program));

  // Request logs are noise next to the game logs; LOG_LEVEL=info brings them back.
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'warn' } });

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
