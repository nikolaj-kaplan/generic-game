import path from 'path';
import { v4 as uuid } from 'uuid';
import { dataDir } from '../paths';
import * as store from '../store';
import * as connStore from '../connection-store';
import { enqueue } from '../llm/orchestrator';
import { llmConfig } from '../llm/client';
import { newLogDirName, writeMetrics } from '../llm/logger';
import type { ChatMessage, GameMetrics, Session, UIComponent } from '../types';
import { performAiRequest } from './ai';
import { generateProgram, patchProgram, checkProgram } from './generator';
import { AiRequest, DispatchOutput, EnginePlayer, EngineState, GameEvent, ProgramError, runDispatch } from './sandbox';
import { routingSummary } from './models';

// =============================================================================
// Engine host: runs a session's game program. The program decides everything
// about the game; this module only moves events in and screens out:
//   player input / timer → sandboxed program → new engine state + screens
// It also starts timers, shows who is still answering, pauses the game while
// the host changes it, and asks the generator for programs and patches.
// All work for one session runs through the same queue as the definition chat.
// =============================================================================

export const engineMode = (): 'program' | 'legacy' => (process.env.GAME_ENGINE === 'legacy' ? 'legacy' : 'program');

const timers = new Map<string, ReturnType<typeof setTimeout>>();
/** Bumped on reset: late results of an old game are dropped. */
const epochs = new Map<string, number>();
const generating = new Set<string>();
const patching = new Set<string>();
const aiInFlight = new Map<string, number>();
/** What each player was last sent, to skip unchanged screens. */
const lastSent = new Map<string, Map<string, string>>();

const epochOf = (id: string) => epochs.get(id) ?? 0;
const tag = (s: Session) => `[game:${s.joinCode}]`;

function players(session: Session): EnginePlayer[] {
  return session.players.map((p) => ({ id: p.id, name: p.name, isHost: p.isHost }));
}

function engineOf(session: Session): EngineState | null {
  return (session.engine as EngineState | undefined) ?? null;
}

function systemMessage(session: Session, content: string): void {
  const msg: ChatMessage = { id: uuid(), role: 'system', content, timestamp: new Date().toISOString() };
  session.chatHistory.push(msg);
  connStore.broadcast(session.id, { type: 'chat_message', message: msg });
}

function metricsOf(session: Session): GameMetrics {
  if (!session.metrics) {
    session.metrics = {
      model: routingSummary(),
      startedAt: new Date().toISOString(),
      llmCalls: 0,
      llmMs: 0,
      turns: 0,
      invalidCalls: 0,
      textReplies: 0,
      stalls: 0,
      httpErrors: 0,
      promptTokensMax: 0,
      finished: false,
      engine: 'program',
      aiCallsByComplexity: {},
      events: 0,
      eventMs: 0,
      patches: 0,
    };
  }
  return session.metrics;
}

/** Rules plus accepted changes: what the program must implement. */
function effectiveRules(session: Session): string {
  const adj = session.adjustments ?? [];
  return adj.length ? `${session.agreedRules ?? ''}\n\nCHANGES DURING THE GAME (a later one wins):\n${adj.map((a, i) => `${i + 1}. ${a}`).join('\n')}` : session.agreedRules ?? '';
}

function rangeOf(session: Session): { min: number; max: number } {
  return session.playerRange ?? { min: 1, max: 8 };
}

// ─── Timers ──────────────────────────────────────────────────────────────────

function clearTimer(sessionId: string): void {
  const t = timers.get(sessionId);
  if (t) clearTimeout(t);
  timers.delete(sessionId);
}

function armTimer(session: Session, timer: { turn: number; endsAt: number } | null): void {
  clearTimer(session.id);
  if (!timer || session.paused) return;
  const epoch = epochOf(session.id);
  const handle = setTimeout(() => {
    timers.delete(session.id);
    void enqueue(session.id, async () => {
      const s = store.getSession(session.id);
      if (!s || epoch !== epochOf(s.id) || s.status !== 'playing' || s.paused) return;
      connStore.broadcast(s.id, { type: 'timer_expired', timerId: `t${timer.turn}` });
      await dispatch(s, { type: 'timer', turn: timer.turn });
    });
  }, Math.max(0, timer.endsAt - Date.now()));
  timers.set(session.id, handle);
}

