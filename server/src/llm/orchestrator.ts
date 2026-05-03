import { v4 as uuid } from 'uuid';
import * as store from '../store';
import * as connStore from '../connection-store';
import { chat } from './client';
import { definitionPrompt, playingPrompt } from './prompts';
import { definitionTools, gameTools } from './tools';
import { clearLogs } from './logger';
import {
  Session,
  ChatMessage,
  LLMMessage,
  LLMToolCall,
  UIComponent,
} from '../types';

// =============================================================================
// Constants
// =============================================================================

const MAX_GAME_LOOP_ITERATIONS = 20;
/** Keep only the last N messages in the playing-phase history to avoid huge context windows. */
const MAX_GAME_LLM_MESSAGES = 40;

// =============================================================================
// Active timers  (sessionId:timerId → timeout handle)
// =============================================================================

const activeTimers = new Map<string, ReturnType<typeof setTimeout>>();

function timerKey(sessionId: string, timerId: string): string {
  return `${sessionId}:${timerId}`;
}

function clearTimer(sessionId: string, timerId: string): void {
  const key = timerKey(sessionId, timerId);
  const handle = activeTimers.get(key);
  if (handle !== undefined) {
    clearTimeout(handle);
    activeTimers.delete(key);
  }
}

function startTimer(sessionId: string, timerId: string, seconds: number): void {
  clearTimer(sessionId, timerId);
  const handle = setTimeout(() => {
    activeTimers.delete(timerKey(sessionId, timerId));
    handleTimerExpired(sessionId, timerId, seconds).catch((err) =>
      console.error('[orchestrator] timer error:', err),
    );
  }, seconds * 1000);
  activeTimers.set(timerKey(sessionId, timerId), handle);
}

/** Cancel every timer belonging to a session (e.g. on reset). */
export function cancelAllTimers(sessionId: string): void {
  for (const key of [...activeTimers.keys()]) {
    if (key.startsWith(`${sessionId}:`)) {
      clearTimeout(activeTimers.get(key)!);
      activeTimers.delete(key);
    }
  }
}

// =============================================================================
// Helpers
// =============================================================================

function toPublicSession(session: Session) {
  return {
    id: session.id,
    joinCode: session.joinCode,
    status: session.status,
    players: session.players,
    chatHistory: session.chatHistory,
    agreedRules: session.agreedRules,
    gameState: session.gameState,
    createdAt: session.createdAt,
  };
}

function addAiChatMessage(session: Session, content: string): void {
  const msg: ChatMessage = {
    id: uuid(),
    role: 'ai',
    content,
    timestamp: new Date().toISOString(),
  };
  session.chatHistory.push(msg);
  connStore.broadcast(session.id, { type: 'chat_message', message: msg });
}

function addSystemChatMessage(session: Session, content: string): void {
  const msg: ChatMessage = {
    id: uuid(),
    role: 'system',
    content,
    timestamp: new Date().toISOString(),
  };
  session.chatHistory.push(msg);
  connStore.broadcast(session.id, { type: 'chat_message', message: msg });
}

// =============================================================================
// Pseudo-tool-call detection
// =============================================================================

const GAME_TOOL_NAMES = new Set([
  'set_state_schema', 'get_state', 'set_state', 'set_user_ui',
  'run_sequence', 'start_timer', 'update_rules', 'end_game',
]);

/**
 * Some models return tool calls as plain JSON text instead of using the
 * tool-calling protocol. Detect the two common patterns:
 *   { "set_user_ui": { ...args } }          (single-key object)
 *   { "name": "set_user_ui", "arguments": { ...args } }
 */
