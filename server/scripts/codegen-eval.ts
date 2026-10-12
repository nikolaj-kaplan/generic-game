/**
 * Code-generation evaluation: let a model write programs for the preset games
 * and record how it went. Each run writes data/codegen-evals/<run>/report.json
 * (plus the programs), then rebuilds data/codegen-evals/index.html, a static
 * page comparing every run so far (models, prompts and library versions).
 *
 *   npm run codegen:eval -- --game most-likely --model strong
 *   npm run codegen:eval -- --all --model local        (Ollama trial)
 *   npm run codegen:eval -- --html                     (only rebuild the page)
 *
 * --model is an entry from models.json (default: the generator model).
 * The strong model runs through the Claude bridge: keep those runs small.
 */
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { ENV_FILE, dataDir } from '../src/paths';

dotenv.config({ path: ENV_FILE });

import { GAME_PRESETS } from '../../client/src/data/presets';
import { generateProgram } from '../src/engine/generator';
import { generatorModel, namedModel } from '../src/engine/models';
import { PRESET_RANGES } from '../src/engine/presets';

interface GameResult {
  game: string;
  ok: boolean;
  attempts: number;
  seconds: number;
  questions?: string;
  problems: string[];
  linesOfCode?: number;
  customLines?: number;
  aiCalls?: Record<string, number>;
  botGames?: number;
  botFinished?: number;
  phases?: Record<string, string>;
  summary?: string;
  assumptions: string[];
}

interface Report {
  run: string;
  model: string;
  modelName: string;
  startedAt: string;
  results: GameResult[];
}

const LIBRARY = /\b(defineGame|collect|turn|buzzer|show|slides|ui\.|g\.|tally|match\.)/;

/** Non-blank, non-comment lines, and the ones that use no library name (approximate "own logic"). */
function measure(code: string): { linesOfCode: number; customLines: number } {
  const lines = code.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('//') && !/^[\])},;]+$/.test(l));
  return { linesOfCode: lines.length, customLines: lines.filter((l) => !LIBRARY.test(l)).length };
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const ROOT = path.join(dataDir(), 'codegen-evals');

async function main(): Promise<void> {
  if (!process.argv.includes('--html')) await evaluate();
  writeHtml();
}

async function evaluate(): Promise<void> {
  const modelName = arg('model');
  const model = modelName ? namedModel(modelName) : generatorModel();
  const games = process.argv.includes('--all') ? GAME_PRESETS.map((p) => p.id) : (arg('game') ?? 'most-likely').split(',');
  const run = `${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}_${model.name}`;
  const dir = path.join(ROOT, run);
  fs.mkdirSync(dir, { recursive: true });
  const report: Report = { run, model: model.model, modelName: model.name, startedAt: new Date().toISOString(), results: [] };
  console.log(`[eval] ${games.length} game(s) with ${model.name} (${model.model}) → ${dir}`);

  for (const game of games) {
    const preset = GAME_PRESETS.find((p) => p.id === game);
    if (!preset) {
      console.warn(`[eval] Unknown game ${game}`);
      continue;
    }
    console.log(`[eval] ${game}…`);
    const t0 = Date.now();
    const r = await generateProgram(preset.prompt, PRESET_RANGES[game], {
      model,
      excludeExample: game,
      logDir: path.join('..', 'codegen-evals', run, 'llm-logs'),
      onProgress: (m) => console.log(`[eval]   ${m}`),
    });
    const result: GameResult = {
      game,
      ok: r.ok,
      attempts: r.attempts,
      seconds: Math.round((Date.now() - t0) / 100) / 10,
      problems: r.problems,
      summary: r.summary,
      assumptions: r.assumptions,
      ...(r.questions ? { questions: r.questions } : {}),
    };
    if (r.program) {
      fs.writeFileSync(path.join(dir, `${game}.js`), r.program);
      Object.assign(result, measure(r.program));
    }
    if (r.bots) {
      result.aiCalls = r.bots.aiCallsByComplexity;
      result.botGames = r.bots.runs.length;
      result.botFinished = r.bots.runs.filter((x) => x.finished).length;
    }
    if (r.info) result.phases = r.info.phases;
    report.results.push(result);
    fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 2));
    console.log(`[eval]   ${r.ok ? 'PASSED' : 'FAILED'} in ${result.seconds} s, ${r.attempts} attempt(s)${r.problems.length ? `: ${r.problems[0]}` : ''}`);
  }
}

