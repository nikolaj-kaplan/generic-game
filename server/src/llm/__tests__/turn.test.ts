import { describe, it, expect } from 'vitest';
import type { LLMMessage, Player, PendingTurn } from '../../types';
import {
  personalize,
  screenFor,
  parseNextTurn,
  trimHistory,
  mergeConsecutiveUserMessages,
  applyStateUpdate,
  tryParsePseudoNextTurn,
  formatTurnEvent,
  expectedResponders,
} from '../turn';

const players: Player[] = [
  { id: 'p1', name: 'Ana', isHost: true, connectedAt: '' },
  { id: 'p2', name: 'Bob', isHost: false, connectedAt: '' },
];

const question = [
  { type: 'text', content: 'Q1' },
  { type: 'multiple_choice', fieldId: 'answer', question: '2+2?', options: ['3', '4'] },
];

describe('parseNextTurn', () => {
  it('accepts a minimal valid turn', () => {
    const r = parseNextTurn({ screens: { all: question } }, players);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.turn.waitFor).toBe('any');
      expect(r.turn.screens.all).toHaveLength(2);
    }
  });

  it('maps player names to ids and keeps "all" as fallback', () => {
    const r = parseNextTurn({ screens: { all: question, Bob: [{ type: 'text', content: 'secret' }, { type: 'button', label: 'OK', actionId: 'ok' }] } }, players);
    expect(r.ok).toBe(true);
    if (r.ok) expect(Object.keys(r.turn.screens).sort()).toEqual(['all', 'p2']);
  });

  it('rejects unknown screen keys and lists valid ids', () => {
    const r = parseNextTurn({ screens: { Carl: question } }, players);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toContain('"p1" (Ana)');
  });

  it('turns a splash screen into an auto-continue, but only once in a row', () => {
    const splash = { screens: { all: [{ type: 'text', content: 'Get ready!' }] } };
    const first = parseNextTurn(splash, players, { isFirstTurn: true });
    expect(first.ok && first.turn.autoContinue).toBe(true);
    const second = parseNextTurn(splash, players, { isFirstTurn: true, allowAutoContinue: false });
    expect(second.ok && second.turn.autoContinue).toBe(false);
    if (second.ok) expect(second.turn.screens.all.at(-1)).toMatchObject({ type: 'button', actionId: 'continue' });
  });

  it('adds a Continue button to a mid-game screen with nothing to click', () => {
    const r = parseNextTurn({ screens: { all: [{ type: 'text', content: 'Correct!' }] } }, players);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.turn.screens.all).toEqual([{ type: 'text', content: 'Correct!' }, { type: 'button', label: 'Continue', actionId: 'continue' }]);
  });

  it('rejects wait_for "all" when nobody has anything to answer, even with a timer', () => {
    const r = parseNextTurn({ screens: { all: [{ type: 'text', content: 'Vote now!' }] }, wait_for: 'all', timer_seconds: 30 }, players);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toContain('wait_for is "all"');
  });

  it('allows a non-interactive screen when a longer timer is set', () => {
    const r = parseNextTurn({ screens: { all: [{ type: 'text', content: 'Memorise the list!' }] }, timer_seconds: 15 }, players);
    expect(r.ok).toBe(true);
  });

  it('allows one short-timer results screen, but not a chain of slides', () => {
    const slide = { screens: { all: [{ type: 'text', content: 'Japan' }] }, timer_seconds: 2 };
    const once = parseNextTurn(slide, players);
    expect(once.ok && once.turn.isSlide).toBe(true);
    const again = parseNextTurn(slide, players, { previousWasSlide: true });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.errors[0]).toContain('intro');
  });

  it('turns a countdown component into timer_seconds', () => {
    const r = parseNextTurn({ screens: { all: [...question, { type: 'countdown', seconds: 20 }] } }, players);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.turn.timerSeconds).toBe(20);
      expect(r.turn.screens.all.some((c) => c.type === 'countdown')).toBe(false);
    }
  });

  it('normalises common aliases', () => {
    const r = parseNextTurn(
      {
        screens: {
          all: [
            { type: 'text', text: 'hi' },
            { type: 'multiple_choice', question: 'x', choices: [{ label: 'a' }, { label: 'b' }] },
            { type: 'scoreboard', players: { Ana: 2, Bob: 1 } },
          ],
        },
      },
      players,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.turn.screens.all[0]).toEqual({ type: 'text', content: 'hi' });
      expect(r.turn.screens.all[1]).toMatchObject({ options: ['a', 'b'], fieldId: 'answer' });
      expect(r.turn.screens.all[2]).toMatchObject({ players: [{ name: 'Ana', score: 2 }, { name: 'Bob', score: 1 }] });
    }
  });

  it('treats a text style used as type as a text component', () => {
    const r = parseNextTurn({ screens: { all: [{ type: 'body', content: 'hello' }, { type: 'button', label: 'Go', actionId: 'go', style: 'large' }] } }, players);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.turn.screens.all[0]).toEqual({ type: 'text', content: 'hello', style: 'body' });
      expect(r.turn.screens.all[1]).toEqual({ type: 'button', label: 'Go', actionId: 'go' });
    }
  });

  it('requires a button next to a free-text input', () => {
    const r = parseNextTurn({ screens: { all: [{ type: 'input', fieldId: 'guess' }] } }, players);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toMatch(/no button/);
  });

  it('rejects unknown component types', () => {
    const r = parseNextTurn({ screens: { all: [{ type: 'image', src: 'x' }] } }, players);
    expect(r.ok).toBe(false);
  });

  it('accepts game_over without interactive screens', () => {
    const r = parseNextTurn({ screens: { all: [{ type: 'text', content: 'Ana wins' }] }, game_over: { message: 'Ana wins' } }, players);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.turn.gameOver?.message).toBe('Ana wins');
  });

  it('treats placeholder values from constrained decoding as "not set"', () => {
    const r = parseNextTurn({ screens: { all: question }, wait_for: 'all', game_over: false, final_message: 'Game Over', timer_seconds: 0, rule_change: 'None' }, players);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.turn.gameOver).toBeUndefined();
      expect(r.turn.timerSeconds).toBeUndefined();
      expect(r.turn.ruleChange).toBeUndefined();
    }
  });

  it('ends the game with game_over true and final_message', () => {
    const r = parseNextTurn({ screens: { all: [{ type: 'text', content: 'Bob wins' }] }, wait_for: 'any', game_over: true, final_message: 'Bob wins 3-1' }, players);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.turn.gameOver).toEqual({ message: 'Bob wins 3-1' });
  });

  it('accepts a bare array as the "all" screen', () => {
    const r = parseNextTurn({ screens: question }, players);
    expect(r.ok).toBe(true);
  });
});

