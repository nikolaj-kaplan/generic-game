import fs from 'fs';
import path from 'path';
import { LLMMessage, LLMTool, LLMResponse, GameMetrics } from '../types';
import { dataDir } from '../paths';

// One folder per definition chat / game run: data/llm-logs/<runDir>/
// Each LLM exchange writes <seq>_<phase>.json plus a readable .yaml summary.

export type LogPhase = 'definition' | 'playing' | 'generate' | 'patch' | 'ai' | 'unknown';

function logRoot(): string {
  return path.join(dataDir(), 'llm-logs');
}

const seqByDir = new Map<string, number>();

function nextSeq(dir: string): number {
  let seq = seqByDir.get(dir);
  if (seq === undefined) {
    // Continue numbering if the folder already has files (server restart).
    seq = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json') && /^\d+_/.test(f)).length : 0;
  }
  seqByDir.set(dir, ++seq);
  return seq;
}

/** Build a folder name like 2026-10-10_08-30-00_ABCDE_play */
export function newLogDirName(joinCode: string, kind: 'define' | 'play' | 'build'): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  return `${ts}_${joinCode}_${kind}`;
}

/** Write metrics.json for a game run so model/prompt variants can be compared. */
export function writeMetrics(runDir: string | undefined, metrics: GameMetrics): void {
  try {
    const dir = path.join(logRoot(), runDir ?? 'unsorted');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'metrics.json'), JSON.stringify(metrics, null, 2));
  } catch (err) {
    console.error('[llm-logger] Failed to write metrics:', err);
  }
}

/** A message as it appears in log files — tool-call arguments are parsed JSON, not raw strings. */
type LogMessage = Omit<LLMMessage, 'tool_calls'> & {
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: unknown };
  }>;
};

export interface LLMLogEntry {
  timestamp: string;
  model: string;
  phase: LogPhase;
  durationMs: number;
  request: {
    systemPrompt: string | null;
    messages: LogMessage[];
    tools: LLMTool[] | null;
    temperature: number | null;
  };
  response: {
    finishReason: string;
    content: string | null;
    reasoning?: string;
    toolCalls: Array<{
      id: string;
      name: string;
      arguments: unknown;
    }> | null;
    usage?: LLMResponse['usage'];
  };
  error?: string;
}

// =============================================================================
// YAML summary helpers
// =============================================================================

/** Encode a string as a valid YAML scalar, choosing style based on content. */
function yamlStr(s: string | null | undefined, indent = '    '): string {
  if (s == null) return 'null';
  // Truncate very long strings
  const truncated = s.length > 300 ? s.slice(0, 297) + '...' : s;
  // If the string contains newlines use a literal block scalar (|)
  if (truncated.includes('\n')) {
    const block = truncated
      .split('\n')
      .map((line) => `${indent}${line}`)
      .join('\n');
    return `|\n${block}`;
  }
  // Otherwise single-quoted (escape internal single quotes by doubling them)
  return `'${truncated.replace(/'/g, "''")}'`;
}

function yamlVal(v: unknown, indent = '    '): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  if (typeof v === 'string') return yamlStr(v, indent);
  return yamlStr(JSON.stringify(v), indent);
}

/** Render a UI component array as readable YAML lines. */
function renderUiComponents(components: unknown[], baseIndent: string): string[] {
  const lines: string[] = [];
  for (const c of components as Array<Record<string, unknown>>) {
    lines.push(`${baseIndent}- type: ${c.type}`);
    switch (c.type) {
      case 'text':
        lines.push(`${baseIndent}  content: ${yamlStr(c.content as string, baseIndent + '  ')}`);
        if (c.style) lines.push(`${baseIndent}  style: ${c.style}`);
        break;
      case 'button':
        lines.push(`${baseIndent}  label: ${yamlStr(c.label as string, baseIndent + '  ')}`);
        lines.push(`${baseIndent}  actionId: ${c.actionId}`);
        if (c.style) lines.push(`${baseIndent}  style: ${c.style}`);
        break;
      case 'multiple_choice':
        lines.push(`${baseIndent}  fieldId: ${c.fieldId}`);
        lines.push(`${baseIndent}  question: ${yamlStr(c.question as string, baseIndent + '  ')}`);
        lines.push(`${baseIndent}  options: [${(c.options as string[]).map(o => `'${o}'`).join(', ')}]`);
        break;
      case 'input':
        lines.push(`${baseIndent}  fieldId: ${c.fieldId}`);
        if (c.label) lines.push(`${baseIndent}  label: ${yamlStr(c.label as string, baseIndent + '  ')}`);
        if (c.placeholder) lines.push(`${baseIndent}  placeholder: ${yamlStr(c.placeholder as string, baseIndent + '  ')}`);
        break;
      case 'scoreboard': {
        const players = c.players as Array<{ name: string; score: number }>;
        lines.push(`${baseIndent}  players: [${players.map(p => `${p.name}:${p.score}`).join(', ')}]`);
        break;
      }
      case 'form':
        lines.push(`${baseIndent}  formId: ${c.formId}`);
        if (c.submitLabel) lines.push(`${baseIndent}  submitLabel: ${yamlStr(c.submitLabel as string, baseIndent + '  ')}`);
        if (Array.isArray(c.fields) && c.fields.length) {
          lines.push(`${baseIndent}  fields:`);
          lines.push(...renderUiComponents(c.fields as unknown[], baseIndent + '    '));
        }
        break;
      case 'list':
        lines.push(`${baseIndent}  items: [${(c.items as string[]).map(i => `'${i}'`).join(', ')}]`);
        break;
      default:
        // countdown, divider — no extra fields needed
        break;
    }
  }
  return lines;
}

