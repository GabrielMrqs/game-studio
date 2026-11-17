import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const uuid = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const statuses = ['queued', 'running', 'waiting', 'review', 'done', 'failed', 'cancelled'];

async function exists(path) {
  try { await lstat(path); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

export async function inspectRecovery({ id, repoRoot, state }) {
  if (!uuid.test(id || '')) throw new Error('invalid run ID');
  const root = await realpath(repoRoot);
  const index = JSON.parse(await readFile(join(root, '.ai/cezar/runs.json'), 'utf8'));
  if (!Array.isArray(index)) throw new Error('invalid Cezar run index');
  const matches = index.filter((run) => run && typeof run.id === 'string' && run.id.toLowerCase() === id.toLowerCase());
  if (matches.length !== 1) throw new Error('run is missing or ambiguous in Cezar index');
  const run = matches[0];
  const expected = join(root, '.ai/cezar/worktrees', run.id);
  const worktree = { expected_path: expected, state: 'unavailable' };
  if (typeof run.worktreePath !== 'string' || !run.worktreePath.trim()) {
    worktree.state = 'not_recorded';
    worktree.expected_path_exists = await exists(expected);
  } else if (!isAbsolute(run.worktreePath) || resolve(run.worktreePath) !== expected) {
    worktree.state = 'path_mismatch';
  } else {
    try {
      if (await realpath(expected) !== expected) throw new Error('symlink');
      const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd();
      const registered = git(root, ['worktree', 'list', '--porcelain', '-z']).split('\0').includes(`worktree ${expected}`);
      const rootCommon = await realpath(git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
      const treeCommon = await realpath(git(expected, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
      const top = await realpath(git(expected, ['rev-parse', '--path-format=absolute', '--show-toplevel']));
      worktree.state = registered && rootCommon === treeCommon && top === expected ? 'registered' : 'invalid';
      if (typeof run.branch === 'string' && run.branch) worktree.branch_matches = git(expected, ['branch', '--show-current']) === run.branch;
    } catch (error) {
      worktree.state = error.code === 'ENOENT' ? 'missing_or_unavailable' : 'invalid_or_unavailable';
    }
  }
  const sessions = Array.isArray(run.steps) ? run.steps.filter((step) => step && step.sessionId).map((step) => ({
    step: typeof step.id === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(step.id) ? step.id : 'unrecognized',
    backend: step.backend === 'opencode' ? 'opencode' : 'other_or_unspecified',
    session_id: typeof step.sessionId === 'string' && /^ses_[a-zA-Z0-9_-]{1,128}$/.test(step.sessionId) ? step.sessionId : null,
  })) : [];
  const report = { run: { id: run.id, status: statuses.includes(run.status) ? run.status : 'unrecognized', workflow: ['studio-plan', 'studio-feature'].includes(run.workflow) ? run.workflow : 'other' }, sessions: { recorded: sessions, opencode_store: 'not_checked' }, worktree, receipts: { state: 'unavailable' }, linear_store: 'not_checked', note: 'Read-only snapshot; stop all writers for a reliable inspection. No recovery or publication is authorized.' };
  const path = join(state, 'inbox.sqlite');
  try {
    if (await exists(`${path}-wal`) || await exists(`${path}-journal`)) {
      report.receipts = { state: 'unavailable_active_or_uncheckpointed_database' };
      return report;
    }
    const db = new DatabaseSync(`${pathToFileURL(path).href}?immutable=1`, { readOnly: true });
    try {
      const columns = db.prepare('PRAGMA table_info(receipts)').all().map((column) => column.name);
      const competing = columns.includes('conflicting_run_id');
      const marker = typeof run.task === 'string' ? /\n\n\[studio-receipt:([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\]$/i.exec(run.task)?.[1] : undefined;
      const rows = db.prepare(`SELECT hash,status,run_id,source_id,workflow,marker${competing ? ',conflicting_run_id' : ''} FROM receipts WHERE run_id=?${competing ? ' OR conflicting_run_id=?' : ''} OR marker=?`).all(...(competing ? [run.id, run.id, marker ?? null] : [run.id, marker ?? null]));
      report.receipts = { state: 'ok', matches: rows.map((row) => {
        let taskMatches = null;
        if (typeof row.marker === 'string' && uuid.test(row.marker) && /^[a-f0-9]{64}$/.test(row.hash || '') && typeof run.task === 'string') {
          const suffix = `\n\n[studio-receipt:${row.marker}]`;
          taskMatches = run.task.endsWith(suffix) && createHash('sha256').update(run.task.slice(0, -suffix.length).trim()).digest('hex') === row.hash;
        }
        return { role: row.run_id === run.id ? 'primary' : row.conflicting_run_id === run.id ? 'conflicting' : 'marker_only', status: ['pending', 'provisional', 'submitted', 'conflict', 'quarantined'].includes(row.status) ? row.status : 'unrecognized', workflow_matches: ['studio-plan', 'studio-feature'].includes(row.workflow) && row.workflow === run.workflow, task_matches: taskMatches, linear_issue_id: uuid.test(row.source_id || '') ? row.source_id : null };
      }) };
    } finally { db.close(); }
    if (await exists(`${path}-wal`) || await exists(`${path}-journal`)) report.receipts = { state: 'unavailable_active_or_uncheckpointed_database' };
  } catch { report.receipts = { state: 'unavailable' }; }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3) throw new Error('usage: node studio/inspect-recovery.mjs RUN_ID');
    const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, stdio: ['ignore', 'pipe', 'ignore'] }).trimEnd();
    const report = await inspectRecovery({ id: process.argv[2], repoRoot, state: resolve(process.env.STUDIO_STATE || '.studio-state') });
    console.log(JSON.stringify(report, null, 2));
    const receipts = report.receipts.matches;
    if (report.run.status === 'unrecognized' || report.receipts.state !== 'ok' || receipts.length !== 1 || receipts[0].role !== 'primary' || receipts[0].status !== 'submitted' || receipts[0].workflow_matches !== true || receipts[0].task_matches !== true || report.worktree.state !== 'registered' || report.worktree.branch_matches !== true) process.exitCode = 1;
  } catch (error) { console.error(`Recovery inspection stopped: ${error.message}`); process.exitCode = 1; }
}
