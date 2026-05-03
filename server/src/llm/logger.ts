import fs from 'fs';
import path from 'path';
import { LLMMessage, LLMTool, LLMResponse } from '../types';

// Resolve log dirs relative to project root regardless of __dirname depth.
// At runtime __dirname = dist/server/src/llm  → 5 levels to project root
const LOG_DIR = path.join(__dirname, '../../../../../data/llm-logs');
const SUMMARY_DIR = path.join(__dirname, '../../../../../data/llm-logs-summary');

let _logDirReady = false;
function ensureLogDir(): void {
  if (_logDirReady) return;
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.mkdirSync(SUMMARY_DIR, { recursive: true });
  _logDirReady = true;
}

let _seq = 0;

/** Delete all log files in LOG_DIR and SUMMARY_DIR. Called at the start of each new game. */
export function clearLogs(): void {
  try {
    ensureLogDir();
    for (const f of fs.readdirSync(LOG_DIR)) {
      if (f.endsWith('.json')) fs.unlinkSync(path.join(LOG_DIR, f));
    }
    for (const f of fs.readdirSync(SUMMARY_DIR)) {
      if (f.endsWith('.yaml')) fs.unlinkSync(path.join(SUMMARY_DIR, f));
    }
    _seq = 0;
  } catch { /* non-fatal */ }
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
  seq: number;
  timestamp: string;
  model: string;
  phase: 'definition' | 'playing' | 'unknown';
  durationMs: number;
  request: {
    systemPrompt: string | null;
    messages: LogMessage[];
    tools: LLMTool[] | null;
    temperature: number;
  };
  response: {
    finishReason: string;
    content: string | null;
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
 * set_user_ui and run_sequence get special treatment; everything else falls
 * back to a single-line JSON string.
 */
function renderToolArgs(name: string, args: unknown, baseIndent: string): string[] {
  if (typeof args !== 'object' || args === null) return [`${baseIndent}${yamlVal(args, baseIndent)}`];
  const a = args as Record<string, unknown>;

  if (name === 'set_user_ui') {
    const lines: string[] = [];
    lines.push(`${baseIndent}playerId: ${a.playerId}`);
    if (Array.isArray(a.ui)) {
      lines.push(`${baseIndent}ui:`);
      lines.push(...renderUiComponents(a.ui, baseIndent + '  '));
    }
    return lines;
  }

  if (name === 'run_sequence') {
    const lines: string[] = [];
    if (Array.isArray(a.steps)) {
      lines.push(`${baseIndent}steps: # ${(a.steps as unknown[]).length} step(s)`);
      for (const step of a.steps as Array<Record<string, unknown>>) {
        lines.push(`${baseIndent}  - action: ${step.action}`);
        if (step.delayBefore != null) lines.push(`${baseIndent}    delayBefore: ${step.delayBefore}`);
        if (step.playerId) lines.push(`${baseIndent}    playerId: ${step.playerId}`);
        if (Array.isArray(step.ui)) {
          lines.push(`${baseIndent}    ui:`);
          lines.push(...renderUiComponents(step.ui, baseIndent + '      '));
        }
      }
    }
    return lines;
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

function writeSummary(filename: string, entry: LLMLogEntry): void {
  try {
    ensureLogDir();
    const lines: string[] = [];
    lines.push(`seq: ${entry.seq}`);
    lines.push(`phase: ${entry.phase}`);
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

    const summaryPath = path.join(SUMMARY_DIR, filename.replace('.json', '.yaml'));
    fs.writeFileSync(summaryPath, lines.join('\n') + '\n');
  } catch (err) {
    console.error('[llm-logger] Failed to write summary:', err);
  }
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Write a structured JSON log file for one LLM exchange.
 * File name: <seq>-<timestamp>-<phase>.json
 * Non-blocking — errors are swallowed so logging never crashes the game.
 */
export function logLLMExchange(entry: LLMLogEntry): void {
  try {
    ensureLogDir();
    const seq = String(entry.seq).padStart(5, '0');
    const ts = entry.timestamp.replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
    const filename = `${seq}_${ts}_${entry.phase}.json`;
    const filepath = path.join(LOG_DIR, filename);
    fs.writeFileSync(filepath, JSON.stringify(entry, null, 2));
    writeSummary(filename, entry);
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
  seq: number;
  timestamp: string;
  model: string;
  messages: LLMMessage[];
  tools: LLMTool[] | undefined;
  temperature: number;
  durationMs: number;
  response?: LLMResponse;
  error?: string;
}): LLMLogEntry {
  // Detect phase from system message content
  const systemMsg = opts.messages.find((m) => m.role === 'system');
  const systemContent = typeof systemMsg?.content === 'string' ? systemMsg.content : null;
  let phase: LLMLogEntry['phase'] = 'unknown';
  if (systemContent) {
    if (systemContent.includes('AGREED RULES')) phase = 'playing';
    else if (systemContent.includes('setup assistant')) phase = 'definition';
  }

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
    seq: opts.seq,
    timestamp: opts.timestamp,
    model: opts.model,
    phase,
    durationMs: opts.durationMs,
    request: {
      systemPrompt: systemContent,
      messages: nonSystemMessages,
      tools: opts.tools ?? null,
      temperature: opts.temperature,
    },
    response: {
      finishReason: opts.response?.choices[0]?.finish_reason ?? 'error',
      content: opts.response?.choices[0]?.message?.content ?? null,
      toolCalls,
      usage: opts.response?.usage,
    },
    ...(opts.error ? { error: opts.error } : {}),
  };
}

export function nextSeq(): number {
  return ++_seq;
}
