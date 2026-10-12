import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Session, LLMResponse, ServerMessage } from '../../types';

// ─── Module mocks (hoisted before imports) ────────────────────────────────────

const cfg = vi.hoisted(() => ({ protocol: 'tools' as 'tools' | 'json' }));
vi.mock('../client', () => ({ chat: vi.fn(), llmConfig: () => ({ model: 'mock-model', protocol: cfg.protocol }) }));
vi.mock('../logger', () => ({ newLogDirName: vi.fn(() => 'test-run'), writeMetrics: vi.fn() }));

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

// connection-store: capture what each player receives
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
import { handlePlayerInput, startGame, retryTurn, handleGameTweak, cancelAllTimers, recoverInterruptedGames, resendState } from '../orchestrator';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const mockedChat = vi.mocked(chat);
const mockedBroadcast = vi.mocked(connStore.broadcast);
const mockedSendToPlayer = vi.mocked(connStore.sendToPlayer);

function nextTurn(args: object): LLMResponse {
  return {
    id: 'mock',
    choices: [{
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: `tc-${Math.random()}`, type: 'function', function: { name: 'next_turn', arguments: JSON.stringify(args) } }],
      },
      finish_reason: 'tool_calls',
    }],
  };
}

function textReply(content: string): LLMResponse {
  return { id: 'mock', choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] };
}

const QUESTION = [
  { type: 'text', content: 'Question 1' },
  { type: 'multiple_choice', fieldId: 'answer', question: '2+2?', options: ['3', '4'] },
];
const NEXT_BUTTON = [{ type: 'button', label: 'Next', actionId: 'next' }];

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-1',
    joinCode: 'TEST',
    status: 'playing',
    players: [
      { id: 'p1', name: 'Ana', isHost: true, connectedAt: '' },
      { id: 'p2', name: 'Bob', isHost: false, connectedAt: '' },
    ],
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

const getSession = () => store.getSession('session-1')!;

function uiSentTo(playerId: string): Array<Extract<ServerMessage, { type: 'ui_update' }>> {
  return mockedSendToPlayer.mock.calls
    .filter(([, id, msg]) => id === playerId && msg.type === 'ui_update')
    .map(([, , msg]) => msg as Extract<ServerMessage, { type: 'ui_update' }>);
}

function broadcastsOfType(type: string) {
  return mockedBroadcast.mock.calls.filter(([, msg]) => msg.type === type);
}

/** Start a game whose first screen is `args`; returns the turn number. */
async function startWith(args: object, sessionOverrides: Partial<Session> = {}) {
  store.saveSession(makeSession({ status: 'defining', ...sessionOverrides }));
  mockedChat.mockResolvedValueOnce(nextTurn(args));
  await startGame('session-1');
  return getSession().pendingTurn?.turn;
}

beforeEach(() => {
  cfg.protocol = 'tools';
  process.env.LLM_PREFETCH = 'false';
  vi.resetAllMocks();
  (store as unknown as { __sessions: Map<string, Session> }).__sessions.clear();
});

