import { Player, UIComponent, LLMMessage, PendingTurn, PlayerResponse, AnswerKey } from '../types';

const comparable = (s: string) =>
  s.toLowerCase().replace(/^\s*(the|a|an)\s+/, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * Find the option an answer key refers to: exact, then ignoring case/articles/
 * punctuation, then a letter ("B") or 1-based number, then a unique partial match.
 */
export function matchOption(value: string, options: string[]): string | undefined {
  const v = value.trim();
  const exact = options.find((o) => sameAnswer(o, v));
  if (exact) return exact;
  const cv = comparable(v);
  const loose = options.find((o) => comparable(o) === cv);
  if (loose) return loose;
  const letter = /^[A-Fa-f]$/.test(v) ? v.toUpperCase().charCodeAt(0) - 65 : /^\d$/.test(v) ? Number(v) - 1 : -1;
  if (letter >= 0 && letter < options.length) return options[letter];
  const partial = options.filter((o) => cv && (comparable(o).includes(cv) || cv.includes(comparable(o))));
  return partial.length === 1 ? partial[0] : undefined;
}

/** Answers match regardless of case and surrounding spaces. */
export function sameAnswer(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}
import { GamePlan, Progress, RESERVED_STATE_KEYS, advance, parsePlan, phaseTimer } from './plan';

// =============================================================================
// next_turn parsing and validation
//
// Small models make predictable mistakes (aliases like "text" for "content",
// player names instead of ids, a countdown component instead of timer_seconds).
// Harmless ones are normalised here; real problems become error messages that
// are sent back to the model so it can fix its call.
// =============================================================================

export interface IntroSlide {
  screen: UIComponent[];
  seconds: number;
}

export interface ParsedTurn {
  stateUpdate?: Record<string, unknown>;
  /** Items appended to array keys, so growing lists are not rewritten every turn. */
  stateAppend?: Record<string, unknown[]>;
  /** Numbers added by the server (scores), so the model does not do arithmetic. */
  stateAdd?: Record<string, unknown>;
  /** A short-timer screen nobody can act on (a slide shown as its own turn). */
  isSlide: boolean;
  /** Keyed by 'all' or a real player id. */
  screens: Record<string, UIComponent[]>;
  waitFor: 'any' | 'all';
  timerSeconds?: number;
  intro: IntroSlide[];
  gameOver?: { message: string };
  ruleChange?: string;
  /** Intro slides followed by a screen nobody can act on: ask the AI again right after the slides. */
  autoContinue: boolean;
  /** A new or changed game plan from this turn. */
  plan?: GamePlan;
  /** Round/phase after this turn (only for games with a plan). */
  progress?: Progress;
}

export type ParseResult = { ok: true; turn: ParsedTurn } | { ok: false; errors: string[] };

export const INTERACTIVE_TYPES = new Set(['button', 'input', 'multiple_choice', 'form']);
const TEXT_STYLES = new Set(['heading', 'subheading', 'body', 'muted', 'success', 'error']);
const BUTTON_STYLES = new Set(['primary', 'secondary', 'danger']);
const MAX_TIMER_SECONDS = 600;
const MAX_INTRO_SECONDS = 30;
/** A timer this short on a screen nobody can act on is a slide, not a waiting period. */
const SLIDE_TIMER_MAX = 5;

const asString = (v: unknown): string | undefined =>
  typeof v === 'string' ? v : typeof v === 'number' ? String(v) : undefined;

const PLACEHOLDERS = new Set(['', 'none', 'n/a', 'na', 'null', 'no', 'false', '-', 'no change', 'nothing']);
/** A string that carries information (not "None", "N/A", ""…). */
const meaningful = (v: string | undefined): string | undefined =>
  v !== undefined && !PLACEHOLDERS.has(v.trim().toLowerCase()) ? v.trim() : undefined;

/** Parse tool-call arguments, tolerating code fences and objects passed as-is. */
export function parseArguments(raw: unknown): Record<string, unknown> | null {
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== 'string') return null;
  const obj = extractJsonObject(raw);
  return obj;
}

