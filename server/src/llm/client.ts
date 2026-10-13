import { LLMMessage, LLMTool, LLMResponse } from '../types';
import { logLLMExchange, buildLogEntry, LogPhase } from './logger';

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_TEMPERATURE = 0.4;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * Any OpenAI-compatible chat completions endpoint works: OpenRouter (default)
 * or a local Ollama server (LLM_BASE_URL=http://localhost:11434/v1).
 * The OPENROUTER_* names are still read as fallbacks.
 */
export function llmConfig() {
  const baseUrl = (process.env.LLM_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const apiKey = process.env.LLM_API_KEY ?? process.env.OPENROUTER_API_KEY;
  const model = process.env.LLM_MODEL ?? process.env.OPENROUTER_MODEL ?? 'openai/gpt-4o';
  // LLM_TEMPERATURE= (empty) omits the parameter, for models that reject it.
  const rawTemp = process.env.LLM_TEMPERATURE;
  const temperature = rawTemp === undefined ? DEFAULT_TEMPERATURE : rawTemp === '' ? undefined : Number(rawTemp);
  // LLM_FORCE_TOOLS=false turns off tool_choice "required" for providers that reject it.
  const forceTools = process.env.LLM_FORCE_TOOLS !== 'false';
  // LLM_PROTOCOL=json asks for schema-constrained JSON replies instead of tool calls
  // (best for small local models: Ollama enforces the schema with a grammar).
  const protocol: 'tools' | 'json' = process.env.LLM_PROTOCOL === 'json' ? 'json' : 'tools';
  // LLM_REASONING_EFFORT=none|low|medium|high is passed through as reasoning_effort.
  const reasoningEffort = process.env.LLM_REASONING_EFFORT || undefined;
  // Caps a runaway reply (e.g. endless whitespace inside constrained JSON).
  const maxTokens = Number(process.env.LLM_MAX_TOKENS ?? 6000) || undefined;
  return { baseUrl, url: `${baseUrl}/chat/completions`, apiKey, model, temperature, forceTools, protocol, reasoningEffort, maxTokens };
}

/**
 * Automated tests set LLM_LOCAL_ONLY=1 so a misconfigured run can never hit a
 * paid API: any non-localhost endpoint is refused before a request is made.
 */
export function assertLocalIfRequired(baseUrl: string): void {
  if (process.env.LLM_LOCAL_ONLY !== '1') return;
  let host: string;
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    throw new Error(`LLM_LOCAL_ONLY=1 but LLM_BASE_URL is not a valid URL: ${baseUrl}`);
  }
  if (!LOCAL_HOSTS.has(host)) {
    throw new Error(`LLM_LOCAL_ONLY=1 refuses non-local LLM endpoint ${baseUrl}`);
  }
}

/**
 * Strip invisible Unicode characters that some upstream providers reject:
 * zero-width spaces, zero-width non-joiners, zero-width joiners, BOM, etc.
 */
function sanitizeContent(value: unknown): unknown {
  if (typeof value === 'string') {
    // Remove zero-width and other invisible Unicode control characters
    return value.replace(/[​-‏‪-‮⁠-⁤﻿]/g, '');
  }
  if (Array.isArray(value)) return value.map(sanitizeContent);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, sanitizeContent(v)]),
    );
  }
  return value;
}

function sanitizeMessages(messages: LLMMessage[]): LLMMessage[] {
  return sanitizeContent(messages) as LLMMessage[];
}

export interface ChatOptions {
  messages: LLMMessage[];
  tools?: LLMTool[];
  /** 'required' forces a tool call (game phase); 'auto' lets the model chat (definition phase). */
  toolChoice?: 'auto' | 'required';
  /** Default: env LLM_MODEL (or OPENROUTER_MODEL) */
  model?: string;
  /** Require the reply to match a JSON schema (json protocol). */
  responseSchema?: { name: string; schema: Record<string, unknown> };
  /** Folder under data/llm-logs to write this exchange to. */
  logDir?: string;
  phase?: LogPhase;
  /** Aborts the request (used to cancel a speculative prefetch that was not needed). */
  signal?: AbortSignal;
  /** Another endpoint than the env default (model routing by complexity). */
  endpoint?: { baseUrl: string; apiKey?: string; model: string; temperature?: number; maxTokens?: number; reasoningEffort?: string };
}

export async function chat(options: ChatOptions): Promise<LLMResponse> {
  const env = llmConfig();
  const ep = options.endpoint;
  const config = ep
    ? {
        ...env,
        baseUrl: ep.baseUrl.replace(/\/+$/, ''),
        url: `${ep.baseUrl.replace(/\/+$/, '')}/chat/completions`,
        apiKey: ep.apiKey,
        temperature: ep.temperature ?? env.temperature,
        maxTokens: ep.maxTokens ?? env.maxTokens,
        reasoningEffort: ep.reasoningEffort,
      }
    : env;
  assertLocalIfRequired(config.baseUrl);
  const model = options.model ?? ep?.model ?? config.model;
  const timestamp = new Date().toISOString();
  const t0 = Date.now();

  const body: Record<string, unknown> = {
    model,
    messages: sanitizeMessages(options.messages),
  };
  if (config.temperature !== undefined) body.temperature = config.temperature;
  if (config.reasoningEffort) body.reasoning_effort = config.reasoningEffort;
  if (config.maxTokens) body.max_tokens = config.maxTokens;
  if (options.responseSchema) {
    body.response_format = {
      type: 'json_schema',
      json_schema: { name: options.responseSchema.name, schema: options.responseSchema.schema },
    };
  }

  if (options.tools && options.tools.length > 0) {
    body.tools = options.tools;
    const choice = options.toolChoice ?? 'auto';
    if (choice === 'required' && config.forceTools) body.tool_choice = 'required';
  }

  let response: LLMResponse | undefined;
  let errorMsg: string | undefined;

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://generic-game',
      'X-Title': 'Generic Game',
    };
    if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;

    const send = () => fetch(config.url, { method: 'POST', headers, body: JSON.stringify(body), signal: options.signal });
    let res: Response;
    try {
      res = await send();
    } catch (err) {
      // A pooled connection the server already closed fails at once ("fetch failed",
      // ECONNRESET). Nothing was sent, so one retry on a fresh connection is safe.
      if (options.signal?.aborted || !(err instanceof TypeError)) throw err;
      res = await send();
    }

    if (!res.ok) {
      const text = await res.text();
      errorMsg = `LLM error ${res.status} from ${config.url}: ${text.slice(0, 500)}`;
      throw new Error(errorMsg);
    }

    const data = (await res.json()) as LLMResponse;

    if (data.error) {
      errorMsg = `LLM error: ${data.error.message}`;
      throw new Error(errorMsg);
    }
    if (!data.choices?.[0]?.message) {
      errorMsg = 'LLM response had no choices';
      throw new Error(errorMsg);
    }

    response = data;
    return data;
  } catch (err) {
    if (!errorMsg) errorMsg = String(err);
    throw err;
  } finally {
    logLLMExchange(options.logDir, buildLogEntry({
      timestamp,
      model,
      phase: options.phase ?? 'unknown',
      messages: options.messages,
      tools: options.tools,
      temperature: config.temperature,
      durationMs: Date.now() - t0,
      response,
      error: errorMsg,
    }));
  }
}
