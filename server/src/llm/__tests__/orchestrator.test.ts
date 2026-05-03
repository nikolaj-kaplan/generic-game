import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Session } from '../../types';
import type { LLMResponse } from '../../types';

// ─── Module mocks (hoisted before imports) ────────────────────────────────────

vi.mock('../client', () => ({ chat: vi.fn() }));
vi.mock('../logger', () => ({ clearLogs: vi.fn(), logLLMExchange: vi.fn(), buildLogEntry: vi.fn(), nextSeq: vi.fn(() => 1) }));
vi.mock('../prompts', () => ({ playingPrompt: vi.fn(() => 'system'), definitionPrompt: vi.fn(() => 'system') }));
vi.mock('../tools', () => ({ gameTools: [], definitionTools: [] }));

// store: real in-memory map, no disk I/O
vi.mock('../../store', () => {
  const sessions = new Map<string, Session>();
  return {
    getSession: (id: string) => sessions.get(id),
    saveSession: (s: Session) => { sessions.set(s.id, s); },
    deleteSession: (id: string) => sessions.delete(id),
    __sessions: sessions,
  };
});

// connection-store: capture broadcast calls
vi.mock('../../connection-store', () => ({
  broadcast: vi.fn(),
  sendToPlayer: vi.fn(),
  registerConnection: vi.fn(),
  unregisterConnection: vi.fn(),
  associateConnection: vi.fn(),
  getConnectionMeta: vi.fn(),
}));

// ─── Imports after mocks ──────────────────────────────────────────────────────

import { chat } from '../client';
import * as connStore from '../../connection-store';
import * as store from '../../store';
import { handleAction, handleFormSubmit, cancelAllTimers } from '../orchestrator';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const mockedChat = vi.mocked(chat);
const mockedBroadcast = vi.mocked(connStore.broadcast);

/** Build an LLMResponse that returns one or more tool calls. */
function toolCallResponse(calls: Array<{ name: string; args: object }>): LLMResponse {
  return {
    id: 'mock',
    choices: [{
      message: {
        role: 'assistant',
        content: null,
        tool_calls: calls.map((c, i) => ({
          id: `tc-${i}`,
          type: 'function' as const,
          function: { name: c.name, arguments: JSON.stringify(c.args) },
        })),
      },
      finish_reason: 'tool_calls',
    }],
  };
}

/** Build an LLMResponse with no tool calls (plain stop). */
function stopResponse(content = ''): LLMResponse {
  return {
    id: 'mock',
    choices: [{ message: { role: 'assistant', content, tool_calls: undefined }, finish_reason: 'stop' }],
  };
}

const INTERACTIVE_UI = [
  { type: 'text' as const, content: 'Question', style: 'body' as const },
  { type: 'button' as const, label: 'Submit', actionId: 'submit', style: 'primary' as const },
];

const NON_INTERACTIVE_UI = [
  { type: 'text' as const, content: 'Loading…', style: 'body' as const },
];

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-1',
    joinCode: 'TEST',
    status: 'playing',
    players: [{
      id: 'player-1', name: 'nik', isHost: true,
      connectedAt: ''
    }],
    chatHistory: [],
    definitionLlmMessages: [],
    gameLlmMessages: [],
    agreedRules: 'Test rules',
    gameState: {},
    playerUi: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function seedSession(session: Session) {
  store.saveSession(session);
}

function broadcastsOfType(type: string) {
  return mockedBroadcast.mock.calls.filter(([, msg]) => msg.type === type);
}

// ─── Setup / teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
  // resetAllMocks clears call history AND the mockResolvedValueOnce queue,
  // preventing responses from one test bleeding into the next.
  vi.resetAllMocks();
  const s = (store as unknown as { __sessions: Map<string, Session> }).__sessions;
  s.clear();
});

