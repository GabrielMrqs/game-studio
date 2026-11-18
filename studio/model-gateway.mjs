import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { readFile, mkdir, open } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function createGateway({ key, model, maxRequests, maxOutputTokens, stateFile, upstream = 'https://api.openai.com/v1/responses', initialize = false, fetcher = fetch }) {
  if (!key?.trim() || !model?.trim() || !Number.isSafeInteger(maxRequests) || maxRequests < 1 || !Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1) throw new Error('gateway key, model and positive limits are required');
  await mkdir(dirname(stateFile), { recursive: true, mode: 0o700 });
  // An existing state must be opened without creating it; initialization never overwrites one.
  const file = await open(stateFile, initialize ? 'wx' : 'r+', 0o600);
  await file.close();
  const db = new DatabaseSync(stateFile);
  try {
    db.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map((row) => row.name);
    if (tables.includes('quota') !== tables.includes('gateway_config')) throw new Error('legacy or incomplete gateway quota state; operator review required');
    if (!tables.length) {
      if (!initialize) throw new Error('empty gateway quota state; operator review required');
      db.exec('CREATE TABLE quota (id INTEGER PRIMARY KEY CHECK(id=1), used INTEGER NOT NULL); INSERT INTO quota VALUES (1,0); CREATE TABLE gateway_config (id INTEGER PRIMARY KEY CHECK(id=1), model TEXT NOT NULL, max_requests INTEGER NOT NULL, max_output_tokens INTEGER NOT NULL, upstream TEXT NOT NULL)');
      db.prepare('INSERT INTO gateway_config VALUES (1,?,?,?,?)').run(model, maxRequests, maxOutputTokens, upstream);
    }
    const saved = db.prepare('SELECT model, max_requests, max_output_tokens, upstream FROM gateway_config WHERE id=1').get();
    const quota = db.prepare('SELECT used FROM quota WHERE id=1').get();
    if (!saved || saved.model !== model || saved.max_requests !== maxRequests || saved.max_output_tokens !== maxOutputTokens || saved.upstream !== upstream || !quota || !Number.isSafeInteger(quota.used) || quota.used < 0) throw new Error('gateway quota configuration or state does not match');
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } finally { db.close(); }
    throw error;
  }
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/responses') { res.writeHead(404).end(); return; }
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 1048576) { res.writeHead(413).end(); return; }
        chunks.push(chunk);
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { res.writeHead(400).end('Invalid JSON'); return; }
      if (!body || typeof body !== 'object' || Array.isArray(body) || body.model !== model || (body.background !== undefined && body.background !== false) || !Number.isSafeInteger(body.max_output_tokens) || body.max_output_tokens < 1 || body.max_output_tokens > maxOutputTokens || (body.tools !== undefined && (!Array.isArray(body.tools) || body.tools.some((tool) => tool?.type !== 'function')))) {
        res.writeHead(400).end('Model, output limit, or tools not allowed'); return;
      }
      // Charge a request before forwarding; uncertain outcomes never restore quota.
      const claim = db.prepare("UPDATE quota SET used=used+1 WHERE id=1 AND typeof(used)='integer' AND used>=0 AND used<? AND EXISTS (SELECT 1 FROM gateway_config WHERE id=1 AND model=? AND max_requests=? AND max_output_tokens=? AND upstream=?)").run(maxRequests, model, maxRequests, maxOutputTokens, upstream);
      if (!claim.changes) { res.writeHead(429).end('Gateway quota unavailable or exhausted'); return; }
      const response = await fetcher(upstream, { method: 'POST', redirect: 'manual', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(120000) });
      if (response.status >= 300 && response.status < 400) { res.writeHead(502).end('Upstream redirect refused'); return; }
      res.writeHead(response.status, { 'content-type': response.headers.get('content-type') || 'application/octet-stream', 'cache-control': 'no-store' });
      if (!response.body) { res.end(); return; }
      const stream = Readable.fromWeb(response.body);
      res.on('close', () => stream.destroy());
      stream.on('error', () => res.destroy());
      stream.pipe(res);
    } catch {
      if (!res.headersSent) res.writeHead(502).end('Gateway request failed');
      else res.destroy();
    }
  });
  return { server, close: async () => { if (server.listening) await new Promise((done, reject) => server.close((error) => error ? reject(error) : done())); db.close(); } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const port = Number(process.env.MODEL_GATEWAY_PORT || 8080);
  if (process.argv.length > 3 || (process.argv[2] && process.argv[2] !== '--initialize')) throw new Error('usage: node studio/model-gateway.mjs [--initialize]');
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !process.env.MODEL_GATEWAY_KEY_FILE || !process.env.MODEL_GATEWAY_STATE) throw new Error('gateway port, key file and state file must be configured');
  const key = (await readFile(process.env.MODEL_GATEWAY_KEY_FILE, 'utf8')).trim();
  const gateway = await createGateway({ key, model: process.env.MODEL_GATEWAY_MODEL, maxRequests: Number(process.env.MODEL_GATEWAY_MAX_REQUESTS), maxOutputTokens: Number(process.env.MODEL_GATEWAY_MAX_OUTPUT_TOKENS), stateFile: resolve(process.env.MODEL_GATEWAY_STATE), initialize: process.argv[2] === '--initialize' });
  gateway.server.listen(port, '0.0.0.0', () => console.log(`Model gateway listening on port ${port}`));
}
