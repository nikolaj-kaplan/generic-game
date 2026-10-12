import { chat } from '../llm/client';
import { extractJsonObject } from '../llm/turn';
import type { AiRequest } from './sandbox';
import { asShape, coerce, Shape, shapeToSchema, ShapeError } from './shape';
import { modelForComplexity } from './models';

// =============================================================================
// g.ai.* calls made by a running program. Each call is small: the request,
// the game's rules for context, and a JSON schema for the reply. The model
// comes from the call's complexity (see models.ts).
// =============================================================================

const ATTEMPTS = 2;

export interface AiContext {
  /** Kept for callers; not sent to the model (see performAiRequest). */
  rules?: string;
  logDir?: string;
  /** Counts calls per complexity, for metrics. */
  onCall?: (complexity: number, ms: number, model: string) => void;
}

function wrapperFor(request: AiRequest): { shape: Shape; schema: Record<string, unknown>; instruction: string; unwrap: (v: Record<string, unknown>) => unknown } {
  switch (request.op) {
    case 'text':
      return {
        shape: { text: 'string' },
        schema: shapeToSchema({ text: 'string' }),
        instruction: 'Put your answer in "text".',
        unwrap: (v) => v.text,
      };
    case 'choose': {
      const options = request.options ?? [];
      return {
        shape: { answer: options },
        schema: shapeToSchema({ answer: options }),
        instruction: `Put exactly one of these options in "answer": ${options.map((o) => JSON.stringify(o)).join(', ')}.`,
        unwrap: (v) => v.answer,
      };
    }
    case 'list': {
      const item = asShape(request.schema ?? 'string');
      const n = Math.max(1, Math.round(request.n ?? 1));
      const schema = shapeToSchema({ items: [item] });
      (schema.properties as Record<string, Record<string, unknown>>).items.minItems = n;
      (schema.properties as Record<string, Record<string, unknown>>).items.maxItems = n;
      return {
        shape: { items: [item] },
        schema,
        instruction: `Put exactly ${n} different items in "items". Vary them: avoid the most obvious picks.`,
        unwrap: (v) => {
          const items = v.items as unknown[];
          if (items.length < n) throw new ShapeError(`"items" had ${items.length} items, not ${n}`);
          return items.slice(0, n);
        },
      };
    }
    case 'json':
    default: {
      const shape = asShape(request.schema ?? 'string');
      const isObject = typeof shape === 'object' && !Array.isArray(shape);
      return isObject
        ? { shape, schema: shapeToSchema(shape), instruction: 'Fill in every field.', unwrap: (v) => v }
        : { shape: { value: shape }, schema: shapeToSchema({ value: shape }), instruction: 'Put your answer in "value".', unwrap: (v) => v.value };
    }
  }
}

export async function performAiRequest(request: AiRequest, context: AiContext): Promise<unknown> {
  const w = wrapperFor(request);
  const model = modelForComplexity(request.complexity);
  // The game's rules are NOT sent: measured with gemma, they made answers worse
  // (band names came back with the vowels removed; 20 Questions answers went from
  // 6/6 to 4-5/6 right). The generator writes self-contained prompts instead.
  const system =
    'You are the helper inside a party-game app. A game program asks you for data or a judgment, one request at a time. ' +
    'Do exactly what the request asks and nothing more. Return plain, complete, correctly spelled data: ' +
    'the program itself hides letters, shuffles, scores and formats. Reply with only a JSON object matching the schema.';
  const user = `${request.prompt}\n\n${w.instruction}\nJSON schema of your reply: ${JSON.stringify(w.schema)}`;

  let problem = '';
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const t0 = Date.now();
    const messages = [
      { role: 'system' as const, content: system },
      { role: 'user' as const, content: problem ? `${user}\n\nYour previous reply was not usable: ${problem}. Try again.` : user },
    ];
    let content: string | null = null;
    try {
      const response = await chat({
        messages,
        // Lists and free text: more temperature, so content differs between games.
        endpoint: request.op === 'list' || request.op === 'text' ? { ...model, temperature: Math.max(model.temperature ?? 0, 0.9) } : model,
        responseSchema: { name: `ai_${request.op}`, schema: w.schema },
        logDir: context.logDir,
        phase: 'ai',
      });
      content = response.choices[0].message.content;
    } catch (err) {
      problem = err instanceof Error ? err.message : String(err);
      if (problem.includes('LLM_LOCAL_ONLY')) break;
      continue;
    } finally {
      context.onCall?.(request.complexity, Date.now() - t0, model.model);
    }
    const parsed = extractJsonObject(content ?? '');
    if (!parsed) {
      problem = 'it was not a JSON object';
      continue;
    }
    try {
      return w.unwrap(coerce(w.shape, parsed) as Record<string, unknown>);
    } catch (err) {
      problem = err instanceof ShapeError ? err.message : String(err);
    }
  }
  throw new Error(`The AI could not answer "${request.prompt.slice(0, 80)}": ${problem}`);
}