function tryParsePseudoToolCall(content: string): { name: string; args: unknown } | null {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const obj = parsed as Record<string, unknown>;
    const keys = Object.keys(obj);
    // Pattern 1: { "tool_name": { ...args } }
    if (keys.length === 1 && GAME_TOOL_NAMES.has(keys[0])) {
      return { name: keys[0], args: obj[keys[0]] };
    }
    // Pattern 2: { "name": "tool_name", "arguments": { ... } }
    if (typeof obj['name'] === 'string' && GAME_TOOL_NAMES.has(obj['name'])) {
      return { name: obj['name'], args: obj['arguments'] ?? {} };
    }
    // Pattern 3: bare set_user_ui args — { "playerId": "...", "ui": [...] }
    if (typeof obj['playerId'] === 'string' && Array.isArray(obj['ui'])) {
      return { name: 'set_user_ui', args: obj };
    }
    // Pattern 4: bare set_state args — { "state": {...} }
    if ('state' in obj && typeof obj['state'] === 'object' && obj['state'] !== null && !Array.isArray(obj['state'])) {
      return { name: 'set_state', args: obj };
    }
    // Pattern 5: bare run_sequence args — { "steps": [...] }
    if (Array.isArray(obj['steps'])) {
      return { name: 'run_sequence', args: obj };
    }
  } catch { /* not JSON */ }
  return null;
}

// =============================================================================
// Game loop (agentic tool-call processing)
// =============================================================================