/** Find the outermost JSON object in a string (handles ```json fences and prose around it). */
export function extractJsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Some models write the tool call as JSON text instead of using tool calling.
 * Accepts {"name":"next_turn","arguments":{...}}, {"next_turn":{...}} or bare
 * next_turn arguments ({"screens": ...}).
 */
export function tryParsePseudoNextTurn(content: string | null | undefined): Record<string, unknown> | null {
  if (!content) return null;
  const obj = extractJsonObject(content);
  if (!obj) return null;
  if (obj.name === 'next_turn') return parseArguments(obj.arguments ?? obj.parameters ?? {});
  if (typeof obj.next_turn === 'object' && obj.next_turn !== null) return obj.next_turn as Record<string, unknown>;
  if (typeof obj.screens === 'object' && obj.screens !== null) return obj;
  return null;
}

// ─── Components ──────────────────────────────────────────────────────────────

interface ComponentResult {
  component?: UIComponent;
  /** Seconds from a countdown component the model added by itself. */
  impliedTimer?: number;
  error?: string;
}

function normalizeComponent(raw: unknown, where: string): ComponentResult {
  if (typeof raw === 'string') return { component: { type: 'text', content: raw } };
  if (typeof raw !== 'object' || raw === null) return { error: `${where} must be an object with a "type".` };
  const c = raw as Record<string, unknown>;
  const type = asString(c.type)?.toLowerCase();

  switch (type) {
    case 'text':
    case 'heading':
    case 'subheading':
    case 'body':
    case 'muted':
    case 'success':
    case 'error': {
      // A text style used as the type ({"type": "body"}) means a text component.
      const content = asString(c.content) ?? asString(c.text) ?? asString(c.value);
      if (content === undefined) return { error: `${where} (text) needs "content".` };
      const rawStyle = asString(c.style) ?? (type !== 'text' ? type : undefined);
      const style = rawStyle && TEXT_STYLES.has(rawStyle) ? rawStyle : undefined;
      return { component: { type: 'text', content, ...(style ? { style: style as never } : {}) } };
    }
    case 'multiple_choice':
    case 'choice':
    case 'vote': {
      const fieldId = asString(c.fieldId) ?? asString(c.id) ?? (type === 'vote' ? 'vote' : 'answer');
      const question = asString(c.question) ?? asString(c.label) ?? '';
      // "options": "other_players" / "players" (or player_options) → the server lists the players per viewer
      const explicit = asString(c.player_options);
      const fromOptions = typeof c.options === 'string' && /player/i.test(c.options) ? c.options : undefined;
      const playerSource = explicit ?? fromOptions;
      if (playerSource) {
        const playerOptions = /other|except|not/i.test(playerSource) ? 'others' : 'all';
        // Extra options (e.g. "I don't know") are listed after the players.
        const extra = Array.isArray(c.options) ? c.options.map((o) => String(typeof o === 'object' && o !== null ? (o as Record<string, unknown>).label ?? '' : o)).filter(Boolean) : [];
        return { component: { type: 'multiple_choice', fieldId, question, options: extra, playerOptions } };
      }
      const rawOptions = (c.options ?? c.choices) as unknown;
      if (!Array.isArray(rawOptions) || rawOptions.length < 2) {
        return {
          error: `${where} (multiple_choice) needs "options" with at least 2 entries, or "options": "other_players" to vote for a player.`,
        };
      }
      const owners: string[] = [];
      const options = rawOptions.map((o) => {
        if (typeof o === 'object' && o !== null) {
          const obj = o as Record<string, unknown>;
          owners.push(asString(obj.owner) ?? asString(obj.author) ?? asString(obj.player) ?? '');
          return asString(obj.label) ?? asString(obj.text) ?? asString(obj.answer) ?? JSON.stringify(o);
        }
        owners.push('');
        return String(o);
      });
      // Optional answer key: the server checks answers and gives points by itself.
      let answerKey: AnswerKey | undefined;
      const rawCorrect = c.correct ?? c.correct_answer ?? c.answer;
      if (rawCorrect !== undefined && rawCorrect !== null && rawCorrect !== '') {
        // Match leniently ("Bronze Age" = "The Bronze Age", "B" = second option); never stall over it.
        const correct = (Array.isArray(rawCorrect) ? rawCorrect : [rawCorrect])
          .map((x) => matchOption(String(x), options))
          .filter((x): x is string => x !== undefined);
        if (correct.length) {
          const points = Number(c.points ?? 1);
          // A "penalty" is never a reward: models sometimes write penalty 2 meaning -2.
          const penalty = -Math.abs(Number(c.penalty ?? 0));
          answerKey = { correct, points: Number.isFinite(points) ? points : 1, penalty: Number.isFinite(penalty) ? penalty : 0 };
        }
      }
      return {
        component: {
          type: 'multiple_choice',
          fieldId,
          question,
          options,
          ...(owners.some(Boolean) ? { owners } : {}),
          ...(answerKey ? { answerKey } : {}),
        },
      };
    }
    case 'button': {
      const label = asString(c.label) ?? asString(c.text) ?? asString(c.content);
      const actionId = asString(c.actionId) ?? asString(c.action) ?? asString(c.id) ?? label;
      if (!label || !actionId) return { error: `${where} (button) needs "label" and "actionId".` };
      return {
        component: {
          type: 'button',
          label,
          actionId,
          ...(BUTTON_STYLES.has(asString(c.style) ?? '') ? { style: asString(c.style) as never } : {}),
        },
      };
    }
    case 'input':
    case 'text_input': {
      const fieldId = asString(c.fieldId) ?? asString(c.id) ?? asString(c.name);
      if (!fieldId) return { error: `${where} (input) needs "fieldId".` };
      return {
        component: {
          type: 'input',
          fieldId,
          ...(asString(c.label) ? { label: asString(c.label) } : {}),
          ...(asString(c.placeholder) ? { placeholder: asString(c.placeholder) } : {}),
          ...(typeof c.maxLength === 'number' ? { maxLength: c.maxLength } : {}),
          ...(c.multiline === true ? { multiline: true } : {}),
        },
      };
    }
    case 'form': {
      const rawFields = (c.fields ?? c.inputs) as unknown;
      if (!Array.isArray(rawFields) || rawFields.length === 0) return { error: `${where} (form) needs "fields" (input components).` };
      const fields: UIComponent[] = [];
      for (let i = 0; i < rawFields.length; i++) {
        const f = rawFields[i] as Record<string, unknown>;
        const r = normalizeComponent(
          typeof f === 'object' && f !== null && !f.type ? { ...f, type: 'input' } : f,
          `${where}.fields[${i}]`,
        );
        if (r.error) return { error: r.error };
        if (r.component) fields.push(r.component);
      }
      if (!fields.some((f) => f.type === 'input')) return { error: `${where} (form) needs at least one input field.` };
      const formId = asString(c.formId) ?? asString(c.id) ?? 'form';
      return { component: { type: 'form', formId, fields, ...(asString(c.submitLabel) ? { submitLabel: asString(c.submitLabel) } : {}) } };
    }
    case 'scoreboard': {
      let rawPlayers = (c.players ?? c.scores) as unknown;
      // Accept {"Ana": 3, "Bob": 1}
      if (typeof rawPlayers === 'object' && rawPlayers !== null && !Array.isArray(rawPlayers)) {
        rawPlayers = Object.entries(rawPlayers as Record<string, unknown>).map(([name, score]) => ({ name, score }));
      }
      if (!Array.isArray(rawPlayers)) return { error: `${where} (scoreboard) needs "players": [{"name": "...", "score": 0}].` };
      const players = rawPlayers.map((p) => {
        const o = (typeof p === 'object' && p !== null ? p : {}) as Record<string, unknown>;
        const name = asString(o.name) ?? asString(o.player) ?? '?';
        const score = Number(o.score ?? o.points ?? 0);
        return { id: asString(o.id) ?? name, name, score: Number.isFinite(score) ? score : 0 };
      });
      return { component: { type: 'scoreboard', players } };
    }
    case 'list': {
      if (!Array.isArray(c.items)) return { error: `${where} (list) needs "items": an array of strings.` };
      const items = c.items.map((i) => (typeof i === 'string' ? i : JSON.stringify(i)));
      return { component: { type: 'list', items, ...(c.ordered === true ? { ordered: true } : {}) } };
    }
    case 'divider':
      return { component: { type: 'divider' } };
    case 'countdown':
    case 'timer': {
      // The server owns countdowns; turn this into timer_seconds.
      const seconds = Number(c.seconds ?? c.duration);
      return Number.isFinite(seconds) && seconds > 0 ? { impliedTimer: seconds } : {};
    }
    default:
      return {
        error: `${where} has unknown type ${JSON.stringify(c.type)}. ` +
          'Use one of: text, multiple_choice, button, input, form, scoreboard, list, divider.',
      };
  }
}

