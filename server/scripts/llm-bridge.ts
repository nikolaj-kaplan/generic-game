/**
 * File-based LLM bridge: an OpenAI-compatible endpoint on localhost that
 * writes every request to data/llm-bridge/pending/<id>.json and waits for a
 * reply in data/llm-bridge/done/<id>.json. Lets a human (or an assistant in
 * another tool) play the game master by hand, to compare against a model.
 *
 *   npm run bridge --prefix server
 *   LLM_BASE_URL=http://127.0.0.1:11435/v1 LLM_MODEL=bridge npm run dev
 *
 * Reply file: the assistant message content as plain text (for the json
 * protocol, the JSON object itself).
 */
import http from 'http';
import fs from 'fs';
import path from 'path';

const PORT = Number(process.env.BRIDGE_PORT ?? 11435);
const ROOT = path.join(__dirname, '..', '..', 'data', 'llm-bridge');
const PENDING = path.join(ROOT, 'pending');
const DONE = path.join(ROOT, 'done');
const TIMEOUT_MS = 15 * 60_000;

fs.mkdirSync(PENDING, { recursive: true });
fs.mkdirSync(DONE, { recursive: true });

let seq = 0;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitForReply(id: string): Promise<string | null> {
  const file = path.join(DONE, `${id}.txt`);
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) {
      await sleep(200); // let the writer finish
      return fs.readFileSync(file, 'utf-8').trim();
    }
    await sleep(500);
  }
  return null;
}

http
  .createServer(async (req, res) => {
    if (req.method !== 'POST') {
      res.end('ok');
      return;
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    const id = `${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}_${String(++seq).padStart(4, '0')}`;
    fs.writeFileSync(path.join(PENDING, `${id}.json`), JSON.stringify(request, null, 2));
    console.log(`[bridge] ${id} waiting (${request.response_format?.json_schema?.name ?? 'chat'})`);

    const content = await waitForReply(id);
    fs.rmSync(path.join(PENDING, `${id}.json`), { force: true });
    if (content === null) {
      res.statusCode = 504;
      res.end(JSON.stringify({ error: { message: 'bridge timed out waiting for a reply' } }));
      return;
    }
    console.log(`[bridge] ${id} answered (${content.length} chars)`);
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        id,
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      }),
    );
  })
  .listen(PORT, '127.0.0.1', () => console.log(`[bridge] listening on http://127.0.0.1:${PORT}/v1 — requests in ${PENDING}`));