async function runGameLoop(session: Session): Promise<void> {
  let iterations = 0;
  const tag = `[game:${session.joinCode}]`;
  let uiWasSet = false; // tracks whether set_user_ui fired at any point this run (used to suppress plain-text fallback)
  let directUiSet = false; // tracks whether set_user_ui was called directly this iteration (used to break the loop)
  let consecutiveErrorIterations = 0; // how many back-to-back iterations had ≥1 tool error

  while (iterations < MAX_GAME_LOOP_ITERATIONS) {
    iterations++;
    console.log(`\n${tag} ── Game loop iteration ${iterations} ──────────────────`);

    // Trim history to avoid bloating the context window
    const recentMessages = session.gameLlmMessages.slice(-MAX_GAME_LLM_MESSAGES);
    console.log(`${tag} Sending ${recentMessages.length} message(s) to LLM`);

    const response = await chat({
      messages: [
        { role: 'system', content: playingPrompt(session) },
        ...recentMessages,
      ],
      tools: gameTools,
    });

    const assistantMsg = response.choices[0].message;
    const finishReason = response.choices[0].finish_reason;
    console.log(`${tag} LLM finish_reason: ${finishReason}`);

    if (assistantMsg.content) {
      console.log(`${tag} LLM text: ${assistantMsg.content.slice(0, 300)}`);
    }

    if (!assistantMsg.tool_calls || assistantMsg.tool_calls.length === 0) {
      // LLM responded with plain text instead of tool calls.
      if (assistantMsg.content && !uiWasSet) {
        // First try: detect pseudo-tool-call JSON, e.g. { "set_user_ui": { ... } }
        const pseudoCall = tryParsePseudoToolCall(assistantMsg.content);
        if (pseudoCall) {
          console.warn(`${tag} LLM returned pseudo-tool-call as plain text — executing ${pseudoCall.name}`);
          const syntheticId = `synthetic-${Date.now()}`;
          const syntheticToolCall: LLMToolCall = {
            id: syntheticId,
            type: 'function',
            function: { name: pseudoCall.name, arguments: JSON.stringify(pseudoCall.args) },
          };
          if (pseudoCall.name === 'set_user_ui') uiWasSet = true;
          // Record as a proper tool call exchange so the history stays well-formed
          session.gameLlmMessages.push({
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: syntheticId,
              type: 'function',
              function: { name: pseudoCall.name, arguments: JSON.stringify(pseudoCall.args) },
            }],
          });
          const result = await executeGameTool(session, syntheticToolCall);
          session.gameLlmMessages.push({
            role: 'tool',
            tool_call_id: syntheticId,
            name: pseudoCall.name,
            content: JSON.stringify(result),
          });
          store.saveSession(session);
          // Don't break — continue the loop so the LLM can proceed
          continue;
        }

        // Second try: if it's raw JSON (not a known tool call) — suppress it entirely.
        const trimmed = assistantMsg.content.trimStart();
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
          console.warn(`${tag} LLM returned unrecognised JSON as plain text — suppressing`);
          // Don't push to history — it's garbage that would poison future calls
        } else {
          // Looks like human-readable text — show it briefly in the UI but do NOT
          // store it in history to avoid garbage accumulation across turns.
          console.warn(`${tag} LLM returned plain text (no tool calls) — showing in UI, not storing in history`);
          const existingUi: UIComponent[] = session.playerUi['all'] ?? [];
          const baseUi = existingUi[0]?.type === 'text' && existingUi[0]?.style === 'success'
            ? existingUi.slice(1)
            : existingUi;
          const updatedUi: UIComponent[] = [
            { type: 'text', content: assistantMsg.content, style: 'success' },
            ...baseUi,
          ];
          session.playerUi['all'] = updatedUi;
          connStore.broadcast(session.id, { type: 'ui_update', ui: updatedUi });
          store.saveSession(session);
        }
      } else if (assistantMsg.content) {
        console.log(`${tag} LLM plain text after set_user_ui (ignored, not stored): ${assistantMsg.content.slice(0, 200)}`);
        // Do not push to history — noisy filler text that pollutes the context
      }
      console.log(`${tag} No tool calls — exiting game loop`);
      break;
    }

    // Record assistant message only when it actually has tool calls
    const llmMsg: LLMMessage = {
      role: 'assistant',
      content: assistantMsg.content ?? null,
      tool_calls: assistantMsg.tool_calls,
    };
    session.gameLlmMessages.push(llmMsg);

    console.log(`${tag} Tool calls: ${assistantMsg.tool_calls.map((t) => t.function.name).join(', ')}`);

    // Execute all tool calls and collect results
    let iterationHadError = false;
    directUiSet = false; // reset each iteration
    for (const toolCall of assistantMsg.tool_calls) {
      if (toolCall.function.name === 'set_user_ui') {
        uiWasSet = true;
        directUiSet = true;
      }
      if (toolCall.function.name === 'run_sequence') {
        // run_sequence may include set_ui steps — mark uiWasSet so we don't
        // inject a duplicate plain-text fallback after the sequence
        try {
          const seqArgs = JSON.parse(toolCall.function.arguments) as { steps?: Array<{ action: string }> };
          if (seqArgs.steps?.some((s) => s.action === 'set_ui')) uiWasSet = true;
        } catch { /* ignore parse errors — executeGameTool will handle it */ }
      }
      const result = await executeGameTool(session, toolCall);
      const resultStr = JSON.stringify(result);
      if (isToolError(result)) {
        iterationHadError = true;
        console.warn(`${tag} [tool] ${toolCall.function.name} returned error: ${(result as { error: string }).error}`);
      }
      session.gameLlmMessages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        name: toolCall.function.name,
        content: resultStr,
      });
    }

    if (iterationHadError) {
      consecutiveErrorIterations++;
      console.warn(`${tag} Consecutive error iterations: ${consecutiveErrorIterations}`);
      if (consecutiveErrorIterations >= 2) {
        const nudge = consecutiveErrorIterations >= 3
          ? `SYSTEM: Your last ${consecutiveErrorIterations} tool calls have all returned errors. ` +
            `Stop, re-read the RULES FOR TOOL USAGE in the system prompt, and fix your next call. ` +
            `Do NOT output plain text — use a proper tool call.`
          : `SYSTEM: The previous tool call returned an error (see result above). ` +
            `Please read the error message carefully and retry with the correct arguments.`;
        console.warn(`${tag} Injecting retry nudge (consecutive=${consecutiveErrorIterations})`);
        session.gameLlmMessages.push({ role: 'user', content: nudge });
      }
    } else {
      consecutiveErrorIterations = 0;
    }

    store.saveSession(session);

    // end_game tool sets status to 'finished'
    if (session.status === 'finished') {
      console.log(`${tag} Game finished — exiting loop`);
      break;
    }

    // Stop after a direct set_user_ui call so the LLM cannot overwrite its own
    // output in the next iteration. run_sequence is excluded: it manages its own
    // timing internally and the LLM may legitimately need another iteration after
    // the sequence completes (e.g. to compute score and then show the next screen).
    if (directUiSet) {
      console.log(`${tag} set_user_ui was called directly — exiting loop to await player input`);
      break;
    }
  }

  console.log(`${tag} ── Game loop done (${iterations} iteration(s)) ────────\n`);
}