function normalizeScreen(raw: unknown, where: string, errors: string[]): { ui: UIComponent[]; impliedTimer?: number } {
  const list = Array.isArray(raw) ? raw : typeof raw === 'object' && raw !== null ? [raw] : null;
  if (!list) {
    errors.push(`${where} must be an array of components.`);
    return { ui: [] };
  }
  const ui: UIComponent[] = [];
  let impliedTimer: number | undefined;
  list.forEach((item, i) => {
    const r = normalizeComponent(item, `${where}[${i}]`);
    if (r.error) errors.push(r.error);
    if (r.component) ui.push(r.component);
    if (r.impliedTimer) impliedTimer = r.impliedTimer;
  });
  if (list.length > 0 && ui.length === 0 && !impliedTimer && errors.length === 0) {
    errors.push(`${where} is empty.`);
  }
  const hasInput = ui.some((c) => c.type === 'input');
  const hasButton = ui.some((c) => c.type === 'button');
  if (hasInput && !hasButton) {
    errors.push(`${where} has an input but no button to submit it. Add a button, or put the input in a form.`);
  }
  return { ui, impliedTimer };
}

export function isInteractive(ui: UIComponent[]): boolean {
  return ui.some((c) => INTERACTIVE_TYPES.has(c.type));
}

// ─── Screens & players ───────────────────────────────────────────────────────

