// =============================================================================
// Shared types — used by both server and client.
// Import from this file in both packages; do not duplicate here.
// =============================================================================

// ─── Domain ──────────────────────────────────────────────────────────────────

export type SessionStatus = 'lobby' | 'defining' | 'playing' | 'finished';

export interface Player {
  id: string;
  name: string;
  isHost: boolean;
  connectedAt: string;
}

export interface ChatMessage {
  id: string;
  role: 'ai' | 'player' | 'system';
  playerId?: string;
  playerName?: string;
  content: string;
  timestamp: string;
}

// ─── UI components ────────────────────────────────────────────────────────────

export type TextStyle = 'heading' | 'subheading' | 'body' | 'muted' | 'error' | 'success';
export type ButtonStyle = 'primary' | 'secondary' | 'danger';

export type UIComponent =
  | { type: 'text'; content: string; style?: TextStyle }
  | { type: 'input'; fieldId: string; label?: string; placeholder?: string; maxLength?: number; multiline?: boolean }
  | { type: 'button'; label: string; actionId: string; style?: ButtonStyle; disabled?: boolean }
  | {
      type: 'multiple_choice';
      fieldId: string;
      question: string;
      options: string[];
      /** Server-only, resolved per player before sending: list players' names (all, or all except the viewer). */
      playerOptions?: 'all' | 'others';
      /** Server-only: player id or name owning each option; a player never sees their own. */
      owners?: string[];
      /** Server-only: the right answer(s) and points, checked by the server when a player answers. */
      answerKey?: AnswerKey;
    }
  /** Injected by the server for turns with a timer. endsAt is epoch ms. */
  | { type: 'countdown'; timerId: string; seconds: number; endsAt?: number; label?: string }
  | { type: 'scoreboard'; players: Array<{ id: string; name: string; score: number }> }
  | { type: 'form'; formId: string; fields: UIComponent[]; submitLabel?: string }
  | { type: 'list'; items: string[]; ordered?: boolean }
  | { type: 'divider' };

/** Right answer(s) for a multiple-choice question; never sent to clients. */
export interface AnswerKey {
  correct: string[];
  /** Points for a right answer (added to state.scores by the server). */
  points: number;
  /** Points for a wrong answer (usually 0 or negative). */
  penalty: number;
}

// ─── Public session (safe to send to clients) ─────────────────────────────────

/** How many players the agreed rules need. */
export interface PlayerRange {
  min: number;
  max: number;
}

export interface SessionPublic {
  id: string;
  joinCode: string;
  status: SessionStatus;
  players: Player[];
  chatHistory: ChatMessage[];
  agreedRules?: string;
  playerRange?: PlayerRange;
  createdAt: string;
}

/** Who still has to answer in a turn that waits for all players. */
export interface TurnStatus {
  turn: number;
  waitingFor: string[];
  answered: string[];
}

// ─── WebSocket protocol ───────────────────────────────────────────────────────

/** Messages sent from server → client */
export type ServerMessage =
  | { type: 'session_created'; session: SessionPublic; playerId: string }
  | { type: 'session_joined'; session: SessionPublic; playerId: string }
  | { type: 'player_joined'; player: Player }
  | { type: 'player_left'; playerId: string; playerName: string }
  /** The player list changed (someone left, the host moved). */
  | { type: 'players_update'; players: Player[] }
  | { type: 'chat_message'; message: ChatMessage }
  /** turn identifies the screen; inputs echo it back so stale clicks are ignored. */
  | { type: 'ui_update'; ui: UIComponent[]; turn?: number }
  | { type: 'turn_status'; status: TurnStatus | null }
  | { type: 'status_change'; status: SessionStatus; agreedRules?: string; playerRange?: PlayerRange; message?: string }
  | { type: 'timer_expired'; timerId: string }
  | { type: 'ai_thinking'; thinking: boolean }
  /** The AI failed to produce the next screen. The host can retry. */
  | { type: 'game_error'; message: string | null }
  /** Small notification that does not change the screen, e.g. "Ana answered ✓". */
  | { type: 'toast'; text: string }
  /** The game is on hold (the host is changing it); null resumes. */
  | { type: 'paused'; message: string | null }
  /** Host only: a prepared change to the running game, waiting for approval (null clears it). */
  | { type: 'patch_proposal'; proposal: PatchProposal | null }
  /** Host only: the program for the agreed rules, so it can be saved with them. */
  | { type: 'program_ready'; program: SavedProgram }
  | { type: 'error'; message: string };

/** A change to a running game, summarised for the host. */
export interface PatchProposal {
  id: string;
  request: string;
  summary: string;
  assumptions: string[];
}

/** A game program as saved with the rules in the browser. */
export interface SavedProgram {
  code: string;
  rules: string;
}

/** Messages sent from client → server */
export type ClientMessage =
  | { type: 'create_session'; playerName: string }
  | { type: 'join_session'; joinCode: string; playerName: string; playerId?: string }
  | { type: 'start_defining' }
  | { type: 'chat'; content: string }
  | { type: 'form_submit'; formId: string; values: Record<string, string>; turn?: number }
  | { type: 'action'; actionId: string; turn?: number }
  | { type: 'confirm_rules' }
  /** Leave the session for good (back to the start page). */
  | { type: 'leave_session' }
  /** Host loads previously saved rules (skips the AI chat), with their program if saved. */
  | { type: 'load_rules'; rules: string; playerRange?: PlayerRange; program?: SavedProgram }
  /** Host approves or rejects a prepared change to the running game. */
  | { type: 'patch_decision'; id: string; apply: boolean }
  | { type: 'retry_turn' }
  | { type: 'reset_session' }
  | { type: 'full_reset' }
  | { type: 'game_tweak'; content: string };