// =============================================================================
// Tool executor
// =============================================================================

/** Structured error that the LLM will see as a tool result. */
function toolErr(message: string, fix?: string): { error: string; fix?: string } {
  return fix ? { error: message, fix } : { error: message };
}

function isToolError(result: unknown): boolean {
  return typeof result === 'object' && result !== null && 'error' in result;
}

const VALID_UI_TYPES = new Set([
  'text', 'input', 'button', 'multiple_choice', 'countdown',
  'scoreboard', 'form', 'list', 'divider',
]);

/**
 * Validate a ui[] array and return a toolErr if invalid, or null if valid.
 * @param ui      The candidate array (any unknown value).
 * @param context Human-readable prefix for error messages, e.g. "Step 2 ui".
 */
function validateUi(
  ui: unknown,
  context: string,
): ReturnType<typeof toolErr> | null {
  if (!Array.isArray(ui)) {
    return toolErr(
      `${context} must be an array of UI component objects.`,
      'Example: [{ "type": "text", "content": "Hello", "style": "body" }]',
    );
  }
  if (ui.length === 0) {
    return toolErr(
      `${context} array is empty. You must include at least one component.`,
      `Valid types: ${[...VALID_UI_TYPES].join(', ')}.`,
    );
  }
  const bad = (ui as Array<{ type?: unknown }>)
    .filter((c) => !c.type || !VALID_UI_TYPES.has(c.type as string))
    .map((c) => JSON.stringify(c.type));
  if (bad.length > 0) {
    return toolErr(
      `${context} contains unknown component type(s): ${bad.join(', ')}.`,
      `Valid types are: ${[...VALID_UI_TYPES].join(', ')}.`,
    );
  }
  return null;
}