/** Map a screens key ("all", a player id, or a player name) to 'all' or a player id. */
function resolveTarget(key: string, players: Player[]): string | null {
  const k = key.trim().toLowerCase();
  if (k === 'all' || k === 'everyone' || k === '*') return 'all';
  const byId = players.find((p) => p.id.toLowerCase() === k);
  if (byId) return byId.id;
  const byName = players.find((p) => p.name.trim().toLowerCase() === k);
  return byName ? byName.id : null;
}

const WAITING_SCREEN: UIComponent[] = [{ type: 'text', content: 'Waiting for the other players…', style: 'muted' }];

function isPlayer(ref: string, player: Player): boolean {
  const r = ref.trim().toLowerCase();
  return r !== '' && (r === player.id.toLowerCase() || r === player.name.trim().toLowerCase());
}

/**
 * Resolve per-viewer parts of a screen: player-name options ("vote for
 * another player") and options owned by the viewer (their own answer).
 */
export function personalize(ui: UIComponent[], viewerId: string, players: Player[]): UIComponent[] {
  const viewer = players.find((p) => p.id === viewerId);
  return ui.map((c) => {
    if (c.type !== 'multiple_choice' || (!c.playerOptions && !c.owners && !c.answerKey)) return c;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { playerOptions, owners, answerKey, ...base } = c;
    let options = base.options;
    if (playerOptions) {
      options = [...players.filter((p) => playerOptions === 'all' || p.id !== viewerId).map((p) => p.name), ...base.options];
    } else if (owners && viewer) {
      options = options.filter((_, i) => !isPlayer(owners[i] ?? '', viewer));
    }
    if (options.length === 0) return { type: 'text', content: 'Nothing for you to vote on this time.', style: 'muted' };
    return { ...base, options };
  });
}

