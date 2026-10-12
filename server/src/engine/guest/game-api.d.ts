// =============================================================================
// Game API: everything a game program can use. A program is one JavaScript
// file that calls defineGame({...}) once. It runs in a sandbox: no imports,
// no network, no timers, no Node or browser APIs. Only what is declared here.
//
// The engine owns waiting for players, timers, the countdown, "waiting for…"
// texts, the round indicator, the scoreboard and the end screen. A program only
// declares phases and what happens between them.
// =============================================================================

/** A player's id (a string). Use g.name(id) to show a name. */
type PlayerId = string;

/** Plain JSON data: strings, numbers, booleans, null, arrays and objects. */
type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/**
 * Where to go after a phase:
 * - a phase id: the next phase in the same round
 * - g.nextRound('phaseId'): round + 1, then that phase
 * - g.end() or g.end('message'): the game is over (default message: the winner by score)
 */
type Next = string | NextRound | GameEnd;
interface NextRound { readonly __marker: true; readonly nextRound: string }
interface GameEnd { readonly __marker: true; readonly end: true }

/**
 * A screen: a component, a string (shown as text), or a (nested) array of them.
 * null / undefined / false entries are skipped, so `cond && ui.text('…')` works.
 */
type Screen = Component | string | null | undefined | false | Screen[];
interface Component { readonly type: string }

/**
 * The value a player sent, as handed to next() and stored in g.answers:
 * - one input on the screen (a choice, a player pick or one text input) → that value
 *   (the option text, the picked player's id, or the typed text)
 * - a button other than the submit button → { button: 'buttonId', ...typed fields }
 * - several text inputs → { fieldId: text, ... }
 * - no answer (time ran out) → undefined
 */
type Answer = any;

/** g.ai.* options. complexity: 1 = trivial (pick from options, list well-known things) … 5 = needs real judgment (humour, nuance). Default 1. */
interface AiOptions { complexity?: 1 | 2 | 3 | 4 | 5 }

/**
 * Shape of JSON the AI must return:
 * 'string' | 'number' | 'boolean' | 'string[]' | 'string[4]' (exactly 4) | ['A', 'B'] (one of these)
 * | { key: shape, ... } | [shape] (a list of shape)
 */
type Shape = string | string[] | Shape[] | { [key: string]: Shape };

interface Ai {
  /** Free text. */
  text(prompt: string, opts?: AiOptions): Promise<string>;
  /** JSON in the given shape, e.g. g.ai.json('…', { answer: ['Yes', 'No'], reason: 'string' }). */
  json(prompt: string, shape: Shape, opts?: AiOptions): Promise<any>;
  /** n items; each item a string, or the given shape. Use it in setup() to create all content at once. */
  list(prompt: string, n: number, itemShape?: Shape, opts?: AiOptions): Promise<any[]>;
  /** Exactly one of the options. Fast: use it for judging and classifying. */
  choose(question: string, options: string[], opts?: AiOptions): Promise<string>;
  /** true for yes. */
  yesNo(question: string, opts?: AiOptions): Promise<boolean>;
}

interface Player { id: PlayerId; name: string; isHost: boolean }

interface Scores {
  add(who: PlayerId | PlayerId[], points: number): void;
  set(who: PlayerId | PlayerId[], points: number): void;
  get(id: PlayerId): number;
  /** { playerId: score } for every player. */
  all(): Record<PlayerId, number>;
  /** Player ids with the highest score (several on a tie). */
  leaders(): PlayerId[];
}

interface Random {
  /** 0 ≤ x < 1. (Math.random is the same seeded generator.) */
  next(): number;
  /** Whole number from min to max, both included. */
  int(min: number, max: number): number;
  pick<T>(items: T[]): T;
  /** A shuffled copy. */
  shuffle<T>(items: T[]): T[];
  /** n different items in random order. */
  sample<T>(items: T[], n: number): T[];
}