async function executeGameTool(
  session: Session,
  toolCall: LLMToolCall,
): Promise<unknown> {
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(toolCall.function.arguments) as Record<string, unknown>;
  } catch {
    return toolErr(
      'Could not parse tool arguments as JSON.',
      'Ensure the arguments are a valid JSON object. Do not include comments or trailing commas.',
    );
  }

  const tag = `[game:${session.joinCode}]`;

  switch (toolCall.function.name) {
    case 'set_state_schema': {
      if (typeof args.schema !== 'object' || args.schema === null || Array.isArray(args.schema)) {
        return toolErr(
          '"schema" must be a non-null JSON object.',
          'Example: { "schema": { "type": "object", "properties": { "score": { "type": "number" } } } }',
        );
      }
      session.stateSchema = args.schema as Record<string, unknown>;
      console.log(`${tag} [tool] set_state_schema:`, JSON.stringify(args.schema, null, 2));
      return { success: true };
    }

    case 'get_state': {
      console.log(`${tag} [tool] get_state →`, JSON.stringify(session.gameState));
      return session.gameState;
    }

    case 'set_state': {
      if (typeof args.state !== 'object' || args.state === null || Array.isArray(args.state)) {
        return toolErr(
          '"state" must be a non-null JSON object.',
          'Example: { "state": { "score": 0, "round": 1 } }',
        );
      }
      const incoming = args.state as Record<string, unknown>;
      if (args.merge === true) {
        session.gameState = { ...session.gameState, ...incoming };
      } else {
        session.gameState = incoming;
      }
      console.log(`${tag} [tool] set_state (merge=${args.merge ?? false}):`, JSON.stringify(session.gameState, null, 2));
      connStore.broadcast(session.id, { type: 'state_update', state: session.gameState });
      return { success: true };
    }

    case 'set_user_ui': {
      if (typeof args.playerId !== 'string' || args.playerId.trim() === '') {
        return toolErr(
          '"playerId" must be a non-empty string.',
          'Use "all" to target all players, or a specific player ID. ' +
          'For single-player games always use "all".',
        );
      }
      const uiErr = validateUi(args.ui, '"ui"');
      if (uiErr) return uiErr;
      const playerId = args.playerId as string;
      const ui = args.ui as UIComponent[];
      session.playerUi[playerId] = ui;
      const componentSummary = ui.map((c) => c.type).join(', ');
      console.log(`${tag} [tool] set_user_ui → player:${playerId} | components: [${componentSummary}]`);
      console.log(`${tag} [tool] set_user_ui payload:\n${JSON.stringify(ui, null, 2)}`);
      if (playerId === 'all') {
        connStore.broadcast(session.id, { type: 'ui_update', ui });
      } else {
        connStore.sendToPlayer(session.id, playerId, { type: 'ui_update', ui });
      }
      const INTERACTIVE_TYPES = new Set(['button', 'input', 'multiple_choice', 'form']);
      const hasInteraction = (ui as Array<{ type: string }>).some((c) => INTERACTIVE_TYPES.has(c.type));
      if (!hasInteraction) {
        return {
          success: true,
          warning:
            'This UI has no interactive elements (no button, input, multiple_choice, or form). ' +
            'The player will be unable to do anything unless a timer or run_sequence will advance the game. ' +
            'If you are waiting for the player to respond, call set_user_ui again with at least one interactive component.',
        };
      }
      return { success: true };
    }

    case 'run_sequence': {
      if (!Array.isArray(args.steps) || args.steps.length === 0) {
        return toolErr(
          '"steps" must be a non-empty array.',
          'Each step needs an "action" field ("set_ui" or "set_state"). ' +
          'set_ui steps need "playerId" and "ui". set_state steps need "state". ' +
          'Add "delayBefore" (seconds) to control how long the previous step stays on screen.',
        );
      }
      const rawSteps = args.steps as Array<Record<string, unknown>>;
      for (let i = 0; i < rawSteps.length; i++) {
        const s = rawSteps[i];
        if (s['action'] !== 'set_ui' && s['action'] !== 'set_state') {
          return toolErr(
            `Step ${i} has invalid action "${String(s['action'])}".`,
            'Each step\'s "action" must be either "set_ui" or "set_state".',
          );
        }
        if (s['action'] === 'set_ui') {
          const stepUiErr = validateUi(s['ui'], `Step ${i} "ui"`);
          if (stepUiErr) return stepUiErr;
        }
        if (s['action'] === 'set_state' && (typeof s['state'] !== 'object' || s['state'] === null)) {
          return toolErr(
            `Step ${i}: set_state step is missing a "state" object.`,
            'Add a "state" field with the state object to apply.',
          );
        }
      }
      const steps = rawSteps as Array<{
        action: 'set_ui' | 'set_state';
        delayBefore?: number;
        playerId?: string;
        ui?: UIComponent[];
        state?: Record<string, unknown>;
        merge?: boolean;
      }>;
      console.log(`${tag} [tool] run_sequence: ${steps.length} step(s)`);

      // The LLM is NOT being called during the sequence — hide the thinking spinner.
      connStore.broadcast(session.id, { type: 'ai_thinking', thinking: false });

      for (let i = 0; i < steps.length; i++) {
        // Check cancellation before each step
        const current = store.getSession(session.id);
        if (!current || current.status !== 'playing') {
          console.log(`${tag} [tool] run_sequence aborted at step ${i} — session no longer playing`);
          return { success: false, reason: 'session_ended', stepsCompleted: i };
        }

        const step = steps[i];
        if (step.delayBefore && step.delayBefore > 0) {
          await new Promise<void>((resolve) => setTimeout(resolve, step.delayBefore! * 1000));
          // Re-check after delay
          const currentAfterDelay = store.getSession(session.id);
          if (!currentAfterDelay || currentAfterDelay.status !== 'playing') {
            console.log(`${tag} [tool] run_sequence aborted after delay at step ${i}`);
            return { success: false, reason: 'session_ended', stepsCompleted: i };
          }
        }

        if (step.action === 'set_ui') {
          const playerId = step.playerId ?? 'all';
          const ui = step.ui ?? [];
          session.playerUi[playerId] = ui;
          const componentSummary = ui.map((c) => c.type).join(', ');
          console.log(`${tag} [tool] run_sequence step ${i + 1}/${steps.length}: set_ui player:${playerId} [${componentSummary}]`);
          if (playerId === 'all') {
            connStore.broadcast(session.id, { type: 'ui_update', ui });
          } else {
            connStore.sendToPlayer(session.id, playerId, { type: 'ui_update', ui });
          }
        } else if (step.action === 'set_state') {
          const incoming = step.state ?? {};
          session.gameState = step.merge === true
            ? { ...session.gameState, ...incoming }
            : incoming;
          console.log(`${tag} [tool] run_sequence step ${i + 1}/${steps.length}: set_state`, JSON.stringify(session.gameState));
          connStore.broadcast(session.id, { type: 'state_update', state: session.gameState });
        }

        store.saveSession(session);
      }

      console.log(`${tag} [tool] run_sequence complete (${steps.length} steps)`);
      // Sequence done — re-show the thinking spinner for the next LLM call.
      connStore.broadcast(session.id, { type: 'ai_thinking', thinking: true });
      return { success: true, stepsCompleted: steps.length };
    }

    case 'start_timer': {
      if (typeof args.timerId !== 'string' || args.timerId.trim() === '') {
        return toolErr(
          '"timerId" must be a non-empty string.',
          'Use a descriptive ID like "answer-timer" or "question-1". Must be unique per active timer.',
        );
      }
      if (typeof args.seconds !== 'number' || args.seconds <= 0) {
        return toolErr(
          '"seconds" must be a positive number.',
          'Example: { "timerId": "answer-timer", "seconds": 30 }',
        );
      }
      const timerId = args.timerId as string;
      const seconds = args.seconds as number;
      console.log(`${tag} [tool] start_timer id:${timerId} seconds:${seconds}`);
      startTimer(session.id, timerId, seconds);
      return { success: true };
    }

    case 'update_rules': {
      if (typeof args.amendment !== 'string' || args.amendment.trim() === '') {
        return toolErr(
          '"amendment" must be a non-empty string.',
          'Describe the rule change concisely, e.g. "Scoring changed: +3 correct, -1 wrong".',
        );
      }
      const amendment = args.amendment as string;
      session.agreedRules = (session.agreedRules ?? '') + `\n\n[AMENDMENT] ${amendment}`;
      console.log(`${tag} [tool] update_rules: ${amendment}`);
      connStore.broadcast(session.id, {
        type: 'status_change',
        status: session.status,
        agreedRules: session.agreedRules,
      });
      return { success: true };
    }

    case 'end_game': {
      if (typeof args.message !== 'string' || args.message.trim() === '') {
        return toolErr(
          '"message" must be a non-empty string.',
          'Provide a human-readable end-of-game message, e.g. "Alice wins with 15 points!".',
        );
      }
      if (typeof args.results !== 'object' || args.results === null || Array.isArray(args.results)) {
        return toolErr(
          '"results" must be a non-null JSON object.',
          'Example: { "results": { "winner": "Alice", "scores": { "Alice": 15, "Bob": 10 } } }',
        );
      }
      session.status = 'finished';
      const finalUi = args.ui as UIComponent[] | undefined;
      console.log(`${tag} [tool] end_game message: ${args.message}`);
      console.log(`${tag} [tool] end_game results:`, JSON.stringify(args.results, null, 2));
      connStore.broadcast(session.id, { type: 'status_change', status: 'finished', message: args.message });
      if (finalUi) {
        connStore.broadcast(session.id, { type: 'ui_update', ui: finalUi });
      }
      return { success: true };
    }

    default:
      console.warn(`${tag} [tool] Unknown tool called: ${toolCall.function.name}`);
      return toolErr(
        `Unknown tool "${toolCall.function.name}".`,
        `Valid tools are: ${[...GAME_TOOL_NAMES].join(', ')}.`,
      );
  }
}