// ─── Running events ──────────────────────────────────────────────────────────

function aiFor(session: Session) {
  return async (request: AiRequest): Promise<unknown> => {
    const n = (aiInFlight.get(session.id) ?? 0) + 1;
    aiInFlight.set(session.id, n);
    if (n === 1) connStore.broadcast(session.id, { type: 'ai_thinking', thinking: true });
    const metrics = metricsOf(session);
    console.log(`${tag(session)} g.ai.${request.op} (complexity ${request.complexity}): ${request.prompt.slice(0, 100)}`);
    try {
      return await performAiRequest(request, {
        rules: effectiveRules(session),
        logDir: session.logDir,
        onCall: (complexity, ms) => {
          metrics.llmCalls++;
          metrics.llmMs += ms;
          const by = (metrics.aiCallsByComplexity ??= {});
          by[complexity] = (by[complexity] ?? 0) + 1;
        },
      });
    } finally {
      const left = (aiInFlight.get(session.id) ?? 1) - 1;
      aiInFlight.set(session.id, left);
      if (left === 0) connStore.broadcast(session.id, { type: 'ai_thinking', thinking: false });
    }
  };
}

function describe(ui: UIComponent[]): string {
  return ui
    .map((c) => (c.type === 'text' ? JSON.stringify(c.content.slice(0, 50)) : c.type === 'multiple_choice' ? `choice[${c.options.length}]` : c.type === 'button' ? `[${c.label}]` : c.type))
    .join(' | ');
}

/** Run one event through the program and show the result. */
async function dispatch(session: Session, event: GameEvent, options: { program?: string; migration?: string } = {}): Promise<DispatchOutput | null> {
  if (!session.program) return null;
  const epoch = epochOf(session.id);
  const metrics = metricsOf(session);
  const t0 = Date.now();
  let out: DispatchOutput;
  try {
    out = await runDispatch(
      options.program ?? session.program.code,
      { engine: event.type === 'start' ? null : engineOf(session), players: players(session), event, seed: Math.floor(Math.random() * 2 ** 31) },
      { ai: aiFor(session), migration: options.migration },
    );
  } catch (err) {
    if (epoch !== epochOf(session.id)) return null;
    if (options.program) throw err; // a patch being applied: the caller keeps the old program
    crashed(session, event, err);
    return null;
  } finally {
    metrics.events = (metrics.events ?? 0) + 1;
    metrics.eventMs = (metrics.eventMs ?? 0) + (Date.now() - t0);
  }
  if (epoch !== epochOf(session.id) || (session.status !== 'playing' && session.status !== 'finished')) return null;
  if (session.failedEvent) {
    session.failedEvent = undefined;
    session.stalled = undefined;
    connStore.broadcast(session.id, { type: 'game_error', message: null });
  }
  show(session, out, event);
  return out;
}

function crashed(session: Session, event: GameEvent, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  const metrics = metricsOf(session);
  metrics.stalls++;
  session.failedEvent = event;
  session.stalled = message;
  console.error(`${tag(session)} Program error on ${event.type}: ${message}`);
  if (err instanceof ProgramError && err.stack_) console.error(err.stack_);
  connStore.broadcast(session.id, {
    type: 'game_error',
    message: `The game hit a problem: ${message.slice(0, 300)}. Press Retry, or the host can use Adjust to describe a fix.`,
  });
  store.saveSession(session);
}

