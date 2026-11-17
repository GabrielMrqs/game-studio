import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, cp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { scan } from './inbox.mjs';
import { publishRun } from './publish-run.mjs';
import { hasUnrecordedWorktree } from './worktree-safety.mjs';
import { checkStartup } from './startup-guard.mjs';
import { inspectRecovery } from './inspect-recovery.mjs';

for (const signal of ['SIGTERM', 'SIGKILL']) test(`Cezar ${signal} restart retains an ambiguously submitted run without a duplicate`, { timeout: 40000, skip: signal === 'SIGKILL' && process.platform === 'win32' }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'studio-cezar-restart-'));
  let child;
  async function stop() {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      if (signal === 'SIGKILL') process.kill(-child.pid, 'SIGKILL');
      else child.kill('SIGTERM');
      const [, exitSignal] = await exited;
      if (signal === 'SIGKILL') assert.equal(exitSignal, 'SIGKILL');
    }
  }
  t.after(async () => { await stop(); await rm(root, { recursive: true, force: true }); });
  const inbox = join(root, 'ideas'), state = join(root, 'state');
  await mkdir(join(root, '.ai/cezar/workflows'), { recursive: true });
  await mkdir(inbox); await mkdir(state);
  const workflowPath = join(root, '.ai/cezar/workflows/studio-feature.yaml');
  if (signal === 'SIGTERM') await cp(resolve('.ai/cezar/workflows/studio-feature.yaml'), workflowPath);
  else {
    const command = `node -e "require('fs').writeFileSync('crash-check-started','yes');setInterval(()=>{},1000)"`;
    await writeFile(workflowPath, `version: 2\nname: studio-feature\nnodes:\n  - { id: start, type: start }\n  - { id: hold, type: check, command: ${JSON.stringify(command)} }\n  - { id: done, type: end, status: success }\n  - { id: failed, type: end, status: failed }\nedges:\n  - { from: start, to: hold }\n  - { from: hold.pass, to: done }\n  - { from: hold.fail, to: failed }\n`);
  }
  const issue = '12345678-1234-1234-1234-123456789012';
  const payload = JSON.stringify({ idea: 'Plan a restart fixture' });
  await writeFile(join(inbox, `linear-${issue}.json`), payload);
  const linear = new DatabaseSync(join(state, 'linear.sqlite'));
  linear.exec('CREATE TABLE issues (id TEXT PRIMARY KEY, payload TEXT NOT NULL, published INTEGER NOT NULL)');
  linear.prepare('INSERT INTO issues VALUES (?,?,1)').run(issue, payload);
  linear.close();
  for (const args of [['init', '-b', 'main'], ['config', 'user.name', 'Test'], ['config', 'user.email', 'test@example.invalid'], ['add', '.'], ['commit', '-m', 'restart fixture']]) execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  const socket = createServer();
  await new Promise((done) => socket.listen(0, '127.0.0.1', done));
  const port = socket.address().port;
  await new Promise((done) => socket.close(done));
  const url = `http://127.0.0.1:${port}`;
  async function start() {
    child = spawn(process.execPath, [resolve('node_modules/@open-mercato/cezar/dist/index.js'), '--no-open', '--port', String(port)], {
      cwd: root, detached: signal === 'SIGKILL', env: { PATH: process.env.PATH, HOME: root, CEZ_HOME: join(root, 'cezar-home'), CEZ_DRY_RUN: '1', CEZ_TELEMETRY: '0', CEZ_RELAY: '0' }, stdio: 'ignore',
    });
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error('fixture Cezar exited before becoming healthy');
      try { if ((await fetch(`${url}/api/v1/health`)).ok) return; } catch {}
      await new Promise((done) => setTimeout(done, 100));
    }
    throw new Error('fixture Cezar did not become healthy');
  }
  await start();
  let posts = 0, created;
  const fetcher = async (target, options) => {
    const response = await fetch(target, options);
    if (options?.method === 'POST') {
      posts++;
      assert.equal(response.status, 201);
      created = (await response.json()).id;
      throw new Error('fixture lost response after creation');
    }
    return response;
  };
  const args = { inbox, state, url, repoRoot: root, workflow: 'studio-feature', fetcher };
  await scan(args);
  assert.equal(posts, 1);
  let run;
  for (let i = 0; i < 100; i++) {
    run = await (await fetch(`${url}/api/v1/runs/${created}`)).json();
    if (signal === 'SIGTERM' && ['waiting', 'failed'].includes(run.status)) break;
    if (signal === 'SIGKILL' && run.status === 'running' && run.worktreePath) {
      try { await access(join(run.worktreePath, 'crash-check-started')); break; } catch {}
    }
    await new Promise((done) => setTimeout(done, 100));
  }
  if (signal === 'SIGTERM') assert.ok(['waiting', 'failed'].includes(run.status), `unexpected mock run status: ${run.status}`);
  else {
    assert.equal(run.status, 'running');
    await access(join(run.worktreePath, 'crash-check-started'));
  }
  assert.ok(run.worktreePath);
  const previousPid = child.pid;
  await stop();
  if (signal === 'SIGKILL') {
    const persisted = JSON.parse(await readFile(join(root, '.ai/cezar/runs.json'), 'utf8')).find((entry) => entry.id === created);
    assert.ok(persisted);
    const inspection = await inspectRecovery({ id: created, repoRoot: root, state });
    assert.equal(inspection.run.id, created);
    assert.equal(inspection.sessions.opencode_store, 'not_checked');
    assert.equal(inspection.receipts.matches[0].role, 'marker_only');
    assert.equal(inspection.receipts.matches[0].task_matches, true);
    if (['queued', 'running', 'waiting'].includes(persisted.status) && !persisted.worktreePath) {
      await assert.rejects(checkStartup(root), /no recorded worktree/);
      console.log('PASS startup guard blocked the actual interrupted run before Cezar restart');
    } else if (['queued', 'running', 'waiting'].includes(persisted.status)) {
      await assert.rejects(checkStartup(root), /requires operator review/);
    } else {
      await checkStartup(root);
    }
  }
  await start();
  assert.notEqual(child.pid, previousPid);
  const restored = await (await fetch(`${url}/api/v1/runs/${created}`)).json();
  assert.equal(restored.id, created);
  if (signal === 'SIGTERM') assert.equal(restored.status, run.status);
  else assert.ok(['queued', 'running', 'waiting', 'failed', 'cancelled'].includes(restored.status), `unexpected recovered status: ${restored.status}`);
  if (signal === 'SIGTERM') assert.equal(restored.worktreePath, run.worktreePath);
  else {
    await access(run.worktreePath);
    assert.ok(restored.worktreePath === undefined || restored.worktreePath === run.worktreePath);
    if (!restored.worktreePath) assert.equal(await hasUnrecordedWorktree(restored, root), true);
    console.log(`Abrupt restart: run ${restored.status}; worktree path ${restored.worktreePath ? 'recorded' : 'missing from API, still on disk'}; started step ${Boolean(restored.steps?.some((step) => step.startedAt))}`);
  }
  await scan(args);
  await scan(args);
  const db = new DatabaseSync(join(state, 'inbox.sqlite'), { readOnly: true });
  const receipt = db.prepare('SELECT status,run_id,source_id,workflow FROM receipts').get();
  assert.equal(receipt.status, 'provisional');
  assert.equal(receipt.run_id, created);
  assert.equal(receipt.source_id, issue);
  assert.equal(receipt.workflow, 'studio-feature');
  db.close();
  const runs = await (await fetch(`${url}/api/v1/runs`)).json();
  assert.equal(runs.length, 1);
  assert.equal(posts, 1);
  let published = false;
  await assert.rejects(publishRun({ id: created, url, state, repoRoot: root, publisher: () => { published = true; } }), /no unique Linear/);
  assert.equal(published, false);
});
