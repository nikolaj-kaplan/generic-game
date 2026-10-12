// =============================================================================
// Re-export all shared types so existing server imports continue to work.
// =============================================================================
export * from '../../shared/types';

// =============================================================================
// Server-only types (never sent to clients directly)
// =============================================================================

import type { UIComponent, SessionStatus, Player, ChatMessage } from '../../shared/types';

/** Full server-side session. Clients receive SessionPublic (from shared) instead. */
export interface Session {
  id: string;
  joinCode: string;
  status: SessionStatus;
  players: Player[];
  chatHistory: ChatMessage[];
  /** Full LLM conversation for the definition phase */
  definitionLlmMessages: LLMMessage[];
  /** LLM conversation for the playing phase (capped to last N messages) */
  gameLlmMessages: LLMMessage[];
  agreedRules?: string;
  /** How many players the agreed rules need (Start is blocked outside the range). */
  playerRange?: { min: number; max: number };
  /** Game state owned by the LLM. Never sent to clients (it holds secrets). */
  gameState: Record<string, unknown>;
  /** Current screen per player id, plus 'all' as the fallback for late joiners. */
  playerUi: Record<string, UIComponent[]>;
  /** Monotonic screen counter; inputs carrying an older number are ignored. */
  turnCounter?: number;
  /** The turn currently waiting for player input (undefined while the AI works). */
  pendingTurn?: PendingTurn;
  /** The last shown turn was a short-timer slide (used to stop slide-per-turn chains). */
  lastTurnWasSlide?: boolean;
  /** Set when the AI failed to produce a screen; the host can retry. */
  stalled?: string;
  /** Folder name under data/llm-logs for the current definition or game run. */
  logDir?: string;
  metrics?: GameMetrics;
  createdAt: string;
  updatedAt: string;

  // ─── Program engine (the default; GAME_ENGINE=legacy uses the AI-per-turn path) ──
  /** The program running this game, written by the generator for the agreed rules. */
  program?: GameProgram;
  /** Earlier versions, oldest first (mid-game changes). */
  programHistory?: GameProgram[];
  /** Engine state of the running game (owned by the sandboxed runtime). */
  engine?: Record<string, unknown>;
  /** Host changes accepted during this game, oldest first. Never merged into the rules. */
  adjustments?: string[];
  /** The game is on hold while the host changes it. */
  paused?: { message: string; remainingMs?: number };
  /** A prepared change waiting for the host's approval. */
  pendingPatch?: PendingPatch;
  /** The event that crashed the program, so Retry can run it again. */
  failedEvent?: import('./engine/sandbox').GameEvent;
}

export interface GameProgram {
  code: string;
  version: number;
  /** The rules (and adjustments) it was written for; reused when they did not change. */
  rules: string;
  summary?: string;
  assumptions?: string[];
  model?: string;
  /** The host request that produced this version (mid-game changes). */
  request?: string;
  createdAt: string;
}

export interface PendingPatch {
  id: string;
  request: string;
  summary: string;
  assumptions: string[];
  code: string;
  migration?: string;
  model?: string;
}

export interface PlayerResponse {
  playerId: string;
  playerName: string;
  kind: 'action' | 'submit';
  /** actionId for buttons, formId / fieldId for submissions */
  id: string;
  values?: Record<string, string>;
  /** Milliseconds from the moment the screen was shown until this answer. */
  elapsedMs?: number;
}

export interface PendingTurn {
  turn: number;
  waitFor: 'any' | 'all';
  /** Players whose screen has something to click or fill in. */
  expected: string[];
  responses: PlayerResponse[];
  timerSeconds?: number;
  endsAt?: number;
  /** When the screens were shown (epoch ms), for answer times. */
  shownAt?: number;
  /** Answer keys per player id → fieldId, taken from the screens before they were sent. */
  answerKeys?: Record<string, Record<string, import('../../shared/types').AnswerKey>>;
  /** Results of answer checks made by the server during this turn. */
  checks?: AnswerCheck[];
}

export interface AnswerCheck {
  playerName: string;
  fieldId: string;
  answer: string;
  correct: boolean;
  points: number;
  rightAnswer: string;
}

/** Counters for one game, written next to the LLM logs for comparing models/prompts. */
export interface GameMetrics {
  model: string;
  startedAt: string;
  llmCalls: number;
  llmMs: number;
  turns: number;
  /** next_turn calls rejected by validation */
  invalidCalls: number;
  /** replies without a tool call */
  textReplies: number;
  /** turns where every attempt failed */
  stalls: number;
  httpErrors: number;
  promptTokensMax: number;
  finished: boolean;
  /** Next screens prepared ahead of time that were used / thrown away. */
  prefetchHits?: number;
  prefetchMisses?: number;
  /** 'program' (generated program) or 'legacy' (AI per turn). */
  engine?: 'program' | 'legacy';
  /** g.ai calls per complexity level. */
  aiCallsByComplexity?: Record<string, number>;
  /** Player actions and timers handled by the program. */
  events?: number;
  /** Total time spent running program code and AI calls for events (ms). */
  eventMs?: number;
  programVersion?: number;
  patches?: number;
}

// ─── LLM types (OpenAI-compatible tool calling) ───────────────────────────────

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: LLMToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface LLMToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface LLMTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
}

export interface LLMResponse {
  id: string;
  choices: Array<{
    message: {
      role: 'assistant';
      content: string | null;
      /** Reasoning text returned by thinking models (e.g. Ollama gemma4) */
      reasoning?: string;
      tool_calls?: LLMToolCall[];
    };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  error?: { message: string; code?: string };
}

