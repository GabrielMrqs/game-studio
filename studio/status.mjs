import { DatabaseSync } from 'node:sqlite';
import { readdir, stat } from 'node:fs/promises';
import { join, resolve, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { hasUnrecordedWorktree } from './worktree-safety.mjs';

function counts(rows, allowed) {
  const result = Object.fromEntries([...allowed, 'other'].map((key) => [key, 0]));
  for (const row of rows) result[allowed.includes(row.kind) ? row.kind : 'other'] += row.count;
  return result;
}

async function database(state, name, query, allowed) {
  const path = join(state, name);
  try { await stat(path); } catch (error) { return { state: error.code === 'ENOENT' ? 'missing' : 'unavailable' }; }
  let db;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    return { state: 'ok', counts: counts(db.prepare(query).all(), allowed) };
  } catch { return { state: 'unavailable' }; }
  finally { db?.close(); }
}

export async function status({ state, inbox, url, repoRoot, fetcher = fetch }) {
  const report = {};
  try {
    const entries = await readdir(inbox, { withFileTypes: true });
    report.idea_files = { state: 'ok', count: entries.filter((entry) => entry.isFile() && ['.md', '.json'].includes(extname(entry.name).toLowerCase())).length };
  } catch (error) { report.idea_files = { state: error.code === 'ENOENT' ? 'missing' : 'unavailable' }; }
  report.inbox = await database(state, 'inbox.sqlite', 'SELECT status AS kind, COUNT(*) AS count FROM receipts GROUP BY status', ['pending', 'provisional', 'submitted', 'conflict', 'quarantined']);
  report.linear = await database(state, 'linear.sqlite', "SELECT CASE published WHEN 0 THEN 'pending' WHEN 1 THEN 'published' ELSE 'other' END AS kind, COUNT(*) AS count FROM issues GROUP BY published", ['pending', 'published']);
  report.publications = await database(state, 'publish.sqlite', 'SELECT phase AS kind, COUNT(*) AS count FROM publications GROUP BY phase', ['claimed', 'pushing', 'pr_pending', 'comment_pending', 'done']);
  report.watchdog = await database(state, 'watchdog.sqlite', 'SELECT result AS kind, COUNT(*) AS count FROM cancellations GROUP BY result', ['pending', 'accepted', 'not-cancelled']);
  try {
    const target = new URL(url);
    if (target.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) || target.username || target.password || target.pathname !== '/' || target.search || target.hash) throw new Error('invalid origin');
    const get = async (path) => {
      const response = await fetcher(new URL(path, target), { signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error('request failed');
      return response.json();
    };
    const health = await get('/api/v1/health');
    if (health.version !== '0.20.0' || health.repoRoot !== repoRoot) throw new Error('identity mismatch');
    const runs = await get('/api/v1/runs');
    if (!Array.isArray(runs) || runs.some((run) => !run || typeof run !== 'object' || Array.isArray(run))) throw new Error('invalid run list');
    const allowed = ['queued', 'running', 'waiting', 'review', 'done', 'failed', 'cancelled'];
    const runCounts = counts(runs.map((run) => ({ kind: run.status, count: 1 })), allowed);
    const listed = await Promise.all(runs.filter((run) => typeof run.id === 'string' && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(run.id)).map(async (run) => ({ id: run.id, status: allowed.includes(run.status) ? run.status : 'other', workflow: ['studio-plan', 'studio-feature'].includes(run.workflow) ? run.workflow : 'other', ...(await hasUnrecordedWorktree(run, repoRoot) ? { warning: 'unrecorded_worktree' } : {}) })));
    report.cezar = { state: 'ok', counts: runCounts, runs: listed };
  } catch { report.cezar = { state: 'unavailable' }; }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 2) throw new Error('unexpected arguments');
    const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const report = await status({ state: resolve(process.env.STUDIO_STATE || '.studio-state'), inbox: resolve(process.env.STUDIO_INBOX || 'ideas'), url: process.env.CEZ_API_URL || 'http://127.0.0.1:4321', repoRoot });
    console.log(JSON.stringify(report, null, 2));
    if (Object.values(report).some((item) => item.state === 'unavailable')) process.exitCode = 1;
  } catch { console.error('Status unavailable; check project and configuration.'); process.exitCode = 1; }
}
