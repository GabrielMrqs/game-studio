import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

export async function scan({ inbox, state, url, repoRoot, workflow = 'studio-plan', fetcher = fetch }) {
  if (!['studio-plan', 'studio-feature'].includes(workflow)) throw new Error('unknown studio workflow');
  const health = await fetcher(new URL('/api/v1/health', url), { signal: AbortSignal.timeout(5000) });
  if (!health.ok) throw new Error(`Cezar health returned HTTP ${health.status}`);
  const identity = await health.json();
  if (identity.version !== '0.20.0' || identity.repoRoot !== repoRoot) throw new Error('Cezar version or project root does not match');
  await mkdir(state, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(resolve(state, 'inbox.sqlite'));
  db.exec('PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS receipts (hash TEXT PRIMARY KEY, file TEXT NOT NULL, status TEXT NOT NULL, run_id TEXT, detail TEXT)');
  const columns = db.prepare('PRAGMA table_info(receipts)').all().map((column) => column.name);
  if (!columns.includes('source_id')) db.exec('ALTER TABLE receipts ADD COLUMN source_id TEXT');
  if (!columns.includes('workflow')) db.exec('ALTER TABLE receipts ADD COLUMN workflow TEXT');
  if (!columns.includes('marker')) db.exec('ALTER TABLE receipts ADD COLUMN marker TEXT');
  if (!columns.includes('conflicting_run_id')) db.exec('ALTER TABLE receipts ADD COLUMN conflicting_run_id TEXT');
  try {
    const pending = db.prepare("SELECT hash, marker, workflow FROM receipts WHERE status='pending' AND marker IS NOT NULL").all();
    if (pending.length) {
      try {
        const response = await fetcher(new URL('/api/v1/runs', url), { signal: AbortSignal.timeout(5000) });
        if (!response.ok) throw new Error(`Cezar HTTP ${response.status}`);
        const runs = await response.json();
        if (!Array.isArray(runs)) throw new Error('invalid run list');
        for (const receipt of pending) {
          const suffix = `\n\n[studio-receipt:${receipt.marker}]`;
          const matches = runs.filter((run) => typeof run.task === 'string' && run.task.endsWith(suffix) && run.workflow === receipt.workflow && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(run.id || ''));
          if (matches.length !== 1) continue;
          const changed = db.prepare("UPDATE receipts SET status='provisional', run_id=?, detail='matching run found; submission outcome requires confirmation' WHERE hash=? AND status='pending'").run(matches[0].id, receipt.hash);
          if (changed.changes) console.log(`Provisional inbox receipt ${receipt.hash.slice(0, 12)}: ${matches[0].id}`);
        }
      } catch (error) { console.error(`Inbox reconciliation unavailable: ${error.message}`); }
    }
    for (const entry of await readdir(inbox, { withFileTypes: true })) {
      if (!entry.isFile() || !['.md', '.json'].includes(extname(entry.name).toLowerCase())) continue;
      try {
        const raw = await readFile(resolve(inbox, entry.name), 'utf8');
        if (Buffer.byteLength(raw) > 64000) throw new Error('idea exceeds 64000 bytes');
        const idea = extname(entry.name).toLowerCase() === '.json' ? JSON.parse(raw).idea : raw;
        if (typeof idea !== 'string' || !idea.trim()) throw new Error('expected non-empty text or JSON {"idea":"..."}');
        let source = null;
        if (entry.name.startsWith('linear-')) {
          const match = /^linear-([0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12})\.json$/i.exec(entry.name);
          if (!match) throw new Error('invalid Linear inbox filename');
          const linear = new DatabaseSync(resolve(state, 'linear.sqlite'), { readOnly: true });
          try {
            const row = linear.prepare('SELECT payload FROM issues WHERE id=?').get(match[1]);
            if (!row || row.payload !== raw) throw new Error('Linear source receipt does not match inbox item');
          } finally { linear.close(); }
          source = match[1];
        }
        const hash = createHash('sha256').update(idea.trim()).digest('hex');
        const marker = randomUUID();
        // shortcut: no or multiple matching runs remain pending until an operator reconciles them.
        const claim = db.prepare('INSERT OR IGNORE INTO receipts (hash, file, status, source_id, workflow, marker) VALUES (?, ?, ?, ?, ?, ?)').run(hash, entry.name, 'pending', source, workflow, marker);
        if (!claim.changes) continue;
        try {
          const response = await fetcher(new URL('/api/v1/runs', url), {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ workflow, task: `${idea.trim()}\n\n[studio-receipt:${marker}]`, runner: 'opencode', worktree: true, autonomous: false }),
            signal: AbortSignal.timeout(15000),
          });
          if (!response.ok) throw new Error(`Cezar returned HTTP ${response.status}`);
          const run = await response.json();
          if (typeof run.id !== 'string' || !run.id) throw new Error('Cezar returned no run ID');
          db.prepare("UPDATE receipts SET status=CASE WHEN status='provisional' AND run_id<>? THEN 'conflict' ELSE 'submitted' END, conflicting_run_id=CASE WHEN status='provisional' AND run_id<>? THEN ? ELSE NULL END, run_id=CASE WHEN status='pending' THEN ? ELSE run_id END, detail=CASE WHEN status='provisional' AND run_id<>? THEN 'submission response conflicts with reconciled run; investigate manually' ELSE NULL END WHERE hash=? AND status IN ('pending','provisional')").run(run.id, run.id, run.id, run.id, run.id, hash);
          const receipt = db.prepare('SELECT status FROM receipts WHERE hash=?').get(hash);
          if (receipt.status === 'conflict') console.error(`${entry.name}: conflicting run IDs; reconcile manually`);
          else console.log(`${entry.name}: submitted ${run.id}`);
        } catch (error) {
          db.prepare("UPDATE receipts SET detail=? WHERE hash=? AND status='pending'").run(String(error.message), hash);
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
  const workflow = process.env.STUDIO_WORKFLOW || 'studio-plan';
  if (!Number.isFinite(interval) || interval < 1) throw new Error('STUDIO_POLL_SECONDS must be at least 1');
  do {
    try {
      await scan({ inbox, state, url, repoRoot, workflow });
      if (process.env.STUDIO_HEALTH_FILE) await writeFile(process.env.STUDIO_HEALTH_FILE, 'ok\n');
    } catch (error) { console.error(`inbox: ${error.message}`); }
    if (process.argv.includes('--once')) break;
    await new Promise((done) => setTimeout(done, interval * 1000));
  } while (true);
}