/** Send changed screens, who we wait for, the timer and the end of the game. */
function show(session: Session, out: DispatchOutput, event: GameEvent): void {
  const before = engineOf(session);
  const answeredBefore = new Set(before?.cur?.responses ? Object.keys(before.cur.responses) : []);
  session.engine = out.engine as unknown as Record<string, unknown>;
  const metrics = metricsOf(session);
  metrics.turns = out.engine.turn;

  if (out.result?.error && event.type === 'input') {
    connStore.sendToPlayer(session.id, event.playerId, { type: 'error', message: out.result.error });
  }

  const sent = lastSent.get(session.id) ?? new Map<string, string>();
  lastSent.set(session.id, sent);
  const turn = out.engine.turn;
  session.playerUi = {};
  for (const p of session.players) {
    const ui = out.screens[p.id] ?? [];
    session.playerUi[p.id] = ui;
    const key = `${turn}:${JSON.stringify(ui)}`;
    if (sent.get(p.id) === key) continue;
    sent.set(p.id, key);
    connStore.sendToPlayer(session.id, p.id, { type: 'ui_update', ui, turn });
  }
  if (before?.turn !== turn) {
    console.log(`${tag(session)} ${out.over ? 'Game over' : `Phase "${out.engine.phase}" round ${out.engine.round}`} (turn ${turn})`);
    const first = session.players[0];
    if (first && !out.over) console.log(`${tag(session)}   ${first.name}: ${describe(out.screens[first.id] ?? [])}`);
  }

  // "Ana answered ✓" for the others, while a collect phase waits for everyone.
  if (out.waiting && before?.turn === turn && event.type === 'input') {
    for (const id of out.waiting.answered) {
      if (answeredBefore.has(id)) continue;
      const name = session.players.find((p) => p.id === id)?.name ?? 'Someone';
      for (const other of session.players) {
        if (other.id !== id) connStore.sendToPlayer(session.id, other.id, { type: 'toast', text: `${name} answered ✓` });
      }
    }
  }
  broadcastWaiting(session, out);

  if (out.over) {
    clearTimer(session.id);
    if (session.status !== 'finished') {
      session.status = 'finished';
      metrics.finished = true;
      connStore.broadcast(session.id, { type: 'status_change', status: 'finished', message: out.over.message });
      console.log(`${tag(session)} ${out.over.message}`);
    }
  } else {
    if (session.status === 'finished') {
      session.status = 'playing';
      metrics.finished = false;
      connStore.broadcast(session.id, { type: 'status_change', status: 'playing' });
    }
    armTimer(session, out.timer);
  }
  store.saveSession(session);
  writeMetrics(session.logDir, metrics);
}

function broadcastWaiting(session: Session, out: { waiting: DispatchOutput['waiting']; engine: EngineState } | null): void {
  const w = out?.waiting;
  if (!w || w.kind !== 'collect' || w.expected.length < 2) {
    connStore.broadcast(session.id, { type: 'turn_status', status: null });
    return;
  }
  const nameOf = (id: string) => session.players.find((p) => p.id === id)?.name ?? id;
  connStore.broadcast(session.id, {
    type: 'turn_status',
    status: { turn: out!.engine.turn, waitingFor: w.expected.filter((id) => !w.answered.includes(id)).map(nameOf), answered: w.answered.map(nameOf) },
  });
}

// ─── Starting a game ─────────────────────────────────────────────────────────

/** Host confirmed the rules: reuse the program if the rules did not change, else write one. */
export function confirmRules(sessionId: string): Promise<void> {
  return enqueue(sessionId, async () => {
    const session = store.getSession(sessionId);
    if (!session?.agreedRules || session.status !== 'defining') return;
    if (generating.has(sessionId)) {
      connStore.broadcast(sessionId, { type: 'toast', text: 'The game program is still being written…' });
      return;
    }
    if (session.program && session.program.rules === session.agreedRules) {
      await startGame(session);
      return;
    }
    void buildAndStart(sessionId);
  });
}

