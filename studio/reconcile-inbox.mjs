import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

export async function reconcile({ state, url, repoRoot, hash, confirmStopped = false, quarantine = false, fetcher = fetch }) {
  if (!/^[a-f0-9]{64}$/.test(hash || '')) throw new Error('provide the full receipt hash');
  if (quarantine && !confirmStopped) throw new Error('quarantine requires confirmation that inbox processes are stopped');
  const target = new URL(url);
  if (target.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) || target.username || target.password || target.pathname !== '/' || target.search || target.hash) throw new Error('Cezar URL must be a loopback HTTP origin');
  const db = new DatabaseSync(`${pathToFileURL(resolve(state, 'inbox.sqlite')).href}?mode=${confirmStopped ? 'rw' : 'ro'}`, { readOnly: !confirmStopped });
  try {
    const columns = db.prepare('PRAGMA table_info(receipts)').all().map((column) => column.name);
    const competing = columns.includes('conflicting_run_id') ? 'conflicting_run_id' : 'NULL AS conflicting_run_id';
    const receipt = db.prepare(`SELECT hash, file, status, run_id, source_id, workflow, marker, detail, ${competing} FROM receipts WHERE hash=?`).get(hash);
    if (!receipt || !['provisional', 'conflict', 'quarantined'].includes(receipt.status)) throw new Error('receipt is not provisional or conflicting');
    const get = async (path) => {
      const response = await fetcher(new URL(path, target), { signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error(`Cezar request failed: HTTP ${response.status}`);
      return response.json();
    };
    const health = await get('/api/v1/health');
    if (health.version !== '0.20.0' || health.repoRoot !== repoRoot) throw new Error('Cezar version or project root does not match');
    const runs = await get('/api/v1/runs');
    if (!Array.isArray(runs) || !receipt.marker) throw new Error('run history or receipt marker unavailable');
    const suffix = `\n\n[studio-receipt:${receipt.marker}]`;
    const matches = runs.filter((run) => typeof run.task === 'string' && run.task.endsWith(suffix)).map((run) => ({
      id: run.id, workflow: run.workflow, status: run.status,
      taskMatches: createHash('sha256').update(run.task.slice(0, -suffix.length).trim()).digest('hex') === hash,
    }));
    if (!confirmStopped) return { receipt, matches };
    if (quarantine) {
      const uuid = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
      if (receipt.status !== 'conflict' || !uuid.test(receipt.run_id || '') || !uuid.test(receipt.conflicting_run_id || '') || receipt.run_id === receipt.conflicting_run_id) throw new Error('quarantine requires a conflict with two distinct recorded run IDs');
      db.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
      try {
        db.exec('CREATE TABLE IF NOT EXISTS conflict_quarantine_audit (hash TEXT NOT NULL, run_id TEXT NOT NULL, conflicting_run_id TEXT NOT NULL, quarantined_at TEXT NOT NULL)');
        const changed = db.prepare("UPDATE receipts SET status='quarantined', detail='operator quarantined conflict after stopping inbox' WHERE hash=? AND status='conflict' AND run_id=? AND conflicting_run_id=? AND marker IS ? AND workflow IS ? AND source_id IS ?").run(hash, receipt.run_id, receipt.conflicting_run_id, receipt.marker, receipt.workflow, receipt.source_id);
        if (changed.changes !== 1) throw new Error('receipt changed during reconciliation');
        db.prepare('INSERT INTO conflict_quarantine_audit VALUES (?,?,?,?)').run(hash, receipt.run_id, receipt.conflicting_run_id, new Date().toISOString());
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      return { receipt: { ...receipt, status: 'quarantined' }, matches };
    }
    // shortcut: conflicts require manual investigation, until all competing runs and their effects are verified.
    if (receipt.status !== 'provisional') throw new Error('conflicting receipts cannot be finalized automatically');
    if (matches.length !== 1 || matches[0].id !== receipt.run_id || matches[0].workflow !== receipt.workflow || !matches[0].taskMatches || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(matches[0].id || '')) throw new Error('run history does not uniquely match the receipt');
    db.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
    try {
      db.exec('CREATE TABLE IF NOT EXISTS reconciliation_audit (hash TEXT NOT NULL, run_id TEXT NOT NULL, confirmed_at TEXT NOT NULL)');
      const result = db.prepare("UPDATE receipts SET status='submitted', detail='operator confirmed after stopping inbox' WHERE hash=? AND status='provisional' AND run_id=? AND marker=? AND workflow=? AND source_id IS ?").run(hash, receipt.run_id, receipt.marker, receipt.workflow, receipt.source_id);
      if (result.changes !== 1) throw new Error('receipt changed during reconciliation');
      db.prepare('INSERT INTO reconciliation_audit VALUES (?,?,?)').run(hash, receipt.run_id, new Date().toISOString());
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    return { receipt: { ...receipt, status: 'submitted' }, matches };
  } finally { db.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length < 1 || args.length > 3 || (args[1] && args[1] !== '--confirm-inbox-stopped') || (args[2] && args[2] !== '--quarantine-conflict')) throw new Error('usage: node studio/reconcile-inbox.mjs HASH [--confirm-inbox-stopped [--quarantine-conflict]]');
    const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
    const result = await reconcile({ hash: args[0], confirmStopped: args[1] === '--confirm-inbox-stopped', quarantine: args[2] === '--quarantine-conflict', state: resolve(process.env.STUDIO_STATE || '.studio-state'), url: process.env.CEZ_API_URL || 'http://127.0.0.1:4321', repoRoot });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) { console.error(`Reconciliation stopped: ${error.message}`); process.exitCode = 1; }
}
