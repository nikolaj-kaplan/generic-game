import fs from 'fs';
import path from 'path';
import { getQuickJS, QuickJSContext, QuickJSHandle, QuickJSRuntime, QuickJSWASMModule } from 'quickjs-emscripten';
import { PROJECT_ROOT } from '../paths';
import type { UIComponent } from '../types';

// =============================================================================
// Sandbox: runs a game program inside QuickJS (a JS interpreter compiled to
// WebAssembly). The program sees only the game runtime (runtime.js): no
// require, no process, no network, no file system. Every call gets a fresh
// runtime, so a program cannot keep data anywhere except g.state.
//
// Limits: CPU time per synchronous slice (an endless loop is stopped), memory
// and stack size. AI calls are the only way out, through __hostAi.
// =============================================================================

const RUNTIME_FILE = path.join(PROJECT_ROOT, 'server', 'src', 'engine', 'guest', 'runtime.js');
const MEMORY_LIMIT = 64 * 1024 * 1024;
const STACK_LIMIT = 1024 * 1024;
/** Longest stretch of program code allowed without returning (ms). */
const SLICE_MS = Number(process.env.GAME_CPU_SLICE_MS ?? 250);
/** Longest a whole event may take, AI calls included. */
const EVENT_TIMEOUT_MS = 10 * 60_000;

let runtimeSource: string | undefined;
let quickjs: Promise<QuickJSWASMModule> | undefined;

function runtimeCode(): string {
  if (!runtimeSource) runtimeSource = fs.readFileSync(RUNTIME_FILE, 'utf-8');
  return runtimeSource;
}

// ─── Types shared with the guest runtime ─────────────────────────────────────

export interface EnginePlayer {
  id: string;
  name: string;
  isHost: boolean;
}

/** Engine state owned by the guest; the host stores it as opaque JSON. */
export interface EngineState {
  v: number;
  phase: string | null;
  round: number;
  rounds: number | null;
  turn: number;
  state: Record<string, unknown>;
  scores: Record<string, number>;
  answers: Record<string, Record<string, Record<string, unknown>>>;
  cur: {
    expected: string[];
    responses: Record<string, boolean>;
    endsAt?: number;
    seconds?: number;
    [key: string]: unknown;
  } | null;
  over: { message: string; winners: string[] } | null;
  rng: number;
  log: string[];
}

export type GameEvent =
  | { type: 'start' }
  | { type: 'input'; playerId: string; turn?: number; input: { kind: 'action' | 'submit'; id: string; values?: Record<string, string> } }
  | { type: 'timer'; turn: number }
  | { type: 'render' }
  | { type: 'migrate' };

export interface DispatchInput {
  engine: EngineState | null;
  players: EnginePlayer[];
  event: GameEvent;
  seed?: number;
}

export interface DispatchOutput {
  engine: EngineState;
  screens: Record<string, UIComponent[]>;
  result: { error?: string; ignored?: string };
  timer: { turn: number; endsAt: number } | null;
  waiting: { kind: string | null; expected: string[]; answered: string[] } | null;
  over: { message: string; winners: string[] } | null;
}

export interface ProgramInfo {
  start: string;
  rounds: number | null;
  players: { min?: number; max?: number } | null;
  phases: Record<string, string>;
  scoreboard: string;
}

/** What a program asks for through g.ai.* */
export interface AiRequest {
  op: 'text' | 'json' | 'list' | 'choose';
  prompt: string;
  complexity: number;
  schema?: unknown;
  n?: number;
  options?: string[];
}

export type AiHandler = (request: AiRequest) => Promise<unknown>;

export class ProgramError extends Error {
  constructor(message: string, readonly stack_?: string) {
    super(message);
  }
}

// ─── Running code ────────────────────────────────────────────────────────────

/** Programs may be written as `export default defineGame(...)`; the sandbox runs scripts. */
export function prepareProgram(code: string): string {
  return code.replace(/^\s*export\s+default\s+/m, '').replace(/^\s*export\s+(const|function|async function)\s/gm, '$1 ');
}

interface Box {
  rt: QuickJSRuntime;
  ctx: QuickJSContext;
  deadline: number;
  pending: Set<Promise<unknown>>;
}

