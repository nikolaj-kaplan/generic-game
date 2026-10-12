/**
 * Play a game program with LLM players and write a readable transcript:
 * every screen each player saw, every action, and every g.ai call with its
 * result. Made for finding problems a person would notice (wrong content,
 * an answer that can never be right, confusing screens) without playing.
 *
 *   npm run play:program -- --program data/codegen-evals/<run>/band-buzzer.js --rules band-buzzer --players 2 --games 2
 *
 * The players and g.ai content use the local model (LLM_* settings, or the
 * models.json levels for g.ai). Transcripts go to data/program-plays/.
 */
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { ENV_FILE, dataDir } from '../src/paths';

dotenv.config({ path: ENV_FILE });

import { GAME_PRESETS } from '../../client/src/data/presets';
import { performAiRequest } from '../src/engine/ai';
import { botPlayers } from '../src/engine/botTest';
import { AiRequest, DispatchOutput, EngineState, GameEvent, runDispatch } from '../src/engine/sandbox';
import { chat } from '../src/llm/client';
import { extractJsonObject } from '../src/llm/turn';
import type { UIComponent } from '../src/types';

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : fallback;
}

const programPath = arg('program');
if (!programPath) {
  console.error('--program <file.js> is required');
  process.exit(1);
}
const program = fs.readFileSync(path.resolve(process.cwd(), '..', programPath), 'utf-8');
const rulesId = arg('rules');
const rules = arg('rules-text') ?? GAME_PRESETS.find((p) => p.id === rulesId)?.prompt ?? '';
const playerCount = Number(arg('players', '2'));
const games = Number(arg('games', '1'));
const maxSteps = Number(arg('max-steps', '120'));

const lines: string[] = [];
const log = (s = '') => {
  lines.push(s);
  if (!process.argv.includes('--quiet')) console.log(s);
};

function screenText(ui: UIComponent[]): string[] {
  return ui.map((c) => {
    switch (c.type) {
      case 'text':
        return c.style === 'heading' ? `# ${c.content}` : c.style === 'muted' ? `(${c.content})` : c.content;
      case 'multiple_choice':
        return `[choice] ${c.question}: ${c.options.map((o) => `«${o}»`).join(' ')}`;
      case 'input':
        return `[text field] ${c.label ?? c.fieldId}`;
      case 'button':
        return `[button] ${c.label}`;
      case 'list':
        return c.items.map((i) => `  - ${i}`).join('\n');
      case 'countdown':
        return `[timer ${c.seconds}s${c.label ? `: ${c.label}` : ''}]`;
      case 'scoreboard':
        return `[scores] ${c.players.map((p) => `${p.name} ${p.score}`).join(', ')}`;
      default:
        return `[${c.type}]`;
    }
  });
}

type Act = { label: string; input: { kind: 'action' | 'submit'; id: string; values?: Record<string, string> }; needsText?: string[] };

function possibleActs(ui: UIComponent[]): Act[] {
  const acts: Act[] = [];
  const choice = ui.find((c): c is Extract<UIComponent, { type: 'multiple_choice' }> => c.type === 'multiple_choice');
  if (choice) {
    for (const o of choice.options) acts.push({ label: `pick «${o}»`, input: { kind: 'submit', id: choice.fieldId, values: { [choice.fieldId]: o } } });
    return acts;
  }
  const inputs = ui.filter((c): c is Extract<UIComponent, { type: 'input' }> => c.type === 'input');
  for (const b of ui.filter((c): c is Extract<UIComponent, { type: 'button' }> => c.type === 'button')) {
    acts.push({
      label: inputs.length ? `type into ${inputs.map((i) => `"${i.label ?? i.fieldId}"`).join(', ')} and press [${b.label}]` : `press [${b.label}]`,
      input: { kind: inputs.length ? 'submit' : 'action', id: b.actionId },
      needsText: inputs.length ? inputs.map((i) => i.fieldId) : undefined,
    });
  }
  return acts;
}

