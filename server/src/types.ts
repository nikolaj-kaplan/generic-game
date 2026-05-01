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
  stateSchema?: Record<string, unknown>;
  gameState: Record<string, unknown>;
  /** Per-player current UI. Key is playerId or 'all'. */
  playerUi: Record<string, UIComponent[]>;
  createdAt: string;
  updatedAt: string;
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

