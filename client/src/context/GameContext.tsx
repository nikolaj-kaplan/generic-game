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
  TurnStatus,
  PlayerRange,
  PatchProposal,
  SavedProgram,
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
  /** Turn number of the current screen; echoed back with inputs. Null for intro slides. */
  currentTurn: number | null;
  /** Increments on every new screen (used to re-key the renderer). */
  screenVersion: number;
  turnStatus: TurnStatus | null;
  /** Set when the AI failed to produce a screen (Retry is offered). */
  gameError: string | null;
  /** Small notification shown briefly, e.g. "Ana answered ✓". */
  toast: { id: number; text: string } | null;
  agreedRules: string | null;
  /** How many players the agreed rules need. */
  playerRange: PlayerRange | null;
  endGameMessage: string | null;
  isAiThinking: boolean;
  expiredTimers: Set<string>;
  errorMessage: string | null;
  /** Set while the game is on hold (the host is changing it). */
  paused: string | null;
  /** Host only: a prepared change waiting for approval. */
  patchProposal: PatchProposal | null;
  /** Host only: the program for the agreed rules (saved with them). */
  program: SavedProgram | null;
}

interface GameContextValue extends GameState {
  send: (message: ClientMessage) => void;
  clearError: () => void;
  /** Leave the session for good and go back to the start page. */
  leaveSession: () => void;
}

const initialState: GameState = {
  connectionStatus: 'connecting',
  sessionStatus: null,
  session: null,
  playerId: null,
  chatMessages: [],
  currentUI: [],
  currentTurn: null,
  screenVersion: 0,
  turnStatus: null,
  gameError: null,
  toast: null,
  agreedRules: null,
  playerRange: null,
  endGameMessage: null,
  isAiThinking: false,
  expiredTimers: new Set(),
  errorMessage: null,
  paused: null,
  patchProposal: null,
  program: null,
};

const GameContext = createContext<GameContextValue>({
  ...initialState,
  send: () => undefined,
  clearError: () => undefined,
  leaveSession: () => undefined,
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

  // Toasts disappear by themselves
  useEffect(() => {
    if (!state.toast) return;
    const id = setTimeout(() => setState((prev) => (prev.toast?.id === state.toast?.id ? { ...prev, toast: null } : prev)), 2500);
    return () => clearTimeout(id);
  }, [state.toast]);

  const clearError = useCallback(() => {
    setState((prev) => ({ ...prev, errorMessage: null }));
  }, []);

  const leaveSession = useCallback(() => {
    send({ type: 'leave_session' });
    localStorage.removeItem('gg_playerId');
    localStorage.removeItem('gg_joinCode');
    setState((prev) => ({ ...initialState, connectionStatus: prev.connectionStatus, expiredTimers: new Set() }));
  }, [send]);

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
              agreedRules: msg.session.agreedRules ?? null,
              playerRange: msg.session.playerRange ?? null,
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

          case 'players_update': {
            if (!prev.session) return prev;
            return { ...prev, session: { ...prev.session, players: msg.players } };
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
            return { ...prev, currentUI: msg.ui, currentTurn: msg.turn ?? null, screenVersion: prev.screenVersion + 1 };
          }

          case 'turn_status': {
            return { ...prev, turnStatus: msg.status };
          }

          case 'game_error': {
            return { ...prev, gameError: msg.message };
          }

          case 'toast': {
            return { ...prev, toast: { id: Date.now(), text: msg.text } };
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
              playerRange: resetToLobby ? null : (msg.playerRange !== undefined ? msg.playerRange : msg.agreedRules !== undefined ? null : prev.playerRange),
              endGameMessage: (resetToDefining || resetToLobby) ? null : (msg.message ?? prev.endGameMessage),
              currentUI: (resetToDefining || resetToLobby) ? [] : prev.currentUI,
              currentTurn: (resetToDefining || resetToLobby) ? null : prev.currentTurn,
              turnStatus: (resetToDefining || resetToLobby) ? null : prev.turnStatus,
              gameError: (resetToDefining || resetToLobby) ? null : prev.gameError,
              chatMessages: resetToLobby ? [] : prev.chatMessages,
              paused: (resetToDefining || resetToLobby) ? null : prev.paused,
              patchProposal: (resetToDefining || resetToLobby) ? null : prev.patchProposal,
              program: resetToLobby ? null : prev.program,
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

          case 'paused': {
            return { ...prev, paused: msg.message };
          }

          case 'patch_proposal': {
            return { ...prev, patchProposal: msg.proposal };
          }

          case 'program_ready': {
            return { ...prev, program: msg.program };
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
    <GameContext.Provider value={{ ...state, send, clearError, leaveSession }}>
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