/**
 * Render tool call arguments as readable YAML lines.
 * next_turn gets special treatment; everything else falls back to a
 * single-line JSON string.
 */
function renderToolArgs(name: string, args: unknown, baseIndent: string): string[] {
  if (typeof args !== 'object' || args === null) return [`${baseIndent}${yamlVal(args, baseIndent)}`];
  const a = args as Record<string, unknown>;

  if (name === 'next_turn') {
    const lines: string[] = [];
    for (const key of ['wait_for', 'timer_seconds', 'rule_change']) {
      if (a[key] != null) lines.push(`${baseIndent}${key}: ${yamlVal(a[key], baseIndent + '  ')}`);
    }
    if (a.state_update != null) lines.push(`${baseIndent}state_update: ${yamlVal(a.state_update, baseIndent + '  ')}`);
    if (Array.isArray(a.intro)) {
      lines.push(`${baseIndent}intro: # ${a.intro.length} slide(s)`);
      for (const slide of a.intro as Array<Record<string, unknown>>) {
        lines.push(`${baseIndent}  - seconds: ${slide.seconds}`);
        if (Array.isArray(slide.screen)) {
          lines.push(`${baseIndent}    screen:`);
          lines.push(...renderUiComponents(slide.screen, baseIndent + '      '));
        }
      }
    }
    if (typeof a.screens === 'object' && a.screens !== null) {
      lines.push(`${baseIndent}screens:`);
      for (const [target, ui] of Object.entries(a.screens as Record<string, unknown>)) {
        lines.push(`${baseIndent}  ${target}:`);
        if (Array.isArray(ui)) lines.push(...renderUiComponents(ui, baseIndent + '    '));
        else lines.push(`${baseIndent}    ${yamlVal(ui, baseIndent + '    ')}`);
      }
    }
    if (a.game_over != null) lines.push(`${baseIndent}game_over: ${yamlVal(a.game_over, baseIndent + '  ')}`);
    return lines.length ? lines : [`${baseIndent}${yamlVal(args, baseIndent)}`];
  }

  // Default: single-line JSON string
  return [`${baseIndent}${yamlVal(args, baseIndent)}`];
}

/** Render a single message from the conversation history as a compact YAML block. */
function summariseMessage(m: LogMessage): string {
  const lines: string[] = [];
  lines.push(`  - role: ${m.role}`);
  if (m.role === 'assistant' && m.tool_calls?.length) {
    lines.push(`    tool_calls:`);
    for (const tc of m.tool_calls) {
      const argLines = renderToolArgs(tc.function.name, tc.function.arguments, '        ');
      if (argLines.length === 1) {
        lines.push(`      - ${tc.function.name}: ${argLines[0].trimStart()}`);
      } else {
        lines.push(`      - ${tc.function.name}:`);
        lines.push(...argLines);
      }
    }
  } else if (m.content) {
    const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
    lines.push(`    content: ${yamlStr(content, '      ')}`);
  } else if (m.role === 'tool') {
    lines.push(`    content: ${yamlStr(typeof m.content === 'string' ? m.content : JSON.stringify(m.content))}`);
  }
  return lines.join('\n');
}