/** The screen a given player should see for this turn (personalized when players are given). */
export function screenFor(screens: Record<string, UIComponent[]>, playerId: string, players?: Player[]): UIComponent[] {
  const ui = screens[playerId] ?? screens.all ?? WAITING_SCREEN;
  return players ? personalize(ui, playerId, players) : ui;
}

/** Answer keys on a player's screen (before personalizing strips them), by fieldId. */
export function answerKeysFor(screens: Record<string, UIComponent[]>, playerId: string): Record<string, AnswerKey> {
  const keys: Record<string, AnswerKey> = {};
  for (const c of screenFor(screens, playerId)) {
    if (c.type === 'multiple_choice' && c.answerKey) keys[c.fieldId] = c.answerKey;
  }
  return keys;
}

/** Players who have something to click or fill in on their screen. */
export function expectedResponders(screens: Record<string, UIComponent[]>, players: Player[]): string[] {
  return players.filter((p) => isInteractive(screenFor(screens, p.id, players))).map((p) => p.id);
}

// ─── next_turn ───────────────────────────────────────────────────────────────

export interface ParseOptions {
  /** false right after an auto-continue (no endless chains). */
  allowAutoContinue?: boolean;
  /** The game-start turn may be a splash screen. */
  isFirstTurn?: boolean;
  /** The previous turn was already a short-timer slide. */
  previousWasSlide?: boolean;
  /** The game's current plan and progress, if it has one. */
  plan?: GamePlan;
  progress?: Progress;
}

