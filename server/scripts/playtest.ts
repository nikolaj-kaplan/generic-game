/**
 * Automated playtest: bot players play preset games end-to-end against a
 * LOCAL model and print a scorecard (turns, errors, stalls, time per call).
 *
 *   npm run playtest --prefix server -- --game quiz-battle
 *   npm run playtest --prefix server -- --all --model gemma4:26b-a4b-it-qat
 *
 * Safety: the harness only ever talks to an LLM on localhost. It starts its own
 * server with LLM_LOCAL_ONLY=1, which makes the server refuse any non-local
 * endpoint, so a stray OpenRouter key in .env can never be used.
 */
import { spawn, ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import { GAME_PRESETS } from '../../client/src/data/presets';
import type { ServerMessage, ClientMessage, UIComponent } from '../../shared/types';

// ─── Options ─────────────────────────────────────────────────────────────────

const PRESET_PLAYERS: Record<string, number> = {
  'twenty-questions': 1,
  'quiz-battle': 2,
  'most-likely': 3,
  'memory-flash': 1,
  imposter: 4,
  'funny-answers': 3,
  'two-truths': 3,
};

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (name: string, fallback?: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
  };
  return {
    games: args.includes('--all') ? Object.keys(PRESET_PLAYERS) : get('game', 'quiz-battle')!.split(','),
    players: get('players') ? Number(get('players')) : undefined,
    model: get('model', process.env.PLAYTEST_MODEL ?? 'gemma4:26b-a4b-it-qat')!,
    protocol: get('protocol', 'json')!,
    reasoning: get('reasoning', 'none')!,
    quiet: args.includes('--quiet'),
    // Random clicking is fast; "smart" players ask the local model to act like a person.
    smart: !args.includes('--random-players'),
    baseUrl: get('base-url', 'http://localhost:11434/v1')!,
    port: Number(get('port', '3199')),
    maxMinutes: Number(get('max-minutes', '25')),
    maxTurns: Number(get('max-turns', '60')),
  };
}

const opts = parseArgs();

// ─── Safety: local only ──────────────────────────────────────────────────────

const host = new URL(opts.baseUrl).hostname;
if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) {
  console.error(`Refusing to run: --base-url ${opts.baseUrl} is not local. Automated tests only run against local models.`);
  process.exit(1);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const pick = <T>(items: T[]): T => items[Math.floor(Math.random() * items.length)];
const SERVER_DIR = path.join(__dirname, '..');
const RUN_DIR = path.join(SERVER_DIR, '..', 'data', 'playtests', new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19));

async function preflight(): Promise<void> {
  const ollamaRoot = opts.baseUrl.replace(/\/v1\/?$/, '');
  let tags: { models?: Array<{ name: string }> };
  try {
    tags = (await (await fetch(`${ollamaRoot}/api/tags`)).json()) as typeof tags;
  } catch {
    console.error(`Cannot reach Ollama at ${ollamaRoot}. Start it with: OLLAMA_CONTEXT_LENGTH=16384 ollama serve`);
    process.exit(1);
  }
  if (!tags.models?.some((m) => m.name === opts.model)) {
    console.error(`Model ${opts.model} is not downloaded. Available: ${tags.models?.map((m) => m.name).join(', ')}`);
    process.exit(1);
  }
}

/** Ollama's loaded context window; small windows silently truncate prompts. */
async function contextLength(): Promise<number | undefined> {
  try {
    const ps = (await (await fetch(`${opts.baseUrl.replace(/\/v1\/?$/, '')}/api/ps`)).json()) as {
      models?: Array<{ name: string; context_length?: number }>;
    };
    return ps.models?.find((m) => m.name === opts.model)?.context_length;
  } catch {
    return undefined;
  }
}

