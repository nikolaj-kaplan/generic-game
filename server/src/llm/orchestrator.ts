import path from 'path';
import { v4 as uuid } from 'uuid';
import { dataDir } from '../paths';
import * as store from '../store';
import * as connStore from '../connection-store';
import { chat, llmConfig, ChatOptions } from './client';
import { definitionPrompt, playingPrompt } from './prompts';
import { definitionTools, definitionResponseSchema, gameToolsFor, nextTurnSchema } from './tools';
import { newLogDirName, writeMetrics } from './logger';
import {
  ParsedTurn,
  applyStateUpdate,
  expectedResponders,
  formatTurnEvent,
  mergeConsecutiveUserMessages,
  parseArguments,
  parseNextTurn,
  screenFor,
  trimHistory,
  tryParsePseudoNextTurn,
  isInteractive,
  extractJsonObject,
  answerKeysFor,
  sameAnswer,
} from './turn';
import { GamePlan, Progress, progressLine, recordAnswers } from './plan';
import {
  Session,
  ChatMessage,
  LLMMessage,
  LLMToolCall,
  UIComponent,
  PlayerResponse,
  GameMetrics,
  LLMResponse,
  PendingTurn,
} from '../types';

// =============================================================================
// Constants
// =============================================================================

/** Attempts per event before the turn is reported as stalled. */
const MAX_ATTEMPTS = 3;
/** Playing-phase history sent to the model (about 3 messages per turn). */
const MAX_GAME_LLM_MESSAGES = Number(process.env.LLM_HISTORY_MESSAGES ?? 45);

// =============================================================================
// Per-session event queue
//
// Every event that touches a session (player input, timer, host action, AI
// turn) runs one at a time, so two players clicking at once can never run two
// game loops in parallel on the same history.
// =============================================================================

const queues = new Map<string, Promise<void>>();

export function enqueue(sessionId: string, task: () => Promise<void>): Promise<void> {
  const previous = queues.get(sessionId) ?? Promise.resolve();
  const next = previous.then(task).catch((err) => console.error(`[orchestrator] task failed for ${sessionId}:`, err));
  queues.set(sessionId, next);
  void next.finally(() => {
    if (queues.get(sessionId) === next) queues.delete(sessionId);
  });
  return next;
}

/**
 * Bumped on reset so an AI call that finishes after the host reset the game
 * does not apply its (now stale) screens.
 */
const epochs = new Map<string, number>();
const epochOf = (sessionId: string) => epochs.get(sessionId) ?? 0;

// =============================================================================
// Turn timers (one per session: the pending turn's timer)
// =============================================================================

const turnTimers = new Map<string, ReturnType<typeof setTimeout>>();

function clearTurnTimer(sessionId: string): void {
  const handle = turnTimers.get(sessionId);
  if (handle !== undefined) {
    clearTimeout(handle);
    turnTimers.delete(sessionId);
  }
}

function startTurnTimer(sessionId: string, turn: number, seconds: number): void {
  clearTurnTimer(sessionId);
  const handle = setTimeout(() => {
    turnTimers.delete(sessionId);
    void enqueue(sessionId, () => onTimerExpired(sessionId, turn));
  }, seconds * 1000);
  turnTimers.set(sessionId, handle);
}

/** Stop timers and invalidate in-flight AI work (used by resets). */
export function cancelAllTimers(sessionId: string): void {
  clearTurnTimer(sessionId);
  dropPrefetch(sessionId);
  epochs.set(sessionId, epochOf(sessionId) + 1);
  const session = store.getSession(sessionId);
  if (session) {
    session.pendingTurn = undefined;
    session.stalled = undefined;
  }
}

// =============================================================================
// Helpers
// =============================================================================

function addChatMessage(session: Session, role: 'ai' | 'system', content: string): void {
  const msg: ChatMessage = { id: uuid(), role, content, timestamp: new Date().toISOString() };
  session.chatHistory.push(msg);
  connStore.broadcast(session.id, { type: 'chat_message', message: msg });
}

function newMetrics(): GameMetrics {
  return {
    model: llmConfig().model,
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
  };
}

function metricsOf(session: Session): GameMetrics {
  if (!session.metrics) session.metrics = newMetrics();
  return session.metrics;
}

function broadcastTurnStatus(session: Session): void {
  const pt = session.pendingTurn;
  if (!pt || pt.waitFor !== 'all') {
    connStore.broadcast(session.id, { type: 'turn_status', status: null });
    return;
  }
  const nameOf = (id: string) => session.players.find((p) => p.id === id)?.name ?? id;
  const answered = pt.responses.map((r) => nameOf(r.playerId));
  const waitingFor = pt.expected.filter((id) => !pt.responses.some((r) => r.playerId === id)).map(nameOf);
  connStore.broadcast(session.id, { type: 'turn_status', status: { turn: pt.turn, waitingFor, answered } });
}

