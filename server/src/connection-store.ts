import type { WebSocket } from '@fastify/websocket';
import { ServerMessage } from './types';

// =============================================================================
// Connection registry
// Each WebSocket connection is tracked here. A connection is initially
// anonymous; once the client sends create_session / join_session it becomes
// associated with a session and player.
// =============================================================================

interface Connection {
  id: string;
  socket: WebSocket;
  sessionId?: string;
  playerId?: string;
}

/** connectionId → Connection */
const connections = new Map<string, Connection>();

/** sessionId → Set<connectionId> */
const sessionIndex = new Map<string, Set<string>>();

// ─── Registration ─────────────────────────────────────────────────────────────

export function registerConnection(id: string, socket: WebSocket): void {
  connections.set(id, { id, socket });
}

export function unregisterConnection(id: string): void {
  const conn = connections.get(id);
  if (conn?.sessionId) {
    sessionIndex.get(conn.sessionId)?.delete(id);
  }
  connections.delete(id);
}

export function associateConnection(
  connectionId: string,
  sessionId: string,
  playerId: string,
): void {
  const conn = connections.get(connectionId);
  if (!conn) return;

  // Remove from any previous session index
  if (conn.sessionId) {
    sessionIndex.get(conn.sessionId)?.delete(connectionId);
  }

  conn.sessionId = sessionId;
  conn.playerId = playerId;

  if (!sessionIndex.has(sessionId)) {
    sessionIndex.set(sessionId, new Set());
  }
  sessionIndex.get(sessionId)!.add(connectionId);
}

export function getConnectionMeta(
  connectionId: string,
): { sessionId?: string; playerId?: string } {
  const conn = connections.get(connectionId);
  return { sessionId: conn?.sessionId, playerId: conn?.playerId };
}

// ─── Broadcasting ─────────────────────────────────────────────────────────────

function send(socket: WebSocket, message: ServerMessage): void {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

/** Broadcast a message to every connected player in a session. */
export function broadcast(sessionId: string, message: ServerMessage): void {
  const connIds = sessionIndex.get(sessionId);
  if (!connIds) return;
  for (const connId of connIds) {
    const conn = connections.get(connId);
    if (conn) send(conn.socket, message);
  }
}

/** Send a message to a specific player in a session. */
export function sendToPlayer(
  sessionId: string,
  playerId: string,
  message: ServerMessage,
): void {
  const connIds = sessionIndex.get(sessionId);
  if (!connIds) return;
  for (const connId of connIds) {
    const conn = connections.get(connId);
    if (conn?.playerId === playerId) {
      send(conn.socket, message);
      return;
    }
  }
}