afterEach(() => {
  cancelAllTimers('session-1');
  vi.useRealTimers();
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('starting a game', () => {
  it('makes one LLM call and shows the screen to every player', async () => {
    const turn = await startWith({ state_update: { round: 1 }, screens: { all: QUESTION } });
    expect(mockedChat).toHaveBeenCalledTimes(1);
    expect(turn).toBe(1);
    expect(uiSentTo('p1')).toHaveLength(1);
    expect(uiSentTo('p2')).toHaveLength(1);
    expect(getSession().gameState).toEqual({ round: 1 });
  });

  it('forces a tool call in the playing phase', async () => {
    await startWith({ screens: { all: QUESTION } });
    expect(mockedChat.mock.calls[0][0].toolChoice).toBe('required');
  });

  it('never sends game state to clients', async () => {
    await startWith({ state_update: { secret: 'Zanzibar' }, screens: { all: QUESTION } });
    const everything = JSON.stringify([...mockedBroadcast.mock.calls, ...mockedSendToPlayer.mock.calls]);
    expect(everything).not.toContain('Zanzibar');
  });

  it('sends the state with the latest event, not in the system prompt', async () => {
    await startWith({ state_update: { secret: 'Zanzibar' }, screens: { all: QUESTION } });
    mockedChat.mockResolvedValueOnce(nextTurn({ screens: { all: QUESTION } }));
    await handlePlayerInput('session-1', 'p1', { kind: 'submit', id: 'answer', values: { answer: '4' }, turn: 1 });
    const messages = mockedChat.mock.calls[1][0].messages;
    expect(messages[0].content).not.toContain('Zanzibar');
    expect(messages[messages.length - 1].content).toContain('"secret":"Zanzibar"');
  });
});

describe('validation and retries', () => {
  it('sends validation errors back and keeps only the successful exchange', async () => {
    store.saveSession(makeSession({ status: 'defining' }));
    mockedChat
      .mockResolvedValueOnce(nextTurn({ screens: { all: [{ type: 'image', src: 'x.png' }] } }))
      .mockResolvedValueOnce(nextTurn({ screens: { all: QUESTION } }));
    await startGame('session-1');

    expect(mockedChat).toHaveBeenCalledTimes(2);
    const retryMessages = mockedChat.mock.calls[1][0].messages;
    expect(retryMessages[retryMessages.length - 1].content).toContain('unknown type');
    // history: start event + one successful call + its result
    expect(getSession().gameLlmMessages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);
    expect(getSession().metrics?.invalidCalls).toBe(1);
  });

  it('nudges after a text reply and accepts next_turn written as JSON text', async () => {
    store.saveSession(makeSession({ status: 'defining' }));
    mockedChat
      .mockResolvedValueOnce(textReply('Let me think about the game...'))
      .mockResolvedValueOnce(textReply(JSON.stringify({ name: 'next_turn', arguments: { screens: { all: QUESTION } } })));
    await startGame('session-1');
    expect(getSession().pendingTurn?.turn).toBe(1);
    expect(getSession().metrics?.textReplies).toBe(1);
  });

  it('stalls after repeated failures and recovers on retry', async () => {
    store.saveSession(makeSession({ status: 'defining' }));
    mockedChat.mockResolvedValue(textReply('no idea'));
    await startGame('session-1');
    expect(getSession().stalled).toBeTruthy();
    expect(broadcastsOfType('game_error').some(([, m]) => (m as { message: string | null }).message)).toBe(true);

    mockedChat.mockReset();
    mockedChat.mockResolvedValueOnce(nextTurn({ screens: { all: QUESTION } }));
    await retryTurn('session-1', 'Ana');
    expect(getSession().stalled).toBeUndefined();
    expect(getSession().pendingTurn).toBeDefined();
  });

  it('reports HTTP errors as a stall instead of crashing', async () => {
    store.saveSession(makeSession({ status: 'defining' }));
    mockedChat.mockRejectedValue(new Error('LLM error 500'));
    vi.useFakeTimers();
    const p = startGame('session-1');
    await vi.runAllTimersAsync();
    await p;
    expect(getSession().stalled).toContain('500');
  });
});

describe('waiting for players', () => {
  it('wait_for "any" resolves on the first response', async () => {
    await startWith({ screens: { all: QUESTION } });
    mockedChat.mockResolvedValueOnce(nextTurn({ screens: { all: NEXT_BUTTON } }));
    await handlePlayerInput('session-1', 'p2', { kind: 'submit', id: 'answer', values: { answer: '4' }, turn: 1 });
    expect(mockedChat).toHaveBeenCalledTimes(2);
    const event = mockedChat.mock.calls[1][0].messages.at(-1)!.content!;
    expect(event).toContain('Bob (p2) answered "4"');
  });

  it('wait_for "all" collects every answer into one event', async () => {
    await startWith({ screens: { all: QUESTION }, wait_for: 'all' });
    await handlePlayerInput('session-1', 'p1', { kind: 'submit', id: 'answer', values: { answer: '3' }, turn: 1 });
    expect(mockedChat).toHaveBeenCalledTimes(1);
    // Ana's screen is locked while waiting
    const lockedUi = uiSentTo('p1').at(-1)!.ui;
    expect(lockedUi.some((c) => c.type === 'multiple_choice')).toBe(false);
    expect(broadcastsOfType('turn_status').at(-1)![1]).toMatchObject({ status: { waitingFor: ['Bob'], answered: ['Ana'] } });

    mockedChat.mockResolvedValueOnce(nextTurn({ screens: { all: NEXT_BUTTON } }));
    await handlePlayerInput('session-1', 'p2', { kind: 'submit', id: 'answer', values: { answer: '4' }, turn: 1 });
    expect(mockedChat).toHaveBeenCalledTimes(2);
    const event = mockedChat.mock.calls[1][0].messages.at(-1)!.content!;
    expect(event).toContain('all players responded');
    expect(event).toContain('Ana (p1) answered "3"');
    expect(event).toContain('Bob (p2) answered "4"');
  });

  it('ignores duplicate answers and inputs for an old turn', async () => {
    await startWith({ screens: { all: QUESTION }, wait_for: 'all' });
    await handlePlayerInput('session-1', 'p1', { kind: 'submit', id: 'answer', values: { answer: '3' }, turn: 1 });
    await handlePlayerInput('session-1', 'p1', { kind: 'submit', id: 'answer', values: { answer: '4' }, turn: 1 });
    await handlePlayerInput('session-1', 'p2', { kind: 'submit', id: 'answer', values: { answer: '4' }, turn: 0 });
    expect(getSession().pendingTurn?.responses).toHaveLength(1);
    expect(mockedChat).toHaveBeenCalledTimes(1);
  });

  it('only the player with buttons can act in a per-player turn', async () => {
    await startWith({
      screens: {
        all: [{ type: 'text', content: "Ana's turn" }],
        p1: [{ type: 'text', content: 'Your turn' }, { type: 'button', label: 'Roll', actionId: 'roll' }],
      },
    });
    expect(uiSentTo('p2')[0].ui[0]).toMatchObject({ content: "Ana's turn" });
    expect(uiSentTo('p1')[0].ui[0]).toMatchObject({ content: 'Your turn' });

    await handlePlayerInput('session-1', 'p2', { kind: 'action', id: 'roll', turn: 1 });
    expect(mockedChat).toHaveBeenCalledTimes(1);
    expect(mockedSendToPlayer.mock.calls.some(([, id, m]) => id === 'p2' && m.type === 'error')).toBe(true);
  });

  it('processes simultaneous inputs one at a time', async () => {
    await startWith({ screens: { all: QUESTION } });
    let inFlight = 0;
    let maxInFlight = 0;
    mockedChat.mockImplementation(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return nextTurn({ screens: { all: QUESTION } });
    });
    await Promise.all([
      handlePlayerInput('session-1', 'p1', { kind: 'submit', id: 'answer', values: { answer: '3' }, turn: 1 }),
      handlePlayerInput('session-1', 'p2', { kind: 'submit', id: 'answer', values: { answer: '4' }, turn: 1 }),
    ]);
    expect(maxInFlight).toBe(1);
    // Bob's click was for turn 1, which Ana already ended → ignored
    expect(mockedChat).toHaveBeenCalledTimes(2);
  });
});

describe('timers', () => {
  it('injects a countdown and sends a timeout event listing missing players', async () => {
    vi.useFakeTimers();
    await startWith({ screens: { all: QUESTION }, wait_for: 'all', timer_seconds: 10 });
    expect(uiSentTo('p1')[0].ui[0]).toMatchObject({ type: 'countdown', seconds: 10 });

    await handlePlayerInput('session-1', 'p1', { kind: 'submit', id: 'answer', values: { answer: '4' }, turn: 1 });
    mockedChat.mockResolvedValueOnce(nextTurn({ screens: { all: NEXT_BUTTON } }));
    await vi.advanceTimersByTimeAsync(10_000);

    expect(mockedChat).toHaveBeenCalledTimes(2);
    const event = mockedChat.mock.calls[1][0].messages.at(-1)!.content!;
    expect(event).toContain('timer ran out');
    expect(event).toContain('No response from: Bob');
  });

  it('cancels the timer when everyone answers in time', async () => {
    vi.useFakeTimers();
    await startWith({ screens: { all: QUESTION }, wait_for: 'all', timer_seconds: 10 });
    mockedChat.mockResolvedValueOnce(nextTurn({ screens: { all: NEXT_BUTTON } }));
    await handlePlayerInput('session-1', 'p1', { kind: 'submit', id: 'answer', values: { answer: '4' }, turn: 1 });
    await handlePlayerInput('session-1', 'p2', { kind: 'submit', id: 'answer', values: { answer: '4' }, turn: 1 });
    expect(mockedChat).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(20_000);
    expect(mockedChat).toHaveBeenCalledTimes(2); // no stale timeout event
  });
});

describe('intro slides and game over', () => {
  it('plays intro slides before the interactive screen', async () => {
    vi.useFakeTimers();
    store.saveSession(makeSession({ status: 'defining' }));
    mockedChat.mockResolvedValueOnce(nextTurn({
      intro: [
        { screen: [{ type: 'text', content: 'France' }], seconds: 2 },
        { screen: [{ type: 'text', content: 'Peru' }], seconds: 2 },
      ],
      screens: { all: QUESTION },
    }));
    const p = startGame('session-1');
    await vi.advanceTimersByTimeAsync(5_000);
    await p;
    const uis = broadcastsOfType('ui_update').map(([, m]) => (m as { ui: Array<{ content?: string }> }).ui[0].content);
    expect(uis).toEqual(['France', 'Peru']);
    expect(uiSentTo('p1').at(-1)!.ui[0]).toMatchObject({ content: 'Question 1' });
    expect(getSession().pendingTurn?.turn).toBe(1);
  });

  it('game_over finishes the session', async () => {
    await startWith({ screens: { all: [{ type: 'text', content: 'Ana wins' }] }, game_over: { message: 'Ana wins!' } });
    expect(getSession().status).toBe('finished');
    expect(getSession().metrics?.finished).toBe(true);
    expect(broadcastsOfType('status_change').at(-1)![1]).toMatchObject({ status: 'finished', message: 'Ana wins!' });
  });
});

describe('host adjustments', () => {
  it('interrupts the pending turn and records rule changes', async () => {
    await startWith({ screens: { all: QUESTION }, wait_for: 'all' });
    await handlePlayerInput('session-1', 'p1', { kind: 'submit', id: 'answer', values: { answer: '4' }, turn: 1 });
    mockedChat.mockResolvedValueOnce(nextTurn({ screens: { all: QUESTION }, rule_change: '+3 per correct answer' }));
    await handleGameTweak('session-1', 'Ana', '3 points per correct answer');

    const event = mockedChat.mock.calls[1][0].messages.at(-1)!.content!;
    expect(event).toContain('HOST ADJUSTMENT from Ana');
    expect(event).toContain('Ana (p1) answered "4"');
    expect(getSession().agreedRules).toContain('[AMENDMENT] +3 per correct answer');
  });
});

describe('reset during an AI call', () => {
  it('discards the result of a call that finishes after a reset', async () => {
    await startWith({ screens: { all: QUESTION } });
    let release!: () => void;
    mockedChat.mockImplementationOnce(() => new Promise((resolve) => {
      release = () => resolve(nextTurn({ screens: { all: NEXT_BUTTON } }));
    }));
    const p = handlePlayerInput('session-1', 'p1', { kind: 'submit', id: 'answer', values: { answer: '4' }, turn: 1 });
    await vi.waitFor(() => expect(release).toBeDefined());
    cancelAllTimers('session-1');
    getSession().status = 'defining';
    release();
    await p;
    expect(getSession().pendingTurn).toBeUndefined();
    expect(uiSentTo('p1')).toHaveLength(1); // only the first screen
  });
});

describe('json protocol', () => {
  it('asks for schema-constrained JSON with only valid screen keys', async () => {
    cfg.protocol = 'json';
    store.saveSession(makeSession({ status: 'defining' }));
    mockedChat.mockResolvedValueOnce(textReply(JSON.stringify({ screens: { all: QUESTION } })));
    await startGame('session-1');

    const request = mockedChat.mock.calls[0][0];
    expect(request.tools).toBeUndefined();
    const schema = request.responseSchema!.schema as { properties: { screens: { properties: object; additionalProperties: boolean } } };
    expect(Object.keys(schema.properties.screens.properties)).toEqual(['all', 'p1', 'p2']);
    expect(schema.properties.screens.additionalProperties).toBe(false);
    expect(getSession().pendingTurn?.turn).toBe(1);
    expect(getSession().gameLlmMessages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(getSession().gameLlmMessages.at(-1)!.content).toContain('Waiting for the first response from: Ana, Bob');
  });

  it('feeds validation problems back as a user message', async () => {
    cfg.protocol = 'json';
    store.saveSession(makeSession({ status: 'defining' }));
    mockedChat
      .mockResolvedValueOnce(textReply(JSON.stringify({ screens: { all: [{ type: 'image' }] } })))
      .mockResolvedValueOnce(textReply(JSON.stringify({ screens: { all: QUESTION } })));
    await startGame('session-1');
    const retry = mockedChat.mock.calls[1][0].messages.at(-1)!;
    expect(retry.role).toBe('user');
    expect(retry.content).toContain('unknown type');
    expect(getSession().gameLlmMessages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
  });
});

describe('intro slides followed by nothing to click', () => {
  const slidesOnly = {
    intro: [{ screen: [{ type: 'text', content: 'Japan' }], seconds: 1 }],
    screens: { all: [{ type: 'text', content: 'Round 1' }] },
  };

  it('asks the AI for the next screen right after the slides', async () => {
    vi.useFakeTimers();
    store.saveSession(makeSession({ status: 'defining' }));
    mockedChat
      .mockResolvedValueOnce(nextTurn(slidesOnly))
      .mockResolvedValueOnce(nextTurn({ screens: { all: QUESTION } }));
    const p = startGame('session-1');
    await vi.advanceTimersByTimeAsync(2_000);
    await p;
    expect(mockedChat).toHaveBeenCalledTimes(2);
    expect(mockedChat.mock.calls[1][0].messages.at(-1)!.content).toContain('That screen has been shown');
    expect(getSession().pendingTurn?.expected).toEqual(['p1', 'p2']);
  });

  it('does not allow two auto-continues in a row', async () => {
    vi.useFakeTimers();
    store.saveSession(makeSession({ status: 'defining' }));
    mockedChat
      .mockResolvedValueOnce(nextTurn(slidesOnly))
      .mockResolvedValueOnce(nextTurn(slidesOnly))
      .mockResolvedValueOnce(nextTurn({ screens: { all: QUESTION } }));
    const p = startGame('session-1');
    await vi.advanceTimersByTimeAsync(5_000);
    await p;
    // The second splash in a row is not auto-continued: it gets a Continue button instead
    expect(mockedChat).toHaveBeenCalledTimes(2);
    expect(uiSentTo('p1').at(-1)!.ui.at(-1)).toMatchObject({ type: 'button', actionId: 'continue' });
    expect(getSession().pendingTurn).toBeDefined();
  });
});

describe('server restart in the middle of an AI turn', () => {
  it('marks the game as stalled so players get Retry, and tells reconnecting clients the AI is idle', async () => {
    // State as persisted when the server died while waiting for the AI: playing, no pending turn
    const session = makeSession({ playerUi: { p1: QUESTION as never, all: QUESTION as never } });
    store.saveSession(session);
    recoverInterruptedGames([getSession()]);
    expect(getSession().stalled).toContain('restart');

    resendState(getSession(), 'p1');
    const toAna = mockedSendToPlayer.mock.calls.filter(([, id]) => id === 'p1').map(([, , m]) => m);
    expect(toAna).toContainEqual({ type: 'ai_thinking', thinking: false });
    expect(toAna.some((m) => m.type === 'game_error' && m.message)).toBe(true);

    // Retry continues the game
    mockedChat.mockResolvedValueOnce(nextTurn({ screens: { all: QUESTION } }));
    await retryTurn('session-1', 'Ana');
    expect(getSession().stalled).toBeUndefined();
    expect(getSession().pendingTurn).toBeDefined();
  });

  it('leaves games that are waiting for players alone', async () => {
    await startWith({ screens: { all: QUESTION } });
    recoverInterruptedGames([getSession()]);
    expect(getSession().stalled).toBeUndefined();
  });
});

describe('host adjustment regenerates the screen', () => {
  it('sends the adjustment to the AI and shows the new screen right away', async () => {
    await startWith({ screens: { all: QUESTION } });
    const withIdk = [{ type: 'multiple_choice', fieldId: 'answer', question: '2+2?', options: ['3', '4', "I don't know"] }];
    mockedChat.mockResolvedValueOnce(nextTurn({ screens: { all: withIdk }, rule_change: 'Every question offers "I don\'t know"' }));
    await handleGameTweak('session-1', 'Ana', 'add an option "I don\'t know"');
    expect(uiSentTo('p1').at(-1)!.ui[0]).toMatchObject({ options: ['3', '4', "I don't know"] });
    expect(getSession().pendingTurn?.turn).toBe(2);
  });
});

describe('game plan bookkeeping', () => {
  it('records answers per round/phase, counts rounds and adds the plan timer', async () => {
    await startWith({
      plan: { rounds: 2, phases: [{ id: 'answer', timer_seconds: 30 }, { id: 'reveal' }] },
      phase: 'answer',
      screens: { all: QUESTION },
      wait_for: 'all',
    });
    expect(uiSentTo('p1')[0].ui[0]).toMatchObject({ type: 'countdown', seconds: 30 });

    mockedChat.mockResolvedValueOnce(nextTurn({ phase: 'reveal', screens: { all: NEXT_BUTTON } }));
    await handlePlayerInput('session-1', 'p1', { kind: 'submit', id: 'answer', values: { answer: '4' }, turn: 1 });
    await handlePlayerInput('session-1', 'p2', { kind: 'submit', id: 'answer', values: { answer: '3' }, turn: 1 });

    expect(getSession().gameState.answers).toEqual({ round1: { answer: { Ana: '4', Bob: '3' } } });
    expect(getSession().gameState.progress).toMatchObject({ round: 1, phase: 'reveal' });
    const event = mockedChat.mock.calls[1][0].messages.at(-1)!.content!;
    expect(event).toContain('PLAN PROGRESS: round 1 of 2, current phase "answer"');

    mockedChat.mockResolvedValueOnce(nextTurn({ phase: 'answer', screens: { all: QUESTION }, wait_for: 'all' }));
    await handlePlayerInput('session-1', 'p1', { kind: 'action', id: 'next', turn: 2 });
    expect(getSession().gameState.progress).toMatchObject({ round: 2, phase: 'answer' });
  });
});

describe('after game over', () => {
  it('a host adjustment reopens the game and shows the new screen', async () => {
    await startWith({ screens: { all: [{ type: 'text', content: 'Ana wins' }] }, game_over: true, final_message: 'Ana wins' });
    expect(getSession().status).toBe('finished');
    mockedChat.mockResolvedValueOnce(nextTurn({ screens: { all: [{ type: 'text', content: 'Final scores per question' }] }, game_over: true, final_message: 'Ana wins 3-1' }));
    await handleGameTweak('session-1', 'Ana', 'add a final screen with the score of each question');
    expect(broadcastsOfType('status_change').map(([, m]) => (m as { status: string }).status)).toContain('playing');
    expect(mockedChat.mock.calls[1][0].messages.at(-1)!.content).toContain('had already ended');
    expect(uiSentTo('p1').at(-1)!.ui[0]).toMatchObject({ content: 'Final scores per question' });
    expect(getSession().status).toBe('finished');
  });
});

describe('answered notifications', () => {
  it('tells the other players when someone answers, without changing their screen', async () => {
    await startWith({ screens: { all: QUESTION }, wait_for: 'all', timer_seconds: 30 });
    const bobScreensBefore = uiSentTo('p2').length;
    await handlePlayerInput('session-1', 'p1', { kind: 'submit', id: 'answer', values: { answer: '4' }, turn: 1 });
    const toBob = mockedSendToPlayer.mock.calls.filter(([, id]) => id === 'p2').map(([, , m]) => m);
    expect(toBob).toContainEqual({ type: 'toast', text: 'Ana answered ✓' });
    expect(uiSentTo('p2').length).toBe(bobScreensBefore);
    // Ana's locked screen has no running timer any more
    expect(uiSentTo('p1').at(-1)!.ui.some((c) => c.type === 'countdown')).toBe(false);
  });
});

describe('answer keys', () => {
  const quiz = [{ type: 'multiple_choice', fieldId: 'q1', question: 'Capital of France?', options: ['Paris', 'Rome'], correct: 'Paris', points: 2, penalty: -1 }];

  it('never sends the right answer to the browsers', async () => {
    await startWith({ screens: { all: quiz }, wait_for: 'all' });
    const everything = JSON.stringify(mockedSendToPlayer.mock.calls);
    expect(everything).not.toContain('answerKey');
    expect(everything).not.toContain('"correct"');
  });

  it('gives instant feedback and points, and reports the check to the AI', async () => {
    await startWith({ screens: { all: quiz }, wait_for: 'all' });
    await handlePlayerInput('session-1', 'p1', { kind: 'submit', id: 'q1', values: { q1: 'Paris' }, turn: 1 });
    expect(uiSentTo('p1').at(-1)!.ui.some((c) => c.type === 'text' && c.content.startsWith('✓ Correct! (+2)'))).toBe(true);
    expect(getSession().gameState.scores).toEqual({ Ana: 2 });

    mockedChat.mockResolvedValueOnce(nextTurn({ screens: { all: NEXT_BUTTON } }));
    await handlePlayerInput('session-1', 'p2', { kind: 'submit', id: 'q1', values: { q1: 'Rome' }, turn: 1 });
    expect(getSession().gameState.scores).toEqual({ Ana: 2, Bob: -1 });
    const event = mockedChat.mock.calls[1][0].messages.at(-1)!.content!;
    expect(event).toContain('Answer check for "q1" (right answer: Paris): Ana ✓ +2, Bob ✗ -1');
  });

  it('shows the verdict right away in a single-player turn too', async () => {
    await startWith({ screens: { all: quiz } });
    mockedChat.mockResolvedValueOnce(nextTurn({ screens: { all: NEXT_BUTTON } }));
    await handlePlayerInput('session-1', 'p2', { kind: 'submit', id: 'q1', values: { q1: 'Rome' }, turn: 1 });
    const bobScreens = uiSentTo('p2').map((m) => m.ui);
    expect(bobScreens.some((ui) => ui.some((c) => c.type === 'text' && c.content === '✗ The answer was Paris (-1)'))).toBe(true);
  });
});

describe('thinking ahead (prefetch)', () => {
  const solo: Partial<Session> = { players: [{ id: 'p1', name: 'Ana', isHost: true, connectedAt: '' }] };

  it('prepares the next screen when the only option is one button, and uses it', async () => {
    process.env.LLM_PREFETCH = 'true';
    mockedChat
      .mockResolvedValueOnce(nextTurn({ screens: { all: NEXT_BUTTON } })) // first screen: just "Next"
      .mockResolvedValueOnce(nextTurn({ screens: { all: QUESTION } })); // prefetched follow-up
    store.saveSession(makeSession({ status: 'defining', ...solo }));
    await startGame('session-1');
    expect(mockedChat).toHaveBeenCalledTimes(2); // the second call started right away

    await handlePlayerInput('session-1', 'p1', { kind: 'action', id: 'next', turn: 1 });
    expect(mockedChat).toHaveBeenCalledTimes(2); // no new call: the prepared reply was used
    expect(uiSentTo('p1').at(-1)!.ui[0]).toMatchObject({ content: 'Question 1' });
    expect(getSession().metrics?.prefetchHits).toBe(1);
  });

  it('throws the prepared reply away when something else happens', async () => {
    process.env.LLM_PREFETCH = 'true';
    mockedChat
      .mockResolvedValueOnce(nextTurn({ screens: { all: NEXT_BUTTON } }))
      .mockResolvedValueOnce(nextTurn({ screens: { all: QUESTION } })) // prefetch (not used)
      .mockResolvedValueOnce(nextTurn({ screens: { all: [{ type: 'text', content: 'Adjusted' }, ...NEXT_BUTTON] } }));
    store.saveSession(makeSession({ status: 'defining', ...solo }));
    await startGame('session-1');
    await handleGameTweak('session-1', 'Ana', 'make it harder');
    expect(mockedChat).toHaveBeenCalledTimes(4); // real call for the tweak (+ a new prefetch for its Next button)
    expect(getSession().metrics?.prefetchMisses).toBe(1);
    expect(uiSentTo('p1').some((m) => m.ui[0]?.type === 'text' && (m.ui[0] as { content: string }).content === 'Adjusted')).toBe(true);
  });

  it('does not think ahead when several outcomes are possible', async () => {
    process.env.LLM_PREFETCH = 'true';
    await startWith({ screens: { all: QUESTION } }); // a choice: many possible answers
    expect(mockedChat).toHaveBeenCalledTimes(1);
  });
});

describe('optional plan', () => {
  it('does not require "plan" or "phase" in the JSON schema', async () => {
    cfg.protocol = 'json';
    store.saveSession(makeSession({ status: 'defining' }));
    mockedChat.mockResolvedValueOnce(textReply(JSON.stringify({ plan: { rounds: 2, phases: ['q'] }, phase: 'q', screens: { all: QUESTION }, wait_for: 'all', game_over: false })));
    await startGame('session-1');
    expect((mockedChat.mock.calls[0][0].responseSchema!.schema as { required: string[] }).required).toEqual(['screens', 'wait_for', 'game_over']);
    expect(getSession().gameState.progress).toMatchObject({ round: 1, phase: 'q' });
  });
});