/** Send every player their current screen (also used after reconnects). */
function pushScreens(session: Session, turn: number | undefined): void {
  for (const player of session.players) {
    const ui = session.playerUi[player.id] ?? session.playerUi.all ?? [];
    connStore.sendToPlayer(session.id, player.id, { type: 'ui_update', ui, turn });
  }
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const AUTO_CONTINUE_EVENT = 'EVENT: That screen has been shown.';

// Models pick the same "random" content every game (the Eiffel Tower, every
// time). A few random words at game start nudge secret picks and questions
// in a different direction each game.
const INSPIRATION = [
  'volcano', 'penguin', 'saxophone', 'Tokyo', 'chess', 'submarine', 'pizza', 'Amazon river', 'jazz', 'Mars',
  'castle', 'octopus', 'Olympics', 'Egypt', 'chocolate', 'robot', 'Viking', 'rainforest', 'bicycle', 'opera',
  'desert', 'lighthouse', 'tiger', 'Brazil', 'magician', 'glacier', 'dinosaur', 'Hollywood', 'tea', 'pirate',
  'Antarctica', 'violin', 'football', 'Moon', 'samurai', 'circus', 'coral reef', 'Iceland', 'detective', 'kangaroo',
  'medieval', 'skateboard', 'Shakespeare', 'Sahara', 'honey', 'astronaut', 'carnival', 'Norway', 'cheese', 'eagle',
];

function varietyHint(): string {
  const picks = [...INSPIRATION].sort(() => Math.random() - 0.5).slice(0, 3);
  return `secret answers, words and questions you invent this game must be connected to one of these themes: ${picks.join(', ')} ` +
    '(not the most famous example you can think of). Do not mention the themes to the players.';
}

/** Lengths of list values, so the model does not have to count items itself. */
function listLengths(state: Record<string, unknown>): string {
  const parts = Object.entries(state)
    .filter(([, v]) => Array.isArray(v))
    .map(([k, v]) => `${k}=${(v as unknown[]).length}`);
  return parts.length ? `\nLIST LENGTHS: ${parts.join(', ')}` : '';
}

/** One-line summary of a screen for the console, e.g. "Round 2" | multiple_choice(4) | scoreboard */
function describeScreen(ui: UIComponent[]): string {
  return ui
    .map((c) => {
      if (c.type === 'text') return JSON.stringify(c.content.slice(0, 60));
      if (c.type === 'multiple_choice') {
        const opts = c.playerOptions ? `<players: ${c.playerOptions}>` : c.options.join(' / ').slice(0, 80);
        return `choice ${JSON.stringify(c.question.slice(0, 50))} [${opts}]`;
      }
      if (c.type === 'button') return `[${c.label}]`;
      return c.type;
    })
    .join(' | ');
}

// =============================================================================
// Playing phase: one AI turn per event
// =============================================================================

/** The full chat request for the next game turn (same shape for real calls and prefetches). */
function gameRequest(session: Session, scratch: LLMMessage[]): ChatOptions {
  const jsonMode = llmConfig().protocol === 'json';
  return {
    messages: buildGameMessages(session, scratch),
    ...(jsonMode
      ? { responseSchema: { name: 'next_turn', schema: nextTurnSchema(session.players, session.gameState.plan as GamePlan | undefined) } }
      : { tools: gameToolsFor(session.players), toolChoice: 'required' as const }),
    logDir: session.logDir,
    phase: 'playing',
  };
}

const requestKey = (r: ChatOptions) => JSON.stringify([r.messages, r.responseSchema, r.tools]);

// =============================================================================
// Prefetch: think ahead when the next event is certain
//
// When only one thing can happen next (one player with a single button, or a
// screen that just waits for its timer), the next event is fully known. The
// server asks the AI for the following screen while the player reads, and uses
// the reply only if the real request turns out byte-for-byte identical.
// =============================================================================

interface Prefetch {
  key: string;
  promise: Promise<LLMResponse>;
  controller: AbortController;
}

const prefetches = new Map<string, Prefetch>();
const prefetchEnabled = () => process.env.LLM_PREFETCH !== 'false';

function dropPrefetch(sessionId: string): void {
  const p = prefetches.get(sessionId);
  if (p) {
    p.controller.abort();
    prefetches.delete(sessionId);
  }
}

function takePrefetch(sessionId: string, key: string, metrics: GameMetrics): Promise<LLMResponse> | undefined {
  const p = prefetches.get(sessionId);
  if (!p) return undefined;
  prefetches.delete(sessionId);
  if (p.key === key) {
    metrics.prefetchHits = (metrics.prefetchHits ?? 0) + 1;
    return p.promise;
  }
  metrics.prefetchMisses = (metrics.prefetchMisses ?? 0) + 1;
  p.controller.abort();
  return undefined;
}

/** The single response this turn can get, or null when there are several possible outcomes. */
function onlyPossibleOutcome(session: Session, pending: PendingTurn): { reason: 'responses' | 'timeout'; responses: PlayerResponse[] } | null {
  if (pending.expected.length === 0) return pending.timerSeconds ? { reason: 'timeout', responses: [] } : null;
  if (pending.expected.length !== 1 || pending.waitFor !== 'any' || pending.timerSeconds) return null;
  const playerId = pending.expected[0];
  const player = session.players.find((p) => p.id === playerId);
  const ui = session.playerUi[playerId] ?? [];
  const interactive = ui.filter((c) => isInteractive([c]));
  if (!player || interactive.length !== 1 || interactive[0].type !== 'button') return null;
  return { reason: 'responses', responses: [{ playerId, playerName: player.name, kind: 'action', id: interactive[0].actionId }] };
}

/** Start preparing the next screen if the next event is certain. */
function maybePrefetch(session: Session): void {
  dropPrefetch(session.id);
  const pending = session.pendingTurn;
  if (!prefetchEnabled() || !pending || session.status !== 'playing') return;
  const outcome = onlyPossibleOutcome(session, pending);
  if (!outcome) return;

  // Replay exactly what resolveTurn + runAiTurn will do, on a copy of the session.
  const future = structuredClone(session) as Session;
  const futurePending = { ...pending, responses: outcome.responses };
  future.gameState = recordAnswers(future.gameState, futurePending, future.players);
  future.gameLlmMessages.push({ role: 'user', content: formatTurnEvent(futurePending, outcome.reason, future.players) });
  const request = gameRequest(future, []);
  const controller = new AbortController();
  const promise = chat({ ...request, signal: controller.signal });
  promise.catch(() => undefined); // a failed or aborted prefetch just means no shortcut
  prefetches.set(session.id, { key: requestKey(request), promise, controller });
  console.log(`[game:${session.joinCode}] Thinking ahead: only one possible next step`);
}

/** Messages for one game-phase request. The current state rides on the latest event. */
function buildGameMessages(session: Session, scratch: LLMMessage[]): LLMMessage[] {
  const history = [...trimHistory(session.gameLlmMessages, MAX_GAME_LLM_MESSAGES)];
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === 'user') {
      history[i] = {
        ...history[i],
        content:
          `${history[i].content}\n\nCURRENT GAME STATE:\n${JSON.stringify(session.gameState)}${listLengths(session.gameState)}` +
          progressLine(session.gameState.plan as GamePlan | undefined, session.gameState.progress as Progress | undefined),
      };
      break;
    }
  }
  return mergeConsecutiveUserMessages([
    { role: 'system', content: playingPrompt(session, llmConfig().protocol) },
    ...history,
    ...scratch,
  ]);
}

