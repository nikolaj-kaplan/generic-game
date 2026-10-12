import { describe, expect, it, vi } from 'vitest';
import { allPresetPrograms } from '../presets';
import { runDispatch, describeProgram, EnginePlayer, DispatchOutput } from '../sandbox';
import { botPlayers, fakeAi } from '../botTest';
import { checkProgramSource } from '../typecheck';
import { shapeToSchema, coerce } from '../shape';

const players: EnginePlayer[] = botPlayers(3);
const [ana, bob, cleo] = players.map((p) => p.id);
const ai = fakeAi(() => 0.42);

async function start(program: string, list = players): Promise<DispatchOutput> {
  return runDispatch(program, { engine: null, players: list, event: { type: 'start' }, seed: 1 }, { ai });
}

async function send(program: string, out: DispatchOutput, playerId: string, input: { kind: 'action' | 'submit'; id: string; values?: Record<string, string> }, list = players) {
  return runDispatch(program, { engine: out.engine, players: list, event: { type: 'input', playerId, turn: out.engine.turn, input } }, { ai });
}

const texts = (out: DispatchOutput, id: string) =>
  out.screens[id].map((c) => ('content' in c ? c.content : 'label' in c ? (c.label as string) : c.type));

describe('preset programs', () => {
  for (const preset of allPresetPrograms()) {
    it(`${preset.id} type-checks and survives bot games`, async () => {
      expect(checkProgramSource(preset.code)).toEqual([]);
      const { checkProgram } = await import('../generator');
      const result = await checkProgram(preset.code, preset.range, { runs: 6 });
      expect(result.problems).toEqual([]);
    }, 60_000);
  }
});

describe('sandbox', () => {
  it('stops an endless loop', async () => {
    const program = `defineGame({ start: 'a', phases: { a: show({ enter() { while (true) {} }, view: () => 'x', next: 'a' }) } });`;
    await expect(start(program)).rejects.toThrow(/endless loop/);
  });

  it('gives the program no Node or network access', async () => {
    const program = `defineGame({ setup(g) { g.state.seen = [typeof process, typeof require, typeof fetch, typeof setTimeout].join(','); }, start: 'a', phases: { a: show({ view: (g) => g.state.seen, next: (g) => g.end() }) } });`;
    const out = await start(program);
    expect(out.engine.state.seen).toBe('undefined,undefined,undefined,undefined');
  });

  it('keeps nothing between events except g.state', async () => {
    const program = `const counter = { n: 0 };
defineGame({ start: 'a', phases: { a: collect({ input: (g) => { counter.n++; return ui.button('go', 'Go ' + counter.n); }, next: 'a' }) } });`;
    const one = [players[0]];
    let out = await start(program, one);
    out = await send(program, out, ana, { kind: 'action', id: 'go' }, one);
    const first = texts(out, ana);
    out = await send(program, out, ana, { kind: 'action', id: 'go' }, one);
    // The module-level counter starts again for every event (screens are drawn more than once per event).
    expect(texts(out, ana)).toEqual(first);
  });
});

describe('answers', () => {
  const program = `defineGame({
  start: 'pick',
  phases: {
    pick: collect({ input: (g) => ui.pickPlayer('Who?'), next: 'type' }),
    type: collect({ input: () => [ui.textInput('Word'), ui.button('skip', 'Skip')], next: 'done' }),
    done: show({ view: (g) => JSON.stringify(g.answers), next: (g) => g.end() }),
  },
});`;

  it('a player pick is the player id; one text input is the text; another button is an object', async () => {
    let out = await start(program);
    const options = (out.screens[ana].find((c) => c.type === 'multiple_choice') as { options: string[] }).options;
    expect(options).toEqual(['Bob', 'Cleo']);
    out = await send(program, out, ana, { kind: 'submit', id: 'player', values: { player: 'Bob' } });
    out = await send(program, out, bob, { kind: 'submit', id: 'player', values: { player: 'Ana' } });
    out = await send(program, out, cleo, { kind: 'submit', id: 'player', values: { player: 'Ana' } });
    expect(out.engine.phase).toBe('type');
    out = await send(program, out, ana, { kind: 'submit', id: 'submit', values: { text: '  hello ' } });
    out = await send(program, out, bob, { kind: 'submit', id: 'skip', values: { text: 'x' } });
    out = await send(program, out, cleo, { kind: 'action', id: 'skip' });
    const answers = out.engine.answers.r1 as Record<string, Record<string, unknown>>;
    expect(answers.pick).toEqual({ [ana]: bob, [bob]: ana, [cleo]: ana });
    expect(answers.type).toEqual({ [ana]: 'hello', [bob]: { text: 'x', button: 'skip' }, [cleo]: { button: 'skip' } });
  });

  it('ignores old screens and players who already answered', async () => {
    let out = await start(program);
    const old = out;
    out = await send(program, out, ana, { kind: 'submit', id: 'player', values: { player: 'Bob' } });
    const again = await send(program, out, ana, { kind: 'submit', id: 'player', values: { player: 'Cleo' } });
    expect(again.result.ignored).toBe('already answered');
    const stale = await runDispatch(program, { engine: out.engine, players, event: { type: 'input', playerId: bob, turn: old.engine.turn - 1, input: { kind: 'submit', id: 'player', values: { player: 'Ana' } } } }, { ai });
    expect(stale.result.ignored).toBe('old screen');
  });

  it('checks a choice with an answer key and scores it', async () => {
    const quiz = `defineGame({ start: 'q', phases: { q: collect({ input: () => ui.choice('2+2?', ['3', '4'], { correct: '4', points: 5, penalty: 2 }), next: (g) => g.end() }) } });`;
    let out = await start(quiz);
    out = await send(quiz, out, ana, { kind: 'submit', id: 'choice', values: { choice: '4' } });
    expect(texts(out, ana)).toContain('✓ Correct! (+5)');
    out = await send(quiz, out, bob, { kind: 'submit', id: 'choice', values: { choice: '3' } });
    expect(out.engine.scores[ana]).toBe(5);
    expect(out.engine.scores[bob]).toBe(-2);
  });
});