export function parseNextTurn(
  args: Record<string, unknown> | null,
  players: Player[],
  options: ParseOptions = {},
): ParseResult {
  if (!args) return { ok: false, errors: ['The arguments are not a valid JSON object.'] };
  const errors: string[] = [];
  let impliedTimer: number | undefined;

  // state_update (also accept "state")
  let stateUpdate: Record<string, unknown> | undefined;
  const rawState = args.state_update ?? args.state;
  if (rawState !== undefined && rawState !== null) {
    if (typeof rawState !== 'object' || Array.isArray(rawState)) errors.push('"state_update" must be an object of key/value pairs.');
    else {
      // plan / progress / answers are kept by the server
      stateUpdate = Object.fromEntries(
        Object.entries(rawState as Record<string, unknown>).filter(([k]) => !RESERVED_STATE_KEYS.includes(k)),
      );
    }
  }

  // Game plan: a new plan from this turn, or the existing one; then where we are in it.
  // Small models often put the plan inside state_update; accept it from there too.
  const rawPlan = args.plan ?? (typeof rawState === 'object' && rawState !== null ? (rawState as Record<string, unknown>).plan : undefined);
  const planResult = parsePlan(rawPlan);
  if (planResult.error) errors.push(planResult.error);
  const plan = planResult.plan ?? options.plan;
  let progress: Progress | undefined;
  if (plan) {
    // A replaced plan keeps the current position when that phase still exists.
    const current = planResult.plan && options.progress && !plan.phases.some((p) => p.id === options.progress!.phase)
      ? undefined
      : options.progress;
    const round = args.round === undefined || args.round === null ? undefined : Number(args.round);
    progress = advance(plan, current, asString(args.phase)?.trim(), round);
  }

  let stateAdd: Record<string, unknown> | undefined;
  if (args.state_add !== undefined && args.state_add !== null) {
    if (typeof args.state_add !== 'object' || Array.isArray(args.state_add)) {
      errors.push('"state_add" must be an object like {"scores": {"Ana": 2}}.');
    } else {
      stateAdd = args.state_add as Record<string, unknown>;
    }
  }

  let stateAppend: Record<string, unknown[]> | undefined;
  if (args.state_append !== undefined && args.state_append !== null) {
    if (typeof args.state_append !== 'object' || Array.isArray(args.state_append)) {
      errors.push('"state_append" must be an object like {"history": [new items]}.');
    } else {
      stateAppend = {};
      for (const [k, v] of Object.entries(args.state_append as Record<string, unknown>)) {
        stateAppend[k] = Array.isArray(v) ? v : [v];
      }
    }
  }

  // screens (also accept a bare array or "ui" as the "all" screen)
  let rawScreens = args.screens ?? args.ui;
  if (Array.isArray(rawScreens)) rawScreens = { all: rawScreens };
  const screens: Record<string, UIComponent[]> = {};
  if (typeof rawScreens !== 'object' || rawScreens === null) {
    errors.push('"screens" is required: {"all": [components]} and/or {"<player id>": [components]}.');
  } else {
    for (const [key, value] of Object.entries(rawScreens as Record<string, unknown>)) {
      const target = resolveTarget(key, players);
      if (!target) {
        errors.push(
          `screens key "${key}" is not "all" or a player id. Valid keys: "all", ` +
            players.map((p) => `"${p.id}" (${p.name})`).join(', ') + '.',
        );
        continue;
      }
      const r = normalizeScreen(value, `screens.${key}`, errors);
      screens[target] = r.ui;
      if (r.impliedTimer) impliedTimer = r.impliedTimer;
    }
    if (Object.keys(screens).length === 0 && errors.length === 0) errors.push('"screens" is empty.');
  }

  const rawWait = asString(args.wait_for)?.toLowerCase();
  const waitFor: 'any' | 'all' = rawWait === 'all' ? 'all' : 'any';

  let timerSeconds: number | undefined;
  // 0 / null / "" mean "no timer" (models fill optional fields with placeholders)
  const rawTimer = args.timer_seconds || impliedTimer;
  if (rawTimer !== undefined && rawTimer !== null && rawTimer !== '' && rawTimer !== 0) {
    const t = Number(rawTimer);
    if (!Number.isFinite(t) || t <= 0 || t > MAX_TIMER_SECONDS) errors.push(`"timer_seconds" must be between 1 and ${MAX_TIMER_SECONDS}.`);
    else timerSeconds = Math.round(t);
  }

  const intro: IntroSlide[] = [];
  if (args.intro !== undefined && args.intro !== null) {
    if (!Array.isArray(args.intro)) errors.push('"intro" must be an array of {"screen": [...], "seconds": n}.');
    else {
      args.intro.forEach((s, i) => {
        const slide = (typeof s === 'object' && s !== null ? s : {}) as Record<string, unknown>;
        const seconds = Number(slide.seconds ?? slide.delay ?? 2);
        if (!Number.isFinite(seconds) || seconds <= 0 || seconds > MAX_INTRO_SECONDS) {
          errors.push(`intro[${i}].seconds must be between 1 and ${MAX_INTRO_SECONDS}.`);
        }
        const r = normalizeScreen(slide.screen ?? slide.ui, `intro[${i}].screen`, errors);
        intro.push({ screen: r.ui, seconds });
      });
    }
  }

  // game_over: true (with final_message), or the older {"message": "..."} form.
  let gameOver: { message: string } | undefined;
  const go = args.game_over;
  if (go === true || go === 'true') {
    // No fallback text: the final screen already shows the result.
    gameOver = { message: meaningful(asString(args.final_message)) ?? '' };
  } else if (typeof go === 'object' && go !== null && meaningful(asString((go as Record<string, unknown>).message))) {
    gameOver = { message: asString((go as Record<string, unknown>).message)! };
  }

  const ruleChange = meaningful(asString(args.rule_change));

  // The plan's phase timer applies when the AI forgot timer_seconds on a screen players answer.
  if (timerSeconds === undefined && !gameOver && errors.length === 0) {
    const planned = phaseTimer(plan, progress);
    if (planned && expectedResponders(screens, players).length > 0) timerSeconds = planned;
  }

  let autoContinue = false;
  const nobodyCanAct = errors.length === 0 && expectedResponders(screens, players).length === 0;
  if (nobodyCanAct && !gameOver && waitFor === 'all') {
    errors.push(
      'wait_for is "all" but no player has anything to answer. Add the component players respond with ' +
        '(e.g. a multiple_choice to vote, or an input) to their screens.',
    );
  } else if (nobodyCanAct && !gameOver && timerSeconds === undefined) {
    // A welcome splash, or the screen right after intro slides, may have nothing to click:
    // the server then asks for the next screen right away (once in a row). Anywhere else
    // that pattern doubles the number of AI turns, so results need a button or a timer.
    if (options.allowAutoContinue !== false && (options.isFirstTurn || intro.length > 0)) autoContinue = true;
    else {
      // Rejecting this made small models loop on the same reply. A Continue
      // button gives players control and keeps the game moving.
      screens.all = [...(screens.all ?? []), { type: 'button', label: 'Continue', actionId: 'continue' }];
    }
  } else if (
    nobodyCanAct && !gameOver && timerSeconds !== undefined && timerSeconds <= SLIDE_TIMER_MAX &&
    intro.length === 0 && options.previousWasSlide
  ) {
    // Slides one per turn with a short timer: every slide also waits for the AI, so timing breaks.
    errors.push(
      `Do not show slides one per turn with a short timer. Put ALL slides in "intro" (each with "seconds") ` +
        'and the screen that follows them (e.g. the question) in "screens", in this one turn.',
    );
  }

  if (errors.length > 0) return { ok: false, errors };
  const isSlide = nobodyCanAct && !gameOver && timerSeconds !== undefined && timerSeconds <= SLIDE_TIMER_MAX && intro.length === 0;
  return { ok: true, turn: { plan: planResult.plan, progress, stateUpdate, stateAppend, stateAdd, isSlide, screens, waitFor, timerSeconds, intro, gameOver, ruleChange, autoContinue } };
}