afterEach(() => {
  cancelAllTimers('session-1');
  // Restore real timers even if a test threw before reaching vi.useRealTimers()
  vi.useRealTimers();
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('game loop — set_user_ui breaks loop', () => {
  it('stops the loop immediately after a direct set_user_ui call', async () => {
    seedSession(makeSession());

    // LLM responds with set_user_ui once, then a stop (should never be reached)
    mockedChat
      .mockResolvedValueOnce(toolCallResponse([{ name: 'set_user_ui', args: { playerId: 'all', ui: INTERACTIVE_UI } }]))
      .mockResolvedValueOnce(stopResponse()); // safety net — must NOT be called

    await handleAction('session-1', 'player-1', 'nik', 'some_action');

    // chat should have been called exactly once — loop broke before second call
    expect(mockedChat).toHaveBeenCalledTimes(1);
    // exactly one ui_update broadcast
    expect(broadcastsOfType('ui_update')).toHaveLength(1);
  });

  it('prevents the LLM from overwriting its own UI in a subsequent iteration', async () => {
    seedSession(makeSession());

    // Without the fix, the LLM would be called twice and broadcast two ui_updates
    mockedChat
      .mockResolvedValueOnce(toolCallResponse([{ name: 'set_user_ui', args: { playerId: 'all', ui: INTERACTIVE_UI } }]))
      .mockResolvedValueOnce(toolCallResponse([{ name: 'set_user_ui', args: { playerId: 'all', ui: NON_INTERACTIVE_UI } }]));

    await handleAction('session-1', 'player-1', 'nik', 'some_action');

    expect(mockedChat).toHaveBeenCalledTimes(1);
    const uiUpdates = broadcastsOfType('ui_update');
    expect(uiUpdates).toHaveLength(1);
    // The first (and only) UI is the interactive one
    expect((uiUpdates[0][1] as { ui: unknown[] }).ui).toEqual(INTERACTIVE_UI);
  });

  it('allows set_state and set_user_ui to be batched in the same iteration', async () => {
    seedSession(makeSession());

    mockedChat.mockResolvedValueOnce(
      toolCallResponse([
        { name: 'set_state', args: { state: { score: 10 } } },
        { name: 'set_user_ui', args: { playerId: 'all', ui: INTERACTIVE_UI } },
      ]),
    );

    await handleAction('session-1', 'player-1', 'nik', 'submit');

    expect(mockedChat).toHaveBeenCalledTimes(1);
    expect(broadcastsOfType('state_update')).toHaveLength(1);
    expect(broadcastsOfType('ui_update')).toHaveLength(1);
  });
});

describe('game loop — run_sequence does NOT break loop', () => {
  it('continues after run_sequence so the LLM can do follow-up work', async () => {
    seedSession(makeSession());

    mockedChat
      // Iteration 1: run_sequence (delayBefore omitted → no sleep)
      .mockResolvedValueOnce(toolCallResponse([{
        name: 'run_sequence',
        args: {
          steps: [
            { action: 'set_ui', playerId: 'all', ui: NON_INTERACTIVE_UI },
          ],
        },
      }]))
      // Iteration 2: LLM does follow-up set_user_ui → loop breaks
      .mockResolvedValueOnce(toolCallResponse([{
        name: 'set_user_ui',
        args: { playerId: 'all', ui: INTERACTIVE_UI },
      }]));

    await handleAction('session-1', 'player-1', 'nik', 'some_action');

    // chat called TWICE — loop continued after run_sequence
    expect(mockedChat).toHaveBeenCalledTimes(2);
    // ui_update from run_sequence step + ui_update from set_user_ui
    expect(broadcastsOfType('ui_update')).toHaveLength(2);
  });

  it('executes all delayed steps inside run_sequence before continuing', async () => {
    seedSession(makeSession());

    const order: string[] = [];

    mockedChat
      .mockResolvedValueOnce(toolCallResponse([{
        name: 'run_sequence',
        args: {
          steps: [
            { action: 'set_ui', playerId: 'all', ui: NON_INTERACTIVE_UI },
            // delayBefore: 0 → no real sleep but tests step ordering
            { action: 'set_state', state: { phase: 'result' } },
          ],
        },
      }]))
      .mockImplementationOnce(async () => {
        order.push('llm-iteration-2');
        return toolCallResponse([{ name: 'set_user_ui', args: { playerId: 'all', ui: INTERACTIVE_UI } }]);
      });

    // Capture broadcast order
    mockedBroadcast.mockImplementation((_, msg) => {
      if (msg.type === 'ui_update' || msg.type === 'state_update') order.push(msg.type);
    });

    await handleAction('session-1', 'player-1', 'nik', 'next');

    // sequence steps execute before the next LLM call
    expect(order).toEqual(['ui_update', 'state_update', 'llm-iteration-2', 'ui_update']);
  });
});

describe('game loop — run_sequence with delayBefore', () => {
  it('respects delayBefore timing before broadcasting each step', async () => {
    vi.useFakeTimers();
    seedSession(makeSession());

    const uiUpdates: unknown[] = [];
    mockedBroadcast.mockImplementation((_, msg) => {
      if (msg.type === 'ui_update') uiUpdates.push((msg as { ui: unknown }).ui);
    });

    mockedChat
      .mockResolvedValueOnce(toolCallResponse([{
        name: 'run_sequence',
        args: {
          steps: [
            { action: 'set_ui', playerId: 'all', ui: NON_INTERACTIVE_UI },
            { action: 'set_ui', playerId: 'all', ui: INTERACTIVE_UI, delayBefore: 2 },
          ],
        },
      }]))
      .mockResolvedValueOnce(stopResponse());

    const actionPromise = handleAction('session-1', 'player-1', 'nik', 'go');

    // Before advancing timers: first step already rendered, second still pending
    await vi.runAllTimersAsync();
    await actionPromise;

    expect(uiUpdates).toHaveLength(2);
    expect(uiUpdates[0]).toEqual(NON_INTERACTIVE_UI);
    expect(uiUpdates[1]).toEqual(INTERACTIVE_UI);

    vi.useRealTimers();
  });
});

describe('game loop — start_timer + set_user_ui', () => {
  it('registers the timer and breaks the loop in the same iteration', async () => {
    vi.useFakeTimers();
    seedSession(makeSession());

    mockedChat
      // Iteration 1: set a countdown UI and start a timer
      .mockResolvedValueOnce(toolCallResponse([
        { name: 'set_user_ui', args: { playerId: 'all', ui: NON_INTERACTIVE_UI } },
        { name: 'start_timer', args: { timerId: 'round-timer', seconds: 5 } },
      ]))
      // Called when timer fires
      .mockResolvedValueOnce(toolCallResponse([
        { name: 'set_user_ui', args: { playerId: 'all', ui: INTERACTIVE_UI } },
      ]));

    await handleAction('session-1', 'player-1', 'nik', 'start');

    // Loop broke after first iteration — only 1 LLM call so far
    expect(mockedChat).toHaveBeenCalledTimes(1);
    expect(broadcastsOfType('ui_update')).toHaveLength(1);

    // Advance timer — should trigger a second game loop run
    await vi.runAllTimersAsync();

    expect(mockedChat).toHaveBeenCalledTimes(2);
    expect(broadcastsOfType('ui_update')).toHaveLength(2);

    vi.useRealTimers();
  });
});

describe('game loop — end_game', () => {
  it('stops the loop and broadcasts finished status', async () => {
    seedSession(makeSession());

    mockedChat
      .mockResolvedValueOnce(toolCallResponse([{
        name: 'end_game',
        args: { message: 'You win!', results: { winner: 'nik' } },
      }]))
      .mockResolvedValueOnce(stopResponse()); // must NOT be called

    await handleAction('session-1', 'player-1', 'nik', 'final_answer');

    expect(mockedChat).toHaveBeenCalledTimes(1);
    const statusChanges = broadcastsOfType('status_change');
    expect(statusChanges).toHaveLength(1);
    expect((statusChanges[0][1] as { status: string }).status).toBe('finished');
  });
});

describe('game loop — error handling', () => {
  it('injects a retry nudge after two consecutive iterations with errors', async () => {
    seedSession(makeSession());

    mockedChat
      // Iteration 1: call unknown tool → error
      .mockResolvedValueOnce(toolCallResponse([{ name: 'bad_tool', args: {} }]))
      // Iteration 2: call unknown tool again → error → nudge injected
      .mockResolvedValueOnce(toolCallResponse([{ name: 'bad_tool', args: {} }]))
      // Iteration 3: stop
      .mockResolvedValueOnce(stopResponse());

    await handleAction('session-1', 'player-1', 'nik', 'go');

    const session = store.getSession('session-1')!;
    // The nudge is injected as a user role message in the LLM history
    const nudgeMessages = session.gameLlmMessages.filter(
      (m) => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('SYSTEM:'),
    );
    expect(nudgeMessages.length).toBeGreaterThanOrEqual(1);
  });

  it('does not inject a nudge after a single error', async () => {
    seedSession(makeSession());

    mockedChat
      .mockResolvedValueOnce(toolCallResponse([{ name: 'bad_tool', args: {} }]))
      .mockResolvedValueOnce(stopResponse());

    await handleAction('session-1', 'player-1', 'nik', 'go');

    const session = store.getSession('session-1')!;
    const nudgeMessages = session.gameLlmMessages.filter(
      (m) => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('SYSTEM:'),
    );
    expect(nudgeMessages).toHaveLength(0);
  });
});

describe('game loop — non-interactive set_user_ui warning', () => {
  it('still breaks the loop even when the UI has no interactive elements', async () => {
    seedSession(makeSession());

    // The loop should break after set_user_ui regardless of interactivity,
    // so the LLM cannot overwrite non-interactive UIs either.
    mockedChat
      .mockResolvedValueOnce(toolCallResponse([{ name: 'set_user_ui', args: { playerId: 'all', ui: NON_INTERACTIVE_UI } }]))
      .mockResolvedValueOnce(stopResponse()); // must NOT be called

    await handleAction('session-1', 'player-1', 'nik', 'go');

    expect(mockedChat).toHaveBeenCalledTimes(1);
    // Tool result should contain a warning
    const toolResults = store.getSession('session-1')!.gameLlmMessages.filter((m) => m.role === 'tool');
    const lastToolResult = JSON.parse(toolResults[toolResults.length - 1].content ?? '{}') as { warning?: string };
    expect(lastToolResult.warning).toBeTruthy();
  });
});