function startServer(dataDir: string): Promise<ChildProcess> {
  fs.mkdirSync(dataDir, { recursive: true });
  const child = spawn('npx', ['tsx', 'src/index.ts'], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      PORT: String(opts.port),
      DATA_DIR: dataDir,
      LLM_LOCAL_ONLY: '1',
      // Never route to models.json (the strong model is not for automated runs).
      GAME_MODELS_FILE: 'none',
      LLM_BASE_URL: opts.baseUrl,
      LLM_MODEL: opts.model,
      LLM_PROTOCOL: opts.protocol,
      LLM_REASONING_EFFORT: opts.reasoning === 'default' ? '' : opts.reasoning,
      LLM_API_KEY: '',
      OPENROUTER_API_KEY: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = fs.createWriteStream(path.join(dataDir, 'server.log'));
  child.stdout?.pipe(log);
  child.stderr?.pipe(log);
  // Echo the server's game events (not Fastify's JSON request logs) so a run can be followed live.
  if (!opts.quiet) {
    let buffer = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (/^\[(game|define|start)/.test(line)) console.log(`    │ ${line.slice(0, 220)}`);
      }
    });
  }
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = async () => {
      try {
        const res = await fetch(`http://localhost:${opts.port}/health`);
        if (res.ok) return resolve(child);
      } catch { /* not up yet */ }
      if (Date.now() - started > 30_000) return reject(new Error('Server did not start within 30s'));
      setTimeout(poll, 300);
    };
    void poll();
  });
}

// ─── Bot player ──────────────────────────────────────────────────────────────

const QUESTIONS = [
  'Is it a person?', 'Is it alive today?', 'Is it from Europe?', 'Is it bigger than a car?',
  'Is it famous for sports?', 'Is it used every day?', 'Is it man-made?', 'Is it in Asia?',
  'Is it older than 100 years?', 'Can you eat it?', 'Is it an animal?', 'Is it a building?',
  'Is it related to music?', 'Is it found in nature?', 'Is it electronic?', 'Is it in America?',
];
/** Questions in random order without repeats (the AI rightly complains about repeats). */
const questionDeck: string[] = [];
function nextQuestion(): string {
  if (questionDeck.length === 0) questionDeck.push(...[...QUESTIONS].sort(() => Math.random() - 0.5));
  return questionDeck.pop()!;
}
const GUESSES = ['Albert Einstein', 'The Eiffel Tower', 'A bicycle', 'Taylor Swift', 'Mount Everest'];
const CATEGORIES = ['Science', 'History', 'Geography', 'Sports', 'Music', 'Movies'];

function cannedText(hint: string): string {
  const h = hint.toLowerCase();
  if (h.includes('categor')) return pick(CATEGORIES);
  if (h.includes('guess')) return pick(GUESSES);
  if (h.includes('question') || h.includes('ask')) return nextQuestion();
  if (h.includes('name')) return pick(['Ana', 'Bob']);
  if (h.includes('number')) return String(1 + Math.floor(Math.random() * 10));
  return pick(['yes', 'Paris', 'blue', 'I think so']);
}

interface Problem { at: number; kind: string; detail: string }

class Bot {
  ws!: WebSocket;
  playerId = '';
  joinCode = '';
  ui: UIComponent[] = [];
  turn: number | undefined;
  status = '';
  thinking = false;
  rules: string | null = null;
  gameError: string | null = null;
  endMessage: string | null = null;
  chat: Array<{ role: string; content: string }> = [];
  turnsSeen = new Set<number>();
  /** Any screen change (intro slides included) counts as progress. */
  lastScreenAt = Date.now();
  problems: Problem[] = [];
  private actedOnTurn: number | undefined;

  constructor(public name: string, private game: string) {}

  connect(port: number): Promise<void> {
    this.ws = new WebSocket(`ws://localhost:${port}/ws`);
    this.ws.onmessage = (e) => this.onMessage(JSON.parse(String(e.data)) as ServerMessage);
    return new Promise((resolve, reject) => {
      this.ws.onopen = () => resolve();
      this.ws.onerror = () => reject(new Error(`${this.name}: websocket error`));
    });
  }

  send(msg: ClientMessage): void {
    this.ws.send(JSON.stringify(msg));
  }

