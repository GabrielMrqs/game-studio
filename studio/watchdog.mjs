import { DatabaseSync } from 'node:sqlite';
import { mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { hasUnrecordedWorktree } from './worktree-safety.mjs';

export async function checkRuns({ state, url, repoRoot, maxSeconds, maxTokens, now = Date.now(), fetcher = fetch }) {
  if (!Number.isFinite(maxSeconds) || maxSeconds <= 0 || !Number.isSafeInteger(maxTokens) || maxTokens <= 0) throw new Error('positive time and reported-token limits are required');
  const target = new URL(url);
  if (target.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) || target.username || target.password || target.pathname !== '/' || target.search || target.hash) throw new Error('Cezar URL must be a loopback HTTP origin');
  const request = async (path, options = {}) => {
    const response = await fetcher(new URL(path, target), { ...options, signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`Cezar request failed: HTTP ${response.status}`);
    return response.json();
  };
  const health = await request('/api/v1/health');
  if (health.version !== '0.20.0' || health.repoRoot !== repoRoot) throw new Error('Cezar version or project root does not match');
  const inbox = new DatabaseSync(join(state, 'inbox.sqlite'), { readOnly: true });
  let ids;
  try {
    ids = inbox.prepare("SELECT DISTINCT run_id FROM receipts WHERE status IN ('submitted','provisional','conflict','quarantined') AND run_id IS NOT NULL").all().map((row) => row.run_id);
    if (inbox.prepare('PRAGMA table_info(receipts)').all().some((column) => column.name === 'conflicting_run_id')) {
      ids.push(...inbox.prepare("SELECT DISTINCT conflicting_run_id FROM receipts WHERE status IN ('conflict','quarantined') AND conflicting_run_id IS NOT NULL").all().map((row) => row.conflicting_run_id));
      ids = [...new Set(ids)];
    }
  }
  finally { inbox.close(); }
  await mkdir(state, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(state, 'watchdog.sqlite'));
  db.exec('PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS cancellations (run_id TEXT PRIMARY KEY, reason TEXT NOT NULL, last_attempt TEXT NOT NULL, result TEXT NOT NULL)');
  try {
    for (const id of ids) {
      if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) { console.error('Watchdog skipped invalid run ID'); continue; }
      let run;
      try { run = await request(`/api/v1/runs/${id}`); }
      catch (error) { console.error(`Watchdog cannot inspect ${id}: ${error.message}`); continue; }
      if (run.id !== id) throw new Error('Cezar run identity mismatch');
      if (!['queued', 'running', 'waiting'].includes(run.status)) continue;
      if (await hasUnrecordedWorktree(run, repoRoot)) {
        try { run = await request(`/api/v1/runs/${id}`); }
        catch (error) { console.error(`Watchdog cannot recheck ${id}: ${error.message}`); continue; }
        if (run.id !== id) throw new Error('Cezar run identity mismatch');
        if (!['queued', 'running', 'waiting'].includes(run.status)) continue;
      }
      const created = Date.parse(run.createdAt);
      const tokens = run.tokensUsed;
      let reason = db.prepare('SELECT reason FROM cancellations WHERE run_id=?').get(id)?.reason;
      if (!reason) {
        if (await hasUnrecordedWorktree(run, repoRoot)) reason = 'unrecorded worktree metadata';
        else if (!Number.isFinite(created) || created > now + 60000) reason = 'invalid run timestamp';
        else if (now - created >= maxSeconds * 1000) reason = 'wall-clock limit';
        else if (typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens < 0) reason = 'reported token usage unavailable';
        else if (tokens >= maxTokens) reason = 'reported-token limit';
      }
      if (!reason) continue;
      db.prepare("INSERT INTO cancellations VALUES (?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET reason=excluded.reason,last_attempt=excluded.last_attempt,result=excluded.result").run(id, reason, new Date(now).toISOString(), 'pending');
      try {
        const result = await request(`/api/v1/runs/${id}/cancel`, { method: 'POST' });
        if (typeof result.cancelled !== 'boolean') throw new Error('invalid cancellation response');
        db.prepare('UPDATE cancellations SET result=? WHERE run_id=?').run(result.cancelled ? 'accepted' : 'not-cancelled', id);
        console.log(`Watchdog ${reason}: cancellation ${result.cancelled ? 'accepted' : 'not accepted'} for ${id}`);
      } catch (error) {
        console.error(`Watchdog cancellation uncertain for ${id}: ${error.message}`);
      }
    }
  } finally { db.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  const args = { repoRoot, state: resolve(process.env.STUDIO_STATE || '.studio-state'), url: process.env.CEZ_API_URL || 'http://127.0.0.1:4321', maxSeconds: Number(process.env.STUDIO_MAX_RUN_SECONDS), maxTokens: Number(process.env.STUDIO_MAX_REPORTED_TOKENS) };
  if (!Number.isFinite(args.maxSeconds) || args.maxSeconds <= 0 || !Number.isSafeInteger(args.maxTokens) || args.maxTokens <= 0) throw new Error('set STUDIO_MAX_RUN_SECONDS and STUDIO_MAX_REPORTED_TOKENS to positive limits');
  do {
    try { await checkRuns(args); } catch (error) { console.error(`Watchdog: ${error.message}`); }
    if (process.argv.includes('--once')) break;
    await new Promise((done) => setTimeout(done, 5000));
  } while (true);
}