// =============================================================================
// Timer expiry handler
// =============================================================================

async function handleTimerExpired(
  sessionId: string,
  timerId: string,
  seconds: number,
): Promise<void> {
  const session = store.getSession(sessionId);
  if (!session || session.status !== 'playing') return;

  console.log(`[game:${session.joinCode}] ⏰ Timer expired: ${timerId}`);
  connStore.broadcast(sessionId, { type: 'timer_expired', timerId });

  session.gameLlmMessages.push({
    role: 'user',
    content: `Timer "${timerId}" has expired (${seconds}s limit). Process the timeout — award or deduct points as per the rules, then advance the game.`,
  });

  connStore.broadcast(sessionId, { type: 'ai_thinking', thinking: true });
  try {
    await runGameLoop(session);
    store.saveSession(session);
  } finally {
    connStore.broadcast(sessionId, { type: 'ai_thinking', thinking: false });
  }
}

// =============================================================================
// Public API
// =============================================================================

/** Called when a player sends a chat message during the definition phase. */
export async function handleDefinitionMessage(
  sessionId: string,
  playerName: string,
  content: string,
): Promise<void> {
  const session = store.getSession(sessionId);
  if (!session) return;

  // Record player chat message
  const playerMsg: ChatMessage = {
    id: uuid(),
    role: 'player',
    playerName,
    content,
    timestamp: new Date().toISOString(),
  };
  session.chatHistory.push(playerMsg);
  connStore.broadcast(sessionId, { type: 'chat_message', message: playerMsg });

  // Add to LLM history
  session.definitionLlmMessages.push({
    role: 'user',
    content: `[${playerName}]: ${content}`,
  });

  const defTag = `[define:${session.joinCode}]`;
  console.log(`${defTag} Player message from ${playerName}: ${content}`);
  connStore.broadcast(sessionId, { type: 'ai_thinking', thinking: true });

  try {
    const playerNames = session.players.map((p) => p.name);
    console.log(`${defTag} Calling LLM (${session.definitionLlmMessages.length} messages in history)…`);
    const response = await chat({
      messages: [
        { role: 'system', content: definitionPrompt(playerNames, session.agreedRules) },
        ...session.definitionLlmMessages,
      ],
      tools: definitionTools,
    });

    const assistantMsg = response.choices[0].message;
    const finishReason = response.choices[0].finish_reason;
    console.log(`${defTag} LLM finish_reason: ${finishReason}`);

    // Record assistant response
    session.definitionLlmMessages.push({
      role: 'assistant',
      content: assistantMsg.content ?? null,
      tool_calls: assistantMsg.tool_calls,
    });

    // Broadcast any plain-text response as an AI chat message
    if (assistantMsg.content) {
      console.log(`${defTag} AI text: ${assistantMsg.content.slice(0, 300)}`);
      addAiChatMessage(session, assistantMsg.content);
    }

    // Handle tool calls
    if (assistantMsg.tool_calls) {
      for (const toolCall of assistantMsg.tool_calls) {
        if (toolCall.function.name === 'propose_rules') {
          let toolArgs: { summary: string };
          try {
            toolArgs = JSON.parse(toolCall.function.arguments) as { summary: string };
          } catch {
            continue;
          }

          session.agreedRules = toolArgs.summary;
          console.log(`${defTag} ✅ Rules proposed:\n${toolArgs.summary}`);

          // Add tool result to LLM history
          session.definitionLlmMessages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            name: 'propose_rules',
            content: 'Rules proposed. Waiting for host confirmation.',
          });

          // Show rules in chat and prompt host to confirm
          addSystemChatMessage(
            session,
            `📋 **Proposed rules:**\n\n${toolArgs.summary}\n\n*The host can now start the game.*`,
          );

          connStore.broadcast(sessionId, {
            type: 'status_change',
            status: 'defining',
            agreedRules: toolArgs.summary,
          });
        }
      }
    }

    store.saveSession(session);
  } finally {
    connStore.broadcast(sessionId, { type: 'ai_thinking', thinking: false });
  }
}