  private onMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case 'session_created':
      case 'session_joined':
        this.playerId = msg.playerId;
        this.joinCode = msg.session.joinCode;
        this.status = msg.session.status;
        break;
      case 'status_change':
        this.status = msg.status;
        if (msg.agreedRules) this.rules = msg.agreedRules;
        if (msg.message) this.endMessage = msg.message;
        break;
      case 'chat_message':
        this.chat.push({ role: msg.message.role, content: msg.message.content });
        break;
      case 'ui_update':
        this.ui = msg.ui;
        this.turn = msg.turn;
        this.lastScreenAt = Date.now();
        if (msg.ui.length) this.seen.push(screenText(msg.ui));
        if (this.seen.length > 12) this.seen.shift();
        if (msg.turn !== undefined) this.turnsSeen.add(msg.turn);
        break;
      case 'ai_thinking':
        this.thinking = msg.thinking;
        break;
      case 'game_error':
        this.gameError = msg.message;
        if (msg.message) this.problems.push({ at: Date.now(), kind: 'stall', detail: msg.message });
        break;
      case 'error':
        this.problems.push({ at: Date.now(), kind: 'error', detail: msg.message });
        break;
    }
  }

  /** Ask the local model which of the on-screen actions this person would take. */
  async decideWithModel(): Promise<InputMessage | null> {
    const actions = possibleActions(this.ui);
    if (actions.length === 0) return null;
    if (!PERSONA_BY_NAME.has(this.name)) PERSONA_BY_NAME.set(this.name, PERSONAS[PERSONA_BY_NAME.size % PERSONAS.length]);
    const needsText = actions.some((a) => a.textFields?.length);
    const schema = {
      type: 'object',
      properties: {
        action: { type: 'string', enum: actions.map((a) => a.label) },
        ...(needsText ? { text: { type: 'string', description: 'What you type into the text field(s)' } } : {}),
      },
      required: needsText ? ['action', 'text'] : ['action'],
    };
    const system =
      `You are ${this.name}, a human playing a party game in a browser with friends. Personality: ${PERSONA_BY_NAME.get(this.name)}. ` +
      'Play genuinely to have fun and to win: make real, sensible guesses and questions based on what you have seen. ' +
      'Never repeat a question you already asked. Keep typed answers short, like a person on a phone.';
    const user =
      (this.rules ? `Game rules:\n${this.rules.slice(0, 1500)}\n\n` : '') +
      `Earlier screens (oldest first):\n${this.seen.slice(0, -1).join('\n---\n') || '(none)'}\n\n` +
      `Current screen:\n${screenText(this.ui)}\n\nChoose what you do now.`;
    const reply = await askModel(system, user, schema);
    const chosen = actions.find((a) => a.label === reply.action) ?? actions[0];
    const message = structuredClone(chosen.message);
    if (chosen.textFields?.length && message.type === 'form_submit') {
      const text = String(reply.text ?? '').slice(0, 120) || 'yes';
      for (const f of chosen.textFields) message.values[f] = text;
    }
    return message;
  }

  hasSomethingToDo(): boolean {
    return this.ui.some((c) => ['button', 'input', 'multiple_choice', 'form'].includes(c.type));
  }

  /** Recent screens this player saw, as text (memory for the smart player). */
  seen: string[] = [];

  /** Act once per turn, like a human would (smart) or at random. */
  async maybeAct(): Promise<void> {
    if (this.status !== 'playing' || this.turn === undefined || this.actedOnTurn === this.turn) return;
    if (!this.hasSomethingToDo()) return;
    const turn = this.turn;
    this.actedOnTurn = turn;
    await sleep(500 + Math.random() * 2000);
    if (this.turn !== turn) return;

    // A lone Continue/Next button needs no thinking; clicking it directly keeps the
    // shared local model free for the game master.
    const lone = this.ui.filter((c) => ['button', 'input', 'multiple_choice', 'form'].includes(c.type));
    if (opts.smart && !(lone.length === 1 && lone[0].type === 'button')) {
      try {
        const msg = await this.decideWithModel();
        if (msg && this.turn === turn) {
          this.send({ ...msg, turn } as ClientMessage);
          return;
        }
      } catch (err) {
        this.problems.push({ at: Date.now(), kind: 'bot', detail: `smart player failed: ${String(err).slice(0, 120)}` });
      }
      if (this.turn !== turn) return;
    }

    const mc = this.ui.find((c): c is Extract<UIComponent, { type: 'multiple_choice' }> => c.type === 'multiple_choice');
    const form = this.ui.find((c): c is Extract<UIComponent, { type: 'form' }> => c.type === 'form');
    const inputs = this.ui.filter((c): c is Extract<UIComponent, { type: 'input' }> => c.type === 'input');
    const buttons = this.ui.filter((c): c is Extract<UIComponent, { type: 'button' }> => c.type === 'button' && !c.disabled);

    if (mc) {
      const option = pick(mc.options);
      this.send({ type: 'form_submit', formId: mc.fieldId, values: { [mc.fieldId]: option }, turn });
    } else if (form) {
      const values: Record<string, string> = {};
      for (const f of form.fields) {
        if (f.type === 'input') values[f.fieldId] = cannedText(`${f.label ?? ''} ${f.placeholder ?? ''} ${f.fieldId}`);
      }
      this.send({ type: 'form_submit', formId: form.formId, values, turn });
    } else if (inputs.length > 0 && buttons.length > 0) {
      const values: Record<string, string> = {};
      for (const f of inputs) values[f.fieldId] = cannedText(`${f.label ?? ''} ${f.placeholder ?? ''} ${f.fieldId} ${this.game}`);
      const button = buttons.find((b) => b.style !== 'danger') ?? buttons[0];
      this.send({ type: 'form_submit', formId: button.actionId, values, turn });
    } else if (buttons.length > 0) {
      const candidates = buttons.filter((b) => b.style !== 'danger');
      this.send({ type: 'action', actionId: pick(candidates.length ? candidates : buttons).actionId, turn });
    }
  }
}