/**
 * Append an event to the game history and ask the model for the next turn.
 * Retries invalid or text-only replies; only the successful exchange is kept
 * in the history so failed attempts do not clutter later prompts.
 */
async function runAiTurn(session: Session, eventText: string): Promise<void> {
  const tag = `[game:${session.joinCode}]`;
  const epoch = epochOf(session.id);
  const metrics = metricsOf(session);

  clearTurnTimer(session.id);
  session.pendingTurn = undefined;
  if (session.stalled) {
    session.stalled = undefined;
    connStore.broadcast(session.id, { type: 'game_error', message: null });
  }
  connStore.broadcast(session.id, { type: 'turn_status', status: null });

  session.gameLlmMessages.push({ role: 'user', content: eventText });
  console.log(`${tag} ${eventText.split('\n')[0]}`);
  connStore.broadcast(session.id, { type: 'ai_thinking', thinking: true });

  const scratch: LLMMessage[] = [];
  let lastProblem = 'unknown error';
  const jsonMode = llmConfig().protocol === 'json';
  // An auto-continue turn may not be followed by another one (no endless slide loops).
  const parseOptions = {
    allowAutoContinue: !eventText.startsWith(AUTO_CONTINUE_EVENT),
    isFirstTurn: (session.turnCounter ?? 0) === 0,
    previousWasSlide: session.lastTurnWasSlide === true,
    plan: session.gameState.plan as GamePlan | undefined,
    progress: session.gameState.progress as Progress | undefined,
  };

  try {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let response;
      const t0 = Date.now();
      try {
        const request = gameRequest(session, scratch);
        const prefetched = attempt === 1 ? takePrefetch(session.id, requestKey(request), metrics) : undefined;
        response = prefetched ? await prefetched : await chat(request);
        if (prefetched) console.log(`${tag} Using the next screen prepared ahead of time`);
      } catch (err) {
        metrics.httpErrors++;
        lastProblem = err instanceof Error ? err.message : String(err);
        console.error(`${tag} LLM request failed (attempt ${attempt}): ${lastProblem}`);
        if (lastProblem.includes('LLM_LOCAL_ONLY')) break;
        await delay(1000 * attempt);
        continue;
      } finally {
        metrics.llmCalls++;
        metrics.llmMs += Date.now() - t0;
      }
      metrics.promptTokensMax = Math.max(metrics.promptTokensMax, response.usage?.prompt_tokens ?? 0);

      // Reset or game over while the model was thinking: drop the result.
      if (epoch !== epochOf(session.id) || session.status !== 'playing') {
        console.log(`${tag} Session was reset during the AI call — discarding result`);
        return;
      }

      const message = response.choices[0].message;

      if (response.choices[0].finish_reason === 'length') {
        metrics.invalidCalls++;
        lastProblem = 'reply was cut off at the token limit';
        console.warn(`${tag} Attempt ${attempt}: ${lastProblem}`);
        scratch.push(
          { role: 'assistant', content: (message.content ?? '').slice(0, 500) + ' …(cut off)' },
          { role: 'user', content: 'Your reply was cut off because it was too long. Reply again with a shorter turn: fewer and shorter texts, no extra whitespace.' },
        );
        continue;
      }

      if (jsonMode) {
        const args = extractJsonObject(message.content ?? '');
        if (!args) {
          metrics.textReplies++;
          lastProblem = `reply was not a JSON object: ${(message.content ?? '').slice(0, 200)}`;
          console.warn(`${tag} Attempt ${attempt}: ${lastProblem}`);
          scratch.push(
            { role: 'assistant', content: message.content || '(empty reply)' },
            { role: 'user', content: 'Reply with one JSON object for the next turn, and nothing else.' },
          );
          continue;
        }
        const parsedJson = parseNextTurn(args, session.players, parseOptions);
        const assistantJson: LLMMessage = { role: 'assistant', content: JSON.stringify(args) };
        if (!parsedJson.ok) {
          metrics.invalidCalls++;
          lastProblem = parsedJson.errors.join(' ');
          console.warn(`${tag} Attempt ${attempt}: invalid turn — ${lastProblem}`);
          scratch.push(assistantJson, {
            role: 'user',
            content: `That turn was rejected and nothing was shown. Problems:\n- ${parsedJson.errors.join('\n- ')}\nReply with the corrected JSON object.`,
          });
          continue;
        }
        session.gameLlmMessages.push(assistantJson, {
          role: 'user',
          content: `(server) Turn shown. ${describeWaiting(session, parsedJson.turn)}`,
        });
        await applyTurn(session, parsedJson.turn, epoch);
        return;
      }

      let call: LLMToolCall | undefined =
        message.tool_calls?.find((c) => c.function.name === 'next_turn') ?? message.tool_calls?.[0];

      if (!call) {
        const pseudo = tryParsePseudoNextTurn(message.content);
        if (pseudo) {
          console.warn(`${tag} Model wrote next_turn as text — using it`);
          call = { id: `text-${Date.now()}`, type: 'function', function: { name: 'next_turn', arguments: JSON.stringify(pseudo) } };
        } else {
          metrics.textReplies++;
          lastProblem = `replied with text instead of a tool call: ${(message.content ?? '').slice(0, 200)}`;
          console.warn(`${tag} Attempt ${attempt}: ${lastProblem}`);
          scratch.push(
            { role: 'assistant', content: message.content || '(empty reply)' },
            { role: 'user', content: 'You must respond by calling the next_turn tool with the next screens. Do not write plain text.' },
          );
          continue;
        }
      }

      const assistantMsg: LLMMessage = { role: 'assistant', content: null, tool_calls: [call] };
      const parsed =
        call.function.name === 'next_turn'
          ? parseNextTurn(parseArguments(call.function.arguments), session.players, parseOptions)
          : { ok: false as const, errors: [`Unknown tool "${call.function.name}". The only tool is next_turn.`] };

      if (!parsed.ok) {
        metrics.invalidCalls++;
        lastProblem = parsed.errors.join(' ');
        console.warn(`${tag} Attempt ${attempt}: invalid next_turn — ${lastProblem}`);
        scratch.push(assistantMsg, {
          role: 'tool',
          tool_call_id: call.id,
          name: call.function.name,
          content: JSON.stringify({ error: 'next_turn was rejected. Nothing was shown.', problems: parsed.errors, fix: 'Call next_turn again with every problem fixed.' }),
        });
        continue;
      }

      const ignored = (message.tool_calls?.length ?? 1) - 1;
      session.gameLlmMessages.push(assistantMsg, {
        role: 'tool',
        tool_call_id: call.id,
        name: 'next_turn',
        content: JSON.stringify(turnResultSummary(session, parsed.turn, ignored)),
      });
      await applyTurn(session, parsed.turn, epoch);
      return;
    }

    // Every attempt failed
    metrics.stalls++;
    session.stalled = lastProblem;
    console.error(`${tag} Turn stalled: ${lastProblem}`);
    connStore.broadcast(session.id, {
      type: 'game_error',
      message: `The AI could not produce the next screen (${lastProblem.slice(0, 200)}). Press Retry to try again.`,
    });
  } finally {
    connStore.broadcast(session.id, { type: 'ai_thinking', thinking: false });
    store.saveSession(session);
    writeMetrics(session.logDir, metrics);
  }
}

