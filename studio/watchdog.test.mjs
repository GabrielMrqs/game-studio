import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { checkRuns } from './watchdog.mjs';

test('watchdog cancels expired, over-token and unaccounted runs and retries uncertain cancellation', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'studio-watchdog-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const db = new DatabaseSync(join(root, 'inbox.sqlite'));
  db.exec('CREATE TABLE receipts (status TEXT, run_id TEXT)');
  const ids = [1, 2, 3, 4, 5].map((n) => `12345678-1234-1234-1234-12345678901${n}`);
  for (const id of ids.slice(0, 4)) db.prepare('INSERT INTO receipts VALUES (?,?)').run('submitted', id);
  db.prepare('UPDATE receipts SET status=? WHERE run_id=?').run('provisional', ids[1]);
  db.prepare('UPDATE receipts SET status=? WHERE run_id=?').run('quarantined', ids[2]);
  db.exec('ALTER TABLE receipts ADD COLUMN conflicting_run_id TEXT');
  db.prepare('UPDATE receipts SET conflicting_run_id=? WHERE run_id=?').run(ids[4], ids[2]);
  db.close();
  const now = Date.now();
  const runs = [
    { id: ids[0], status: 'running', createdAt: new Date(now - 11000).toISOString(), tokensUsed: 1 },
    { id: ids[1], status: 'running', createdAt: new Date(now).toISOString(), tokensUsed: 50 },
    { id: ids[2], status: 'waiting', createdAt: new Date(now).toISOString() },
    { id: ids[3], status: 'done', createdAt: new Date(now - 11000).toISOString(), tokensUsed: 100 },
    { id: ids[4], status: 'running', createdAt: new Date(now - 11000).toISOString(), tokensUsed: 0 },
  ];
  const cancelled = [];
  let fail = true;
  const fetcher = async (url, options) => {
    if (url.pathname.endsWith('/health')) return Response.json({ version: '0.20.0', repoRoot: root });
    const id = url.pathname.split('/')[4];
    if (options.method === 'POST') {
      cancelled.push(id);
      if (id === ids[0] && fail) throw new Error('timeout');
      return Response.json({ cancelled: true });
    }
    return Response.json(runs.find((item) => item.id === id));
  };
  const args = { state: root, url: 'http://127.0.0.1:4321', repoRoot: root, maxSeconds: 10, maxTokens: 50, now, fetcher };
  await checkRuns(args);
  let guard = new DatabaseSync(join(root, 'watchdog.sqlite'), { readOnly: true });
  assert.equal(guard.prepare('SELECT result FROM cancellations WHERE run_id=?').get(ids[0]).result, 'pending');
  assert.equal(guard.prepare('SELECT COUNT(*) AS count FROM cancellations').get().count, 4);
  guard.close();
  fail = false;
  await checkRuns(args);
  guard = new DatabaseSync(join(root, 'watchdog.sqlite'), { readOnly: true });
  assert.equal(guard.prepare('SELECT result FROM cancellations WHERE run_id=?').get(ids[0]).result, 'accepted');
  guard.close();
  assert.equal(cancelled.length, 8);
  assert.ok(cancelled.includes(ids[4]));
  assert.ok(!cancelled.includes(ids[3]));
});

test('watchdog cancels a corroborated unrecorded worktree but not normal startup', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'studio-worktree-guard-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ids = [1, 2, 3].map((n) => `12345678-1234-1234-1234-12345678901${n}`);
  const db = new DatabaseSync(join(root, 'inbox.sqlite'));
  db.exec('CREATE TABLE receipts (status TEXT, run_id TEXT)');
  for (const id of ids) db.prepare('INSERT INTO receipts VALUES (?,?)').run('submitted', id);
  db.close();
  for (const id of ids.slice(0, 2)) {
    const path = join(root, '.ai/cezar/worktrees', id);
    await mkdir(path, { recursive: true });
    await writeFile(join(path, '.git'), 'fixture');
  }
  const lookups = new Map(), cancelled = [];
  const fetcher = async (url, options) => {
    if (url.pathname.endsWith('/health')) return Response.json({ version: '0.20.0', repoRoot: root });
    const id = url.pathname.split('/')[4];
    if (options.method === 'POST') { cancelled.push(id); return Response.json({ cancelled: true }); }
    const seen = (lookups.get(id) || 0) + 1;
    lookups.set(id, seen);
    return Response.json({ id, status: 'queued', createdAt: new Date().toISOString(), tokensUsed: 0, ...(id === ids[1] && seen > 1 ? { worktreePath: '/fixture/reattached' } : {}) });
  };
  await checkRuns({ state: root, url: 'http://127.0.0.1:4321', repoRoot: root, maxSeconds: 3600, maxTokens: 1000, fetcher });
  assert.deepEqual(cancelled, [ids[0]]);
  assert.equal(lookups.get(ids[0]), 2);
  assert.equal(lookups.get(ids[1]), 2);
  const guard = new DatabaseSync(join(root, 'watchdog.sqlite'), { readOnly: true });
  assert.equal(guard.prepare('SELECT reason FROM cancellations WHERE run_id=?').get(ids[0]).reason, 'unrecorded worktree metadata');
  guard.close();
});

test('watchdog retains cancellation intent after a failed attempt and changing usage', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'studio-watchdog-intent-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const id = '12345678-1234-1234-1234-123456789012', now = Date.now();
  const db = new DatabaseSync(join(root, 'inbox.sqlite'));
  db.exec('CREATE TABLE receipts (status TEXT, run_id TEXT)');
  db.prepare('INSERT INTO receipts VALUES (?,?)').run('submitted', id);
  db.close();
  let attempts = 0, tokens = 50, status = 'running';
  const fetcher = async (url, options) => {
    if (url.pathname.endsWith('/health')) return Response.json({ version: '0.20.0', repoRoot: root });
    if (options.method === 'POST') {
      attempts++;
      if (attempts === 1) throw new Error('response lost');
      return Response.json({ cancelled: true });
    }
    return Response.json({ id, status, createdAt: new Date(now).toISOString(), tokensUsed: tokens });
  };
  const args = { state: root, url: 'http://127.0.0.1:4321', repoRoot: root, maxSeconds: 3600, maxTokens: 50, now, fetcher };
  await checkRuns(args);
  tokens = 0;
  await checkRuns(args);
  assert.equal(attempts, 2);
  const guard = new DatabaseSync(join(root, 'watchdog.sqlite'), { readOnly: true });
  assert.deepEqual({ ...guard.prepare('SELECT reason,result FROM cancellations WHERE run_id=?').get(id) }, { reason: 'reported-token limit', result: 'accepted' });
  guard.close();
  status = 'cancelled';
  await checkRuns(args);
  assert.equal(attempts, 2);
});