describe('expectedResponders', () => {
  it('only counts players with interactive screens', () => {
    const screens = {
      all: [{ type: 'text' as const, content: 'Waiting for Ana' }],
      p1: [{ type: 'button' as const, label: 'Roll', actionId: 'roll' }],
    };
    expect(expectedResponders(screens, players)).toEqual(['p1']);
  });
});

describe('applyStateUpdate', () => {
  it('merges and deletes null keys', () => {
    expect(applyStateUpdate({ a: 1, b: 2 }, { b: null, c: 3 })).toEqual({ a: 1, c: 3 });
  });
});

describe('tryParsePseudoNextTurn', () => {
  it('reads next_turn written as text in a code fence', () => {
    const text = 'Here you go:\n```json\n{"name": "next_turn", "arguments": {"screens": {"all": []}}}\n```';
    expect(tryParsePseudoNextTurn(text)).toEqual({ screens: { all: [] } });
  });
  it('ignores unrelated text', () => {
    expect(tryParsePseudoNextTurn('{"action": "await"}')).toBeNull();
  });
});

describe('trimHistory', () => {
  const event = (n: number): LLMMessage => ({ role: 'user', content: `event ${n}` });
  const call = (n: number): LLMMessage => ({ role: 'assistant', content: null, tool_calls: [{ id: `c${n}`, type: 'function', function: { name: 'next_turn', arguments: '{}' } }] });
  const result = (n: number): LLMMessage => ({ role: 'tool', tool_call_id: `c${n}`, content: '{}' });
  const history = Array.from({ length: 10 }, (_, i) => [event(i), call(i), result(i)]).flat();

  it('never starts with an orphaned tool result and keeps the start event', () => {
    const trimmed = trimHistory(history, 8);
    expect(trimmed[0].role).toBe('user');
    expect(trimmed[0].content).toContain('event 0');
    for (let i = 0; i < trimmed.length; i++) {
      if (trimmed[i].role === 'tool') expect(trimmed[i - 1].role).toBe('assistant');
    }
  });

  it('returns short histories unchanged', () => {
    expect(trimHistory(history.slice(0, 3), 8)).toHaveLength(3);
  });
});

describe('mergeConsecutiveUserMessages', () => {
  it('joins back-to-back user messages', () => {
    const merged = mergeConsecutiveUserMessages([
      { role: 'user', content: 'a' },
      { role: 'user', content: 'b' },
      { role: 'assistant', content: 'c' },
    ]);
    expect(merged).toHaveLength(2);
    expect(merged[0].content).toBe('a\n\nb');
  });
});

describe('formatTurnEvent vote counts', () => {
  it('counts identical answers per field', () => {
    const pending: PendingTurn = {
      turn: 5,
      waitFor: 'all',
      expected: ['p1', 'p2'],
      responses: [
        { playerId: 'p1', playerName: 'Ana', kind: 'submit', id: 'vote', values: { vote: 'Bob' } },
        { playerId: 'p2', playerName: 'Bob', kind: 'submit', id: 'vote', values: { vote: 'Bob' } },
      ],
    };
    expect(formatTurnEvent(pending, 'responses', players)).toContain('Count for "vote": Bob 2.');
  });
});

