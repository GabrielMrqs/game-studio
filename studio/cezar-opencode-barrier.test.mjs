import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { autoNamingActive } from '../node_modules/@open-mercato/cezar/dist/runs/auto-name.js';

for (const mode of ['release', 'interrupted', 'alternate-runner']) test(`contained Cezar fixture ${mode}`, { timeout: 30000, skip: process.platform !== 'linux' }, async (t) => {
  if (spawnSync('bwrap', ['--version']).error?.code === 'ENOENT') return t.skip('bubblewrap unavailable');
  if (spawnSync('/usr/bin/opencode', ['--version']).error?.code === 'ENOENT') return t.skip('OpenCode unavailable');
  assert.equal(autoNamingActive({ CEZ_AUTONAME: '0', CEZ_DRY_RUN: '0' }), false);
  const root = await mkdtemp(join(tmpdir(), 'studio-opencode-barrier-'));
  let child;
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await new Promise((done) => child.once('exit', done));
    }
    await rm(root, { recursive: true, force: true });
  });
  const baseline = join(root, 'baseline'), project = join(root, 'project'), guard = join(root, 'guard'), permits = join(root, 'permits');
  await mkdir(join(baseline, '.ai/cezar/workflows'), { recursive: true });
  await mkdir(guard);
  await mkdir(permits);
  const check = `printf executed > check-marker; printf fixture > autosave-fixture; /usr/bin/node --input-type=module -e "import {autosaveCommit} from '/tools/node_modules/@open-mercato/cezar/dist/git-worktree.js'; if (await autosaveCommit(process.cwd(), 'turn end') !== 'committed') process.exit(1)"`;
  await writeFile(join(baseline, '.ai/cezar/workflows/barrier.yaml'), `version: 2
name: barrier
nodes:
  - { id: start, type: start }
  - { id: check, type: check, command: ${JSON.stringify(check)} }
  - { id: agent, type: agent, runner: opencode, prompt: 'Reply with OK; do not use tools.' }
  - { id: done, type: end, status: success }
edges:
  - { from: start, to: check }
  - { from: check.pass, to: agent }
  - { from: agent.done, to: done }
`);
  await writeFile(join(baseline, '.ai/cezar/workflows/alternate.yaml'), `version: 2
name: alternate
nodes:
  - { id: start, type: start }
  - { id: agent, type: agent, runner: claude, prompt: fixture }
  - { id: done, type: end, status: success }
edges:
  - { from: start, to: agent }
  - { from: agent.done, to: done }
`);
  await writeFile(join(guard, 'claude'), `#!/usr/bin/node
require('node:fs').writeFileSync('/project/unguarded-agent', process.env.CEZ_TASK_ID || 'missing');
`, { mode: 0o755 });
  await writeFile(join(guard, 'bash'), `#!/usr/bin/node
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const id = process.env.CEZ_RUN_ID;
if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id || '')) process.exit(1);
let baselineWritable = false;
try { fs.writeFileSync('/protected/probe', 'bad'); baselineWritable = true; } catch {}
if (baselineWritable) process.exit(1);
fs.writeFileSync('/project/check-gate-reached', id);
const until = Date.now() + 12000;
function wait() {
  let permit = '';
  try { permit = fs.readFileSync('/permits/' + id + '.check', 'utf8'); } catch {}
  if (permit === id) {
    const result = spawnSync('/usr/bin/bash', process.argv.slice(2), { stdio: 'inherit', env: process.env });
    process.exit(result.status ?? 1);
  }
  if (Date.now() >= until) process.exit(1);
  setTimeout(wait, 20);
}
wait();
`, { mode: 0o755 });
  await writeFile(join(guard, 'opencode'), `#!/usr/bin/node
const fs = require('node:fs');
const { spawn, spawnSync } = require('node:child_process');
if (process.argv[2] !== 'serve') {
  const result = spawnSync('/usr/bin/opencode', process.argv.slice(2), { stdio: 'inherit', env: process.env });
  process.exit(result.status ?? 1);
}
const id = process.env.CEZ_TASK_ID;
if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id || '')) process.exit(1);
let writable = false;
try { fs.writeFileSync('/permits/probe', 'bad'); writable = true; } catch {}
if (writable) process.exit(1);
fs.writeFileSync('/project/agent-gate-reached', id);
const until = Date.now() + 12000;
function wait() {
  let permit = '';
  try { permit = fs.readFileSync('/permits/' + id + '.agent', 'utf8'); } catch {}
  if (permit === id) {
    const escaped = spawn('/usr/bin/node', ['-e', "setInterval(() => require('node:fs').appendFileSync('/project/detached-heartbeat', 'x'), 50)"], { detached: true, stdio: 'ignore' });
    escaped.unref();
    const processChild = spawn('/usr/bin/opencode', process.argv.slice(2), { stdio: 'inherit', env: process.env });
    processChild.once('spawn', () => fs.writeFileSync('/project/agent-launched', String(processChild.pid)));
    processChild.once('exit', (code) => process.exit(code ?? 1));
    processChild.once('error', () => process.exit(1));
    process.on('SIGTERM', () => processChild.kill('SIGTERM'));
    return;
  }
  if (Date.now() >= until) process.exit(1);
  setTimeout(wait, 20);
}
wait();
`, { mode: 0o755 });
  for (const args of [['init', '-b', 'main'], ['config', 'user.name', 'Fixture'], ['config', 'user.email', 'fixture@example.invalid'], ['add', '.'], ['commit', '-m', 'fixture']]) {
    execFileSync('git', args, { cwd: baseline, stdio: 'ignore' });
  }
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: baseline, encoding: 'utf8' }).trim();
  execFileSync('git', ['clone', '--no-hardlinks', baseline, project], { stdio: 'ignore' });
  execFileSync('git', ['remote', 'remove', 'origin'], { cwd: project, stdio: 'ignore' });
  const socket = createServer();
  await new Promise((done) => socket.listen(0, '127.0.0.1', done));
  const port = socket.address().port;
  await new Promise((done) => socket.close(done));
  child = spawn('bwrap', [
    '--unshare-all', '--share-net', '--die-with-parent', '--new-session',
    '--ro-bind', '/usr', '/usr', '--ro-bind', '/lib', '/lib', '--ro-bind-try', '/lib64', '/lib64',
    '--symlink', 'usr/bin', '/bin', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
    '--ro-bind', '/etc/ssl', '/etc/ssl', '--ro-bind', '/etc/resolv.conf', '/etc/resolv.conf',
    '--ro-bind', '/etc/hosts', '/etc/hosts',
    '--bind', project, '/project', '--ro-bind', baseline, '/protected', '--ro-bind', guard, '/guard', '--ro-bind', permits, '/permits',
    '--ro-bind', resolve('node_modules'), '/tools/node_modules', '--chdir', '/project',
    '--clearenv', '--setenv', 'HOME', '/tmp', '--setenv', 'PATH', '/guard:/usr/bin:/bin',
    '--setenv', 'CEZ_HOME', '/tmp/cezar', '--setenv', 'CEZ_OPENCODE_BIN', '/guard/opencode',
    '--setenv', 'CEZ_CLAUDE_BIN', '/guard/claude', '--setenv', 'CEZ_DRY_RUN', mode === 'alternate-runner' ? '1' : '0',
    '--setenv', 'CEZ_AGENT_MODELS_LOCKED', '1', '--setenv', 'CEZ_AUTONAME', '0',
    '--setenv', 'CEZ_TELEMETRY', '0', '--setenv', 'CEZ_RELAY', '0',
    '/usr/bin/node', '/tools/node_modules/@open-mercato/cezar/dist/index.js', '--no-open', '--port', String(port),
  ], { stdio: 'ignore' });
  const url = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('fixture Cezar exited before readiness');
    try { ready = (await fetch(`${url}/api/v1/health`)).ok; } catch {}
    if (!ready) await new Promise((done) => setTimeout(done, 100));
  }
  assert.ok(ready);
  if (mode === 'alternate-runner') {
    const response = await fetch(`${url}/api/v1/runs`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workflow: 'alternate', task: 'fixture', runner: 'opencode', worktree: true, autonomous: false }),
    });
    assert.equal(response.status, 201);
    const { id } = await response.json();
    let ungated;
    for (let i = 0; i < 150; i++) {
      try { ungated = await readFile(join(project, 'unguarded-agent'), 'utf8'); break; } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await new Promise((done) => setTimeout(done, 50));
    }
    assert.equal(ungated, id, 'alternate fixture runner did not execute without a permit');
    console.log('PASS negative control: actual Cezar launched an alternate fixture runner without any permit');
    return;
  }
  const response = await fetch(`${url}/api/v1/runs`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workflow: 'barrier', task: 'fixture', runner: 'opencode', worktree: true, autonomous: false }),
  });
  assert.equal(response.status, 201);
  const { id } = await response.json();
  const checkMarker = join(project, '.ai/cezar/worktrees', id, 'check-marker');
  let checkReached;
  for (let i = 0; i < 150; i++) {
    try { checkReached = await readFile(join(project, 'check-gate-reached'), 'utf8'); break; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await new Promise((done) => setTimeout(done, 50));
  }
  assert.equal(checkReached, id);
  await assert.rejects(readFile(checkMarker), { code: 'ENOENT' });
  await assert.rejects(readFile(join(project, 'agent-gate-reached')), { code: 'ENOENT' });
  const startTime = (await readFile(`/proc/${child.pid}/stat`, 'utf8')).split(') ')[1].split(' ')[19];
  const bindingFile = join(root, 'binding.sqlite');
  const bindingWriter = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { DatabaseSync } from 'node:sqlite';
    const db = new DatabaseSync(process.argv[1]);
    db.exec('PRAGMA synchronous=FULL; CREATE TABLE binding (run_id TEXT PRIMARY KEY, pid INTEGER NOT NULL, start_time TEXT NOT NULL)');
    db.prepare('INSERT INTO binding VALUES (?,?,?)').run(process.argv[2], Number(process.argv[3]), process.argv[4]);
    db.close();
    process.kill(process.pid, 'SIGKILL');
  `, bindingFile, id, String(child.pid), startTime], { stdio: 'ignore' });
  assert.equal(bindingWriter.signal, 'SIGKILL');
  await assert.rejects(readFile(checkMarker), { code: 'ENOENT' });
  const binding = new DatabaseSync(bindingFile, { readOnly: true });
  const row = binding.prepare('SELECT * FROM binding').get();
  binding.close();
  assert.equal(row.run_id, id);
  assert.equal(row.pid, child.pid);
  assert.equal(row.start_time, (await readFile(`/proc/${child.pid}/stat`, 'utf8')).split(') ')[1].split(' ')[19]);
  await writeFile(join(permits, `${id}.check`), id);
  let checked;
  for (let i = 0; i < 100; i++) {
    try { checked = await readFile(checkMarker, 'utf8'); break; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await new Promise((done) => setTimeout(done, 50));
  }
  assert.equal(checked, 'executed');
  let reached;
  for (let i = 0; i < 150; i++) {
    try { reached = await readFile(join(project, 'agent-gate-reached'), 'utf8'); break; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await new Promise((done) => setTimeout(done, 50));
  }
  assert.equal(reached, id, 'Cezar did not reach the fixture agent gate');
  await new Promise((done) => setTimeout(done, 200));
  await assert.rejects(readFile(join(project, 'agent-launched')), { code: 'ENOENT' });
  await writeFile(join(permits, `${id}.agent`), 'wrong-run');
  await new Promise((done) => setTimeout(done, 300));
  await assert.rejects(readFile(join(project, 'agent-launched')), { code: 'ENOENT' });
  if (mode === 'interrupted') {
    // Allow Cezar's debounced run index to be written before the crash.
    let recorded = false;
    for (let i = 0; i < 100; i++) {
      try {
        const runs = JSON.parse(await readFile(join(project, '.ai/cezar/runs.json'), 'utf8'));
        if (runs.some((run) => run.id === id && run.status === 'running' && run.worktreePath)) { recorded = true; break; }
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await new Promise((done) => setTimeout(done, 50));
    }
    assert.ok(recorded, 'active run and worktree were not persisted before interruption');
    child.kill('SIGKILL');
    await new Promise((done) => child.once('exit', done));
    const restarted = spawnSync('bwrap', [
      '--unshare-all', '--die-with-parent', '--new-session',
      '--ro-bind', '/usr', '/usr', '--ro-bind', '/lib', '/lib', '--ro-bind-try', '/lib64', '/lib64',
      '--symlink', 'usr/bin', '/bin', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
      '--bind', project, '/project', '--ro-bind', resolve('studio/startup-guard.mjs'), '/startup-guard.mjs',
      '--chdir', '/project', '--clearenv', '--setenv', 'HOME', '/tmp', '--setenv', 'PATH', '/usr/bin:/bin',
      '/usr/bin/node', '/startup-guard.mjs',
    ], { encoding: 'utf8', timeout: 10000 });
    assert.notEqual(restarted.status, 0);
    assert.match(restarted.stderr, /interrupted run .*requires operator review/);
    await assert.rejects(readFile(join(project, 'agent-launched')), { code: 'ENOENT' });
    const preserved = new DatabaseSync(bindingFile, { readOnly: true });
    assert.equal(preserved.prepare('SELECT run_id FROM binding').get().run_id, id);
    preserved.close();
    console.log('PASS fixture: sandbox SIGKILL before agent release; existing startup guard refused restart and binding remained');
    return;
  }
  await writeFile(join(permits, `${id}.agent`), id);
  let launched;
  for (let i = 0; i < 100; i++) {
    try { launched = await readFile(join(project, 'agent-launched'), 'utf8'); break; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await new Promise((done) => setTimeout(done, 50));
  }
  assert.match(launched || '', /^\d+$/);
  const branch = `refs/heads/cez/${id.slice(0, 8)}`;
  assert.equal(execFileSync('git', ['log', '-1', '--format=%s', branch], { cwd: project, encoding: 'utf8' }).trim(), 'cezar autosave (turn end)');
  assert.notEqual(execFileSync('git', ['rev-parse', branch], { cwd: project, encoding: 'utf8' }).trim(), base);
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: baseline, encoding: 'utf8' }).trim(), base);
  const heartbeat = join(project, 'detached-heartbeat');
  let initialHeartbeat;
  for (let i = 0; i < 100; i++) {
    try { initialHeartbeat = await readFile(heartbeat, 'utf8'); break; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await new Promise((done) => setTimeout(done, 50));
  }
  assert.ok(initialHeartbeat, 'fixture detached child did not start');
  const cancelled = await fetch(`${url}/api/v1/runs/${id}/cancel`, { method: 'POST' });
  assert.ok(cancelled.ok, `Cezar cancellation returned ${cancelled.status}`);
  await new Promise((done) => setTimeout(done, 250));
  const afterCancellation = await readFile(heartbeat, 'utf8');
  assert.ok(afterCancellation.length > initialHeartbeat.length, 'fixture detached child did not survive Cezar cancellation');
  child.kill('SIGTERM');
  await new Promise((done) => child.once('exit', done));
  assert.ok(child.signalCode || child.exitCode !== null);
  await new Promise((done) => setTimeout(done, 200));
  const afterSandboxExit = await readFile(heartbeat, 'utf8');
  await new Promise((done) => setTimeout(done, 300));
  assert.equal(await readFile(heartbeat, 'utf8'), afterSandboxExit, 'detached fixture child survived sandbox exit');
  console.log('PASS fixture: detached child survived Cezar cancellation but stopped after sandbox exit; binding and scratch autosave verified');
});