/** Plain-language feedback on who can answer, so the model notices players it forgot. */
function describeWaiting(session: Session, turn: ParsedTurn): string {
  if (turn.gameOver) return 'The game is over.';
  const expected = expectedResponders(turn.screens, session.players);
  const nameOf = (id: string) => session.players.find((p) => p.id === id)?.name ?? id;
  const idle = session.players.filter((p) => !expected.includes(p.id)).map((p) => p.name);
  const who = expected.map(nameOf).join(', ') || 'nobody';
  const waiting = turn.waitFor === 'all' ? `Waiting for all of: ${who}.` : `Waiting for the first response from: ${who}.`;
  return idle.length ? `${waiting} Nothing to answer on the screens of: ${idle.join(', ')}.` : waiting;
}

function turnResultSummary(session: Session, turn: ParsedTurn, ignoredCalls: number): Record<string, unknown> {
  const expected = expectedResponders(turn.screens, session.players);
  const names = expected.map((id) => session.players.find((p) => p.id === id)?.name ?? id);
  const result: Record<string, unknown> = { ok: true };
  if (turn.gameOver) result.game_over = true;
  else if (turn.waitFor === 'all') result.waiting_for = `all of: ${names.join(', ') || 'nobody'}`;
  else result.waiting_for = `first response from: ${names.join(', ') || 'nobody'}`;
  if (turn.timerSeconds) result.timer_seconds = turn.timerSeconds;
  if (ignoredCalls > 0) result.note = `Only one next_turn call per event is used; ${ignoredCalls} extra call(s) were ignored.`;
  return result;
}

