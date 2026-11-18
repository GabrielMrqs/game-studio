import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { scan } from './inbox.mjs';
import { publishRun } from './publish-run.mjs';

test('deduplicates ideas and retains ambiguous submissions across restarts', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'studio-inbox-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const inbox = join(root, 'ideas'), state = join(root, 'state');
  await mkdir(inbox);
  await writeFile(join(inbox, 'a.md'), 'A lighthouse puzzle');
  await writeFile(join(inbox, 'duplicate.json'), JSON.stringify({ idea: 'A lighthouse puzzle' }));
  await writeFile(join(inbox, 'b.md'), 'A second idea');
  await writeFile(join(inbox, 'invalid.json'), '{}');
  let posts = 0;
  const fetcher = async (url, options) => {
    if (url.pathname.endsWith('health')) return Response.json({ version: '0.20.0', repoRoot: root });
    if (!options?.method) return Response.json([]);
    posts++;
    assert.equal(JSON.parse(options.body).worktree, true);
    assert.equal(JSON.parse(options.body).runner, 'opencode');
    if (posts === 2) throw new Error('connection lost after request');
    return Response.json({ id: 'run-1' }, { status: 201 });
  };
  const args = { inbox, state, repoRoot: root, url: 'http://127.0.0.1:4321', fetcher };
  await scan(args);
  await scan(args);
  assert.equal(posts, 2);
  const db = new DatabaseSync(join(state, 'inbox.sqlite'));
  assert.deepEqual(db.prepare('SELECT status FROM receipts ORDER BY status').all().map((x) => x.status), ['pending', 'submitted']);
  db.close();
});

test('recovers exactly one correlated run without resubmitting an ambiguous request', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'studio-recovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const inbox = join(root, 'ideas'), state = join(root, 'state');
  await mkdir(inbox);
  await writeFile(join(inbox, 'idea.md'), 'Repair the lantern');
  let postCount = 0, found = [];
  const id = '12345678-1234-1234-1234-123456789012';
  const fetcher = async (url, options) => {
    if (url.pathname.endsWith('health')) return Response.json({ version: '0.20.0', repoRoot: root });
    if (!options?.method) return Response.json(found);
    postCount++;
    const request = JSON.parse(options.body);
    found = [{ id, task: request.task, workflow: request.workflow }];
    throw new Error('connection lost after create');
  };
  const args = { inbox, state, repoRoot: root, url: 'http://127.0.0.1:4321', fetcher };
  await scan(args);
  await scan(args);
  const db = new DatabaseSync(join(state, 'inbox.sqlite'), { readOnly: true });
  const row = db.prepare('SELECT status, run_id FROM receipts').get();
  assert.equal(row.status, 'provisional');
  assert.equal(row.run_id, id);
  assert.equal(postCount, 1);
  db.close();
});

test('multiple correlated runs remain pending', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'studio-ambiguous-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const inbox = join(root, 'ideas'), state = join(root, 'state');
  await mkdir(inbox);
  await writeFile(join(inbox, 'idea.md'), 'An ambiguous idea');
  let found = [], posts = 0;
  const fetcher = async (url, options) => {
    if (url.pathname.endsWith('health')) return Response.json({ version: '0.20.0', repoRoot: root });
    if (!options?.method) return Response.json(found);
    posts++;
    const request = JSON.parse(options.body);
    found = [1, 2].map((n) => ({ id: `12345678-1234-1234-1234-12345678901${n}`, task: request.task, workflow: request.workflow }));
    throw new Error('timeout');
  };
  const args = { inbox, state, repoRoot: root, url: 'http://127.0.0.1:4321', fetcher };
  await scan(args);
  await scan(args);
  const db = new DatabaseSync(join(state, 'inbox.sqlite'), { readOnly: true });
  assert.equal(db.prepare('SELECT status FROM receipts').get().status, 'pending');
  assert.equal(posts, 1);
  db.close();
});

