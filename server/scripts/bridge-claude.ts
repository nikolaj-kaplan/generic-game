/**
 * Answer LLM bridge requests with a fresh, tool-less headless Claude per
 * request (no memory between requests, like a real LLM call), and show each
 * question and answer in the terminal while it happens.
 *
 *   npm run bridge:claude --prefix server
 *   BRIDGE_MODEL=claude-sonnet-5-5 npm run bridge:claude --prefix server
 *
 * Starts the bridge endpoint (llm-bridge.ts) as well, unless one is already
 * running on the port; then it only answers.
 */
import { spawn, ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import { BridgeRequest, formatRequest, schemaName } from './bridge-format';
import { BRIDGE_PORT, BRIDGE_ROOT, DONE, PENDING, startBridgeServer } from './llm-bridge';

const MODEL = process.env.BRIDGE_MODEL ?? 'claude-opus-5-5';
const WORKDIR = path.join(BRIDGE_ROOT, 'cwd'); // empty folder: no project CLAUDE.md or settings leak in
const SYSTEM =
  'You are the language model behind a party-game app, receiving one chat-completion request (shown as SYSTEM / USER / ASSISTANT sections). ' +
  'Respond exactly as the SYSTEM section instructs, to the latest message. Output only the reply: a single JSON object in the requested format, ' +
  'with no markdown fences and no commentary. Ignore the "Write the reply to" line; the caller saves your output.';

// ─── Terminal styling ────────────────────────────────────────────────────────

const tty = process.stdout.isTTY === true;
const paint = (code: string) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const c = {
  dim: paint('2'),
  bold: paint('1'),
  cyan: paint('36'),
  green: paint('32'),
  yellow: paint('33'),
  red: paint('31'),
  magenta: paint('35'),
  blue: paint('34'),
};
const width = () => Math.min(process.stdout.columns || 100, 120);
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, Math.max(0, n - 1))}…` : s);
const kb = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const clock = () => new Date().toLocaleTimeString('en-GB');

const KINDS: Record<string, string> = {
  definition_reply: 'rules chat',
  game_program: 'game program',
  chat: 'chat',
};
const kindOf = (name: string) => KINDS[name] ?? (name.startsWith('ai') ? `in-game AI (${name})` : name);

const bar = c.dim('│');
const say = (line = '') => console.log(line ? `${bar} ${line}` : bar);

// ─── Question ────────────────────────────────────────────────────────────────

function showQuestion(n: number, request: BridgeRequest): void {
  const kind = kindOf(schemaName(request));
  const head = `┌ #${n} · ${clock()} · `;
  console.log(`\n${c.dim(head)}${c.bold(c.cyan(kind))} ${c.dim('─'.repeat(Math.max(3, width() - head.length - kind.length - 1)))}`);

  const system = request.messages.find((m) => m.role === 'system')?.content ?? '';
  const users = request.messages.filter((m) => m.role === 'user');
  const last = users[users.length - 1]?.content ?? '';
  const lines = last.split('\n').filter((l, i, all) => l.trim() || (i > 0 && all[i - 1].trim()));
  const shown = lines.slice(0, 8);
  const room = width() - 7;
  shown.forEach((l, i) => say(`${i === 0 ? c.bold(c.yellow('Q ')) : '  '} ${clip(l, room)}`));
  const notes = [
    lines.length > shown.length ? `… ${lines.length - shown.length} more lines` : '',
    users.length > 1 ? `follow-up ${users.length - 1} in this conversation` : '',
    `system prompt ${kb(system.length)} chars`,
  ].filter(Boolean);
  say(`   ${c.dim(notes.join(' · '))}`);
  say();
}

// ─── Answer ──────────────────────────────────────────────────────────────────

const CODE_KEYS = new Set(['program', 'migration', 'code']);

function preview(value: unknown, room: number, key = ''): string {
  if (typeof value === 'string') {
    const lines = value.split('\n');
    if (CODE_KEYS.has(key) && value.trim()) return c.magenta(`«${lines.length} lines of code»`);
    if (lines.length > 1) return `${c.green(JSON.stringify(clip(lines[0], room - 20)))} ${c.dim(`+${lines.length - 1} lines`)}`;
    return c.green(JSON.stringify(clip(value, room)));
  }
  if (Array.isArray(value)) {
    if (!value.length) return c.dim('[]');
    const first = value.slice(0, 3).map((v) => clip(typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v), 60));
    return `${c.blue(`[${value.length}]`)} ${clip(first.join(', '), room - 8)}${value.length > 3 ? c.dim(', …') : ''}`;
  }
  if (value && typeof value === 'object') return clip(JSON.stringify(value), room);
  return c.yellow(String(value));
}