/** Apply a validated turn: state, intro slides, screens, timer, game over. */
async function applyTurn(session: Session, turn: ParsedTurn, epoch: number): Promise<void> {
  const tag = `[game:${session.joinCode}]`;
  const metrics = metricsOf(session);
  metrics.turns++;

  if (turn.ruleChange) {
    session.agreedRules = `${session.agreedRules ?? ''}\n\n[AMENDMENT] ${turn.ruleChange}`;
    connStore.broadcast(session.id, { type: 'status_change', status: session.status, agreedRules: session.agreedRules });
  }
  session.gameState = applyStateUpdate(session.gameState, turn.stateUpdate, turn.stateAppend, turn.stateAdd);
  if (turn.plan) session.gameState = { ...session.gameState, plan: turn.plan };
  if (turn.progress) session.gameState = { ...session.gameState, progress: turn.progress };
  session.lastTurnWasSlide = turn.isSlide;

  if (turn.intro.length > 0) {
    connStore.broadcast(session.id, { type: 'ai_thinking', thinking: false });
    for (const slide of turn.intro) {
      if (epoch !== epochOf(session.id) || session.status !== 'playing') return;
      session.playerUi = { all: slide.screen };
      connStore.broadcast(session.id, { type: 'ui_update', ui: slide.screen });
      await delay(slide.seconds * 1000);
    }
    if (epoch !== epochOf(session.id) || session.status !== 'playing') return;
  }

  const turnNo = (session.turnCounter ?? 0) + 1;
  session.turnCounter = turnNo;
  const endsAt = turn.timerSeconds ? Date.now() + turn.timerSeconds * 1000 : undefined;
  const countdown: UIComponent | undefined = turn.timerSeconds
    ? { type: 'countdown', timerId: `turn-${turnNo}`, seconds: turn.timerSeconds, endsAt }
    : undefined;
  const withTimer = (ui: UIComponent[]) => (countdown ? [countdown, ...ui] : ui);

  session.playerUi = { all: withTimer(screenFor(turn.screens, '', session.players)) };
  for (const player of session.players) {
    session.playerUi[player.id] = withTimer(screenFor(turn.screens, player.id, session.players));
  }
  pushScreens(session, turnNo);
  console.log(`${tag} Turn ${turnNo} shown (wait_for=${turn.waitFor}${turn.timerSeconds ? `, timer=${turn.timerSeconds}s` : ''}${turn.intro.length ? `, ${turn.intro.length} intro slides` : ''})`);
  for (const [target, ui] of Object.entries(turn.screens)) {
    const who = target === 'all' ? 'all' : session.players.find((p) => p.id === target)?.name ?? target;
    console.log(`${tag}   ${who}: ${describeScreen(ui)}`);
  }

  if (turn.gameOver) {
    session.status = 'finished';
    session.pendingTurn = undefined;
    metrics.finished = true;
    connStore.broadcast(session.id, { type: 'status_change', status: 'finished', message: turn.gameOver.message });
    console.log(`${tag} Game over: ${turn.gameOver.message}`);
    return;
  }

  if (turn.autoContinue) {
    console.log(`${tag} Screen has nothing to click — asking the AI for the next screen`);
    await runAiTurn(session, `${AUTO_CONTINUE_EVENT} Now show the next screen (players need something to click or answer).`);
    return;
  }

  const answerKeys: NonNullable<import('../types').PendingTurn['answerKeys']> = {};
  for (const player of session.players) {
    const keys = answerKeysFor(turn.screens, player.id);
    if (Object.keys(keys).length) answerKeys[player.id] = keys;
  }
  session.pendingTurn = {
    turn: turnNo,
    waitFor: turn.waitFor,
    expected: expectedResponders(turn.screens, session.players),
    responses: [],
    timerSeconds: turn.timerSeconds,
    endsAt,
    shownAt: Date.now(),
    ...(Object.keys(answerKeys).length ? { answerKeys, checks: [] } : {}),
  };
  if (turn.timerSeconds) startTurnTimer(session.id, turnNo, turn.timerSeconds);
  broadcastTurnStatus(session);
  maybePrefetch(session);
}

/** End the pending turn and hand the collected responses to the model. */
async function resolveTurn(session: Session, reason: 'responses' | 'timeout'): Promise<void> {
  const pending = session.pendingTurn;
  if (!pending) return;
  clearTurnTimer(session.id);
  session.pendingTurn = undefined;
  session.gameState = recordAnswers(session.gameState, pending, session.players);
  await runAiTurn(session, formatTurnEvent(pending, reason, session.players));
}

async function onTimerExpired(sessionId: string, turn: number): Promise<void> {
  const session = store.getSession(sessionId);
  if (!session || session.status !== 'playing' || session.pendingTurn?.turn !== turn) return;
  connStore.broadcast(sessionId, { type: 'timer_expired', timerId: `turn-${turn}` });
  await resolveTurn(session, 'timeout');
}

// =============================================================================
// Public API — playing phase
// =============================================================================

