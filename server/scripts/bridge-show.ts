/**
 * Show the oldest pending bridge request: the complete request (system prompt
 * and all messages), exactly what a model would receive. Each request is meant
 * to be answered without memory of earlier ones, like a real LLM call.
 *
 *   npm run -s bridge:show --prefix server
 */
import fs from 'fs';
import path from 'path';

const ROOT = path.join(__dirname, '..', '..', 'data', 'llm-bridge');
const PENDING = path.join(ROOT, 'pending');

const files = fs.existsSync(PENDING) ? fs.readdirSync(PENDING).filter((f) => f.endsWith('.json')).sort() : [];
if (files.length === 0) {
  console.log('No pending requests.');
  process.exit(0);
}

const id = files[0].replace(/\.json$/, '');
const request = JSON.parse(fs.readFileSync(path.join(PENDING, files[0]), 'utf-8'));
const messages: Array<{ role: string; content: string | null }> = request.messages;
const schemaName = request.response_format?.json_schema?.name ?? 'chat';

console.log(`ID: ${id}   schema: ${schemaName}`);
for (const m of messages) {
  console.log(`\n===== ${m.role.toUpperCase()} =====\n${m.content ?? ''}`);
}
if (schemaName !== 'chat') {
  const schema = request.response_format?.json_schema?.schema ?? {};
  const props = Object.keys(schema.properties ?? {});
  const screens = schema.properties?.screens?.properties;
  console.log(`\n===== REPLY FORMAT =====\nA JSON object. Fields: ${props.join(', ')}. Required: ${(schema.required ?? []).join(', ')}.`);
  if (screens) console.log(`Allowed screen keys: ${Object.keys(screens).join(', ')}`);
}
console.log(`\nWrite the reply to: /Users/nikap/code/private/generic-game/data/llm-bridge/done/${id}.txt`);
