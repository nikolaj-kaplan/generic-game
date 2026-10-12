import { AiRequest, DispatchOutput, EnginePlayer, EngineState, GameEvent, ProgramError, runDispatch } from './sandbox';
import { asShape, fake } from './shape';
import type { UIComponent } from '../types';

// =============================================================================
// Bot test: play a program many times with random bots before anyone plays.
// Timers fire instantly and g.ai returns fake data of the right shape, so no
// model and no browser are involved. Finds crashes, games that never end,
// screens nobody can act on and phases that are never reached.
// =============================================================================

const NAMES = ['Ana', 'Bob', 'Cleo', 'Dev', 'Eli', 'Fay', 'Gus', 'Hana'];

export interface BotRun {
  players: number;
  finished: boolean;
  steps: number;
  error?: string;
  phases: string[];
  aiCalls: number;
}

export interface BotReport {
  ok: boolean;
  runs: BotRun[];
  /** Problems, worded for the program's author. */
  problems: string[];
  /** Phases no run ever reached. */
  unreached: string[];
  aiCallsByComplexity: Record<string, number>;
  ms: number;
}

function rng(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), s | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function fakeAi(rand: () => number, counts?: Record<string, number>) {
  return async (req: AiRequest): Promise<unknown> => {
    if (counts) counts[req.complexity] = (counts[req.complexity] ?? 0) + 1;
    switch (req.op) {
      case 'text':
        return `Mock text ${Math.floor(rand() * 1000)}`;
      case 'choose': {
        const options = req.options ?? ['Yes'];
        return options[Math.floor(rand() * options.length)];
      }
      case 'list': {
        const shape = asShape(req.schema ?? 'string');
        return Array.from({ length: Math.max(1, req.n ?? 1) }, (_, i) => fake(shape, rand, `Mock item ${i + 1}`));
      }
      default:
        return fake(asShape(req.schema ?? 'string'), rand);
    }
  };
}

const RANDOM_TEXT = ['Paris', 'blue', 'A very long answer that goes on for a while', 'pizza', '', 'Mock item 1', '42'];

/** A random input a player could send from this screen, or null if there is nothing to do. */
type PlayerInput = { kind: 'action' | 'submit'; id: string; values?: Record<string, string> };

function randomInput(screen: UIComponent[], rand: () => number): PlayerInput | null {
  const choices = screen.filter((c): c is Extract<UIComponent, { type: 'multiple_choice' }> => c.type === 'multiple_choice');
  if (choices.length) {
    const c = choices[0];
    return { kind: 'submit', id: c.fieldId, values: { [c.fieldId]: c.options[Math.floor(rand() * c.options.length)] } };
  }
  const inputs = screen.filter((c): c is Extract<UIComponent, { type: 'input' }> => c.type === 'input');
  const buttons = screen.filter((c): c is Extract<UIComponent, { type: 'button' }> => c.type === 'button');
  if (!buttons.length) return null;
  // Mostly the main (first) button, sometimes another one.
  const button = rand() < 0.7 ? buttons[0] : buttons[Math.floor(rand() * buttons.length)];
  if (!inputs.length) return { kind: 'action', id: button.actionId };
  const values: Record<string, string> = {};
  for (const i of inputs) values[i.fieldId] = RANDOM_TEXT[Math.floor(rand() * RANDOM_TEXT.length)];
  return { kind: 'submit', id: button.actionId, values };
}

function checkScreens(out: DispatchOutput, players: EnginePlayer[]): string | null {
  for (const p of players) {
    const screen = out.screens[p.id];
    if (!Array.isArray(screen)) return `No screen for ${p.name}.`;
    for (const c of screen) {
      if (c.type === 'text' && (typeof c.content !== 'string' || c.content.includes('undefined') || c.content.includes('[object Object]'))) {
        return `Phase "${out.engine.phase}" shows "${String(c.content).slice(0, 80)}" (undefined or an object in a text: check the data you show).`;
      }
      if (c.type === 'list' && c.items.some((i) => i.includes('undefined') || i.includes('[object Object]'))) {
        return `Phase "${out.engine.phase}" lists "${c.items.find((i) => i.includes('undefined') || i.includes('[object Object]'))}" (undefined or an object in a list).`;
      }
    }
  }
  if (!out.over && out.waiting) {
    for (const id of out.waiting.expected) {
      if (out.waiting.answered.includes(id)) continue;
      const screen = out.screens[id] ?? [];
      if (!screen.some((c) => c.type === 'button' || c.type === 'multiple_choice')) {
        return `In phase "${out.engine.phase}" the engine waits for ${players.find((p) => p.id === id)?.name}, but their screen has nothing to click.`;
      }
    }
  }
  return null;
}

