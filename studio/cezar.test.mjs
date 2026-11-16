import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { scan } from './inbox.mjs';

test('a local idea reaches the pinned Cezar workflow in dry-run mode', { timeout: 30000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'studio-cezar-'));
  let child;
  t.after(async () => {
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise((done) => child.once('exit', done));
    }
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(join(root, '.ai/cezar/workflows'), { recursive: true });
  await mkdir(join(root, 'ideas'));
  await cp(resolve('.ai/cezar/workflows/studio-plan.yaml'), join(root, '.ai/cezar/workflows/studio-plan.yaml'));
  await writeFile(join(root, 'ideas', 'idea.md'), 'Plan a lighthouse puzzle');
  for (const args of [['init', '-b', 'main'], ['config', 'user.name', 'Test'], ['config', 'user.email', 'test@example.invalid'], ['add', '.'], ['commit', '-m', 'test fixture']]) execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  const server = createServer();
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  const url = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [resolve('node_modules/@open-mercato/cezar/dist/index.js'), '--no-open', '--port', String(port)], {
    cwd: root, env: { ...process.env, HOME: root, CEZ_HOME: join(root, 'cezar-home'), CEZ_DRY_RUN: '1', CEZ_TELEMETRY: '0', CEZ_RELAY: '0' }, stdio: 'ignore',
  });
  let healthy = false;
  for (let i = 0; i < 100 && !healthy; i++) {
    if (child.exitCode !== null) throw new Error(`Cezar exited ${child.exitCode}`);
    try { healthy = (await fetch(`${url}/api/v1/health`)).ok; } catch {}
    if (!healthy) await new Promise((done) => setTimeout(done, 100));
  }
  assert.ok(healthy, 'Cezar did not start');
  const args = { inbox: join(root, 'ideas'), state: join(root, 'state'), repoRoot: root, url };
  await scan(args);
  await scan(args);
  const runs = await (await fetch(`${url}/api/v1/runs`)).json();
  const list = Array.isArray(runs) ? runs : runs.runs;
  assert.equal(list.length, 1);
  assert.equal(list[0].task, 'Plan a lighthouse puzzle');
  let run;
  for (let i = 0; i < 100; i++) {
    run = await (await fetch(`${url}/api/v1/runs/${list[0].id}`)).json();
    if (['done', 'review', 'waiting', 'failed', 'cancelled'].includes(run.status)) break;
    await new Promise((done) => setTimeout(done, 100));
  }
  assert.equal(run.status, 'waiting');
  assert.equal(run.steps[0].backend, 'opencode');
  assert.equal(run.steps[0].sessionId, 'ses_mock_dry_run');
  assert.ok(run.worktreePath);
});
