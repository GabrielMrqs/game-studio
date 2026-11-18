import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, writeFile, readFile, link, unlink, lstat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

const QUERY = `query StudioIssues($team: String!, $cursor: String) {
  team(id: $team) { issues(first: 50, after: $cursor) {
    nodes { id identifier title description url state { type } labels { nodes { name } } }
    pageInfo { hasNextPage endCursor }
  } }
}`;

export function verifyWebhook(raw, signature, secret, now = Date.now()) {
  if (typeof signature !== 'string' || !/^[a-f0-9]{64}$/i.test(signature) || !secret) return false;
  const actual = Buffer.from(signature, 'hex');
  const expected = createHmac('sha256', secret).update(raw).digest();
  if (!timingSafeEqual(actual, expected)) return false;
  try {
    const body = JSON.parse(raw.toString('utf8'));
    return Number.isSafeInteger(body.webhookTimestamp) && Math.abs(now - body.webhookTimestamp) <= 60000;
  } catch { return false; }
}

export async function createAdapter({ inbox, state, apiKey, team, label, secret, endpoint = 'https://api.linear.app/graphql', fetcher = fetch }) {
  if (!apiKey || !team || !label || !secret) throw new Error('Linear API key, team, label and webhook secret are required');
  await mkdir(inbox, { recursive: true, mode: 0o700 });
  await mkdir(state, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(state, 'linear.sqlite'));
  db.exec('PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS issues (id TEXT PRIMARY KEY, payload TEXT NOT NULL, published INTEGER NOT NULL DEFAULT 0)');

  async function publish() {
    for (const row of db.prepare('SELECT id, payload FROM issues WHERE published=0').all()) {
      const target = join(inbox, `linear-${row.id}.json`);
      const temporary = join(inbox, `.linear-${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, row.payload, { flag: 'wx', mode: 0o600 });
        try { await link(temporary, target); }
        catch (error) {
          if (error.code !== 'EEXIST') throw error;
          if (!(await lstat(target)).isFile() || await readFile(target, 'utf8') !== row.payload) {
            console.error(`Linear issue ${row.id}: inbox file conflicts with receipt; manual investigation required`);
            continue;
          }
        }
        db.prepare('UPDATE issues SET published=1 WHERE id=?').run(row.id);
      } finally { await unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; }); }
    }
  }

  async function poll() {
    await publish();
    let cursor = null;
    const seen = new Set();
    do {
      const response = await fetcher(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', authorization: apiKey }, body: JSON.stringify({ query: QUERY, variables: { team, cursor } }), signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error(`Linear HTTP ${response.status}`);
      const result = await response.json();
      if (result.errors?.length || !result.data?.team?.issues?.pageInfo || !Array.isArray(result.data.team.issues.nodes)) throw new Error('Linear GraphQL query failed or returned an invalid response');
      const page = result.data.team.issues;
      for (const issue of page.nodes) {
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(issue.id || '') || typeof issue.identifier !== 'string' || typeof issue.title !== 'string' || typeof issue.url !== 'string' || !['backlog', 'unstarted'].includes(issue.state?.type) || !issue.labels?.nodes?.some((item) => item.name === label)) continue;
        const idea = `Linear ${issue.identifier}: ${issue.title}\n${issue.url}\n\n${issue.description || ''}`;
        if (Buffer.byteLength(idea) > 60000) { console.error(`Linear ${issue.identifier}: description too large; skipped`); continue; }
        db.prepare('INSERT OR IGNORE INTO issues (id,payload) VALUES (?,?)').run(issue.id, JSON.stringify({ idea }));
      }
      await publish();
      if (!page.pageInfo.hasNextPage) break;
      cursor = page.pageInfo.endCursor;
      if (typeof cursor !== 'string' || !cursor || seen.has(cursor)) throw new Error('Linear pagination cursor invalid');
      seen.add(cursor);
    } while (true);
  }

  let running;
  function wake() {
    if (!running) running = poll().catch((error) => console.error(`Linear polling failed: ${error.message}`)).finally(() => { running = undefined; });
    return running;
  }
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/webhooks/linear') { res.writeHead(404).end(); return; }
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 262144) { res.writeHead(413).end(); return; }
      chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks);
    if (!verifyWebhook(raw, req.headers['linear-signature'], secret)) { res.writeHead(401).end(); return; }
    const body = JSON.parse(raw.toString('utf8'));
    if (body.type === 'Issue') void wake();
    res.writeHead(200).end('OK');
  });
  return { poll, wake, server, close: async () => { if (running) await running; if (server.listening) await new Promise((done, reject) => server.close((error) => error ? reject(error) : done())); db.close(); } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const seconds = Number(process.env.LINEAR_POLL_SECONDS || 60);
  const port = Number(process.env.LINEAR_WEBHOOK_PORT || 8787);
  if (!Number.isInteger(seconds) || seconds < 10 || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid polling interval or port');
  const adapter = await createAdapter({ inbox: resolve(process.env.STUDIO_INBOX || 'ideas'), state: resolve(process.env.STUDIO_STATE || '.studio-state'), apiKey: process.env.LINEAR_API_KEY, secret: process.env.LINEAR_WEBHOOK_SECRET, team: process.env.LINEAR_TEAM_ID, label: process.env.LINEAR_LABEL });
  adapter.server.listen(port, '127.0.0.1', () => console.log(`Linear webhook listening on 127.0.0.1:${port}`));
  void adapter.wake();
  setInterval(() => void adapter.wake(), seconds * 1000);
}
