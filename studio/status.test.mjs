import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { status } from './status.mjs';

test('status reports sanitized queue, recovery, publication and run states without changing receipts', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'studio-status-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = join(root, 'state'), inbox = join(root, 'ideas');
  await mkdir(state); await mkdir(inbox);
  await writeFile(join(inbox, 'idea.md'), 'private fixture idea');
  await writeFile(join(inbox, 'ignored.txt'), 'ignored');
  const inboxDb = new DatabaseSync(join(state, 'inbox.sqlite'));
  inboxDb.exec("CREATE TABLE receipts(status TEXT, detail TEXT); INSERT INTO receipts VALUES ('pending','private fixture secret'),('provisional','private fixture secret'),('conflict','private fixture secret')");
  inboxDb.close();
  const pub = new DatabaseSync(join(state, 'publish.sqlite'));
  pub.exec("CREATE TABLE publications(phase TEXT); INSERT INTO publications VALUES ('comment_pending'),('done')");
  pub.close();
  const linear = new DatabaseSync(join(state, 'linear.sqlite'));
  linear.exec("CREATE TABLE issues(published INTEGER, payload TEXT); INSERT INTO issues VALUES (0,'private fixture secret'),(1,'private fixture secret')");
  linear.close();
  const id = '12345678-1234-1234-1234-123456789012';
  const calls = [];
  const fetcher = async (target, options) => {
    calls.push({ path: target.pathname, method: options.method });
    return Response.json(target.pathname.endsWith('health') ? { version: '0.20.0', repoRoot: root } : [{ id, status: 'waiting', workflow: 'studio-feature', task: 'private fixture secret' }, { id: 'private fixture secret', status: 'private fixture secret', workflow: 'private fixture secret' }]);
  };
  const before = (await readdir(state)).sort();
  const report = await status({ state, inbox, url: 'http://127.0.0.1:4321', repoRoot: root, fetcher });
  assert.equal(report.idea_files.count, 1);
  assert.equal(report.inbox.counts.provisional, 1);
  assert.equal(report.inbox.counts.conflict, 1);
  assert.equal(report.linear.counts.pending, 1);
  assert.equal(report.publications.counts.comment_pending, 1);
  assert.equal(report.watchdog.state, 'missing');
  assert.equal(report.cezar.counts.waiting, 1);
  assert.equal(report.cezar.counts.other, 1);
  assert.deepEqual(report.cezar.runs, [{ id, status: 'waiting', workflow: 'studio-feature' }]);
  assert.ok(!JSON.stringify(report).includes('private fixture'));
  assert.ok(calls.every((call) => call.method === undefined));
  assert.deepEqual((await readdir(state)).sort(), before);
  const check = new DatabaseSync(join(state, 'inbox.sqlite'), { readOnly: true });
  assert.equal(check.prepare('SELECT COUNT(*) AS n FROM receipts').get().n, 3);
  check.close();
});

test('status fails closed on missing data, wrong Cezar identity and unsafe origins', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'studio-status-missing-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let calls = 0;
  const fetcher = async () => { calls++; return Response.json({ version: '0.20.0', repoRoot: '/wrong' }); };
  const args = { state: join(root, 'missing-state'), inbox: join(root, 'missing-ideas'), repoRoot: root, url: 'http://127.0.0.1:4321', fetcher };
  const report = await status(args);
  assert.equal(report.cezar.state, 'unavailable');
  assert.equal(report.inbox.state, 'missing');
  assert.equal(report.idea_files.state, 'missing');
  assert.equal(calls, 1);
  assert.deepEqual(await readdir(root), []);
  assert.equal((await status({ ...args, url: 'http://user:secret@127.0.0.1:4321' })).cezar.state, 'unavailable');
  assert.equal(calls, 1);
});

test('status warns when an active run has an on-disk worktree absent from the API', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'studio-status-worktree-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const id = '12345678-1234-1234-1234-123456789012';
  const path = join(root, '.ai/cezar/worktrees', id);
  await mkdir(path, { recursive: true });
  await writeFile(join(path, '.git'), 'fixture');
  const fetcher = async (url) => Response.json(url.pathname.endsWith('health') ? { version: '0.20.0', repoRoot: root } : [{ id, status: 'queued', workflow: 'studio-feature' }]);
  const report = await status({ state: join(root, 'state'), inbox: join(root, 'ideas'), repoRoot: root, url: 'http://127.0.0.1:4321', fetcher });
  assert.equal(report.cezar.runs[0].warning, 'unrecorded_worktree');
  assert.ok(!JSON.stringify(report).includes(path));
});
