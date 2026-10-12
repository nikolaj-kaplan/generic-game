// =============================================================================
// Shapes: the short way a program describes the JSON it wants from g.ai.*
//
//   'string' | 'number' | 'boolean' | 'string[]' | 'string[4]'
//   ['Yes', 'No']          one of these strings
//   [shape]                a list of shape
//   { key: shape, ... }    an object with all keys required
//
// Here: shape → JSON schema (for response_format), checking/coercing a reply,
// and fake values for the bot test.
// =============================================================================

export type Shape = string | Shape[] | { [key: string]: Shape };

const SCALARS = new Set(['string', 'number', 'boolean']);
const ARRAY_RE = /^(string|number|boolean)\[(\d*)\]$/;

/** A one-element array whose element is itself a shape means "a list of". */
function isListShape(shape: Shape[]): boolean {
  if (shape.length !== 1) return false;
  const only = shape[0];
  return typeof only !== 'string' || SCALARS.has(only) || ARRAY_RE.test(only);
}

export function shapeToSchema(shape: Shape): Record<string, unknown> {
  if (typeof shape === 'string') {
    if (SCALARS.has(shape)) return { type: shape };
    const m = ARRAY_RE.exec(shape);
    if (m) {
      const n = m[2] ? Number(m[2]) : undefined;
      return { type: 'array', items: { type: m[1] }, ...(n ? { minItems: n, maxItems: n } : {}) };
    }
    return { type: 'string' };
  }
  if (Array.isArray(shape)) {
    if (isListShape(shape)) return { type: 'array', items: shapeToSchema(shape[0]) };
    return { type: 'string', enum: shape.map(String) };
  }
  const properties: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(shape)) properties[k] = shapeToSchema(v);
  return { type: 'object', properties, required: Object.keys(shape), additionalProperties: false };
}

export class ShapeError extends Error {}

/** Check a value against a shape, fixing harmless differences ("3" → 3, "yes" → "Yes"). */
export function coerce(shape: Shape, value: unknown, where = 'reply'): unknown {
  if (typeof shape === 'string') {
    if (shape === 'string') {
      if (typeof value === 'string') return value;
      if (typeof value === 'number' || typeof value === 'boolean') return String(value);
      throw new ShapeError(`${where} should be a string`);
    }
    if (shape === 'number') {
      const n = typeof value === 'number' ? value : Number(value);
      if (Number.isFinite(n)) return n;
      throw new ShapeError(`${where} should be a number`);
    }
    if (shape === 'boolean') {
      if (typeof value === 'boolean') return value;
      if (value === 'true' || value === 'yes') return true;
      if (value === 'false' || value === 'no') return false;
      throw new ShapeError(`${where} should be true or false`);
    }
    const m = ARRAY_RE.exec(shape);
    if (m) {
      if (!Array.isArray(value)) throw new ShapeError(`${where} should be a list`);
      const n = m[2] ? Number(m[2]) : undefined;
      if (n !== undefined && value.length < n) throw new ShapeError(`${where} should have ${n} items, not ${value.length}`);
      const items = n !== undefined ? value.slice(0, n) : value;
      return items.map((v, i) => coerce(m[1], v, `${where}[${i}]`));
    }
    return value;
  }
  if (Array.isArray(shape)) {
    if (isListShape(shape)) {
      if (!Array.isArray(value)) throw new ShapeError(`${where} should be a list`);
      return value.map((v, i) => coerce(shape[0], v, `${where}[${i}]`));
    }
    const s = String(value ?? '').trim();
    const hit = shape.map(String).find((o) => o.toLowerCase() === s.toLowerCase());
    if (hit === undefined) throw new ShapeError(`${where} should be one of ${shape.map((o) => JSON.stringify(o)).join(', ')}`);
    return hit;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ShapeError(`${where} should be an object`);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(shape)) {
    if (!(k in (value as Record<string, unknown>))) throw new ShapeError(`${where} is missing "${k}"`);
    out[k] = coerce(v, (value as Record<string, unknown>)[k], `${where}.${k}`);
  }
  return out;
}

/** A plausible fake value, for testing programs without a model. */
export function fake(shape: Shape, rand: () => number, label = 'Mock'): unknown {
  const n = (k: number) => Math.floor(rand() * k);
  if (typeof shape === 'string') {
    if (shape === 'string') return `${label} ${n(1000)}`;
    if (shape === 'number') return n(10);
    if (shape === 'boolean') return rand() < 0.5;
    const m = ARRAY_RE.exec(shape);
    if (m) {
      const count = m[2] ? Number(m[2]) : 3 + n(3);
      return Array.from({ length: count }, (_, i) => fake(m[1], rand, `${label} ${i + 1}`));
    }
    return `${label} ${n(1000)}`;
  }
  if (Array.isArray(shape)) {
    if (isListShape(shape)) return Array.from({ length: 2 + n(3) }, (_, i) => fake(shape[0], rand, `${label} ${i + 1}`));
    return shape[n(shape.length)];
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(shape)) out[k] = fake(v, rand, `${label} ${k}`);
  return out;
}

/** Shapes come from program code; anything that is not a valid shape is reported clearly. */
export function asShape(raw: unknown): Shape {
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) return raw.map(asShape);
  if (raw && typeof raw === 'object') {
    const out: Record<string, Shape> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) out[k] = asShape(v);
    return out;
  }
  throw new ShapeError(`Not a valid shape: ${JSON.stringify(raw)}`);
}