async function buildAndStart(sessionId: string): Promise<void> {
  const session = store.getSession(sessionId);
  if (!session?.agreedRules) return;
  const rules = session.agreedRules;
  const epoch = epochOf(sessionId);
  generating.add(sessionId);
  const logDir = newLogDirName(session.joinCode, 'build');
  console.log(`[build:${session.joinCode}] Writing a program for the rules (logs: ${path.join(dataDir(), 'llm-logs', logDir)})`);
  systemMessage(session, '🛠️ Building the game: the AI writes a program for these rules, then bots test it.');
  connStore.broadcast(sessionId, { type: 'ai_thinking', thinking: true });
  let lastProgress = '';
  try {
    const result = await generateProgram(rules, session.playerRange, {
      logDir,
      onProgress: (m) => {
        if (m === lastProgress) return;
        lastProgress = m;
        console.log(`[build:${session.joinCode}] ${m}`);
        connStore.broadcast(sessionId, { type: 'toast', text: m });
      },
    });
    await enqueue(sessionId, async () => {
      const s = store.getSession(sessionId);
      if (!s || epoch !== epochOf(sessionId) || s.status !== 'defining') return;
      if (s.agreedRules !== rules) {
        systemMessage(s, 'The rules changed while the program was being written. Press Start game again.');
        return;
      }
      if (result.questions) {
        askBack(s, result.questions);
        return;
      }
      if (!result.ok || !result.program) {
        console.warn(`[build:${s.joinCode}] Failed after ${result.attempts} attempt(s): ${result.problems.join(' | ')}`);
        systemMessage(
          s,
          `⚠️ The AI could not write a working program (${result.attempts} attempt${result.attempts === 1 ? '' : 's'}).\n\n${result.problems.slice(0, 4).map((p) => `- ${p.slice(0, 200)}`).join('\n')}\n\n*Press Start game to try again, or describe the game differently.*`,
        );
        store.saveSession(s);
        return;
      }
      const bots = result.bots;
      console.log(`[build:${s.joinCode}] Program ready in ${Math.round(result.ms / 1000)} s, ${result.attempts} attempt(s), ${bots?.runs.length ?? 0} bot games passed`);
      s.program = {
        code: result.program,
        version: 1,
        rules,
        summary: result.summary,
        assumptions: result.assumptions,
        model: result.model,
        createdAt: new Date().toISOString(),
      };
      s.programHistory = [];
      const assumptions = result.assumptions.length ? `\n\nWhere the rules were open, the AI decided:\n${result.assumptions.map((a) => `- ${a}`).join('\n')}` : '';
      systemMessage(s, `✅ Game ready (${bots?.runs.length ?? 0} test games played by bots).${assumptions}`);
      const host = s.players.find((p) => p.isHost);
      if (host) connStore.sendToPlayer(s.id, host.id, { type: 'program_ready', program: { code: result.program, rules } });
      await startGame(s);
    });
  } catch (err) {
    const s = store.getSession(sessionId);
    if (s) systemMessage(s, `⚠️ Building the game failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    generating.delete(sessionId);
    connStore.broadcast(sessionId, { type: 'ai_thinking', thinking: false });
  }
}

/** The generator asked instead of writing: the questions go to the definition chat. */
function askBack(session: Session, questions: string): void {
  const text = `Before I can build this game I need to know:\n\n${questions}`;
  const msg: ChatMessage = { id: uuid(), role: 'ai', content: text, timestamp: new Date().toISOString() };
  session.chatHistory.push(msg);
  connStore.broadcast(session.id, { type: 'chat_message', message: msg });
  const jsonMode = llmConfig().protocol === 'json';
  session.definitionLlmMessages.push({
    role: 'assistant',
    content: jsonMode ? JSON.stringify({ message: text, proposed_rules: '', min_players: 0, max_players: 0 }) : text,
  });
  store.saveSession(session);
}

async function startGame(session: Session): Promise<void> {
  clearTimer(session.id);
  epochs.set(session.id, epochOf(session.id) + 1);
  lastSent.delete(session.id);
  session.status = 'playing';
  session.engine = undefined;
  session.adjustments = [];
  session.paused = undefined;
  session.pendingPatch = undefined;
  session.failedEvent = undefined;
  session.stalled = undefined;
  session.playerUi = {};
  session.logDir = newLogDirName(session.joinCode, 'play');
  session.metrics = undefined;
  metricsOf(session).programVersion = session.program?.version;
  console.log(`[start:${session.joinCode}] Starting program v${session.program?.version} (logs: ${path.join(dataDir(), 'llm-logs', session.logDir)})`);
  connStore.broadcast(session.id, { type: 'status_change', status: 'playing', agreedRules: session.agreedRules });
  const loading: UIComponent[] = [{ type: 'text', content: 'Getting the game ready…', style: 'muted' }];
  for (const p of session.players) connStore.sendToPlayer(session.id, p.id, { type: 'ui_update', ui: loading });
  await dispatch(session, { type: 'start' });
}

/** Saved rules came with their program: check it still works with this engine, then keep it. */
export async function adoptSavedProgram(session: Session, code: string, rules: string): Promise<boolean> {
  const check = await checkProgram(code, rangeOf(session), { runs: 8 });
  if (!check.ok) {
    console.warn(`[define:${session.joinCode}] Saved program failed its checks, a new one will be written: ${check.problems[0]}`);
    return false;
  }
  session.program = { code, version: 1, rules, createdAt: new Date().toISOString() };
  session.programHistory = [];
  return true;
}

// ─── Player input, retry, reconnect ──────────────────────────────────────────

export function handleInput(
  sessionId: string,
  playerId: string,
  input: { kind: 'action' | 'submit'; id: string; values?: Record<string, string>; turn?: number },
): Promise<void> {
  return enqueue(sessionId, async () => {
    const session = store.getSession(sessionId);
    if (!session || session.status !== 'playing' || !session.engine) return;
    if (session.paused) {
      connStore.sendToPlayer(sessionId, playerId, { type: 'error', message: 'The game is paused while the host changes it.' });
      return;
    }
    if (session.failedEvent) {
      connStore.sendToPlayer(sessionId, playerId, { type: 'error', message: 'The game hit a problem. Press Retry to continue.' });
      return;
    }
    const { turn, ...rest } = input;
    await dispatch(session, { type: 'input', playerId, turn, input: rest });
  });
}

export function retry(sessionId: string, requestedBy: string): Promise<void> {
  return enqueue(sessionId, async () => {
    const session = store.getSession(sessionId);
    if (!session || session.status !== 'playing') return;
    console.log(`${tag(session)} ${requestedBy} pressed Retry`);
    const event = session.failedEvent ?? (session.engine ? { type: 'render' as const } : { type: 'start' as const });
    await dispatch(session, event);
  });
}

export function resendState(session: Session, playerId: string): void {
  connStore.sendToPlayer(session.id, playerId, { type: 'ai_thinking', thinking: (aiInFlight.get(session.id) ?? 0) > 0 || generating.has(session.id) });
  if (session.status !== 'playing' && session.status !== 'finished') return;
  const engine = engineOf(session);
  const ui = session.playerUi[playerId];
  if (ui) {
    lastSent.get(session.id)?.set(playerId, `${engine?.turn}:${JSON.stringify(ui)}`);
    connStore.sendToPlayer(session.id, playerId, { type: 'ui_update', ui, turn: engine?.turn });
  } else if (engine) {
    // A player who joined mid-game: draw their screen.
    void enqueue(session.id, async () => {
      const s = store.getSession(session.id);
      if (s?.engine && !s.failedEvent) await dispatch(s, { type: 'render' });
    });
  }
  if (session.paused) connStore.sendToPlayer(session.id, playerId, { type: 'paused', message: session.paused.message });
  if (session.stalled) {
    connStore.sendToPlayer(session.id, playerId, { type: 'game_error', message: `The game hit a problem: ${session.stalled.slice(0, 300)}. Press Retry, or the host can use Adjust to describe a fix.` });
  }
  const host = session.players.find((p) => p.isHost);
  if (session.pendingPatch && host?.id === playerId) {
    const { id, request, summary, assumptions } = session.pendingPatch;
    connStore.sendToPlayer(session.id, playerId, { type: 'patch_proposal', proposal: { id, request, summary, assumptions } });
  }
  if (engine) {
    const w = engine.cur ? { kind: null as string | null, expected: engine.cur.expected, answered: Object.keys(engine.cur.responses) } : null;
    // The phase kind is not stored; a collect phase is the only one with several players expected.
    if (w && w.expected.length > 1) w.kind = 'collect';
    broadcastWaiting(session, { waiting: w, engine });
  }
}

// ─── Mid-game changes ────────────────────────────────────────────────────────

function pause(session: Session, message: string): void {
  const engine = engineOf(session);
  clearTimer(session.id);
  const remainingMs = engine?.cur?.endsAt ? Math.max(1000, engine.cur.endsAt - Date.now()) : undefined;
  session.paused = { message, remainingMs };
  connStore.broadcast(session.id, { type: 'paused', message });
  store.saveSession(session);
}

/** Resume after a pause; the timer gets back the time it had left. */
async function resume(session: Session, options: { program?: string; migration?: string } = {}): Promise<void> {
  const engine = engineOf(session);
  if (engine?.cur?.endsAt && session.paused?.remainingMs) engine.cur.endsAt = Date.now() + session.paused.remainingMs;
  session.paused = undefined;
  connStore.broadcast(session.id, { type: 'paused', message: null });
  if (options.program) {
    await dispatch(session, options.migration ? { type: 'migrate' } : { type: 'render' }, options);
  } else if (engine && !session.failedEvent) {
    await dispatch(session, { type: 'render' });
  }
}

/** Host asks for a change: pause, let the best model patch the program, then ask the host to approve. */
export function requestChange(sessionId: string, hostName: string, request: string): Promise<void> {
  return enqueue(sessionId, async () => {
    const session = store.getSession(sessionId);
    if (!session?.program || (session.status !== 'playing' && session.status !== 'finished')) return;
    const host = session.players.find((p) => p.isHost);
    if (patching.has(sessionId) || session.pendingPatch) {
      if (host) connStore.sendToPlayer(sessionId, host.id, { type: 'error', message: 'A change is already being prepared.' });
      return;
    }
    console.log(`${tag(session)} ${hostName} asks for a change: ${request}`);
    pause(session, `⏸ ${hostName} is changing the game…`);
    patching.add(sessionId);
    const epoch = epochOf(sessionId);
    const input = {
      rules: session.agreedRules ?? '',
      adjustments: session.adjustments ?? [],
      program: session.program.code,
      engine: engineOf(session),
      players: players(session),
      request,
      error: session.stalled,
      range: rangeOf(session),
    };
    void (async () => {
      let result;
      try {
        result = await patchProgram(input, {
          logDir: session.logDir,
          onProgress: (m) => host && connStore.sendToPlayer(sessionId, host.id, { type: 'toast', text: m }),
        });
      } catch (err) {
        result = { ok: false, problems: [err instanceof Error ? err.message : String(err)], assumptions: [] } as unknown as Awaited<ReturnType<typeof patchProgram>>;
      } finally {
        patching.delete(sessionId);
      }
      await enqueue(sessionId, async () => {
        const s = store.getSession(sessionId);
        if (!s || epoch !== epochOf(sessionId)) return;
        const h = s.players.find((p) => p.isHost);
        if (result.questions) {
          if (h) connStore.sendToPlayer(sessionId, h.id, { type: 'error', message: `The AI needs more detail: ${result.questions}` });
          await resume(s);
          return;
        }
        if (!result.ok || !result.program) {
          console.warn(`${tag(s)} Change failed: ${result.problems.join(' | ')}`);
          if (h) connStore.sendToPlayer(sessionId, h.id, { type: 'error', message: `That change could not be made: ${(result.problems[0] ?? 'unknown problem').slice(0, 200)}` });
          await resume(s);
          return;
        }
        s.pendingPatch = {
          id: uuid(),
          request,
          summary: result.summary || request,
          assumptions: result.assumptions,
          code: result.program,
          migration: result.migration,
          model: result.model,
        };
        store.saveSession(s);
        console.log(`${tag(s)} Change ready for approval: ${s.pendingPatch.summary}`);
        if (h) {
          const { id, summary, assumptions } = s.pendingPatch;
          connStore.sendToPlayer(sessionId, h.id, { type: 'patch_proposal', proposal: { id, request, summary, assumptions } });
        }
      });
    })();
  });
}

export function decidePatch(sessionId: string, id: string, apply: boolean): Promise<void> {
  return enqueue(sessionId, async () => {
    const session = store.getSession(sessionId);
    const patch = session?.pendingPatch;
    if (!session || !patch || patch.id !== id) return;
    session.pendingPatch = undefined;
    connStore.broadcast(sessionId, { type: 'patch_proposal', proposal: null });
    if (!apply) {
      console.log(`${tag(session)} Change rejected by the host`);
      await resume(session);
      return;
    }
    const old = session.program!;
    try {
      const failed = session.failedEvent;
      session.failedEvent = undefined;
      await resume(session, { program: patch.code, migration: patch.migration });
      // The crashed event (if any) runs again under the fixed program.
      session.program = {
        code: patch.code,
        version: old.version + 1,
        rules: old.rules,
        summary: patch.summary,
        assumptions: patch.assumptions,
        model: patch.model,
        request: patch.request,
        createdAt: new Date().toISOString(),
      };
      session.programHistory = [...(session.programHistory ?? []), old];
      session.adjustments = [...(session.adjustments ?? []), patch.request];
      const metrics = metricsOf(session);
      metrics.patches = (metrics.patches ?? 0) + 1;
      metrics.programVersion = session.program.version;
      if (failed && failed.type !== 'start') {
        session.stalled = undefined;
        connStore.broadcast(sessionId, { type: 'game_error', message: null });
        if (failed.type === 'timer') await dispatch(session, failed);
      }
      connStore.broadcast(sessionId, { type: 'toast', text: `Game changed: ${patch.summary}` });
      console.log(`${tag(session)} Program v${session.program.version} applied: ${patch.summary}`);
      store.saveSession(session);
    } catch (err) {
      session.program = old;
      const h = session.players.find((p) => p.isHost);
      if (h) connStore.sendToPlayer(sessionId, h.id, { type: 'error', message: `The change failed on the running game: ${err instanceof Error ? err.message : String(err)}` });
      await resume(session);
    }
  });
}

// ─── Resets and restarts ─────────────────────────────────────────────────────

/** Stop timers and drop late results (resets). The program is kept for "play again". */
export function cancel(sessionId: string): void {
  clearTimer(sessionId);
  epochs.set(sessionId, epochOf(sessionId) + 1);
  lastSent.delete(sessionId);
  const session = store.getSession(sessionId);
  if (session) {
    session.engine = undefined;
    session.paused = undefined;
    session.pendingPatch = undefined;
    session.failedEvent = undefined;
    session.stalled = undefined;
  }
}

/** After a server restart: re-arm timers and lift pauses (a patch in progress is lost). */
export function recoverGames(sessions: Session[]): void {
  for (const session of sessions) {
    if (!session.program || session.status !== 'playing') continue;
    const engine = engineOf(session);
    if (session.paused) {
      if (engine?.cur?.endsAt && session.paused.remainingMs) engine.cur.endsAt = Date.now() + session.paused.remainingMs;
      session.paused = undefined;
    }
    session.pendingPatch = undefined;
    if (!engine) {
      session.failedEvent = { type: 'start' };
      session.stalled = 'interrupted by a server restart';
    } else if (engine.cur?.endsAt && !engine.over) {
      armTimer(session, { turn: engine.turn, endsAt: engine.cur.endsAt });
    }
    store.saveSession(session);
    console.log(`[game:${session.joinCode}] Recovered after restart (phase ${engine?.phase ?? 'not started'})`);
  }
}

export function isBusy(sessionId: string): boolean {
  return generating.has(sessionId) || patching.has(sessionId) || (aiInFlight.get(sessionId) ?? 0) > 0;
}
