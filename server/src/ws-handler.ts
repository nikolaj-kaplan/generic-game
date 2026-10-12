import { v4 as uuid } from 'uuid';
import type { WebSocket } from '@fastify/websocket';
import * as store from './store';
import * as connStore from './connection-store';
import * as orchestrator from './llm/orchestrator';
import * as engineHost from './engine/host';
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

/** Games run by a generated program (the default) or by the AI turn by turn (GAME_ENGINE=legacy). */
function programGame(session: Session): boolean {
  if (session.status === 'playing' || session.status === 'finished') return !!session.program;
  return engineHost.engineMode() === 'program';
}

function resendState(session: Session, playerId: string): void {
  if (programGame(session)) engineHost.resendState(session, playerId);
  else orchestrator.resendState(session, playerId);
}

function toPublicSession(session: Session): SessionPublic {
  return {
    id: session.id,
    joinCode: session.joinCode,
    status: session.status,
    players: session.players,
    chatHistory: session.chatHistory,
    agreedRules: session.agreedRules,
    playerRange: session.playerRange,
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

    // Reconnect by playerId if provided (also after the game ended, so the
    // host can still press "Play again" after a reload or a network blip)
    if (msg.playerId) {
      const existing = session.players.find((p) => p.id === msg.playerId);
      if (existing) {
        connStore.associateConnection(connectionId, session.id, existing.id);
        send({
          type: 'session_joined',
          session: toPublicSession(session),
          playerId: existing.id,
        });
        resendState(session, existing.id);
        return;
      }
    }

    if (session.status === 'finished') {
      send({ type: 'error', message: 'This session has already ended.' });
      return;
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
    if (session.status === 'defining') {
      const joinedMsg = {
        id: uuid(),
        role: 'system' as const,
        content: `👋 ${newPlayer.name} joined`,
        timestamp: new Date().toISOString(),
      };
      session.chatHistory.push(joinedMsg);
      store.saveSession(session);
      connStore.broadcast(session.id, { type: 'chat_message', message: joinedMsg });
    }
    // Joining mid-game: show the shared screen until the AI includes the new player.
    if (session.status === 'playing') resendState(session, newPlayer.id);
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

  // ── leave_session ───────────────────────────────────────────────────────────
  if (msg.type === 'leave_session') {
    session.players = session.players.filter((p) => p.id !== playerId);
    connStore.unregisterConnection(connectionId);
    connStore.registerConnection(connectionId, socket);
    if (session.players.length > 0 && !session.players.some((p) => p.isHost)) {
      session.players[0] = { ...session.players[0], isHost: true };
    }
    if (session.players.length === 0) {
      orchestrator.cancelAllTimers(sessionId);
      engineHost.cancel(sessionId);
    }
    store.saveSession(session);
    connStore.broadcast(sessionId, { type: 'players_update', players: session.players });
    console.log(`[ws] ${player.name} left session ${session.joinCode}`);
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
    const range = session.playerRange;
    const count = session.players.length;
    if (range && (count < range.min || count > range.max)) {
      send({
        type: 'error',
        message: count < range.min
          ? `This game needs at least ${range.min} players (${count} joined). Invite more players first.`
          : `This game allows at most ${range.max} players (${count} joined).`,
      });
      return;
    }

    if (programGame(session)) await engineHost.confirmRules(sessionId);
    else await orchestrator.startGame(sessionId);
    return;
  }

  // ── load_rules ──────────────────────────────────────────────────────────────
  if (msg.type === 'load_rules') {
    if (!player.isHost) {
      send({ type: 'error', message: 'Only the host can load saved rules.' });
      return;
    }
    const rules = msg.rules?.trim();
    if (!rules) return;
    if (session.status === 'lobby') {
      session.status = 'defining';
      store.saveSession(session);
      connStore.broadcast(sessionId, { type: 'status_change', status: 'defining' });
    }
    if (session.status !== 'defining') {
      send({ type: 'error', message: 'Saved rules can only be loaded before the game starts.' });
      return;
    }
    await orchestrator.loadSavedRules(sessionId, player.name, rules, msg.playerRange);
    if (msg.program && msg.program.rules === rules && programGame(session)) {
      await orchestrator.enqueue(sessionId, async () => {
        const s = store.getSession(sessionId);
        if (s?.agreedRules === rules && (await engineHost.adoptSavedProgram(s, msg.program!.code, rules))) {
          console.log(`[define:${s.joinCode}] Saved program loaded with the rules`);
          store.saveSession(s);
        }
      });
    }
    return;
  }

  // ── form_submit ─────────────────────────────────────────────────────────────
  if (msg.type === 'form_submit') {
    if (session.status !== 'playing') {
      send({ type: 'error', message: 'Game is not in progress.' });
      return;
    }
    if (programGame(session)) {
      await engineHost.handleInput(sessionId, playerId, { kind: 'submit', id: String(msg.formId ?? ''), values: msg.values ?? {}, turn: msg.turn });
      return;
    }
    await orchestrator.handlePlayerInput(sessionId, playerId, {
      kind: 'submit',
      id: String(msg.formId ?? ''),
      values: msg.values ?? {},
      turn: msg.turn,
    });
    return;
  }

  // ── action ──────────────────────────────────────────────────────────────────
  if (msg.type === 'action') {
    if (session.status !== 'playing') {
      send({ type: 'error', message: 'Game is not in progress.' });
      return;
    }
    if (programGame(session)) {
      await engineHost.handleInput(sessionId, playerId, { kind: 'action', id: String(msg.actionId ?? ''), turn: msg.turn });
      return;
    }
    await orchestrator.handlePlayerInput(sessionId, playerId, {
      kind: 'action',
      id: String(msg.actionId ?? ''),
      turn: msg.turn,
    });
    return;
  }

  // ── retry_turn ──────────────────────────────────────────────────────────────
  if (msg.type === 'retry_turn') {
    if (session.status !== 'playing') {
      send({ type: 'error', message: 'Game is not in progress.' });
      return;
    }
    // Anyone may retry a stalled turn; otherwise only the host can interrupt.
    if (!player.isHost && !session.stalled) {
      send({ type: 'error', message: 'Only the host can ask the AI to continue.' });
      return;
    }
    if (programGame(session)) await engineHost.retry(sessionId, player.name);
    else await orchestrator.retryTurn(sessionId, player.name);
    return;
  }

  // ── game_tweak ───────────────────────────────────────────────────────────────
  if (msg.type === 'game_tweak') {
    if (!player.isHost) {
      send({ type: 'error', message: 'Only the host can send game adjustments.' });
      return;
    }
    // Allowed after game over too: the host can still ask for e.g. a final score screen.
    if (session.status !== 'playing' && session.status !== 'finished') {
      send({ type: 'error', message: 'Game is not in progress.' });
      return;
    }
    const content = msg.content?.trim();
    if (!content) return;
    if (programGame(session)) await engineHost.requestChange(sessionId, player.name, content);
    else await orchestrator.handleGameTweak(sessionId, player.name, content);
    return;
  }

  // ── patch_decision ────────────────────────────────────────────────────────────
  if (msg.type === 'patch_decision') {
    if (!player.isHost) {
      send({ type: 'error', message: 'Only the host can approve changes.' });
      return;
    }
    await engineHost.decidePatch(sessionId, msg.id, msg.apply === true);
    return;
  }

  // ── reset_session ───────────────────────────────────────────────────────────
  if (msg.type === 'reset_session') {
    if (!player.isHost) {
      send({ type: 'error', message: 'Only the host can reset the session.' });
      return;
    }

    // Cancel any in-flight timers (the game program is kept for "play again")
    orchestrator.cancelAllTimers(sessionId);
    engineHost.cancel(sessionId);

    // Wipe game state but keep definition chat, LLM context, and agreed rules
    // so the confirm banner appears immediately (host can start the same game
    // without another definition round-trip, or keep chatting to change rules)
    const previousRules = session.agreedRules;
    session.status = 'defining';
    session.gameState = {};
    session.playerUi = {};
    session.gameLlmMessages = [];
    session.turnCounter = 0;

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
    connStore.broadcast(sessionId, { type: 'turn_status', status: null });
    connStore.broadcast(sessionId, { type: 'game_error', message: null });
    connStore.broadcast(sessionId, { type: 'paused', message: null });
    connStore.broadcast(sessionId, { type: 'patch_proposal', proposal: null });
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
    engineHost.cancel(sessionId);

    // Wipe everything — back to a clean lobby
    session.status = 'lobby';
    session.agreedRules = undefined;
    session.playerRange = undefined;
    session.gameState = {};
    session.turnCounter = 0;
    session.playerUi = {};
    session.chatHistory = [];
    session.definitionLlmMessages = [];
    session.gameLlmMessages = [];
    session.program = undefined;
    session.programHistory = undefined;
    session.adjustments = undefined;
    session.updatedAt = new Date().toISOString();
    store.saveSession(session);

    connStore.broadcast(sessionId, { type: 'status_change', status: 'lobby' });
    connStore.broadcast(sessionId, { type: 'paused', message: null });
    connStore.broadcast(sessionId, { type: 'patch_proposal', proposal: null });
    connStore.broadcast(sessionId, { type: 'ui_update', ui: [] });
    connStore.broadcast(sessionId, { type: 'turn_status', status: null });
    connStore.broadcast(sessionId, { type: 'game_error', message: null });
    console.log(`[ws] Session ${session.joinCode} fully reset to lobby by ${player.name}`);
    return;
  }
}