// ─── Smart player: the local model plays like a person ───────────────────────

const PERSONAS = [
  'competitive and quick, likes to win',
  'playful and a bit silly, makes jokes in free-text answers',
  'careful and logical, thinks before answering',
  'enthusiastic party guest, answers fast and with emoji sometimes',
];

function screenText(ui: UIComponent[]): string {
  return ui
    .map((c) => {
      switch (c.type) {
        case 'text': return c.content;
        case 'list': return c.items.map((i) => `• ${i}`).join('\n');
        case 'scoreboard': return 'Scores: ' + c.players.map((p) => `${p.name} ${p.score}`).join(', ');
        case 'multiple_choice': return `Question: ${c.question}`;
        case 'input': return `Text field: ${[c.label, c.placeholder].filter(Boolean).join(' — ')}`;
        case 'form':
          return c.fields
            .map((f) => (f.type === 'input' ? `Text field: ${[f.label, f.placeholder].filter(Boolean).join(' — ')}` : f.type === 'text' ? f.content : ''))
            .filter(Boolean)
            .join('\n');
        case 'countdown': return `(timer: ${c.seconds}s)`;
        default: return '';
      }
    })
    .filter(Boolean)
    .join('\n');
}

type InputMessage =
  | { type: 'form_submit'; formId: string; values: Record<string, string> }
  | { type: 'action'; actionId: string };
interface Action { label: string; message: InputMessage; textFields?: string[] }

function possibleActions(ui: UIComponent[]): Action[] {
  const actions: Action[] = [];
  const inputs = ui.filter((c): c is Extract<UIComponent, { type: 'input' }> => c.type === 'input');
  for (const c of ui) {
    if (c.type === 'multiple_choice') {
      for (const o of c.options) actions.push({ label: `choose "${o}"`, message: { type: 'form_submit', formId: c.fieldId, values: { [c.fieldId]: o } } });
    } else if (c.type === 'form') {
      const fields = c.fields.filter((f): f is Extract<UIComponent, { type: 'input' }> => f.type === 'input');
      actions.push({ label: `fill in and submit "${c.submitLabel ?? 'Submit'}"`, message: { type: 'form_submit', formId: c.formId, values: {} }, textFields: fields.map((f) => f.fieldId) });
    } else if (c.type === 'button' && !c.disabled) {
      actions.push(
        inputs.length
          ? { label: `type and press "${c.label}"`, message: { type: 'form_submit', formId: c.actionId, values: {} }, textFields: inputs.map((f) => f.fieldId) }
          : { label: `press "${c.label}"`, message: { type: 'action', actionId: c.actionId } },
      );
    }
  }
  return actions;
}

const PERSONA_BY_NAME = new Map<string, string>();

