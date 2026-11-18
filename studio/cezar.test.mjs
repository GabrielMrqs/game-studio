import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { scan } from './inbox.mjs';
import { checkRuns } from './watchdog.mjs';
import { status } from './status.mjs';

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
  const checkMarker = join(root, 'shell-check-ran');
  await writeFile(join(root, '.ai/cezar/workflows/studio-feature.yaml'), `version: 2\nname: studio-feature\nnodes:\n  - { id: start, type: start }\n  - { id: check, type: check, command: ${JSON.stringify(`printf fixture > '${checkMarker}'`)} }\n  - { id: done, type: end, status: success }\n  - { id: blocked, type: end, status: failed }\nedges:\n  - { from: start, to: check }\n  - { from: check.pass, to: done }\n  - { from: check.fail, to: blocked }\n`);
  await writeFile(join(root, 'ideas', 'idea.md'), 'Plan a lighthouse puzzle');
  for (const args of [['init', '-b', 'main'], ['config', 'user.name', 'Test'], ['config', 'user.email', 'test@example.invalid'], ['add', '.'], ['commit', '-m', 'test fixture']]) execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  const server = createServer();
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  const url = `http://127.0.0.1:${port}`;
  const { CEZ_OPENCODE_BIN: _ignored, ...fixtureEnv } = process.env;
  child = spawn(process.execPath, [resolve('node_modules/@open-mercato/cezar/dist/index.js'), '--no-open', '--port', String(port)], {
    cwd: root, env: { ...fixtureEnv, HOME: root, CEZ_HOME: join(root, 'cezar-home'), CEZ_DRY_RUN: '1', CEZ_TELEMETRY: '0', CEZ_RELAY: '0' }, stdio: 'ignore',
  });
  let healthy = false;
  for (let i = 0; i < 100 && !healthy; i++) {
    if (child.exitCode !== null) throw new Error(`Cezar exited ${child.exitCode}`);
    try { healthy = (await fetch(`${url}/api/v1/health`)).ok; } catch {}
    if (!healthy) await new Promise((done) => setTimeout(done, 100));
  }
  assert.ok(healthy, 'Cezar did not start');
  const args = { inbox: join(root, 'ideas'), state: join(root, 'state'), repoRoot: root, url };
  let executedBeforeReceipt = false;
  await scan({ ...args, fetcher: async (target, options) => {
    const response = await fetch(target, options);
    if (options?.method === 'POST' && target.pathname === '/api/v1/runs') {
      const created = await response.clone().json();
      for (let i = 0; i < 100; i++) {
        const run = await (await fetch(`${url}/api/v1/runs/${created.id}`)).json();
        if (run.steps?.some((step) => ['running', 'waiting', 'done'].includes(step.status))) {
          const db = new DatabaseSync(join(root, 'state/inbox.sqlite'), { readOnly: true });
          const receipt = db.prepare('SELECT status,run_id FROM receipts').get();
          db.close();
          assert.equal(receipt.status, 'pending');
          assert.equal(receipt.run_id, null);
          executedBeforeReceipt = true;
          break;
        }
        await new Promise((done) => setTimeout(done, 50));
      }
    }
    return response;
  } });
  assert.ok(executedBeforeReceipt, 'fixture did not observe execution before receipt binding');
  console.log('PASS Cezar began a dry-run step while the submission receipt remained unbound');
  await scan(args);
  const runs = await (await fetch(`${url}/api/v1/runs`)).json();
  const list = Array.isArray(runs) ? runs : runs.runs;
  assert.equal(list.length, 1);
  assert.match(list[0].task, /^Plan a lighthouse puzzle\n\n\[studio-receipt:/);
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
  const report = await status({ state: join(root, 'state'), inbox: join(root, 'ideas'), url, repoRoot: root });
  assert.equal(report.cezar.counts.waiting, 1);
  assert.equal(report.inbox.counts.submitted, 1);
  assert.equal(report.cezar.runs[0].id, list[0].id);
  await checkRuns({ state: join(root, 'state'), url, repoRoot: root, maxSeconds: 1, maxTokens: 100000, now: Date.now() + 2000 });
  const cancelled = await (await fetch(`${url}/api/v1/runs/${list[0].id}`)).json();
  assert.equal(cancelled.status, 'cancelled');
  await writeFile(join(root, 'ideas', 'check.md'), 'Test the fixture shell check');
  let shellBeforeBinding = false;
  await scan({ ...args, workflow: 'studio-feature', fetcher: async (target, options) => {
    const response = await fetch(target, options);
    if (options?.method === 'POST' && target.pathname === '/api/v1/runs') {
      for (let i = 0; i < 100; i++) {
        try {
          if (await readFile(checkMarker, 'utf8') === 'fixture') {
            const db = new DatabaseSync(join(root, 'state/inbox.sqlite'), { readOnly: true });
            const receipt = db.prepare("SELECT status,run_id FROM receipts WHERE file='check.md'").get();
            db.close();
            assert.equal(receipt.status, 'pending');
            assert.equal(receipt.run_id, null);
            shellBeforeBinding = true;
            break;
          }
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
        await new Promise((done) => setTimeout(done, 50));
      }
    }
    return response;
  } });
  assert.ok(shellBeforeBinding, 'shell check did not run while the receipt was unbound');
  console.log('PASS negative control: actual Cezar shell check ran before durable inbox binding');
  const requestedId = '12345678-1234-1234-1234-123456789012';
  const submitted = await fetch(`${url}/api/v1/runs`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: requestedId, workflow: 'studio-plan', task: 'Fixture run identity probe', runner: 'opencode', worktree: true, autonomous: false }),
  });
  assert.equal(submitted.status, 201);
  const created = await submitted.json();
  assert.match(created.id, /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i);
  assert.notEqual(created.id, requestedId, 'fixture unexpectedly accepts a caller-supplied run ID');
  const stop = await fetch(`${url}/api/v1/runs/${created.id}/cancel`, { method: 'POST' });
  assert.ok(stop.ok);
  console.log('PASS Cezar create-run API assigned its own ID rather than the requested fixture ID');
});