/** The context every function receives. */
interface G {
  /** Your game data. Must stay plain JSON. It is the ONLY place data survives between events. */
  state: Record<string, any>;
  players: Player[];
  /** Every player's id, in join order. */
  readonly ids: PlayerId[];
  /** The host's id. */
  readonly host: PlayerId;
  /** Current phase id. */
  readonly phase: string;
  /** Current round, starting at 1. */
  readonly round: number;
  /** Total rounds (from defineGame or g.setRounds), or null. */
  readonly rounds: number | null;
  /** true when round >= rounds. */
  readonly lastRound: boolean;
  setRounds(n: number): void;
  /** Answers given in THIS round: g.answers.vote = { playerId: answer }. */
  readonly answers: Record<string, Record<PlayerId, Answer>>;
  /** Answers given in another round. */
  answersIn(round: number): Record<string, Record<PlayerId, Answer>>;
  player(id: PlayerId): Player | undefined;
  name(id: PlayerId): string;
  /** "Ana, Bob and Cleo". */
  names(ids: PlayerId[]): string;
  /** Every player id except me. */
  others(me: PlayerId): PlayerId[];
  scores: Scores;
  random: Random;
  ai: Ai;
  nextRound(phase: string): NextRound;
  end(message?: string): GameEnd;
  /** Debug note, shown in the server log. */
  log(...parts: unknown[]): void;
}

// ─── Phases ──────────────────────────────────────────────────────────────────

/** Seconds, or a function of g. */
type Seconds = number | ((g: G) => number);
/** A phase id, or a function deciding it. */
type NextSpec<A = void> = Next | ((g: G, arg: A) => Next | Promise<Next>);

interface PhaseBase {
  /**
   * Runs when the phase starts (also again when g.nextRound re-enters it). May be async and call g.ai.
   * May return a Next to skip this phase.
   */
  enter?(g: G): void | Next | Promise<void | Next>;
  /** false hides the "Round x of y" line in this phase. */
  showRound?: boolean;
}

/** Everyone in `who` answers at the same time. Ends when all answered or the timer runs out. */
interface CollectSpec extends PhaseBase {
  /** Who answers (default: every player). */
  who?: PlayerId[] | ((g: G) => PlayerId[]);
  timer?: Seconds;
  /** The screen with ONE input: a ui.choice, a ui.pickPlayer, or text inputs (a Submit button is added). */
  input(g: G, me: PlayerId): Screen;
  /** Screen for a player who already answered (default: the input screen without inputs + "Your answer: …" + "✓ Your answer is in."). Who is still answering is shown by the app. */
  waiting?(g: G, me: PlayerId): Screen;
  /** Screen for players not in `who` (default: "Waiting for …"). */
  view?(g: G, me: PlayerId): Screen;
  /** Answers are in g.answers[thisPhaseId]; a player who did not answer has no entry. */
  next: NextSpec<undefined>;
}

/** One player acts; the others watch. Ends on that player's answer or when the timer runs out. */
interface TurnSpec extends PhaseBase {
  who: PlayerId | ((g: G) => PlayerId);
  timer?: Seconds;
  input(g: G, me: PlayerId): Screen;
  /** What the others see (default: "Waiting for <name>…"). */
  waitingView?(g: G, me: PlayerId): Screen;
  /** answer is undefined when time ran out. */
  next: NextSpec<Answer | undefined>;
}

/** The first player to press a button wins the phase (e.g. "I know!"). */
interface BuzzerSpec extends PhaseBase {
  /** Who may press (default: every player). */
  who?: PlayerId[] | ((g: G) => PlayerId[]);
  timer?: Seconds;
  /** Shown above the buttons (and to players not in `who`). */
  view?(g: G, me: PlayerId): Screen;
  /** { buttonId: label }, e.g. { know: 'I know!', pass: 'Give up' } (default { buzz: 'Buzz!' }). */
  buttons?: Record<string, string> | ((g: G) => Record<string, string>);
  /** press is null when time ran out. */
  next: NextSpec<{ player: PlayerId; button: string } | null>;
}

/** Nothing to answer: a reveal, results, an explanation. With `seconds` it moves on by itself; without, the host gets a Continue button. */
interface ShowSpec extends PhaseBase {
  seconds?: Seconds;
  view(g: G, me: PlayerId): Screen;
  continueLabel?: string;
  next: NextSpec<undefined>;
}

