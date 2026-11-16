import { createHash } from 'node:crypto';
import { readdir, readFile, mkdir } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

export async function scan({ inbox, state, url, repoRoot, fetcher = fetch }) {
  const health = await fetcher(new URL('/api/v1/health', url), { signal: AbortSignal.timeout(5000) });
  if (!health.ok) throw new Error(`Cezar health returned HTTP ${health.status}`);
  const identity = await health.json();
  if (identity.version !== '0.20.0' || identity.repoRoot !== repoRoot) throw new Error('Cezar version or project root does not match');
  await mkdir(state, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(resolve(state, 'inbox.sqlite'));
  db.exec('PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS receipts (hash TEXT PRIMARY KEY, file TEXT NOT NULL, status TEXT NOT NULL, run_id TEXT, detail TEXT)');
  try {
    for (const entry of await readdir(inbox, { withFileTypes: true })) {
      if (!entry.isFile() || !['.md', '.json'].includes(extname(entry.name).toLowerCase())) continue;
      try {
        const raw = await readFile(resolve(inbox, entry.name), 'utf8');
        if (Buffer.byteLength(raw) > 64000) throw new Error('idea exceeds 64000 bytes');
        const idea = extname(entry.name).toLowerCase() === '.json' ? JSON.parse(raw).idea : raw;
        if (typeof idea !== 'string' || !idea.trim()) throw new Error('expected non-empty text or JSON {"idea":"..."}');
        const hash = createHash('sha256').update(idea.trim()).digest('hex');
        // shortcut: ambiguous submissions stay pending, reconcile with Cezar before retrying.
        const claim = db.prepare('INSERT OR IGNORE INTO receipts (hash, file, status) VALUES (?, ?, ?)').run(hash, entry.name, 'pending');
        if (!claim.changes) continue;
        try {
          const response = await fetcher(new URL('/api/v1/runs', url), {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ workflow: 'studio-plan', task: idea.trim(), runner: 'opencode', worktree: true, autonomous: false }),
            signal: AbortSignal.timeout(15000),
          });
          if (!response.ok) throw new Error(`Cezar returned HTTP ${response.status}`);
          const run = await response.json();
          if (typeof run.id !== 'string' || !run.id) throw new Error('Cezar returned no run ID');
          db.prepare('UPDATE receipts SET status=?, run_id=? WHERE hash=?').run('submitted', run.id, hash);
          console.log(`${entry.name}: submitted ${run.id}`);
        } catch (error) {
          db.prepare('UPDATE receipts SET detail=? WHERE hash=?').run(String(error.message), hash);
          console.error(`${entry.name}: submission uncertain; reconcile before retrying (${error.message})`);
        }
      } catch (error) {
        console.error(`${entry.name}: ${error.message}`);
      }
    }
  } finally { db.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const url = new URL(process.env.CEZ_API_URL || 'http://127.0.0.1:4321');
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('CEZ_API_URL must be a loopback HTTP origin');
  }
  const inbox = resolve(process.env.STUDIO_INBOX || 'ideas');
  const state = resolve(process.env.STUDIO_STATE || '.studio-state');
  const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  execFileSync('git', ['rev-parse', '--verify', 'HEAD'], { stdio: 'ignore' });
  const interval = Number(process.env.STUDIO_POLL_SECONDS || 30);
  if (!Number.isFinite(interval) || interval < 1) throw new Error('STUDIO_POLL_SECONDS must be at least 1');
  do {
    try { await scan({ inbox, state, url, repoRoot }); } catch (error) { console.error(`inbox: ${error.message}`); }
    if (process.argv.includes('--once')) break;
    await new Promise((done) => setTimeout(done, interval * 1000));
  } while (true);
}
