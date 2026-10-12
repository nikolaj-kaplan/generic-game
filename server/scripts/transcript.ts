/**
 * Print a readable transcript of one game from its LLM log folder:
 * each event, what the AI changed in the state, and what each player saw.
 *
 *   npm run transcript --prefix server -- data/llm-logs/<folder>
 *   npm run transcript --prefix server -- latest        (newest game in data/llm-logs)
 */
import fs from 'fs';
import path from 'path';

const arg = process.argv[2];
if (!arg) {
  console.error('Usage: transcript <log folder | latest>');
  process.exit(1);
}

function resolveDir(a: string): string {
  if (a !== 'latest') return path.resolve(a);
  const root = path.join(__dirname, '..', '..', 'data', 'llm-logs');
  const dirs = fs.readdirSync(root).filter((d) => d.endsWith('_play')).sort();
  return path.join(root, dirs[dirs.length - 1]);
}

const dir = resolveDir(arg);
const files = fs.readdirSync(dir).filter((f) => /^\d+_playing\.json$/.test(f)).sort();

type Component = Record<string, unknown> & { type: string };

function show(ui: Component[]): string {
  return ui
    .map((c) => {
      switch (c.type) {
        case 'text': return String(c.content);
        case 'multiple_choice': {
          const opts = c.player_options
            ? `<players: ${c.player_options}>`
            : Array.isArray(c.options)
              ? (c.options as Array<string | { label: string; owner?: string }>)
                  .map((o) => (typeof o === 'string' ? o : `${o.label}${o.owner ? ` (by ${o.owner.slice(0, 8)})` : ''}`))
                  .join(' / ')
              : String(c.options);
          return `[choice] ${c.question} → ${opts}`;
        }
        case 'button': return `[button ${c.label}]`;
        case 'input': return `[input ${c.label ?? c.fieldId}]`;
        case 'form': return `[form ${(c.fields as Component[]).map((f) => f.label ?? f.fieldId).join(', ')}]`;
        case 'scoreboard': return `[scores ${(c.players as Array<{ name: string; score: number }>).map((p) => `${p.name}:${p.score}`).join(' ')}]`;
        case 'list': return `[list] ${(c.items as string[]).join(' · ')}`;
        default: return `[${c.type}]`;
      }
    })
    .join('\n      ');
}

let lastEvent = '';
for (const f of files) {
  const entry = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
  const users = (entry.request.messages as Array<{ role: string; content: string }>).filter((m) => m.role === 'user');
  const event = (users[users.length - 1]?.content ?? '').split('\n\nCURRENT GAME STATE')[0];
  let reply: Record<string, unknown> | null = null;
  try {
    reply = JSON.parse(entry.response.content ?? '');
  } catch {
    const call = entry.response.toolCalls?.[0];
    reply = call ? call.arguments : null;
  }

  if (event !== lastEvent) {
    console.log(`\n▶ ${event.replace(/\n/g, '\n  ')}`);
    lastEvent = event;
  } else {
    console.log('  (retry)');
  }
  const ms = entry.durationMs;
  if (!reply) {
    console.log(`  ✗ ${ms} ms, no usable reply: ${String(entry.response.content ?? entry.error ?? '').slice(0, 200)}`);
    continue;
  }
  const flags = [
    reply.wait_for && `wait_for=${reply.wait_for}`,
    reply.timer_seconds && `timer=${reply.timer_seconds}s`,
    Array.isArray(reply.intro) && reply.intro.length && `intro=${reply.intro.length}`,
    reply.game_over === true && 'GAME OVER',
  ].filter(Boolean);
  console.log(`  ⏱ ${(ms / 1000).toFixed(1)}s, ${entry.response.usage?.completion_tokens ?? '?'} tokens out ${flags.length ? `· ${flags.join(' · ')}` : ''}`);
  if (reply.state_update) console.log(`  state ← ${JSON.stringify(reply.state_update).slice(0, 400)}`);
  if (reply.state_append) console.log(`  state += ${JSON.stringify(reply.state_append).slice(0, 300)}`);
  for (const [who, ui] of Object.entries((reply.screens ?? {}) as Record<string, Component[]>)) {
    console.log(`  ${who === 'all' ? 'ALL' : who.slice(0, 8)}: ${show(ui)}`);
  }
}