function showAnswer(raw: string, seconds: number, failed: boolean): void {
  const stats = `${seconds.toFixed(1)}s · ${kb(raw.length)} chars`;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }
  if (failed || parsed === undefined) {
    say(`${c.bold(c.red('A  ✗'))} ${c.dim(stats)} ${c.red(failed ? 'Claude exited with an error' : 'not JSON')}`);
    raw.split('\n').slice(0, 6).forEach((l) => say(`   ${c.red(clip(l, width() - 6))}`));
  } else {
    say(`${c.bold(c.green('A  ✓'))} ${c.dim(stats)}`);
    const room = width() - 8;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const entries = Object.entries(parsed as Record<string, unknown>);
      const keyWidth = Math.min(16, Math.max(...entries.map(([k]) => k.length)));
      for (const [k, v] of entries.slice(0, 12)) say(`   ${c.dim(k.padEnd(keyWidth))}  ${preview(v, room - keyWidth, k)}`);
      if (entries.length > 12) say(`   ${c.dim(`… ${entries.length - 12} more fields`)}`);
    } else {
      say(`   ${preview(parsed, room)}`);
    }
  }
  console.log(c.dim(`└${'─'.repeat(width() - 1)}`));
}

// ─── Waiting ─────────────────────────────────────────────────────────────────

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function queued(currentId: string): number {
  return pendingIds().filter((id) => id !== currentId).length;
}

/** Spinner line while the model works; returns a function that clears it. */
function thinking(id: string): () => void {
  const start = Date.now();
  const label = MODEL.replace(/^claude-/, '').replace(/-(\d+)-(\d+)$/, ' $1.$2');
  if (!tty) {
    say(c.dim(`… waiting for ${label}`));
    return () => undefined;
  }
  let frame = 0;
  const draw = () => {
    const secs = Math.floor((Date.now() - start) / 1000);
    const waiting = queued(id);
    const more = waiting ? c.yellow(`   +${waiting} queued`) : '';
    process.stdout.write(`\r\x1b[2K${bar} ${c.magenta(FRAMES[frame++ % FRAMES.length])} ${c.bold(`Waiting for ${label}`)} ${c.dim(`${secs}s`)}${more}`);
  };
  draw();
  const timer = setInterval(draw, 100);
  return () => {
    clearInterval(timer);
    process.stdout.write('\r\x1b[2K');
  };
}

// ─── Worker ──────────────────────────────────────────────────────────────────

let child: ChildProcess | null = null;

function pendingIds(): string[] {
  if (!fs.existsSync(PENDING)) return [];
  return fs
    .readdirSync(PENDING)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''))
    .filter((id) => !fs.existsSync(path.join(DONE, `${id}.txt`)))
    .sort();
}

function askClaude(prompt: string): Promise<{ output: string; failed: boolean }> {
  return new Promise((resolve) => {
    const args = ['-p', '--model', MODEL, '--tools', '', '--no-session-persistence', '--strict-mcp-config', '--output-format', 'text', '--append-system-prompt', SYSTEM];
    const proc = spawn('claude', args, { cwd: WORKDIR, stdio: ['pipe', 'pipe', 'pipe'] });
    child = proc;
    let output = '';
    proc.stdout.on('data', (d) => (output += d));
    proc.stderr.on('data', (d) => (output += d));
    proc.on('error', (err) => {
      child = null;
      resolve({ output: String(err), failed: true });
    });
    proc.on('close', (code) => {
      child = null;
      resolve({ output, failed: code !== 0 });
    });
    proc.stdin.end(prompt);
  });
}

/** Keep only the outermost JSON object (drops stray fences or prose). */
function outermostJson(text: string): string {
  const a = text.indexOf('{');
  const b = text.lastIndexOf('}');
  return a !== -1 && b > a ? text.slice(a, b + 1) : text;
}

async function main(): Promise<void> {
  fs.mkdirSync(WORKDIR, { recursive: true });
  const header = `◆ LLM bridge · ${MODEL}`;
  console.log(`\n${c.bold(c.magenta(header))}`);
  try {
    await startBridgeServer(() => undefined);
    console.log(c.dim(`  endpoint http://127.0.0.1:${BRIDGE_PORT}/v1 · answers with a fresh headless Claude per request`));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
    console.log(c.dim(`  endpoint already running on :${BRIDGE_PORT} (another process), only answering`));
  }
  console.log(c.dim('  Ctrl+C to stop'));

  let n = 0;
  let idle = true;
  for (;;) {
    const id = pendingIds()[0];
    if (!id) {
      if (!idle) console.log(c.dim(`\n  ${clock()} · idle, waiting for requests…`));
      idle = true;
      await new Promise((r) => setTimeout(r, 500));
      continue;
    }
    idle = false;
    const file = path.join(PENDING, `${id}.json`);
    let request: BridgeRequest;
    try {
      request = JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch {
      await new Promise((r) => setTimeout(r, 200)); // still being written
      continue;
    }
    showQuestion(++n, request);
    const stop = thinking(id);
    const started = Date.now();
    const { output, failed } = await askClaude(formatRequest(id, request, path.join(DONE, `${id}.txt`)));
    stop();
    const json = outermostJson(output);
    fs.writeFileSync(path.join(DONE, `${id}.tmp`), json);
    fs.renameSync(path.join(DONE, `${id}.tmp`), path.join(DONE, `${id}.txt`));
    showAnswer(json, (Date.now() - started) / 1000, failed);
  }
}

process.on('SIGINT', () => {
  child?.kill();
  if (tty) process.stdout.write('\r\x1b[2K');
  console.log(c.dim('\n  bridge stopped'));
  process.exit(0);
});

void main();