async function newBox(ai: AiHandler | undefined): Promise<Box> {
  if (!quickjs) quickjs = getQuickJS();
  const module = await quickjs;
  const rt = module.newRuntime();
  rt.setMemoryLimit(MEMORY_LIMIT);
  rt.setMaxStackSize(STACK_LIMIT);
  const box: Box = { rt, ctx: rt.newContext(), deadline: Date.now() + SLICE_MS, pending: new Set() };
  rt.setInterruptHandler(() => Date.now() > box.deadline);

  const { ctx } = box;
  const hostAi = ctx.newFunction('__hostAi', (reqHandle) => {
    const request = JSON.parse(ctx.getString(reqHandle)) as AiRequest;
    const deferred = ctx.newPromise();
    const work = (async () => {
      try {
        if (!ai) throw new Error('AI calls are not available here.');
        const value = await ai(request);
        if (!ctx.alive) return;
        const handle = ctx.newString(JSON.stringify(value ?? null));
        deferred.resolve(handle);
        handle.dispose();
      } catch (err) {
        if (!ctx.alive) return;
        const handle = ctx.newError(err instanceof Error ? err.message : String(err));
        deferred.reject(handle);
        handle.dispose();
      }
      box.deadline = Date.now() + SLICE_MS;
      rt.executePendingJobs();
    })();
    box.pending.add(work);
    void work.finally(() => box.pending.delete(work));
    return deferred.handle;
  });
  ctx.setProp(ctx.global, '__hostAi', hostAi);
  hostAi.dispose();
  return box;
}

function disposeBox(box: Box): void {
  try {
    box.ctx.dispose();
    box.rt.dispose();
  } catch {
    // An AI call may still hold a handle; the runtime is garbage either way.
  }
}

function errorText(ctx: QuickJSContext, handle: QuickJSHandle): ProgramError {
  const dumped = ctx.dump(handle) as unknown;
  if (dumped && typeof dumped === 'object') {
    const e = dumped as { name?: string; message?: string; stack?: string };
    const base = e.message === 'interrupted'
      ? `The program ran for more than ${SLICE_MS} ms without stopping (an endless loop?).`
      : `${e.name && e.name !== 'Error' ? `${e.name}: ` : ''}${e.message ?? JSON.stringify(dumped)}`;
    // Where in the game program it happened, so the author (often a model) can find it.
    const at = /at ([^\s(]+)? ?\(?game\.js:(\d+)/.exec(e.stack ?? '');
    const message = at ? `${base} (game.js line ${at[2]}${at[1] && at[1] !== '<anonymous>' ? `, in ${at[1]}` : ''})` : base;
    return new ProgramError(message, e.stack);
  }
  return new ProgramError(String(dumped));
}

function evalOrThrow(box: Box, code: string, filename: string): QuickJSHandle {
  box.deadline = Date.now() + SLICE_MS;
  const result = box.ctx.evalCode(code, filename);
  if (result.error) {
    const err = errorText(box.ctx, result.error);
    result.error.dispose();
    throw err;
  }
  return result.value;
}

async function loadProgram(box: Box, program: string): Promise<void> {
  evalOrThrow(box, runtimeCode(), 'runtime.js').dispose();
  evalOrThrow(box, prepareProgram(program), 'game.js').dispose();
}

async function awaitPromise(box: Box, handle: QuickJSHandle): Promise<string> {
  const { ctx, rt } = box;
  const settled = ctx.resolvePromise(handle);
  handle.dispose();
  box.deadline = Date.now() + SLICE_MS;
  rt.executePendingJobs();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ProgramError('The event took longer than 10 minutes.')), EVENT_TIMEOUT_MS);
  });
  try {
    const result = await Promise.race([settled, timeout]);
    if (result.error) {
      const err = errorText(ctx, result.error);
      result.error.dispose();
      throw err;
    }
    const text = ctx.getString(result.value);
    result.value.dispose();
    return text;
  } finally {
    clearTimeout(timer);
  }
}

/** Load the program and describe its phases (also catches syntax errors). */
export async function describeProgram(program: string): Promise<ProgramInfo> {
  const box = await newBox(undefined);
  try {
    await loadProgram(box, program);
    const handle = evalOrThrow(box, '__engine.describe()', 'describe.js');
    const text = box.ctx.getString(handle);
    handle.dispose();
    return JSON.parse(text) as ProgramInfo;
  } finally {
    disposeBox(box);
  }
}

/**
 * Run one event through the program. `migration` is optional code that
 * defines `async function migrate(g)`, run once for a 'migrate' event.
 */
export async function runDispatch(
  program: string,
  input: DispatchInput,
  options: { ai?: AiHandler; migration?: string } = {},
): Promise<DispatchOutput> {
  const box = await newBox(options.ai);
  try {
    await loadProgram(box, program);
    if (options.migration) {
      evalOrThrow(box, `${prepareProgram(options.migration)}\n;globalThis.__migrate = typeof migrate === 'function' ? migrate : undefined;`, 'migration.js').dispose();
    }
    const arg = box.ctx.newString(JSON.stringify(input));
    box.ctx.setProp(box.ctx.global, '__input', arg);
    arg.dispose();
    const promise = evalOrThrow(box, '__engine.dispatch(__input)', 'dispatch.js');
    const text = await awaitPromise(box, promise);
    return JSON.parse(text) as DispatchOutput;
  } finally {
    // Late AI replies for an abandoned event are dropped.
    disposeBox(box);
  }
}