/** Play one game with bots, starting fresh or from a saved engine state. */
export async function playOnce(
  program: string,
  players: EnginePlayer[],
  seed: number,
  options: { maxSteps?: number; from?: EngineState; aiCounts?: Record<string, number> } = {},
): Promise<BotRun> {
  const rand = rng(seed);
  const ai = fakeAi(rand, options.aiCounts);
  const phases = new Set<string>();
  const maxSteps = options.maxSteps ?? 400;
  let aiCalls = 0;
  const countingAi = async (req: AiRequest) => {
    aiCalls++;
    return ai(req);
  };
  const run: BotRun = { players: players.length, finished: false, steps: 0, phases: [], aiCalls: 0 };
  try {
    let out = await runDispatch(program, { engine: options.from ?? null, players, event: options.from ? { type: 'render' } : { type: 'start' }, seed }, { ai: countingAi });
    for (; run.steps < maxSteps; run.steps++) {
      if (out.engine.phase) phases.add(out.engine.phase);
      const bad = checkScreens(out, players);
      if (bad) throw new ProgramError(bad);
      if (out.over) {
        run.finished = true;
        break;
      }
      const waiting = (out.waiting?.expected ?? []).filter((id) => !out.waiting!.answered.includes(id));
      let event: GameEvent | null = null;
      // Sometimes let the timer run out instead of answering.
      if (out.timer && (waiting.length === 0 || rand() < 0.12)) {
        event = { type: 'timer', turn: out.timer.turn };
      } else if (waiting.length) {
        const who = waiting[Math.floor(rand() * waiting.length)];
        const input = randomInput(out.screens[who] ?? [], rand);
        if (input) event = { type: 'input', playerId: who, turn: out.engine.turn, input };
      }
      if (!event) {
        throw new ProgramError(`The game is stuck in phase "${out.engine.phase}": nobody can act and there is no timer.`);
      }
      out = await runDispatch(program, { engine: out.engine, players, event }, { ai: countingAi });
      if (out.result?.error && event.type === 'input') {
        // A bot sent something the screen did not accept; that is the bot's problem, unless it repeats.
        if (/not understood/.test(out.result.error)) continue;
      }
    }
    if (!run.finished) {
      throw new ProgramError(`The game did not end after ${maxSteps} player actions (stuck around phase "${out.engine.phase}", round ${out.engine.round}).`);
    }
  } catch (err) {
    run.error = err instanceof Error ? err.message : String(err);
  }
  run.phases = [...phases];
  run.aiCalls = aiCalls;
  return run;
}

export function botPlayers(n: number): EnginePlayer[] {
  return Array.from({ length: n }, (_, i) => ({ id: `bot-${i + 1}`, name: NAMES[i] ?? `Bot ${i + 1}`, isHost: i === 0 }));
}

/** Play `runs` games with player counts spread over the range. */
export async function botTest(
  program: string,
  range: { min: number; max: number },
  options: { runs?: number; phaseIds?: string[]; from?: EngineState; players?: EnginePlayer[] } = {},
): Promise<BotReport> {
  const t0 = Date.now();
  const runs: BotRun[] = [];
  const counts: Record<string, number> = {};
  const total = options.runs ?? 20;
  const lo = Math.max(1, range.min);
  const hi = Math.max(lo, Math.min(8, range.max));
  for (let i = 0; i < total; i++) {
    const n = lo + (i % (hi - lo + 1));
    const players = options.players ?? botPlayers(n);
    runs.push(await playOnce(program, players, 1000 + i * 7919, { from: options.from, aiCounts: counts }));
  }
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const r of runs) {
    if (r.error && !seen.has(r.error)) {
      seen.add(r.error);
      problems.push(`${r.error} (with ${r.players} player${r.players === 1 ? '' : 's'})`);
    }
  }
  const reached = new Set(runs.flatMap((r) => r.phases));
  const unreached = (options.phaseIds ?? []).filter((id) => !reached.has(id));
  return { ok: problems.length === 0, runs, problems, unreached, aiCallsByComplexity: counts, ms: Date.now() - t0 };
}
