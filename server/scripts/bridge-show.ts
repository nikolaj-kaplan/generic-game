/**
 * Show the oldest pending bridge request: the complete request (system prompt
 * and all messages), exactly what a model would receive. Each request is meant
 * to be answered without memory of earlier ones, like a real LLM call.
 *
 *   npm run -s bridge:show --prefix server
 */
import fs from 'fs';
import path from 'path';
import { formatRequest } from './bridge-format';

const ROOT = path.join(__dirname, '..', '..', 'data', 'llm-bridge');
const PENDING = path.join(ROOT, 'pending');
const DONE = path.join(ROOT, 'done');

const files = fs.existsSync(PENDING) ? fs.readdirSync(PENDING).filter((f) => f.endsWith('.json')).sort() : [];
if (files.length === 0) {
  console.log('No pending requests.');
  process.exit(0);
}

const id = files[0].replace(/\.json$/, '');
const request = JSON.parse(fs.readFileSync(path.join(PENDING, files[0]), 'utf-8'));
console.log(formatRequest(id, request, path.join(DONE, `${id}.txt`)));