export interface PlayerInput {
  kind: 'action' | 'submit';
  id: string;
  values?: Record<string, string>;
  /** Turn number of the screen the input came from. */
  turn?: number;
}

/** A player clicked a button, picked an option or submitted a form. */
export function handlePlayerInput(sessionId: string, playerId: string, input: PlayerInput): Promise<void> {
  return enqueue(sessionId, async () => {
    const session = store.getSession(sessionId);
    if (!session || session.status !== 'playing') return;
    const player = session.players.find((p) => p.id === playerId);
    if (!player) return;
    const tag = `[game:${session.joinCode}]`;
    const pending = session.pendingTurn;

    if (!pending) {
      if (session.stalled) {
        connStore.sendToPlayer(sessionId, playerId, { type: 'error', message: 'The AI is stuck. Press Retry to continue.' });
      }
      return;
    }
    if (input.turn !== undefined && input.turn !== pending.turn) {
      console.log(`${tag} Ignoring input from ${player.name} for old turn ${input.turn} (current ${pending.turn})`);
      return;
    }
    if (!pending.expected.includes(playerId)) {
      connStore.sendToPlayer(sessionId, playerId, { type: 'error', message: "It's not your turn." });
      return;
    }
    if (pending.responses.some((r) => r.playerId === playerId)) return;

    const response: PlayerResponse = {
      playerId,
      playerName: player.name,
      kind: input.kind,
      id: input.id,
      ...(input.values ? { values: input.values } : {}),
      ...(pending.shownAt ? { elapsedMs: Date.now() - pending.shownAt } : {}),
    };
    pending.responses.push(response);
    console.log(`${tag} ${player.name} → ${input.kind} "${input.id}" ${input.values ? JSON.stringify(input.values) : ''}`);

    // Answer key: check right away, give points, and show the player the result instantly.
    const feedback = checkAnswer(session, pending, player, input);

    const allIn = pending.expected.every((id) => pending.responses.some((r) => r.playerId === id));
    if ((pending.waitFor === 'any' || allIn) && feedback) {
      // Show the verdict while the AI prepares the next screen.
      const current = session.playerUi[playerId] ?? [];
      const verdict = [...current.filter((c) => !isInteractive([c]) && c.type !== 'countdown'), ...feedback];
      session.playerUi[playerId] = verdict;
      connStore.sendToPlayer(sessionId, playerId, { type: 'ui_update', ui: verdict, turn: pending.turn });
    }
    if (pending.waitFor === 'any' || allIn) {
      await resolveTurn(session, 'responses');
      return;
    }

    // Waiting for others: lock this player's screen (their timer stops) and tell the others.
    const current = session.playerUi[playerId] ?? [];
    const locked: UIComponent[] = [
      ...current.filter((c) => !isInteractive([c]) && c.type !== 'countdown'),
      ...(feedback ?? []),
      { type: 'text', content: '✓ Your answer is in. Waiting for the other players…', style: feedback ? 'muted' : 'success' },
    ];
    session.playerUi[playerId] = locked;
    connStore.sendToPlayer(sessionId, playerId, { type: 'ui_update', ui: locked, turn: pending.turn });
    for (const other of session.players) {
      if (other.id !== playerId) connStore.sendToPlayer(sessionId, other.id, { type: 'toast', text: `${player.name} answered ✓` });
    }
    broadcastTurnStatus(session);
    store.saveSession(session);
  });
}

/**
 * Check a submitted answer against the turn's answer key, add the points to
 * state.scores and return the feedback components for the player (or null).
 */
function checkAnswer(
  session: Session,
  pending: import('../types').PendingTurn,
  player: { id: string; name: string },
  input: PlayerInput,
): UIComponent[] | null {
  if (input.kind !== 'submit' || !input.values) return null;
  const keys = pending.answerKeys?.[player.id];
  if (!keys) return null;
  const feedback: UIComponent[] = [];
  for (const [fieldId, value] of Object.entries(input.values)) {
    const key = keys[fieldId];
    if (!key) continue;
    const correct = key.correct.some((c) => sameAnswer(c, String(value)));
    const points = correct ? key.points : key.penalty;
    if (points) session.gameState = applyStateUpdate(session.gameState, undefined, undefined, { scores: { [player.name]: points } });
    pending.checks = [
      ...(pending.checks ?? []),
      { playerName: player.name, fieldId, answer: String(value), correct, points, rightAnswer: key.correct.join(' / ') },
    ];
    const pts = points ? ` (${points > 0 ? '+' : ''}${points})` : '';
    feedback.push(
      correct
        ? { type: 'text', content: `✓ Correct!${pts}`, style: 'success' }
        : { type: 'text', content: `✗ The answer was ${key.correct.join(' / ')}${pts}`, style: 'error' },
    );
  }
  return feedback.length ? feedback : null;
}

