import { LLMMessage, LLMTool, LLMResponse } from '../types';
import { logLLMExchange, buildLogEntry, nextSeq } from './logger';

const OPENROUTER_API = 'https://openrouter.ai/api/v1/chat/completions';
const TEMPERATURE = 0.4;

/**
 * Strip invisible Unicode characters that some upstream providers reject:
 * zero-width spaces, zero-width non-joiners, zero-width joiners, BOM, etc.
 */
function sanitizeContent(value: unknown): unknown {
  if (typeof value === 'string') {
    // Remove zero-width and other invisible Unicode control characters
    return value.replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g, '');
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

interface ChatOptions {
  messages: LLMMessage[];
  tools?: LLMTool[];
  /** Default: env OPENROUTER_MODEL */
  model?: string;
}

export async function chat(options: ChatOptions): Promise<LLMResponse> {
  const model = options.model ?? process.env.OPENROUTER_MODEL ?? 'openai/gpt-4o';
  const seq = nextSeq();
  const timestamp = new Date().toISOString();
  const t0 = Date.now();

  const body: Record<string, unknown> = {
    model,
    messages: sanitizeMessages(options.messages),
    temperature: TEMPERATURE,
  };

  if (options.tools && options.tools.length > 0) {
    body.tools = options.tools;
    // 'required' forces a tool call on every turn — prevents the model from
    // outputting plain text instead of a tool call (finish_reason: stop).
    body.tool_choice = 'required';
  }

  let response: LLMResponse | undefined;
  let errorMsg: string | undefined;

  try {
    const res = await fetch(OPENROUTER_API, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://generic-game',
        'X-Title': 'Generic Game',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      errorMsg = `OpenRouter error ${res.status}: ${text}`;
      throw new Error(errorMsg);
    }

    const data = (await res.json()) as LLMResponse;

    if (data.error) {
      errorMsg = `LLM error: ${data.error.message}`;
      throw new Error(errorMsg);
    }

    response = data;
    return data;
  } catch (err) {
    if (!errorMsg) errorMsg = String(err);
    throw err;
  } finally {
    logLLMExchange(buildLogEntry({
      seq,
      timestamp,
      model,
      messages: options.messages,
      tools: options.tools,
      temperature: TEMPERATURE,
      durationMs: Date.now() - t0,
      response,
      error: errorMsg,
    }));
  }
}
