import { v4 as uuid } from 'uuid';
import type { WebSocket } from '@fastify/websocket';
import * as store from './store';
import * as connStore from './connection-store';
import * as orchestrator from './llm/orchestrator';
import { ClientMessage, Session, Player, SessionPublic } from './types';

// =============================================================================
// Session helpers
// =============================================================================

const JOIN_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateJoinCode(): string {
  let code = '';
  for (let i = 0; i < 5; i++) {
    code += JOIN_CODE_CHARS[Math.floor(Math.random() * JOIN_CODE_CHARS.length)];
  }
  return code;
}

function createFreshSession(hostName: string): { session: Session; player: Player } {
  let joinCode = generateJoinCode();
  // Ensure uniqueness
  while (store.getSessionByCode(joinCode)) {
    joinCode = generateJoinCode();
  }

  const player: Player = {
    id: uuid(),
    name: hostName.trim().slice(0, 20),
    isHost: true,
    connectedAt: new Date().toISOString(),
  };

  const session: Session = {
    id: uuid(),
    joinCode,
    status: 'lobby',
    players: [player],
    chatHistory: [],
    definitionLlmMessages: [],
    gameLlmMessages: [],
    gameState: {},
    playerUi: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  return { session, player };
}

function toPublicSession(session: Session): SessionPublic {
  return {
    id: session.id,
    joinCode: session.joinCode,
    status: session.status,
    players: session.players,
    chatHistory: session.chatHistory,
    agreedRules: session.agreedRules,
    gameState: session.gameState,
    createdAt: session.createdAt,
  };
}

// =============================================================================
// Message handler
// =============================================================================

export function handleConnection(socket: WebSocket): void {
  const connectionId = uuid();
  connStore.registerConnection(connectionId, socket);
  console.log(`[ws] Client connected (${connectionId})`);

  socket.on('message', (raw) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw.toString()) as ClientMessage;
    } catch {
      socket.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
      return;
    }
    handleMessage(connectionId, socket, msg).catch((err) => {
      console.error('[ws] Unhandled error:', err);
      socket.send(JSON.stringify({ type: 'error', message: 'Internal server error' }));
    });
  });

  socket.on('close', () => {
    const { sessionId, playerId } = connStore.getConnectionMeta(connectionId);
    connStore.unregisterConnection(connectionId);

    if (sessionId && playerId) {
      const session = store.getSession(sessionId);
      if (session) {
        const player = session.players.find((p) => p.id === playerId);
        if (player) {
          connStore.broadcast(sessionId, {
            type: 'player_left',
            playerId,
            playerName: player.name,
          });
        }
      }
    }
    console.log(`[ws] Client disconnected (${connectionId})`);
  });
}