test('concurrent reconciliation cannot be overwritten by a conflicting submission response', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'studio-race-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const inbox = join(root, 'ideas'), state = join(root, 'state');
  await mkdir(inbox);
  await writeFile(join(inbox, 'idea.md'), 'An interrupted idea');
  const first = '12345678-1234-1234-1234-123456789011';
  const second = '12345678-1234-1234-1234-123456789012';
  let release, started;
  const ready = new Promise((done) => { started = done; });
  const waiting = new Promise((done) => { release = done; });
  let created;
  const fetcher = async (url, options) => {
    if (url.pathname.endsWith('health')) return Response.json({ version: '0.20.0', repoRoot: root });
    if (!options?.method) return Response.json([created]);
    const request = JSON.parse(options.body);
    created = { id: first, task: request.task, workflow: request.workflow };
    started();
    await waiting;
    return Response.json({ id: second }, { status: 201 });
  };
  const args = { inbox, state, repoRoot: root, url: 'http://127.0.0.1:4321', fetcher };
  const submission = scan(args);
  await ready;
  await scan(args);
  const live = new DatabaseSync(join(state, 'inbox.sqlite'));
  live.prepare("UPDATE receipts SET source_id=?, workflow='studio-feature' WHERE run_id=?").run(first, first);
  assert.equal(live.prepare('SELECT status FROM receipts').get().status, 'provisional');
  live.close();
  let published = false;
  await assert.rejects(publishRun({ id: first, url: args.url, state, repoRoot: root, publisher: () => { published = true; } }), /no unique Linear/);
  assert.equal(published, false);
  release();
  await submission;
  const db = new DatabaseSync(join(state, 'inbox.sqlite'), { readOnly: true });
  const receipt = db.prepare('SELECT status, run_id, conflicting_run_id, detail FROM receipts').get();
  assert.equal(receipt.status, 'conflict');
  assert.equal(receipt.run_id, first);
  assert.equal(receipt.conflicting_run_id, second);
  assert.match(receipt.detail, /conflicts/);
  db.close();
});

test('a matching submission response finalizes a provisional receipt', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'studio-match-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const inbox = join(root, 'ideas'), state = join(root, 'state');
  await mkdir(inbox);
  await writeFile(join(inbox, 'idea.md'), 'A matching idea');
  const id = '12345678-1234-1234-1234-123456789012';
  let release, started, created;
  const ready = new Promise((done) => { started = done; });
  const waiting = new Promise((done) => { release = done; });
  const fetcher = async (url, options) => {
    if (url.pathname.endsWith('health')) return Response.json({ version: '0.20.0', repoRoot: root });
    if (!options?.method) return Response.json([created]);
    const request = JSON.parse(options.body);
    created = { id, task: request.task, workflow: request.workflow };
    started();
    await waiting;
    return Response.json({ id }, { status: 201 });
  };
  const args = { inbox, state, repoRoot: root, url: 'http://127.0.0.1:4321', fetcher };
  const submission = scan(args);
  await ready;
  await scan(args);
  release();
  await submission;
  const db = new DatabaseSync(join(state, 'inbox.sqlite'), { readOnly: true });
  const receipt = db.prepare('SELECT status, run_id FROM receipts').get();
  assert.equal(receipt.status, 'submitted');
  assert.equal(receipt.run_id, id);
  db.close();
});

test('existing receipt databases gain the conflict ID column without changing receipts', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'studio-migrate-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const inbox = join(root, 'ideas'), state = join(root, 'state');
  await mkdir(inbox);
  await mkdir(state);
  const db = new DatabaseSync(join(state, 'inbox.sqlite'));
  db.exec("CREATE TABLE receipts (hash TEXT PRIMARY KEY, file TEXT NOT NULL, status TEXT NOT NULL, run_id TEXT, detail TEXT, source_id TEXT, workflow TEXT, marker TEXT); INSERT INTO receipts (hash,file,status,run_id) VALUES ('old','idea.md','conflict','old-run')");
  db.close();
  await scan({ inbox, state, repoRoot: root, url: 'http://127.0.0.1:4321', fetcher: async () => Response.json({ version: '0.20.0', repoRoot: root }) });
  const updated = new DatabaseSync(join(state, 'inbox.sqlite'), { readOnly: true });
  const row = updated.prepare('SELECT status, run_id, conflicting_run_id FROM receipts').get();
  assert.equal(row.status, 'conflict');
  assert.equal(row.run_id, 'old-run');
  assert.equal(row.conflicting_run_id, null);
  updated.close();
});

test('refuses to submit to the wrong Cezar project', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'studio-inbox-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(scan({ inbox: root, state: join(root, 'state'), repoRoot: root, url: 'http://localhost:4321', fetcher: async () => Response.json({ version: '0.20.0', repoRoot: '/different' }) }), /does not match/);
});