/** Called by the host to confirm rules and start the game. */
export function startGame(sessionId: string): Promise<void> {
  return enqueue(sessionId, async () => {
    const session = store.getSession(sessionId);
    if (!session || !session.agreedRules) return;

    clearTurnTimer(sessionId);
    epochs.set(sessionId, epochOf(sessionId) + 1);
    session.status = 'playing';
    session.gameLlmMessages = [];
    session.gameState = {};
    session.playerUi = {};
    session.turnCounter = 0;
    session.pendingTurn = undefined;
    session.stalled = undefined;
    session.logDir = newLogDirName(session.joinCode, 'play');
    session.metrics = newMetrics();
    console.log(`[start:${session.joinCode}] Host confirmed rules — starting game (logs: ${path.join(dataDir(), 'llm-logs', session.logDir)})`);

    connStore.broadcast(sessionId, { type: 'status_change', status: 'playing', agreedRules: session.agreedRules });

    const playerList = session.players.map((p) => `${p.name} (id: ${p.id})`).join(', ');
    await runAiTurn(
      session,
      `EVENT: The game is starting. Players: ${playerList}. Set up the initial game state and show the first screen.\n` +
        `Variety: ${varietyHint()}`,
    );
  });
}

/**
 * Host sends an adjustment. Interrupts the pending turn. After game over it
 * reopens the game, so the host can still ask for e.g. an extra final screen.
 */
export function handleGameTweak(sessionId: string, playerName: string, content: string): Promise<void> {
  return enqueue(sessionId, async () => {
    const session = store.getSession(sessionId);
    if (!session || (session.status !== 'playing' && session.status !== 'finished')) return;
    const reopened = session.status === 'finished';
    if (reopened) {
      session.status = 'playing';
      if (session.metrics) session.metrics.finished = false;
      connStore.broadcast(sessionId, { type: 'status_change', status: 'playing' });
    }
    const pending = session.pendingTurn;
    if (pending) session.gameState = recordAnswers(session.gameState, pending, session.players);
    const lines = [`EVENT: HOST ADJUSTMENT from ${playerName}: ${content}`];
    if (reopened) {
      lines.push('The game had already ended. Apply the adjustment (for example show the requested final screen), then set game_over to true again.');
    }
    if (pending) {
      lines.push(
        '',
        `This interrupted turn ${pending.turn}. Show the current step again (adjusted) or move on.`,
        formatTurnEvent(pending, 'interrupted', session.players).split('\n').slice(1).join('\n'),
      );
    }
    await runAiTurn(session, lines.join('\n'));
  });
}

/** Ask the AI again after a stall (or when players are stuck on a screen). */
export function retryTurn(sessionId: string, requestedBy: string): Promise<void> {
  return enqueue(sessionId, async () => {
    const session = store.getSession(sessionId);
    if (!session || session.status !== 'playing') return;
    const pending = session.pendingTurn;
    if (pending) session.gameState = recordAnswers(session.gameState, pending, session.players);
    const lines = [`EVENT: ${requestedBy} asked you to continue the game. Show the next screen now.`];
    if (pending) {
      lines.push(formatTurnEvent(pending, 'interrupted', session.players).split('\n').slice(1).join('\n'));
    }
    await runAiTurn(session, lines.join('\n'));
  });
}

/** True while an event (usually an AI turn) is being processed for the session. */
export function isBusy(sessionId: string): boolean {
  return queues.has(sessionId);
}

/**
 * After a server restart, games that were waiting for the AI have no pending
 * turn and nobody would ever answer. Mark them stalled so players get Retry.
 */
export function recoverInterruptedGames(sessions: Session[]): void {
  for (const session of sessions) {
    if (session.status === 'playing' && !session.pendingTurn && !session.stalled) {
      session.stalled = 'interrupted by a server restart';
      store.saveSession(session);
      console.log(`[game:${session.joinCode}] Was interrupted by a server restart — players can press Retry`);
    }
  }
}

/** Re-send the current screen and status to one reconnecting player. */
export function resendState(session: Session, playerId: string): void {
  connStore.sendToPlayer(session.id, playerId, { type: 'ai_thinking', thinking: isBusy(session.id) });
  const ui = session.playerUi[playerId] ?? session.playerUi.all;
  if (ui) connStore.sendToPlayer(session.id, playerId, { type: 'ui_update', ui, turn: session.pendingTurn?.turn });
  if (session.stalled) {
    connStore.sendToPlayer(session.id, playerId, { type: 'game_error', message: `The AI could not produce the next screen. Press Retry to try again.` });
  }
  broadcastTurnStatus(session);
}

// =============================================================================
// Public API — definition phase
// =============================================================================

function toPlayerRange(min: unknown, max: unknown): { min: number; max: number } | undefined {
  const lo = Math.round(Number(min));
  const hi = Math.round(Number(max));
  if (!Number.isFinite(lo) || lo < 1) return undefined;
  return { min: lo, max: Number.isFinite(hi) && hi >= lo ? hi : Math.max(lo, 20) };
}

function rangeText(range: { min: number; max: number } | undefined): string {
  if (!range) return '';
  return range.min === range.max ? `${range.min} player${range.min === 1 ? '' : 's'}` : `${range.min}–${range.max} players`;
}

/** Make rules the agreed rules (proposed by the AI or loaded from a saved game). */
export function applyRules(session: Session, rules: string, range: { min: number; max: number } | undefined, source: 'ai' | 'saved'): void {
  session.agreedRules = rules;
  session.playerRange = range;
  const intro = source === 'saved' ? '📂 **Saved rules loaded:**' : '📋 **Proposed rules:**';
  const needs = range ? `\n\n*Needs ${rangeText(range)}.*` : '';
  console.log(`[define:${session.joinCode}] ✅ Rules ${source === 'saved' ? 'loaded' : 'proposed'}${range ? ` (${rangeText(range)})` : ''}`);
  addChatMessage(session, 'system', `${intro}\n\n${rules}${needs}\n\n*The host can start the game, or keep chatting to change the rules.*`);
  connStore.broadcast(session.id, { type: 'status_change', status: 'defining', agreedRules: rules, playerRange: range });
}