async function handleMessage(
  connectionId: string,
  socket: WebSocket,
  msg: ClientMessage,
): Promise<void> {
  const send = (data: object) => socket.send(JSON.stringify(data));
  const { sessionId, playerId } = connStore.getConnectionMeta(connectionId);

  // ── create_session ──────────────────────────────────────────────────────────
  if (msg.type === 'create_session') {
    const name = msg.playerName?.trim();
    if (!name) {
      send({ type: 'error', message: 'Player name is required.' });
      return;
    }

    const { session, player } = createFreshSession(name);
    store.saveSession(session);
    connStore.associateConnection(connectionId, session.id, player.id);

    send({ type: 'session_created', session: toPublicSession(session), playerId: player.id });
    console.log(`[ws] Session created: ${session.joinCode} by ${name}`);
    return;
  }

  // ── join_session ────────────────────────────────────────────────────────────
  if (msg.type === 'join_session') {
    const name = msg.playerName?.trim();
    const code = msg.joinCode?.trim();

    if (!code) {
      send({ type: 'error', message: 'Join code is required.' });
      return;
    }

    const session = store.getSessionByCode(code);
    if (!session) {
      send({ type: 'error', message: 'Session not found. Check your join code.' });
      return;
    }

    if (session.status === 'finished') {
      send({ type: 'error', message: 'This session has already ended.' });
      return;
    }

    // Reconnect by playerId if provided
    if (msg.playerId) {
      const existing = session.players.find((p) => p.id === msg.playerId);
      if (existing) {
        connStore.associateConnection(connectionId, session.id, existing.id);
        const ui = session.playerUi[existing.id] ?? session.playerUi['all'];
        send({
          type: 'session_joined',
          session: toPublicSession(session),
          playerId: existing.id,
        });
        if (ui) send({ type: 'ui_update', ui });
        return;
      }
    }

    if (!name) {
      send({ type: 'error', message: 'Player name is required.' });
      return;
    }

    // Add new player
    const newPlayer: Player = {
      id: uuid(),
      name: name.slice(0, 20),
      isHost: false,
      connectedAt: new Date().toISOString(),
    };
    session.players.push(newPlayer);
    store.saveSession(session);

    connStore.associateConnection(connectionId, session.id, newPlayer.id);
    send({ type: 'session_joined', session: toPublicSession(session), playerId: newPlayer.id });
    connStore.broadcast(session.id, { type: 'player_joined', player: newPlayer });
    console.log(`[ws] ${name} joined session ${session.joinCode}`);
    return;
  }

  // All subsequent messages require an established session
  if (!sessionId || !playerId) {
    send({ type: 'error', message: 'Not in a session. Create or join one first.' });
    return;
  }

  const session = store.getSession(sessionId);
  if (!session) {
    send({ type: 'error', message: 'Session not found.' });
    return;
  }

  const player = session.players.find((p) => p.id === playerId);
  if (!player) {
    send({ type: 'error', message: 'Player not found in session.' });
    return;
  }

  // ── start_defining ──────────────────────────────────────────────────────────
  if (msg.type === 'start_defining') {
    if (!player.isHost) {
      send({ type: 'error', message: 'Only the host can start the definition phase.' });
      return;
    }
    if (session.status !== 'lobby') {
      send({ type: 'error', message: 'Already past the lobby.' });
      return;
    }

    session.status = 'defining';
    store.saveSession(session);

    connStore.broadcast(sessionId, { type: 'status_change', status: 'defining' });

    // Seed the first AI message
    const greeting = `Welcome! I'm here to help you design your game. Let me know the rules of the game you want to play. 🎮`;
    const greetingMsg = {
      id: uuid(),
      role: 'ai' as const,
      content: greeting,
      timestamp: new Date().toISOString(),
    };
    session.chatHistory.push(greetingMsg);
    store.saveSession(session);
    connStore.broadcast(sessionId, { type: 'chat_message', message: greetingMsg });
    return;
  }

  // ── chat ────────────────────────────────────────────────────────────────────
  if (msg.type === 'chat') {
    if (session.status !== 'defining') {
      send({ type: 'error', message: 'Chat is only available during the definition phase.' });
      return;
    }
    const content = msg.content?.trim();
    if (!content) return;

    await orchestrator.handleDefinitionMessage(sessionId, player.name, content);
    return;
  }

  // ── confirm_rules ───────────────────────────────────────────────────────────
  if (msg.type === 'confirm_rules') {
    if (!player.isHost) {
      send({ type: 'error', message: 'Only the host can confirm rules.' });
      return;
    }
    if (session.status !== 'defining' || !session.agreedRules) {
      send({ type: 'error', message: 'No rules have been proposed yet.' });
      return;
    }

    await orchestrator.startGame(sessionId);
    return;
  }

  // ── form_submit ─────────────────────────────────────────────────────────────
  if (msg.type === 'form_submit') {
    if (session.status !== 'playing') {
      send({ type: 'error', message: 'Game is not in progress.' });
      return;
    }
    await orchestrator.handleFormSubmit(
      sessionId,
      playerId,
      player.name,
      msg.formId,
      msg.values,
    );
    return;
  }

  // ── action ──────────────────────────────────────────────────────────────────
  if (msg.type === 'action') {
    if (session.status !== 'playing') {
      send({ type: 'error', message: 'Game is not in progress.' });
      return;
    }
    await orchestrator.handleAction(sessionId, playerId, player.name, msg.actionId);
    return;
  }

  // ── game_tweak ───────────────────────────────────────────────────────────────
  if (msg.type === 'game_tweak') {
    if (!player.isHost) {
      send({ type: 'error', message: 'Only the host can send game adjustments.' });
      return;
    }
    if (session.status !== 'playing') {
      send({ type: 'error', message: 'Game is not in progress.' });
      return;
    }
    const content = msg.content?.trim();
    if (!content) return;
    await orchestrator.handleGameTweak(sessionId, player.name, content);
    return;
  }

  // ── reset_session ───────────────────────────────────────────────────────────
  if (msg.type === 'reset_session') {
    if (!player.isHost) {
      send({ type: 'error', message: 'Only the host can reset the session.' });
      return;
    }

    // Cancel any in-flight timers
    orchestrator.cancelAllTimers(sessionId);

    // Wipe game state but keep definition chat, LLM context, and agreed rules
    // so the confirm banner appears immediately (host can start the same game
    // without another definition round-trip, or keep chatting to change rules)
    const previousRules = session.agreedRules;
    session.status = 'defining';
    session.stateSchema = undefined;
    session.gameState = {};
    session.playerUi = {};
    session.gameLlmMessages = [];

    // Append a system message so the chat history shows the reset
    const resetMsg = {
      id: uuid(),
      role: 'system' as const,
      content: previousRules
        ? '— Game reset. The previous rules are shown below — hit \'Start game\' to play again, or describe a new game to change them.'
        : '— Game reset. Describe a new game to play.',
      timestamp: new Date().toISOString(),
    };
    session.chatHistory.push(resetMsg);
    session.updatedAt = new Date().toISOString();
    store.saveSession(session);

    connStore.broadcast(sessionId, { type: 'chat_message', message: resetMsg });
    connStore.broadcast(sessionId, { type: 'status_change', status: 'defining', agreedRules: previousRules });
    connStore.broadcast(sessionId, { type: 'ui_update', ui: [] });
    console.log(`[ws] Session ${session.joinCode} reset to defining by ${player.name}`);
    return;
  }

  // ── full_reset ───────────────────────────────────────────────────────────────
  if (msg.type === 'full_reset') {
    if (!player.isHost) {
      send({ type: 'error', message: 'Only the host can reset the session.' });
      return;
    }

    orchestrator.cancelAllTimers(sessionId);

    // Wipe everything — back to a clean lobby
    session.status = 'lobby';
    session.agreedRules = undefined;
    session.stateSchema = undefined;
    session.gameState = {};
    session.playerUi = {};
    session.chatHistory = [];
    session.definitionLlmMessages = [];
    session.gameLlmMessages = [];
    session.updatedAt = new Date().toISOString();
    store.saveSession(session);

    connStore.broadcast(sessionId, { type: 'status_change', status: 'lobby' });
    connStore.broadcast(sessionId, { type: 'ui_update', ui: [] });
    console.log(`[ws] Session ${session.joinCode} fully reset to lobby by ${player.name}`);
    return;
  }
}