/** Called by the host to confirm rules and start the game. */
export async function startGame(sessionId: string): Promise<void> {
  const session = store.getSession(sessionId);
  if (!session || !session.agreedRules) return;

  clearLogs();
  const startTag = `[start:${session.joinCode}]`;
  console.log(`${startTag} 🚀 Host confirmed rules — starting game`);
  session.status = 'playing';
  session.gameLlmMessages = [];

  connStore.broadcast(sessionId, {
    type: 'status_change',
    status: 'playing',
    agreedRules: session.agreedRules,
  });

  const playerList = session.players
    .map((p) => `${p.name} (id: ${p.id})`)
    .join(', ');
  console.log(`${startTag} Players: ${playerList}`);

  session.gameLlmMessages.push({
    role: 'user',
    content: `Game is starting. Players: ${playerList}. Initialize the game state, create the first screen, and start the game.`,
  });

  connStore.broadcast(sessionId, { type: 'ai_thinking', thinking: true });
  try {
    await runGameLoop(session);
    store.saveSession(session);
  } finally {
    connStore.broadcast(sessionId, { type: 'ai_thinking', thinking: false });
  }
}

/** Called when a player submits a form during the playing phase. */
export async function handleFormSubmit(
  sessionId: string,
  playerId: string,
  playerName: string,
  formId: string,
  values: Record<string, string>,
): Promise<void> {
  const session = store.getSession(sessionId);
  if (!session || session.status !== 'playing') return;

  console.log(`[game:${session.joinCode}] 📝 Form submit — player:${playerName} form:${formId} values:${JSON.stringify(values)}`);
  session.gameLlmMessages.push({
    role: 'user',
    content: `Player ${playerName} (id: ${playerId}) submitted form "${formId}" with values: ${JSON.stringify(values)}`,
  });

  connStore.broadcast(sessionId, { type: 'ai_thinking', thinking: true });
  try {
    await runGameLoop(session);
    store.saveSession(session);
  } finally {
    connStore.broadcast(sessionId, { type: 'ai_thinking', thinking: false });
  }
}

