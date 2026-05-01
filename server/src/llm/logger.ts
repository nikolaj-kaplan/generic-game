import fs from 'fs';
import path from 'path';
import { LLMMessage, LLMTool, LLMResponse } from '../types';

// Resolve log dir relative to project root regardless of __dirname depth.
// At runtime __dirname = dist/server/src/llm  → 5 levels to project root
const LOG_DIR = path.join(__dirname, '../../../../../data/llm-logs');

let _logDirReady = false;
function ensureLogDir(): void {
  if (_logDirReady) return;
  fs.mkdirSync(LOG_DIR, { recursive: true });
  _logDirReady = true;
}

let _seq = 0;

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