/** Add numbers into a (nested) state object: {"scores": {"Ana": 2}} adds 2 to scores.Ana. */
function addNumbers(target: Record<string, unknown>, add: Record<string, unknown>): Record<string, unknown> {
  const next = { ...target };
  for (const [k, v] of Object.entries(add)) {
    if (typeof v === 'number') {
      const current = Number(next[k] ?? 0);
      next[k] = (Number.isFinite(current) ? current : 0) + v;
    } else if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
      const inner = typeof next[k] === 'object' && next[k] !== null && !Array.isArray(next[k]) ? (next[k] as Record<string, unknown>) : {};
      next[k] = addNumbers(inner, v as Record<string, unknown>);
    }
  }
  return next;
}

/** Shallow-merge a state update (null deletes a key), append list items, then add numbers. */
export function applyStateUpdate(
  state: Record<string, unknown>,
  update: Record<string, unknown> | undefined,
  append?: Record<string, unknown[]>,
  add?: Record<string, unknown>,
): Record<string, unknown> {
  let next = { ...state };
  for (const [k, v] of Object.entries(update ?? {})) {
    if (v === null) delete next[k];
    else next[k] = v;
  }
  for (const [k, items] of Object.entries(append ?? {})) {
    const current = next[k];
    next[k] = Array.isArray(current) ? [...current, ...items] : current === undefined ? [...items] : [current, ...items];
  }
  if (add) next = addNumbers(next, add);
  return next;
}

// ─── History ─────────────────────────────────────────────────────────────────

/**
 * Keep the last ~max messages without splitting a tool call from its result.
 * The first message (the game-start event) is always kept, merged into the
 * first kept user message so roles keep alternating.
 */
export function trimHistory(messages: LLMMessage[], max: number): LLMMessage[] {
  if (messages.length <= max) return messages;
  let start = messages.length - max;
  while (start < messages.length && messages[start].role !== 'user') start++;
  if (start >= messages.length) return messages.slice(-1);
  const head = messages[0];
  const first = messages[start];
  if (start === 0 || head.role !== 'user') return messages.slice(start);
  return [
    { role: 'user', content: `${head.content}\n\n(Older turns omitted. The game state holds everything important.)\n\n${first.content}` },
    ...messages.slice(start + 1),
  ];
}

