import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  ClientMessage,
  ServerMessage,
  SessionPublic,
  SessionStatus,
  ChatMessage,
  UIComponent,
  Player,
} from '../types';

// =============================================================================
// Context shape
// =============================================================================

interface GameState {
  connectionStatus: 'connecting' | 'connected' | 'disconnected';
  sessionStatus: SessionStatus | null;
  session: SessionPublic | null;
  playerId: string | null;
  chatMessages: ChatMessage[];
  currentUI: UIComponent[];
  gameState: Record<string, unknown>;
  agreedRules: string | null;
  endGameMessage: string | null;
  isAiThinking: boolean;
  expiredTimers: Set<string>;
  errorMessage: string | null;
}

interface GameContextValue extends GameState {
  send: (message: ClientMessage) => void;
  clearError: () => void;
}

const initialState: GameState = {
  connectionStatus: 'connecting',
  sessionStatus: null,
  session: null,
  playerId: null,
  chatMessages: [],
  currentUI: [],
  gameState: {},
  agreedRules: null,
  endGameMessage: null,
  isAiThinking: false,
  expiredTimers: new Set(),
  errorMessage: null,
};

const GameContext = createContext<GameContextValue>({
  ...initialState,
  send: () => undefined,
  clearError: () => undefined,
});

// =============================================================================
// Provider
// =============================================================================

const WS_URL = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws`;

export function GameProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<GameState>(initialState);
  const wsRef = useRef<WebSocket | null>(null);
  const pendingMessages = useRef<ClientMessage[]>([]);

  const send = useCallback((message: ClientMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(message));
    } else {
      // Queue messages sent before the socket is open
      pendingMessages.current.push(message);
    }
  }, []);

  const clearError = useCallback(() => {
    setState((prev) => ({ ...prev, errorMessage: null }));
  }, []);

  useEffect(() => {
    // Guard against stale reconnect timers created during React StrictMode
    // double-mount (effect runs → cleanup → effect runs again). Without this,
    // the onclose handler from the first mount schedules a reconnect that fires
    // 2 s later while the second mount has already opened its own connection,
    // resulting in two live WebSocket connections and duplicated messages.
    let active = true;

    function connect() {
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;

      ws.onopen = () => {
        setState((prev) => ({ ...prev, connectionStatus: 'connected' }));

        // Drain any queued messages
        for (const msg of pendingMessages.current) {
          ws.send(JSON.stringify(msg));
        }
        pendingMessages.current = [];

        // Attempt to rejoin a previous session
        const savedPlayerId = localStorage.getItem('gg_playerId');
        const savedJoinCode = localStorage.getItem('gg_joinCode');
        if (savedPlayerId && savedJoinCode) {
          ws.send(
            JSON.stringify({
              type: 'join_session',
              joinCode: savedJoinCode,
              playerName: '',
              playerId: savedPlayerId,
            } satisfies ClientMessage),
          );
        }
      };

      ws.onclose = () => {
        setState((prev) => ({ ...prev, connectionStatus: 'disconnected' }));
        // Only reconnect if this effect invocation is still the active one
        if (active) setTimeout(connect, 2000);
      };

      ws.onerror = () => {
        ws.close();
      };

      ws.onmessage = (event) => {
        let msg: ServerMessage;
        try {
          msg = JSON.parse(event.data as string) as ServerMessage;
        } catch {
          return;
        }
        handleServerMessage(msg);
      };
    }

    function handleServerMessage(msg: ServerMessage) {
      setState((prev) => {
        switch (msg.type) {
          case 'session_created':
          case 'session_joined': {
            localStorage.setItem('gg_playerId', msg.playerId);
            localStorage.setItem('gg_joinCode', msg.session.joinCode);
            return {
              ...prev,
              session: msg.session,
              sessionStatus: msg.session.status,
              playerId: msg.playerId,
              chatMessages: msg.session.chatHistory,
              gameState: msg.session.gameState,
              agreedRules: msg.session.agreedRules ?? null,
              currentUI: [],
              errorMessage: null,
            };
          }

          case 'player_joined': {
            if (!prev.session) return prev;
            const alreadyIn = prev.session.players.some((p) => p.id === msg.player.id);
            if (alreadyIn) return prev;
            return {
              ...prev,
              session: {
                ...prev.session,
                players: [...prev.session.players, msg.player],
              },
            };
          }

          case 'player_left': {
            if (!prev.session) return prev;
            return {
              ...prev,
              session: {
                ...prev.session,
                players: prev.session.players.filter((p) => p.id !== msg.playerId),
              },
            };
          }

          case 'chat_message': {
            // Deduplicate by id (guards against double-connection edge cases)
            if (prev.chatMessages.some((m) => m.id === msg.message.id)) return prev;
            return {
              ...prev,
              chatMessages: [...prev.chatMessages, msg.message],
            };
          }

          case 'ui_update': {
            console.group('%c[GenericGame] UI_UPDATE', 'color: #7c6af7; font-weight: bold');
            console.log('Components:', msg.ui.map((c) => c.type).join(', '));
            console.log('Full payload:', msg.ui);
            console.groupEnd();
            return { ...prev, currentUI: msg.ui };
          }

          case 'state_update': {
            console.log('%c[GenericGame] STATE_UPDATE', 'color: #4ade80; font-weight: bold', msg.state);
            return { ...prev, gameState: msg.state };
          }

          case 'status_change': {
            const wasPlaying =
              prev.sessionStatus === 'playing' || prev.sessionStatus === 'finished';
            const resetToDefining = msg.status === 'defining' && wasPlaying;
            const resetToLobby = msg.status === 'lobby';
            return {
              ...prev,
              sessionStatus: msg.status,
              agreedRules: resetToLobby ? null : (msg.agreedRules !== undefined ? msg.agreedRules : prev.agreedRules),
              endGameMessage: (resetToDefining || resetToLobby) ? null : (msg.message ?? prev.endGameMessage),
              gameState: (resetToDefining || resetToLobby) ? {} : prev.gameState,
              currentUI: (resetToDefining || resetToLobby) ? [] : prev.currentUI,
              chatMessages: resetToLobby ? [] : prev.chatMessages,
              session: prev.session
                ? { ...prev.session, status: msg.status }
                : prev.session,
            };
          }

          case 'timer_expired': {
            const newExpired = new Set(prev.expiredTimers);
            newExpired.add(msg.timerId);
            return { ...prev, expiredTimers: newExpired };
          }

          case 'ai_thinking': {
            return { ...prev, isAiThinking: msg.thinking };
          }

          case 'error': {
            return { ...prev, errorMessage: msg.message };
          }

          default:
            return prev;
        }
      });
    }

    connect();

    return () => {
      active = false;
      wsRef.current?.close();
    };
  }, []);

  return (
    <GameContext.Provider value={{ ...state, send, clearError }}>
      {children}
    </GameContext.Provider>
  );
}

// =============================================================================
// Hook
// =============================================================================

export function useGame(): GameContextValue {
  return useContext(GameContext);
}

/** Returns the current player object from the session. */
export function useCurrentPlayer(): Player | undefined {
  const { session, playerId } = useGame();
  return session?.players.find((p) => p.id === playerId);
}