/** The local model plays: it sees the screen and picks an action like a person would. */
async function decide(name: string, ui: UIComponent[], acts: Act[]): Promise<{ act: Act; texts: Record<string, string> }> {
  const schema = {
    type: 'object',
    properties: { action: { type: 'number' }, texts: { type: 'object', additionalProperties: { type: 'string' } } },
    required: ['action', 'texts'],
  };
  const fields = acts.flatMap((a) => a.needsText ?? []);
  const prompt =
    `You are ${name}, a player in a party game on your phone. Play well and honestly, like a real person.\n\nGAME RULES:\n${rules}\n\nYOUR SCREEN:\n${screenText(ui).join('\n')}\n\n` +
    `What do you do? Actions:\n${acts.map((a, i) => `${i + 1}. ${a.label}`).join('\n')}\n` +
    (fields.length ? `If you type, put your text per field id in "texts" (field ids: ${[...new Set(fields)].join(', ')}).\n` : '') +
    'Reply with JSON: {"action": <number>, "texts": {...}}';
  try {
    const r = await chat({ messages: [{ role: 'user', content: prompt }], responseSchema: { name: 'player_move', schema } });
    const obj = extractJsonObject(r.choices[0].message.content ?? '') ?? {};
    const n = Math.round(Number(obj.action));
    const act = acts[n >= 1 && n <= acts.length ? n - 1 : 0];
    return { act, texts: (obj.texts as Record<string, string>) ?? {} };
  } catch {
    return { act: acts[0], texts: {} };
  }
}

async function playGame(n: number): Promise<void> {
  const players = botPlayers(playerCount);
  const nameOf = (id: string) => players.find((p) => p.id === id)?.name ?? id;
  const ai = async (req: AiRequest) => {
    const t0 = Date.now();
    const result = await performAiRequest(req, { rules });
    log(`> g.ai.${req.op} (complexity ${req.complexity}, ${((Date.now() - t0) / 1000).toFixed(1)} s): ${req.prompt.slice(0, 160)}`);
    log(`> → ${JSON.stringify(result).slice(0, 600)}`);
    return result;
  };
  log(`\n## Game ${n} (${players.map((p) => p.name).join(', ')})\n`);
  let out: DispatchOutput = await runDispatch(program, { engine: null, players, event: { type: 'start' }, seed: Date.now() % 100000 }, { ai });
  let lastShown = '';
  for (let step = 0; step < maxSteps; step++) {
    const engine: EngineState = out.engine;
    const shown = JSON.stringify(out.screens);
    if (shown !== lastShown) {
      lastShown = shown;
      log(`### ${out.over ? 'END' : `phase "${engine.phase}", round ${engine.round}`} (turn ${engine.turn})`);
      const groups = new Map<string, string[]>();
      for (const p of players) {
        const key = screenText(out.screens[p.id] ?? []).join('\n');
        groups.set(key, [...(groups.get(key) ?? []), p.name]);
      }
      for (const [text, who] of groups) log(`**${who.join(', ')}:**\n${text.split('\n').map((l) => `    ${l}`).join('\n')}`);
    }
    if (out.result?.error) log(`! ${out.result.error}`);
    if (out.over) {
      log(`\n**Result:** ${out.over.message}`);
      return;
    }
    const waiting = (out.waiting?.expected ?? []).filter((id) => !out.waiting!.answered.includes(id));
    let event: GameEvent | null = null;
    if (out.timer && (waiting.length === 0 || Math.random() < 0.08)) {
      event = { type: 'timer', turn: out.timer.turn };
      log(`→ (time runs out)`);
    } else if (waiting.length) {
      const who = waiting[Math.floor(Math.random() * waiting.length)];
      const acts = possibleActs(out.screens[who] ?? []);
      if (!acts.length) {
        log(`! ${nameOf(who)} is expected to act but has nothing to click`);
        return;
      }
      const { act, texts } = await decide(nameOf(who), out.screens[who] ?? [], acts);
      const input = { ...act.input };
      if (act.needsText) input.values = Object.fromEntries(act.needsText.map((f) => [f, String(texts[f] ?? '')]));
      log(`→ ${nameOf(who)}: ${act.label}${input.values && act.needsText ? ` ${JSON.stringify(input.values)}` : ''}`);
      event = { type: 'input', playerId: who, turn: engine.turn, input };
    }
    if (!event) {
      log('! stuck: nobody can act and there is no timer');
      return;
    }
    out = await runDispatch(program, { engine, players, event }, { ai });
  }
  log(`! stopped after ${maxSteps} steps`);
}

(async () => {
  const name = path.basename(programPath, '.js');
  log(`# ${name}: ${games} game(s), ${playerCount} players`);
  for (let i = 1; i <= games; i++) {
    try {
      await playGame(i);
    } catch (err) {
      log(`! PROGRAM ERROR: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const dir = path.join(dataDir(), 'program-plays');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}_${name}.md`);
  fs.writeFileSync(file, lines.join('\n'));
  console.error(`Transcript: ${file}`);
})();