/** json protocol: the reply is {"message", "proposed_rules", "min_players", "max_players"}. */
function handleJsonDefinitionReply(session: Session, content: string | null): void {
  const reply = extractJsonObject(content ?? '');
  const message = typeof reply?.message === 'string' ? reply.message.trim() : '';
  const rules = typeof reply?.proposed_rules === 'string' ? reply.proposed_rules.trim() : '';
  session.definitionLlmMessages.push({ role: 'assistant', content: content ?? '' });
  if (message) addChatMessage(session, 'ai', message);
  if (rules) applyRules(session, rules, toPlayerRange(reply?.min_players, reply?.max_players), 'ai');
  if (!message && !rules) addChatMessage(session, 'system', 'The AI gave an empty reply. Try sending your message again.');
}

/** Host loads saved rules: no AI call; the AI learns about them on the next chat message. */
export function loadSavedRules(sessionId: string, playerName: string, rules: string, range?: { min: number; max: number }): Promise<void> {
  return enqueue(sessionId, async () => {
    const session = store.getSession(sessionId);
    if (!session || session.status !== 'defining') return;
    session.definitionLlmMessages.push({ role: 'user', content: `[${playerName} loaded these saved rules]:\n${rules}` });
    session.definitionLlmMessages.push({ role: 'assistant', content: JSON.stringify({ message: 'Saved rules loaded.', proposed_rules: '', min_players: 0, max_players: 0 }) });
    applyRules(session, rules, range ? toPlayerRange(range.min, range.max) : undefined, 'saved');
    store.saveSession(session);
  });
}

/** Called when a player sends a chat message during the definition phase. */
export function handleDefinitionMessage(sessionId: string, playerName: string, content: string): Promise<void> {
  return enqueue(sessionId, async () => {
    const session = store.getSession(sessionId);
    if (!session || session.status !== 'defining') return;
    const defTag = `[define:${session.joinCode}]`;

    const playerMsg: ChatMessage = {
      id: uuid(),
      role: 'player',
      playerName,
      content,
      timestamp: new Date().toISOString(),
    };
    session.chatHistory.push(playerMsg);
    connStore.broadcast(sessionId, { type: 'chat_message', message: playerMsg });
    session.definitionLlmMessages.push({ role: 'user', content: `[${playerName}]: ${content}` });
    if (!session.logDir?.endsWith('_define')) session.logDir = newLogDirName(session.joinCode, 'define');

    console.log(`${defTag} ${playerName}: ${content.slice(0, 120)}`);
    connStore.broadcast(sessionId, { type: 'ai_thinking', thinking: true });

    try {
      const jsonMode = llmConfig().protocol === 'json';
      const response = await chat({
        messages: mergeConsecutiveUserMessages([
          { role: 'system', content: definitionPrompt(session, llmConfig().protocol) },
          ...session.definitionLlmMessages,
        ]),
        ...(jsonMode
          ? { responseSchema: { name: 'definition_reply', schema: definitionResponseSchema } }
          : { tools: definitionTools, toolChoice: 'auto' as const }),
        logDir: session.logDir,
        phase: 'definition',
      });

      if (jsonMode) {
        handleJsonDefinitionReply(session, response.choices[0].message.content);
        return;
      }

      const assistantMsg = response.choices[0].message;
      const proposal = assistantMsg.tool_calls?.find((c) => c.function.name === 'propose_rules');
      session.definitionLlmMessages.push({
        role: 'assistant',
        content: assistantMsg.content || null,
        ...(proposal ? { tool_calls: [proposal] } : {}),
      });

      if (assistantMsg.content) addChatMessage(session, 'ai', assistantMsg.content);

      if (proposal) {
        const args = parseArguments(proposal.function.arguments);
        const summary = typeof args?.summary === 'string' ? args.summary.trim() : '';
        if (summary) {
          session.definitionLlmMessages.push({
            role: 'tool',
            tool_call_id: proposal.id,
            name: 'propose_rules',
            content: 'Rules shown to the players. Waiting for the host to start the game.',
          });
          applyRules(session, summary, toPlayerRange(args?.min_players, args?.max_players), 'ai');
        } else {
          session.definitionLlmMessages.push({
            role: 'tool',
            tool_call_id: proposal.id,
            name: 'propose_rules',
            content: 'Error: "summary" was missing or empty. Nothing was shown.',
          });
          addChatMessage(session, 'system', 'The AI tried to propose rules but the proposal was empty. Ask it to propose the rules again.');
        }
      } else if (!assistantMsg.content) {
        addChatMessage(session, 'system', 'The AI gave an empty reply. Try sending your message again.');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`${defTag} LLM call failed: ${message}`);
      addChatMessage(session, 'system', `⚠️ The AI could not be reached: ${message.slice(0, 200)}`);
    } finally {
      store.saveSession(session);
      connStore.broadcast(sessionId, { type: 'ai_thinking', thinking: false });
    }
  });
}
