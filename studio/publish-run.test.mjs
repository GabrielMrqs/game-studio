import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { publishRun } from './publish-run.mjs';

test('publication refuses missing source bindings and unreviewed runs', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'studio-publish-run-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const id = '12345678-1234-1234-1234-123456789012';
  const db = new DatabaseSync(join(root, 'inbox.sqlite'));
  db.exec('CREATE TABLE receipts (run_id TEXT, status TEXT, source_id TEXT, workflow TEXT)');
  const run = { id, workflow: 'studio-feature', status: 'done', graphState: { taken: ['review.approve->commit', 'branch_check.pass->done'] } };
  const fetcher = async (url) => Response.json(url.pathname.endsWith('health') ? { version: '0.20.0', repoRoot: root } : run);
  let calls = 0;
  const args = { id, url: 'http://127.0.0.1:4321', state: root, repoRoot: root, fetcher, publisher: () => { calls++; } };
  await assert.rejects(publishRun(args), /no unique Linear/);
  db.prepare('INSERT INTO receipts VALUES (?,?,?,?)').run(id, 'submitted', id, 'studio-plan');
  await assert.rejects(publishRun(args), /no unique Linear/);
  db.exec("UPDATE receipts SET workflow='studio-feature'");
  await assert.rejects(publishRun(args), /has not passed Godot checks/);
  run.graphState.taken.unshift('game.pass->qa');
  await assert.rejects(publishRun(args), /has not passed Godot checks/);
  run.graphState.taken.unshift('qa.pass->review');
  await assert.rejects(publishRun(args), /full reviewed commit SHA is required/);
  await assert.rejects(publishRun({ ...args, approvedSha: 'abcd1234' }), /full reviewed commit SHA is required/);
  for (const status of ['queued', 'running', 'waiting', 'failed', 'cancelled']) {
    run.status = status;
    await assert.rejects(publishRun(args), /has not passed Godot checks/, `${status} must not publish even with successful graph edges`);
  }
  assert.equal(calls, 0);
  db.close();
});
