import { describe, it, expect } from 'vitest';
import type { Player, PendingTurn } from '../../types';
import { parsePlan, advance, progressLine, recordAnswers, GamePlan } from '../plan';
import { parseNextTurn } from '../turn';

const players: Player[] = [
  { id: 'p1', name: 'Ana', isHost: true, connectedAt: '' },
  { id: 'p2', name: 'Bob', isHost: false, connectedAt: '' },
];

const plan: GamePlan = {
  rounds: 2,
  phases: [{ id: 'clue', timer_seconds: 45 }, { id: 'vote', timer_seconds: 30 }, { id: 'reveal' }],
};

const vote = [{ type: 'multiple_choice', fieldId: 'vote', question: 'Who?', player_options: 'others' }];

describe('parsePlan', () => {
  it('accepts phases as objects or strings', () => {
    expect(parsePlan({ rounds: 3, phases: ['a', { id: 'b', timer_seconds: 20 }] }).plan).toEqual({
      rounds: 3,
      phases: [{ id: 'a' }, { id: 'b', timer_seconds: 20 }],
    });
  });
  it('rejects duplicate phase ids and silly round counts', () => {
    expect(parsePlan({ rounds: 2, phases: ['a', 'a'] }).error).toContain('twice');
    expect(parsePlan({ rounds: 0, phases: ['a'] }).error).toContain('rounds');
  });
});

describe('advance', () => {
  it('starts at round 1 and moves through phases', () => {
    const p1 = advance(plan, undefined, 'clue');
    expect(p1).toMatchObject({ round: 1, phase: 'clue' });
    expect(advance(plan, p1, 'vote')).toMatchObject({ round: 1, phase: 'vote' });
  });
  it('going back to an earlier phase starts the next round', () => {
    expect(advance(plan, { round: 1, phase: 'reveal', finalPhase: false }, 'clue')).toMatchObject({ round: 2, phase: 'clue' });
  });
  it('an explicit round wins (the same question opens again)', () => {
    expect(advance(plan, { round: 2, phase: 'reveal', finalPhase: true }, 'clue', 2)).toMatchObject({ round: 2, phase: 'clue', finalPhase: false });
    const r = parseNextTurn({ phase: 'clue', round: 2, screens: { all: vote }, wait_for: 'all' }, players, {
      plan, progress: { round: 2, phase: 'reveal', finalPhase: true },
    });
    expect(r.ok && r.turn.progress).toMatchObject({ round: 2, phase: 'clue' });
  });
  it('never refuses: extra rounds and unknown phases are allowed', () => {
    expect(advance(plan, { round: 2, phase: 'reveal', finalPhase: true }, 'clue')).toMatchObject({ round: 3, phase: 'clue' });
    expect(advance(plan, { round: 1, phase: 'clue', finalPhase: false }, 'dance')).toMatchObject({ round: 1, phase: 'clue' });
  });
});

describe('progressLine', () => {
  it('says where we are and what comes next', () => {
    expect(progressLine(plan, { round: 1, phase: 'reveal', finalPhase: false })).toContain('next: round 2, phase "clue"');
    expect(progressLine(plan, { round: 2, phase: 'reveal', finalPhase: true })).toContain('end the game next, unless the rules say otherwise');
  });
});

describe('recordAnswers', () => {
  const pending: PendingTurn = {
    turn: 4,
    waitFor: 'all',
    expected: ['p1', 'p2'],
    responses: [
      { playerId: 'p1', playerName: 'Ana', kind: 'submit', id: 'vote', values: { vote: 'Bob' } },
      { playerId: 'p2', playerName: 'Bob', kind: 'submit', id: 'vote', values: { vote: 'Ana' } },
    ],
  };
  it('stores answers under round and phase when there is a plan', () => {
    const state = recordAnswers({ plan, progress: { round: 2, phase: 'vote', finalPhase: false } }, pending, players);
    expect(state.answers).toEqual({ round2: { vote: { Ana: 'Bob', Bob: 'Ana' } } });
  });
  it('stores answers under the turn number without a plan', () => {
    const state = recordAnswers({}, pending, players);
    expect(state.answers).toEqual({ turn4: { vote: { Ana: 'Bob', Bob: 'Ana' } } });
  });
});

describe('next_turn with a plan', () => {
  it('a first turn may define the plan and its phase', () => {
    const r = parseNextTurn({ plan, phase: 'clue', screens: { all: [{ type: 'input', fieldId: 'clue' }, { type: 'button', label: 'Send', actionId: 'send' }] }, wait_for: 'all' }, players);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.turn.plan).toEqual(plan);
    expect(r.turn.progress).toMatchObject({ round: 1, phase: 'clue' });
    expect(r.turn.timerSeconds).toBe(45); // phase timer applied
  });

  it('keeps the explicit timer when given', () => {
    const r = parseNextTurn({ phase: 'vote', screens: { all: vote }, wait_for: 'all', timer_seconds: 20 }, players, {
      plan, progress: { round: 1, phase: 'clue', finalPhase: false },
    });
    expect(r.ok && r.turn.timerSeconds).toBe(20);
  });

  it('allows an extra round when the rules need one', () => {
    const extra = parseNextTurn({ phase: 'clue', screens: { all: vote }, wait_for: 'all' }, players, { plan, progress: { round: 2, phase: 'reveal', finalPhase: true } });
    expect(extra.ok && extra.turn.progress).toMatchObject({ round: 3 });
  });

  it('ignores attempts to overwrite server-owned state keys', () => {
    const r = parseNextTurn({ phase: 'clue', screens: { all: vote }, state_update: { answers: {}, progress: null, round_word: 'x' } }, players, { plan });
    expect(r.ok && r.turn.stateUpdate).toEqual({ round_word: 'x' });
  });
});

describe('optional plan', () => {
  it('accepts turns without a plan or a phase', () => {
    expect(parseNextTurn({ screens: { all: vote } }, players, {}).ok).toBe(true);
    const r = parseNextTurn({ screens: { all: vote } }, players, { plan, progress: { round: 1, phase: 'clue', finalPhase: false } });
    expect(r.ok && r.turn.progress).toMatchObject({ round: 1, phase: 'clue' });
  });
  it('never turns a penalty into a reward', () => {
    const r = parseNextTurn({ phase: 'vote', screens: { all: [{ type: 'multiple_choice', fieldId: 'q', question: '?', options: ['a', 'b'], correct: 'a', penalty: 2 }] } }, players, { plan, progress: { round: 1, phase: 'clue', finalPhase: false } });
    expect(r.ok && r.turn.screens.all[0]).toMatchObject({ answerKey: { penalty: -2 } });
  });
});