describe('migration', () => {
  const v1 = `defineGame({ rounds: 2, start: 'a', phases: { a: collect({ input: () => ui.button('ok', 'OK'), next: (g) => g.lastRound ? g.end() : g.nextRound('a') }) } });`;
  const v2 = `defineGame({ rounds: 2, start: 'b', phases: { b: collect({ input: () => ui.button('ok', 'OK v2'), next: (g) => g.end() }) } });`;

  it('a removed phase needs a migration that says where to continue', async () => {
    const out = await start(v1);
    await expect(runDispatch(v2, { engine: out.engine, players, event: { type: 'render' } })).rejects.toThrow(/does not exist/);
    const moved = await runDispatch(v2, { engine: out.engine, players, event: { type: 'migrate' } }, { migration: `async function migrate(g) { g.state.migrated = true; return 'b'; }` });
    expect(moved.engine.phase).toBe('b');
    expect(moved.engine.state.migrated).toBe(true);
    expect(texts(moved, ana)).toContain('OK v2');
  });
});

describe('static checks', () => {
  it('finds wrong API names and top-level variables', () => {
    const problems = checkProgramSource(`let x = 1;\ndefineGame({ start: 'a', phases: { a: show({ view: () => ui.headng('x'), next: (g) => g.end() }) } });`);
    expect(problems.join('\n')).toMatch(/must be const/);
    expect(problems.join('\n')).toMatch(/headng/);
  });

  it('describes a program', async () => {
    const info = await describeProgram(allPresetPrograms().find((p) => p.id === 'band-buzzer')!.code);
    expect(info.phases).toEqual({ buzz: 'buzzer', guess: 'turn', reveal: 'show' });
  });
});

describe('shapes', () => {
  it('turns shapes into schemas and checks replies', () => {
    expect(shapeToSchema({ a: ['Yes', 'No'], b: 'string[2]' })).toMatchObject({
      properties: { a: { enum: ['Yes', 'No'] }, b: { type: 'array', minItems: 2 } },
    });
    expect(coerce({ a: ['Yes', 'No'], n: 'number' }, { a: 'yes', n: '3' })).toEqual({ a: 'Yes', n: 3 });
    expect(() => coerce('string[4]', ['a'])).toThrow(/4 items/);
  });
});

describe('generator', () => {
  it('feeds check failures back to the model until the program passes', async () => {
    vi.resetModules();
    const replies = [
      { program: `defineGame({ start: 'a', phases: { a: show({ view: () => ui.headng('x'), next: (g) => g.end() }) } });` },
      { program: `defineGame({ start: 'a', phases: { a: show({ view: () => ui.heading('x'), next: (g) => g.end() }) } });` },
    ];
    const seen: string[] = [];
    vi.doMock('../../llm/client', () => ({
      llmConfig: () => ({ baseUrl: 'http://localhost', model: 'mock', protocol: 'json' }),
      chat: vi.fn(async (opts: { messages: Array<{ content: string | null }> }) => {
        seen.push(opts.messages[opts.messages.length - 1].content ?? '');
        const r = replies.shift()!;
        return { choices: [{ message: { content: JSON.stringify({ migration: '', summary: 's', assumptions: [], questions: '', ...r }) }, finish_reason: 'stop' }] };
      }),
    }));
    const { generateProgram } = await import('../generator');
    const result = await generateProgram('GAME: test', { min: 1, max: 2 });
    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(2);
    expect(seen[1]).toMatch(/headng/);
    vi.doUnmock('../../llm/client');
  }, 60_000);
});