async function askModel(system: string, user: string, schema: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch(`${opts.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: opts.model,
      temperature: 0.9,
      max_tokens: 300,
      reasoning_effort: 'none',
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      response_format: { type: 'json_schema', json_schema: { name: 'player_move', schema } },
    }),
  });
  if (!res.ok) throw new Error(`model ${res.status}`);
  const data = (await res.json()) as { choices: Array<{ message: { content: string } }> };
  const content = data.choices[0].message.content;
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  return JSON.parse(content.slice(start, end + 1)) as Record<string, unknown>;
}

// ─── One game ────────────────────────────────────────────────────────────────

interface GameResult {
  game: string;
  players: number;
  model: string;
  outcome: 'finished' | 'timeout' | 'max-turns' | 'no-rules';
  minutes: number;
  turns: number;
  endMessage: string | null;
  problems: Problem[];
  stuckNudges: number;
  /** Host adjustment test: was a new screen shown, and did "I don't know" show up afterwards? */
  adjustment?: { sentAtTurn: number; newScreen: boolean; applied: boolean };
  metrics?: Record<string, unknown>;
  logDir?: string;
}

async function playGame(game: string, playerCount: number): Promise<GameResult> {
  const preset = GAME_PRESETS.find((p) => p.id === game);
  if (!preset) throw new Error(`Unknown game ${game}. Options: ${GAME_PRESETS.map((p) => p.id).join(', ')}`);
  const started = Date.now();
  const names = ['Ana', 'Bob', 'Carl', 'Dana', 'Erik'].slice(0, playerCount);
  const bots = names.map((n) => new Bot(n, game));
  const host = bots[0];
  const result = (outcome: GameResult['outcome'], stuckNudges = 0): GameResult => ({
    game,
    players: playerCount,
    model: opts.model,
    outcome,
    minutes: Math.round((Date.now() - started) / 600) / 100,
    turns: Math.max(0, ...bots.flatMap((b) => [...b.turnsSeen])),
    endMessage: host.endMessage,
    problems: bots.flatMap((b) => b.problems.map((p) => ({ ...p, detail: `${b.name}: ${p.detail}` }))),
    stuckNudges,
  });

  for (const bot of bots) await bot.connect(opts.port);
  host.send({ type: 'create_session', playerName: host.name });
  while (!host.joinCode) await sleep(50);
  for (const bot of bots.slice(1)) bot.send({ type: 'join_session', joinCode: host.joinCode, playerName: bot.name });
  await sleep(300);

  // Definition phase
  host.send({ type: 'start_defining' });
  await sleep(200);
  console.log(`  [${game}] defining rules…`);
  host.send({ type: 'chat', content: preset.prompt });
  let followUps = 0;
  const deadline = started + opts.maxMinutes * 60_000;
  while (!host.rules && Date.now() < deadline) {
    await sleep(500);
    if (!host.thinking && !host.rules && host.chat.at(-1)?.role === 'ai') {
      if (followUps >= 3) break;
      followUps++;
      host.send({ type: 'chat', content: 'Use sensible defaults for anything unclear and propose the rules now.' });
      await sleep(500);
    }
  }
  if (!host.rules) return result('no-rules');

  // Playing phase
  console.log(`  [${game}] rules agreed, playing…`);
  host.send({ type: 'confirm_rules' });
  let lastProgress = Date.now();
  let stuckNudges = 0;
  let adjustment: GameResult['adjustment'];
  while (Date.now() < deadline) {
    await sleep(250);
    const turns = Math.max(0, ...bots.flatMap((b) => [...b.turnsSeen]));
    if (host.status === 'finished') return { ...result('finished', stuckNudges), adjustment };
    // Mid-game host adjustment, like a real host would do
    if (!adjustment && turns >= 3 && !host.thinking) {
      adjustment = { sentAtTurn: turns, newScreen: false, applied: false };
      console.log(`  [${game}] host adjustment at turn ${turns}`);
      host.send({ type: 'game_tweak', content: 'From now on, add the option "I don\'t know" to every multiple-choice question.' });
    }
    if (adjustment) {
      if (turns > adjustment.sentAtTurn) adjustment.newScreen = true;
      if (bots.some((b) => b.ui.some((c) => c.type === 'multiple_choice' && c.options.some((o) => /don.?t know/i.test(o))))) adjustment.applied = true;
    }
    if (turns >= opts.maxTurns) return { ...result('max-turns', stuckNudges), adjustment };
    lastProgress = Math.max(lastProgress, ...bots.map((b) => b.lastScreenAt));
    await Promise.all(bots.map((b) => b.maybeAct()));

    const anyThinking = bots.some((b) => b.thinking);
    const anyCountdown = bots.some((b) => b.ui.some((c) => c.type === 'countdown'));
    const someoneCanAct = bots.some((b) => b.hasSomethingToDo());
    const stalled = bots.some((b) => b.gameError);
    if (!anyThinking && (stalled || (!someoneCanAct && !anyCountdown && Date.now() - lastProgress > 45_000))) {
      if (stuckNudges >= 3) break;
      stuckNudges++;
      host.problems.push({ at: Date.now(), kind: 'stuck', detail: stalled ? 'stalled turn → retry' : 'no player can act → nudge' });
      host.send({ type: 'retry_turn' });
      for (const b of bots) b.gameError = null;
      lastProgress = Date.now();
    }
  }
  return { ...result('timeout', stuckNudges), adjustment };
}

// ─── Main ────────────────────────────────────────────────────────────────────

function readMetrics(dataDir: string): Array<{ dir: string; metrics: Record<string, unknown> }> {
  const root = path.join(dataDir, 'llm-logs');
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root)
    .filter((d) => d.endsWith('_play') && fs.existsSync(path.join(root, d, 'metrics.json')))
    .sort()
    .map((d) => ({ dir: path.join(root, d), metrics: JSON.parse(fs.readFileSync(path.join(root, d, 'metrics.json'), 'utf-8')) }));
}

let currentServer: ChildProcess | undefined;
process.on('SIGINT', () => {
  console.log('\nStopping playtest…');
  currentServer?.kill('SIGTERM');
  process.exit(130);
});

async function main(): Promise<void> {
  await preflight();
  console.log(`Playtest: ${opts.games.join(', ')} · model ${opts.model} · protocol ${opts.protocol} · reasoning ${opts.reasoning} · ${opts.baseUrl}`);
  console.log(`Output: ${RUN_DIR}`);
  const results: GameResult[] = [];

  for (const game of opts.games) {
    const players = opts.players ?? PRESET_PLAYERS[game] ?? 2;
    const dataDir = path.join(RUN_DIR, game);
    const server = await startServer(dataDir);
    currentServer = server;
    try {
      console.log(`\n▶ ${game} with ${players} bot player(s)`);
      const r = await playGame(game, players);
      const m = readMetrics(dataDir).at(-1);
      r.metrics = m?.metrics;
      r.logDir = m?.dir;
      results.push(r);
      const ctx = await contextLength();
      if (ctx !== undefined && ctx < 16384) {
        console.warn(`  ⚠ Ollama context window is ${ctx} tokens; prompts may be truncated. Restart with OLLAMA_CONTEXT_LENGTH=16384 ollama serve`);
      }
    } finally {
      server.kill('SIGTERM');
      await sleep(500);
    }
  }

  // Scorecard
  console.log('\n══════════ Scorecard ══════════');
  for (const r of results) {
    const m = (r.metrics ?? {}) as Record<string, number>;
    const avg = m.llmCalls ? Math.round(m.llmMs / m.llmCalls / 100) / 10 : 0;
    console.log(
      `${r.outcome === 'finished' ? '✅' : '❌'} ${r.game.padEnd(17)} ${r.outcome.padEnd(9)} ` +
        `turns ${String(r.turns).padStart(3)} · ${r.minutes} min · LLM calls ${m.llmCalls ?? '?'} (avg ${avg}s) · ` +
        `invalid ${m.invalidCalls ?? '?'} · text replies ${m.textReplies ?? '?'} · stalls ${m.stalls ?? '?'} · ` +
        `nudges ${r.stuckNudges} · max prompt ${m.promptTokensMax ?? '?'} tok`,
    );
    if (r.endMessage) console.log(`   end: ${r.endMessage}`);
    if (r.adjustment) {
      const a = r.adjustment;
      console.log(`   adjustment at turn ${a.sentAtTurn}: ${a.newScreen ? 'new screen ✓' : 'NO new screen ✗'} · "I don't know" ${a.applied ? 'shown ✓' : 'never shown ✗'}`);
    }
    for (const p of r.problems.slice(0, 5)) console.log(`   ${p.kind}: ${p.detail.slice(0, 160)}`);
    if (r.logDir) console.log(`   logs: ${r.logDir}`);
  }
  fs.mkdirSync(RUN_DIR, { recursive: true });
  fs.writeFileSync(path.join(RUN_DIR, 'report.json'), JSON.stringify(results, null, 2));
  console.log(`\nReport: ${path.join(RUN_DIR, 'report.json')}`);
  process.exit(results.every((r) => r.outcome === 'finished') ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