/** Merge back-to-back user messages (some chat templates require alternating roles). */
export function mergeConsecutiveUserMessages(messages: LLMMessage[]): LLMMessage[] {
  const out: LLMMessage[] = [];
  for (const m of messages) {
    const prev = out[out.length - 1];
    if (prev && prev.role === 'user' && m.role === 'user') {
      out[out.length - 1] = { ...prev, content: `${prev.content ?? ''}\n\n${m.content ?? ''}` };
    } else {
      out.push(m);
    }
  }
  return out;
}

// ─── Events ──────────────────────────────────────────────────────────────────

function describeResponse(r: PlayerResponse, players: Player[]): string {
  const name = players.find((p) => p.id === r.playerId)?.name ?? r.playerName;
  const who = `${name} (${r.playerId})`;
  // Answer time, for rules with speed bonuses or "first to answer". Not for plain
  // button clicks: those events must stay predictable so the next screen can be prefetched.
  const after = r.elapsedMs !== undefined ? ` after ${(r.elapsedMs / 1000).toFixed(1)}s` : '';
  if (r.kind === 'action') return `- ${who} clicked button "${r.id}"`;
  const values = r.values ?? {};
  const keys = Object.keys(values);
  if (keys.length === 1 && keys[0] === r.id) return `- ${who} answered "${values[r.id]}" (field "${r.id}")${after}`;
  return `- ${who} submitted "${r.id}": ${JSON.stringify(values)}${after}`;
}

/** Text of the event sent to the model when a turn ends. */
export function formatTurnEvent(
  pending: PendingTurn,
  reason: 'responses' | 'timeout' | 'interrupted',
  players: Player[],
): string {
  const header =
    reason === 'timeout'
      ? `EVENT: Turn ${pending.turn} ended because the ${pending.timerSeconds}s timer ran out.`
      : reason === 'interrupted'
        ? `EVENT: Turn ${pending.turn} was interrupted.`
        : pending.waitFor === 'all'
          ? `EVENT: Turn ${pending.turn} ended: all players responded.`
          : `EVENT: Turn ${pending.turn} ended: a player responded.`;
  const lines = [header];
  if (pending.responses.length > 0) {
    lines.push('Responses:');
    for (const r of pending.responses) lines.push(describeResponse(r, players));
  } else {
    lines.push('Responses: none.');
  }
  // Answers the server already checked against the answer key (points are in state.scores).
  if (pending.checks?.length) {
    const byField = new Map<string, typeof pending.checks>();
    for (const c of pending.checks) byField.set(c.fieldId, [...(byField.get(c.fieldId) ?? []), c]);
    for (const [field, checks] of byField) {
      const marks = checks.map((c) => `${c.playerName} ${c.correct ? '✓' : '✗'}${c.points ? ` ${c.points > 0 ? '+' : ''}${c.points}` : ''}`);
      lines.push(`Answer check for "${field}" (right answer: ${checks[0].rightAnswer}): ${marks.join(', ')}. These points are already added to state.scores.`);
    }
  }

  // Count identical answers per field (votes), so the model does not have to.
  const tallies = new Map<string, Map<string, number>>();
  for (const r of pending.responses) {
    if (r.kind !== 'submit' || !r.values) continue;
    const keys = Object.keys(r.values);
    if (keys.length !== 1 || keys[0] !== r.id) continue;
    const field = tallies.get(r.id) ?? new Map<string, number>();
    const value = String(r.values[r.id]);
    field.set(value, (field.get(value) ?? 0) + 1);
    tallies.set(r.id, field);
  }
  for (const [field, counts] of tallies) {
    if ([...counts.values()].reduce((a, b) => a + b, 0) < 2) continue;
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    lines.push(`Count for "${field}": ${sorted.map(([v, n]) => `${v} ${n}`).join(', ')}.`);
  }

  const missing = pending.expected.filter((id) => !pending.responses.some((r) => r.playerId === id));
  if (reason !== 'responses' && missing.length > 0) {
    lines.push(`No response from: ${missing.map((id) => players.find((p) => p.id === id)?.name ?? id).join(', ')}.`);
  }
  return lines.join('\n');
}
