import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { reconcile } from './reconcile-inbox.mjs';
import { publishRun } from './publish-run.mjs';
import { reconcilePublication } from './reconcile-publication.mjs';

test('reconciliation refuses missing state without creating databases or contacting services', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'studio-reconcile-missing-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let calls = 0;
  const fetcher = () => { calls++; throw new Error('unexpected request'); };
  for (const confirmStopped of [false, true]) {
    await assert.rejects(reconcile({ state: root, url: 'http://127.0.0.1:4321', repoRoot: root, hash: 'a'.repeat(64), confirmStopped, fetcher }));
    await assert.rejects(reconcilePublication({ state: root, repo: 'fixture/game', branch: 'cez/fixture', githubToken: 'fixture', linearKey: 'fixture', confirmStopped, fetcher }));
  }
  assert.equal(calls, 0);
  assert.deepEqual(await readdir(root), []);
});

test('operator inspection and confirmation safely reconcile a unique provisional run', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'studio-reconcile-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const db = new DatabaseSync(join(root, 'inbox.sqlite'));
  db.exec('CREATE TABLE receipts (hash TEXT PRIMARY KEY, file TEXT, status TEXT, run_id TEXT, source_id TEXT, workflow TEXT, marker TEXT, detail TEXT)');
  const hash = createHash('sha256').update('Fixture idea').digest('hex');
  const id = '12345678-1234-1234-1234-123456789012';
  const marker = '12345678-1234-1234-1234-123456789013';
  db.prepare('INSERT INTO receipts VALUES (?,?,?,?,?,?,?,?)').run(hash, 'idea.json', 'provisional', id, id, 'studio-feature', marker, null);
  let runs = [{ id, workflow: 'studio-feature', task: `Fixture idea\n\n[studio-receipt:${marker}]`, status: 'done' }];
  const fetcher = async (url) => Response.json(url.pathname.endsWith('health') ? { version: '0.20.0', repoRoot: root } : runs);
  const args = { state: root, url: 'http://127.0.0.1:4321', repoRoot: root, hash, fetcher };
  assert.equal((await reconcile(args)).matches[0].taskMatches, true);
  assert.equal(db.prepare('SELECT status FROM receipts').get().status, 'provisional');
  await assert.rejects(publishRun({ id, url: args.url, state: root, repoRoot: root, publisher: () => { throw Error('must not publish'); } }), /no unique Linear/);
  runs.push({ ...runs[0], id: '12345678-1234-1234-1234-123456789014' });
  await assert.rejects(reconcile({ ...args, confirmStopped: true }), /does not uniquely match/);
  runs = [{ ...runs[0], task: `Different idea\n\n[studio-receipt:${marker}]` }];
  await assert.rejects(reconcile({ ...args, confirmStopped: true }), /does not uniquely match/);
  runs = [{ ...runs[0], task: `Fixture idea\n\n[studio-receipt:${marker}]` }];
  db.exec("UPDATE receipts SET status='conflict'");
  assert.equal((await reconcile(args)).receipt.conflicting_run_id, null);
  await assert.rejects(reconcile({ ...args, confirmStopped: true }), /cannot be finalized/);
  await assert.rejects(reconcile({ ...args, confirmStopped: true, quarantine: true }), /two distinct recorded run IDs/);
  db.exec('ALTER TABLE receipts ADD COLUMN conflicting_run_id TEXT');
  const competing = '12345678-1234-1234-1234-123456789014';
  db.prepare('UPDATE receipts SET conflicting_run_id=?').run(competing);
  assert.equal((await reconcile(args)).receipt.conflicting_run_id, competing);
  db.exec("UPDATE receipts SET status='provisional'");
  assert.equal((await reconcile({ ...args, confirmStopped: true })).receipt.status, 'submitted');
  assert.equal(db.prepare('SELECT status FROM receipts').get().status, 'submitted');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM reconciliation_audit').get().n, 1);
  await assert.rejects(reconcile({ ...args, confirmStopped: true }), /not provisional or conflicting/);
  db.close();
});

test('conflicts can be quarantined without selecting or publishing either run', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'studio-quarantine-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const db = new DatabaseSync(join(root, 'inbox.sqlite'));
  db.exec('CREATE TABLE receipts (hash TEXT PRIMARY KEY, file TEXT, status TEXT, run_id TEXT, source_id TEXT, workflow TEXT, marker TEXT, detail TEXT, conflicting_run_id TEXT)');
  const hash = createHash('sha256').update('Fixture idea').digest('hex');
  const first = '12345678-1234-1234-1234-123456789012';
  const second = '12345678-1234-1234-1234-123456789014';
  const marker = '12345678-1234-1234-1234-123456789013';
  db.prepare('INSERT INTO receipts VALUES (?,?,?,?,?,?,?,?,?)').run(hash, 'idea.json', 'conflict', first, first, 'studio-feature', marker, null, second);
  const fetcher = async (url) => Response.json(url.pathname.endsWith('health') ? { version: '0.20.0', repoRoot: root } : []);
  const args = { state: root, url: 'http://127.0.0.1:4321', repoRoot: root, hash, fetcher };
  await assert.rejects(reconcile({ ...args, quarantine: true }), /requires confirmation/);
  await assert.rejects(reconcile({ ...args, confirmStopped: true }), /cannot be finalized/);
  const result = await reconcile({ ...args, confirmStopped: true, quarantine: true });
  assert.equal(result.receipt.status, 'quarantined');
  const receipt = db.prepare('SELECT status, run_id, conflicting_run_id FROM receipts').get();
  assert.equal(receipt.run_id, first);
  assert.equal(receipt.conflicting_run_id, second);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM conflict_quarantine_audit').get().n, 1);
  assert.equal((await reconcile(args)).receipt.status, 'quarantined');
  for (const id of [first, second]) await assert.rejects(publishRun({ id, url: args.url, state: root, repoRoot: root, publisher: () => { throw Error('must not publish'); } }), /no unique Linear/);
  await assert.rejects(reconcile({ ...args, confirmStopped: true, quarantine: true }), /requires a conflict/);
  db.close();
});