/** Called when a player clicks an action button during the playing phase. */
export async function handleAction(
  sessionId: string,
  playerId: string,
  playerName: string,
  actionId: string,
): Promise<void> {
  const session = store.getSession(sessionId);
  if (!session || session.status !== 'playing') return;

  console.log(`[game:${session.joinCode}] 🖱️  Action — player:${playerName} actionId:${actionId}`);
  session.gameLlmMessages.push({
    role: 'user',
    content: `Player ${playerName} (id: ${playerId}) clicked action "${actionId}".`,
  });

  connStore.broadcast(sessionId, { type: 'ai_thinking', thinking: true });
  try {
    await runGameLoop(session);
    store.saveSession(session);
  } finally {
    connStore.broadcast(sessionId, { type: 'ai_thinking', thinking: false });
  }
}

/** Called when the host sends a mid-game tweak instruction. */
export async function handleGameTweak(
  sessionId: string,
  playerName: string,
  content: string,
): Promise<void> {
  const session = store.getSession(sessionId);
  if (!session || session.status !== 'playing') return;

  console.log(`[game:${session.joinCode}] 🎛️  Host tweak from ${playerName}: ${content}`);
  session.gameLlmMessages.push({
    role: 'user',
    content: `[HOST ADJUSTMENT from ${playerName}]: ${content}`,
  });

  connStore.broadcast(sessionId, { type: 'ai_thinking', thinking: true });
  try {
    await runGameLoop(session);
    store.saveSession(session);
  } finally {
    connStore.broadcast(sessionId, { type: 'ai_thinking', thinking: false });
  }
}

export { toPublicSession };