function writeSummary(filePath: string, seq: number, entry: LLMLogEntry): void {
  try {
    const lines: string[] = [];
    lines.push(`seq: ${seq}`);
    lines.push(`phase: ${entry.phase}`);
    lines.push(`model: ${entry.model}`);
    lines.push(`duration_ms: ${entry.durationMs}`);
    lines.push(`finish_reason: ${entry.response.finishReason}`);
    if (entry.response.usage) {
      const u = entry.response.usage;
      lines.push(`tokens: {prompt: ${u.prompt_tokens}, completion: ${u.completion_tokens}, total: ${u.total_tokens}}`);
    }
    if (entry.error) {
      lines.push(`error: ${yamlStr(entry.error, '  ')}`);
    }

    lines.push(`messages:`);
    for (const m of entry.request.messages) {
      lines.push(summariseMessage(m));
    }

    if (entry.response.reasoning) {
      lines.push(`response_reasoning: ${yamlStr(entry.response.reasoning, '  ')}`);
    }
    if (entry.response.toolCalls?.length) {
      lines.push(`response_tool_calls:`);
      for (const tc of entry.response.toolCalls) {
        const argLines = renderToolArgs(tc.name, tc.arguments, '    ');
        if (argLines.length === 1) {
          lines.push(`  - ${tc.name}: ${argLines[0].trimStart()}`);
        } else {
          lines.push(`  - ${tc.name}:`);
          lines.push(...argLines);
        }
      }
    }
    if (entry.response.content) {
      lines.push(`response_content: ${yamlStr(entry.response.content, '  ')}`);
    }

    fs.writeFileSync(filePath, lines.join('\n') + '\n');
  } catch (err) {
    console.error('[llm-logger] Failed to write summary:', err);
  }
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Write a structured JSON log file (and a YAML summary) for one LLM exchange.
 * Non-blocking — errors are swallowed so logging never crashes the game.
 */
export function logLLMExchange(runDir: string | undefined, entry: LLMLogEntry): void {
  try {
    const dir = path.join(logRoot(), runDir ?? 'unsorted');
    fs.mkdirSync(dir, { recursive: true });
    const seq = nextSeq(dir);
    const base = `${String(seq).padStart(5, '0')}_${entry.phase}`;
    fs.writeFileSync(path.join(dir, `${base}.json`), JSON.stringify(entry, null, 2));
    writeSummary(path.join(dir, `${base}.yaml`), seq, entry);
  } catch (err) {
    console.error('[llm-logger] Failed to write log:', err);
  }
}

/** Parse tool-call arguments safely for structured logging. */
function parseTcArgs(raw: string): unknown {
  try { return JSON.parse(raw); } catch { return raw; }
}

/** Build a LLMLogEntry from a completed (or failed) exchange. */
export function buildLogEntry(opts: {
  timestamp: string;
  model: string;
  phase: LogPhase;
  messages: LLMMessage[];
  tools: LLMTool[] | undefined;
  temperature: number | undefined;
  durationMs: number;
  response?: LLMResponse;
  error?: string;
}): LLMLogEntry {
  const systemMsg = opts.messages.find((m) => m.role === 'system');
  const systemContent = typeof systemMsg?.content === 'string' ? systemMsg.content : null;

  const toolCalls = opts.response?.choices[0]?.message?.tool_calls
    ? opts.response.choices[0].message.tool_calls.map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        arguments: parseTcArgs(tc.function.arguments),
      }))
    : null;

  // Separate system prompt from the rest for readability, and parse tool-call
  // argument strings so the log contains real JSON objects throughout.
  const nonSystemMessages = opts.messages
    .filter((m) => m.role !== 'system')
    .map((m) => {
      if (m.role === 'assistant' && m.tool_calls) {
        return {
          ...m,
          tool_calls: m.tool_calls.map((tc) => ({
            ...tc,
            function: {
              ...tc.function,
              arguments: parseTcArgs(tc.function.arguments),
            },
          })),
        };
      }
      return m;
    });

  return {
    timestamp: opts.timestamp,
    model: opts.model,
    phase: opts.phase,
    durationMs: opts.durationMs,
    request: {
      systemPrompt: systemContent,
      messages: nonSystemMessages,
      tools: opts.tools ?? null,
      temperature: opts.temperature ?? null,
    },
    response: {
      finishReason: opts.response?.choices[0]?.finish_reason ?? 'error',
      content: opts.response?.choices[0]?.message?.content ?? null,
      reasoning: opts.response?.choices[0]?.message?.reasoning,
      toolCalls,
      usage: opts.response?.usage,
    },
    ...(opts.error ? { error: opts.error } : {}),
  };
}
