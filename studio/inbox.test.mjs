import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { scan } from './inbox.mjs';

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

test('refuses to submit to the wrong Cezar project', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'studio-inbox-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(scan({ inbox: root, state: join(root, 'state'), repoRoot: root, url: 'http://localhost:4321', fetcher: async () => Response.json({ version: '0.20.0', repoRoot: '/different' }) }), /does not match/);
});