describe('formatTurnEvent', () => {
  it('lists answers and missing players on timeout', () => {
    const pending: PendingTurn = {
      turn: 3,
      waitFor: 'all',
      expected: ['p1', 'p2'],
      responses: [{ playerId: 'p1', playerName: 'Ana', kind: 'submit', id: 'answer', values: { answer: '4' } }],
      timerSeconds: 30,
    };
    const text = formatTurnEvent(pending, 'timeout', players);
    expect(text).toContain('timer ran out');
    expect(text).toContain('Ana (p1) answered "4"');
    expect(text).toContain('No response from: Bob');
  });
});

describe('state_append', () => {
  it('appends to existing lists and creates missing ones', () => {
    const r = parseNextTurn({ screens: { all: question }, state_append: { history: { q: 'b' }, rounds: [1] } }, players);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const next = applyStateUpdate({ history: [{ q: 'a' }] }, r.turn.stateUpdate, r.turn.stateAppend);
    expect(next).toEqual({ history: [{ q: 'a' }, { q: 'b' }], rounds: [1] });
  });
});

describe('vote shortcuts', () => {
  it('player_options "others" lists every player except the viewer', () => {
    const r = parseNextTurn({ screens: { all: [{ type: 'multiple_choice', fieldId: 'vote', question: 'Who?', player_options: 'others' }] }, wait_for: 'all' }, players);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(screenFor(r.turn.screens, 'p1', players)[0]).toEqual({ type: 'multiple_choice', fieldId: 'vote', question: 'Who?', options: ['Bob'] });
    expect(screenFor(r.turn.screens, 'p2', players)[0]).toMatchObject({ options: ['Ana'] });
  });

  it('hides options owned by the viewer (by id or name)', () => {
    const ui = parseNextTurn({
      screens: { all: [{ type: 'multiple_choice', fieldId: 'vote', question: 'Funniest?', options: [{ label: 'a cat', owner: 'p1' }, { label: 'a hat', owner: 'Bob' }, 'a bat'] }] },
    }, players);
    expect(ui.ok).toBe(true);
    if (!ui.ok) return;
    expect(personalize(ui.turn.screens.all, 'p1', players)[0]).toMatchObject({ options: ['a hat', 'a bat'] });
    expect(personalize(ui.turn.screens.all, 'p2', players)[0]).toMatchObject({ options: ['a cat', 'a bat'] });
    expect(JSON.stringify(personalize(ui.turn.screens.all, 'p2', players))).not.toContain('owner');
  });
});

describe('state_add', () => {
  it('adds points into nested scores and starts missing ones at 0', () => {
    const r = parseNextTurn({ screens: { all: question }, state_add: { scores: { Ana: 2, Bob: 1 }, round: 1 } }, players);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const next = applyStateUpdate({ scores: { Ana: 3 }, round: 2 }, r.turn.stateUpdate, r.turn.stateAppend, r.turn.stateAdd);
    expect(next).toEqual({ scores: { Ana: 5, Bob: 1 }, round: 3 });
  });
});

describe('audit fixes', () => {
  it('accepts a plan written inside state_update', () => {
    const r = parseNextTurn({ state_update: { plan: { rounds: 2, phases: ['clue', 'vote'] }, word: 'x' }, phase: 'clue', screens: { all: question } }, players);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.turn.plan?.rounds).toBe(2);
    expect(r.turn.stateUpdate).toEqual({ word: 'x' });
  });

  it('a player vote can carry extra options such as "I don\'t know"', () => {
    const r = parseNextTurn({ screens: { all: [{ type: 'multiple_choice', fieldId: 'vote', question: 'Who?', player_options: 'others', options: ["I don't know"] }] } }, players);
    expect(r.ok).toBe(true);
    if (r.ok) expect(screenFor(r.turn.screens, 'p1', players)[0]).toMatchObject({ options: ['Bob', "I don't know"] });
  });
});

describe('answer key validation', () => {
  it('matches "correct" leniently and never rejects the turn over it', () => {
    const mc = (correct: string) =>
      parseNextTurn({ screens: { all: [{ type: 'multiple_choice', fieldId: 'q', question: '?', options: ['The Bronze Age', 'The Iron Age'], correct }] } }, players);
    const loose = mc('Bronze Age');
    expect(loose.ok && loose.turn.screens.all[0]).toMatchObject({ answerKey: { correct: ['The Bronze Age'] } });
    const letter = mc('B');
    expect(letter.ok && letter.turn.screens.all[0]).toMatchObject({ answerKey: { correct: ['The Iron Age'] } });
    const nonsense = mc('Stone Age');
    expect(nonsense.ok).toBe(true); // question still shown, just without automatic checking
    if (nonsense.ok) expect(nonsense.turn.screens.all[0]).not.toHaveProperty('answerKey');
  });
});

describe('answer times', () => {
  it('shows how long each player took', () => {
    const pending: PendingTurn = {
      turn: 2,
      waitFor: 'all',
      expected: ['p1'],
      responses: [{ playerId: 'p1', playerName: 'Ana', kind: 'submit', id: 'q', values: { q: 'Paris' }, elapsedMs: 3240 }],
    };
    expect(formatTurnEvent(pending, 'responses', players)).toContain('answered "Paris" (field "q") after 3.2s');
  });
});