/** Timed slides shown one after another to everyone (e.g. flash cards). */
interface SlidesSpec extends PhaseBase {
  items: any[] | ((g: G) => any[]);
  /** Seconds per slide (default 3). */
  seconds?: Seconds;
  view(g: G, item: any, index: number, me: PlayerId): Screen;
  next: NextSpec<undefined>;
}

interface Phase { readonly __kind: string }

declare function collect(spec: CollectSpec): Phase;
declare function turn(spec: TurnSpec): Phase;
declare function buzzer(spec: BuzzerSpec): Phase;
declare function show(spec: ShowSpec): Phase;
declare function slides(spec: SlidesSpec): Phase;

interface GameDefinition {
  /** Rounds in the game; g.round counts 1..rounds, g.lastRound is true in the last one. */
  rounds?: number;
  /** Runs once before the first phase. Create content here (one g.ai.list call beats one call per round). */
  setup?(g: G): void | Promise<void>;
  /** The first phase id. */
  start: string;
  phases: Record<string, Phase>;
  /** Extra content on the end screen (e.g. a summary of every round). The result message and the scoreboard are shown by the engine: do not repeat them. */
  final?(g: G, me: PlayerId): Screen;
  /** When the engine shows the scoreboard: 'always', 'reveal' (show phases and the end, default), 'end', 'never'. */
  scoreboard?: 'always' | 'reveal' | 'end' | 'never';
  /** false hides the "Round x of y" line everywhere. */
  showRound?: boolean;
}

declare function defineGame(definition: GameDefinition): GameDefinition;

// ─── Screens ─────────────────────────────────────────────────────────────────

declare const ui: {
  heading(text: string): Component;
  subheading(text: string): Component;
  text(text: string): Component;
  muted(text: string): Component;
  success(text: string): Component;
  error(text: string): Component;
  divider(): Component;
  list(items: string[], opts?: { ordered?: boolean }): Component;
  /** A text field. Its answer is the typed text (id default 'text'; give ids when a screen has several). */
  textInput(label: string, opts?: { id?: string; placeholder?: string; maxLength?: number; multiline?: boolean }): Component;
  /**
   * Multiple choice; clicking an option sends it. With `correct`, the engine checks the answer and adds
   * points (or the penalty) to the score by itself. feedback 'now' (default) shows right/wrong at once,
   * 'at-end' shows nothing until your reveal phase.
   */
  choice(
    question: string,
    options: string[],
    opts?: { id?: string; correct?: string; points?: number; penalty?: number; feedback?: 'now' | 'at-end' },
  ): Component;
  /** Pick a player: the answer is the player's id. others (default true) leaves out the viewer; among limits the options. */
  pickPlayer(question: string, opts?: { id?: string; others?: boolean; among?: PlayerId[] }): Component;
  /** A button; its answer is { button: id }. Text screens get a "Submit" button (id 'submit', pressed by Enter); add ui.button('submit', 'Ask') to name it yourself. */
  button(id: string, label: string, opts?: { style?: 'primary' | 'secondary' | 'danger' }): Component;
  /** "Ana → Bob" for each answer (player ids shown as names). */
  votes(answers: Record<PlayerId, Answer> | undefined): Component;
  scoreboard(): Component;
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

declare function tally(answers: Record<PlayerId, Answer> | undefined): {
  /** { value: votes } */
  counts: Record<string, number>;
  /** The values with the most votes; several on a tie; [] without votes. */
  top(): string[];
  /** The highest vote count. */
  max: number;
  /** Votes for one value. */
  of(value: string): number;
};

declare const match: {
  /** Same text ignoring case, accents, punctuation and a leading "the/a/an". */
  same(a: string, b: string): boolean;
  /** Like same(), also allowing small typos (about 1 wrong letter in 5). Use g.ai.yesNo for anything fuzzier. */
  close(a: string, b: string): boolean;
  normalize(s: string): string;
};