// ─── Results page ────────────────────────────────────────────────────────────

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

function writeHtml(): void {
  if (!fs.existsSync(ROOT)) return;
  const reports: Report[] = fs
    .readdirSync(ROOT)
    .filter((d) => fs.existsSync(path.join(ROOT, d, 'report.json')))
    .map((d) => JSON.parse(fs.readFileSync(path.join(ROOT, d, 'report.json'), 'utf-8')) as Report)
    .sort((a, b) => b.run.localeCompare(a.run));

  const models = [...new Set(reports.map((r) => r.modelName))];
  const summaryRows = models
    .map((m) => {
      const all = reports.filter((r) => r.modelName === m).flatMap((r) => r.results);
      const passed = all.filter((x) => x.ok);
      const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : '–');
      return `<tr><td>${esc(m)}</td><td>${passed.length} / ${all.length}</td><td>${avg(passed.map((x) => x.attempts))}</td><td>${avg(passed.map((x) => x.seconds))}</td><td>${avg(passed.map((x) => x.linesOfCode ?? 0))}</td><td>${avg(passed.map((x) => x.customLines ?? 0))}</td></tr>`;
    })
    .join('');

  const runRows = reports
    .flatMap((r) =>
      r.results.map((x) => {
        const ai = x.aiCalls ? Object.entries(x.aiCalls).map(([k, v]) => `${k}:${v}`).join(' ') : '';
        const status = x.ok ? '<span class="ok">passed</span>' : x.questions ? '<span class="warn">asked</span>' : '<span class="bad">failed</span>';
        const program = fs.existsSync(path.join(ROOT, r.run, `${x.game}.js`)) ? `<a href="${esc(r.run)}/${esc(x.game)}.js">program</a>` : '';
        const detail = x.questions ?? x.problems[0] ?? x.summary ?? '';
        return `<tr><td>${esc(r.run.slice(0, 16).replace('T', ' '))}</td><td>${esc(r.modelName)}</td><td>${esc(x.game)}</td><td>${status}</td><td>${x.attempts}</td><td>${x.seconds}</td><td>${x.linesOfCode ?? ''}</td><td>${x.customLines ?? ''}</td><td>${esc(ai)}</td><td>${program}</td><td class="detail">${esc(detail)}</td></tr>`;
      }),
    )
    .join('');

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Code generation results</title>
<style>
:root { --bg: #fff; --text: #1c1c1e; --muted: #6e6e73; --line: #e5e5ea; --ok: #248a3d; --bad: #d70015; --warn: #c93400; }
@media (prefers-color-scheme: dark) { :root { --bg: #1c1c1e; --text: #f2f2f7; --muted: #98989d; --line: #38383a; --ok: #30d158; --bad: #ff453a; --warn: #ff9f0a; } }
body { margin: 0; padding: 24px 16px; background: var(--bg); color: var(--text); font: 14px/1.45 system-ui, -apple-system, sans-serif; }
h1 { font-size: 20px; margin: 0 0 4px; } h2 { font-size: 16px; margin: 28px 0 8px; }
p { color: var(--muted); margin: 0 0 16px; max-width: 70ch; }
.wrap { overflow-x: auto; } table { border-collapse: collapse; width: 100%; }
th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--line); vertical-align: top; white-space: nowrap; }
th { color: var(--muted); font-weight: 600; } td.detail { white-space: normal; min-width: 240px; color: var(--muted); }
.ok { color: var(--ok); } .bad { color: var(--bad); } .warn { color: var(--warn); } a { color: inherit; }
</style></head><body>
<h1>Code generation results</h1>
<p>Each row is one program written from a preset's rules. "Own logic" counts lines that use no library name: the code the library could take over next. AI calls are per complexity level, counted over the bot test games.</p>
<h2>By model</h2>
<div class="wrap"><table><tr><th>Model</th><th>Passed</th><th>Attempts</th><th>Seconds</th><th>Lines</th><th>Own logic</th></tr>${summaryRows}</table></div>
<h2>Every program</h2>
<div class="wrap"><table><tr><th>Run</th><th>Model</th><th>Game</th><th>Result</th><th>Attempts</th><th>Seconds</th><th>Lines</th><th>Own logic</th><th>AI calls</th><th></th><th>Detail</th></tr>${runRows}</table></div>
</body></html>`;
  fs.writeFileSync(path.join(ROOT, 'index.html'), html);
  console.log(`[eval] Results page: ${path.join(ROOT, 'index.html')}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
