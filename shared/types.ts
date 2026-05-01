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
  | { type: 'multiple_choice'; fieldId: string; question: string; options: string[] }
  | { type: 'countdown'; timerId: string; seconds: number; label?: string }
  | { type: 'scoreboard'; players: Array<{ id: string; name: string; score: number }> }
  | { type: 'form'; formId: string; fields: UIComponent[]; submitLabel?: string }
  | { type: 'list'; items: string[]; ordered?: boolean }
  | { type: 'divider' };

// ─── Public session (safe to send to clients) ─────────────────────────────────

export interface SessionPublic {
  id: string;
  joinCode: string;
  status: SessionStatus;
  players: Player[];
  chatHistory: ChatMessage[];
  agreedRules?: string;
  gameState: Record<string, unknown>;
  createdAt: string;
}

// ─── WebSocket protocol ───────────────────────────────────────────────────────

/** Messages sent from server → client */
export type ServerMessage =
  | { type: 'session_created'; session: SessionPublic; playerId: string }
  | { type: 'session_joined'; session: SessionPublic; playerId: string }
  | { type: 'player_joined'; player: Player }
  | { type: 'player_left'; playerId: string; playerName: string }
  | { type: 'chat_message'; message: ChatMessage }
  | { type: 'ui_update'; ui: UIComponent[] }
  | { type: 'state_update'; state: Record<string, unknown> }
  | { type: 'status_change'; status: SessionStatus; agreedRules?: string }
  | { type: 'timer_expired'; timerId: string }
  | { type: 'ai_thinking'; thinking: boolean }
  | { type: 'error'; message: string };

/** Messages sent from client → server */
export type ClientMessage =
  | { type: 'create_session'; playerName: string }
  | { type: 'join_session'; joinCode: string; playerName: string; playerId?: string }
  | { type: 'start_defining' }
  | { type: 'chat'; content: string }
  | { type: 'form_submit'; formId: string; values: Record<string, string> }
  | { type: 'action'; actionId: string }
  | { type: 'confirm_rules' }
  | { type: 'reset_session' }
  | { type: 'full_reset' }
  | { type: 'game_tweak'; content: string };
