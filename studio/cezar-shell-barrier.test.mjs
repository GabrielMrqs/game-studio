import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';

for (const isolated of [false, true]) test(`actual Cezar check ${isolated ? 'uses a separate fixture home' : 'exposes a shared fixture home'}`, { timeout: 30000, skip: process.platform !== 'linux' }, async (t) => {
  const version = spawnSync('bwrap', ['--version']);
  if (version.error?.code === 'ENOENT') return t.skip('bubblewrap is unavailable');
  assert.equal(version.status, 0);
  const root = await mkdtemp(join(tmpdir(), 'studio-shell-barrier-'));
  let child;
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await new Promise((done) => child.once('exit', done));
    }
    await rm(root, { recursive: true, force: true });
  });
  const project = join(root, 'project'), guard = join(root, 'guard'), permits = join(root, 'permits'), home = join(root, 'home');
  await mkdir(join(project, '.ai/cezar/workflows'), { recursive: true });
  await mkdir(guard);
  await mkdir(permits);
  await mkdir(join(home, '.local/share/opencode'), { recursive: true });
  await writeFile(join(home, '.local/share/opencode/opencode.db'), 'synthetic credential fixture', { mode: 0o600 });
  await writeFile(join(project, '.ai/cezar/workflows/barrier.yaml'), `version: 2
name: barrier
nodes:
  - { id: start, type: start }
  - { id: check, type: check, command: 'if test -r /home/agent/.local/share/opencode/opencode.db || test -r /proc/1/root/home/agent/.local/share/opencode/opencode.db || test -r "$HOME/.local/share/opencode/opencode.db"; then printf accessible > credential-exposed; fi; printf executed > marker' }
  - { id: done, type: end, status: success }
  - { id: blocked, type: end, status: failed }
edges:
  - { from: start, to: check }
  - { from: check.pass, to: done }
  - { from: check.fail, to: blocked }
`);
  await writeFile(join(guard, 'bash'), `#!/usr/bin/node
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const id = process.env.CEZ_RUN_ID;
if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id || '')) process.exit(1);
let writable = false;
try { fs.writeFileSync('/permits/probe', 'bad'); writable = true; } catch {}
if (writable) process.exit(1);
fs.writeFileSync('/project/gate-reached', id);
const until = Date.now() + 12000;
function wait() {
  let permit = '';
  try { permit = fs.readFileSync('/permits/' + id, 'utf8'); } catch {}
  if (permit === id) {
    if (!fs.existsSync('/home/agent/.local/share/opencode/opencode.db')) process.exit(1);
    fs.writeFileSync('/project/agent-home-present', 'yes');
    const isolated = ${isolated};
    // This noninteractive check needs no nested devpts or other device mounts.
    const args = isolated ? [
      '--unshare-all', '--unshare-user', '--disable-userns', '--die-with-parent', '--new-session',
      '--ro-bind', '/usr', '/usr', '--ro-bind', '/lib', '/lib', '--ro-bind-try', '/lib64', '/lib64',
      '--symlink', 'usr/bin', '/bin', '--proc', '/proc', '--dev-bind', '/dev/null', '/dev/null', '--tmpfs', '/tmp',
      '--bind', '/project', '/project', '--chdir', process.cwd(),
      '--clearenv', '--setenv', 'HOME', '/tmp', '--setenv', 'PATH', '/usr/bin:/bin',
      '/usr/bin/bash', ...process.argv.slice(2),
    ] : process.argv.slice(2);
    const result = spawnSync(isolated ? '/usr/bin/bwrap' : '/usr/bin/bash', args, {
      encoding: 'utf8', stdio: ['inherit', 'pipe', 'pipe'], env: process.env,
    });
    if (result.status !== 0) fs.writeFileSync('/project/check-error',
      String(result.error || result.signal || result.status) + ': ' + result.stderr);
    process.stdout.write(result.stdout || '');
    process.stderr.write(result.stderr || '');
    process.exit(result.status ?? 1);
  }
  if (Date.now() >= until) process.exit(1);
  setTimeout(wait, 20);
}
wait();
`, { mode: 0o755 });
  for (const args of [['init', '-b', 'main'], ['config', 'user.name', 'Fixture'], ['config', 'user.email', 'fixture@example.invalid'], ['add', '.'], ['commit', '-m', 'fixture']]) {
    execFileSync('git', args, { cwd: project, stdio: 'ignore' });
  }
  const socket = createServer();
  await new Promise((done) => socket.listen(0, '127.0.0.1', done));
  const port = socket.address().port;
  await new Promise((done) => socket.close(done));
  child = spawn('bwrap', [
    '--unshare-all', '--share-net', '--die-with-parent', '--new-session',
    '--ro-bind', '/usr', '/usr', '--ro-bind', '/lib', '/lib', '--ro-bind-try', '/lib64', '/lib64',
    '--symlink', 'usr/bin', '/bin', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
    '--bind', project, '/project', '--bind', home, '/home/agent', '--ro-bind', guard, '/guard', '--ro-bind', permits, '/permits',
    '--ro-bind', resolve('node_modules'), '/tools/node_modules', '--chdir', '/project',
    '--clearenv', '--setenv', 'HOME', '/home/agent', '--setenv', 'PATH', '/guard:/usr/bin:/bin',
    '--setenv', 'CEZ_HOME', '/tmp/cezar', '--setenv', 'CEZ_DRY_RUN', '1',
    '--setenv', 'CEZ_AUTONAME', '0', '--setenv', 'CEZ_TELEMETRY', '0', '--setenv', 'CEZ_RELAY', '0',
    '/usr/bin/node', '/tools/node_modules/@open-mercato/cezar/dist/index.js', '--no-open', '--port', String(port),
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  const url = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`fixture Cezar exited before readiness: ${stderr}`);
    try { ready = (await fetch(`${url}/api/v1/health`)).ok; } catch {}
    if (!ready) await new Promise((done) => setTimeout(done, 100));
  }
  assert.ok(ready, stderr || 'fixture Cezar did not become ready');
  const response = await fetch(`${url}/api/v1/runs`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workflow: 'barrier', task: 'fixture', runner: 'opencode', worktree: true, autonomous: false }),
  });
  assert.equal(response.status, 201);
  const { id } = await response.json();
  const marker = join(project, '.ai/cezar/worktrees', id, 'marker');
  let reached;
  for (let i = 0; i < 100; i++) {
    try { reached = await readFile(join(project, 'gate-reached'), 'utf8'); break; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await new Promise((done) => setTimeout(done, 50));
  }
  assert.equal(reached, id, 'Cezar did not reach the fixture gate');
  await new Promise((done) => setTimeout(done, 200));
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
  await writeFile(join(permits, id), 'wrong-run');
  await new Promise((done) => setTimeout(done, 300));
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
  await writeFile(join(permits, id), id);
  let output;
  for (let i = 0; i < 100; i++) {
    const failure = await readFile(join(project, 'check-error'), 'utf8').catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
    assert.equal(failure, undefined, failure);
    try { output = await readFile(marker, 'utf8'); break; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await new Promise((done) => setTimeout(done, 50));
  }
  assert.equal(output, 'executed', `Cezar did not write the execution marker after the matching permit: ${stderr}`);
  assert.equal(await readFile(join(project, 'agent-home-present'), 'utf8'), 'yes');
  const exposed = join(project, '.ai/cezar/worktrees', id, 'credential-exposed');
  if (isolated) {
    await assert.rejects(readFile(exposed), { code: 'ENOENT' });
    console.log('PASS fixture: actual Cezar check could not read the separately mounted synthetic agent home');
  } else {
    assert.equal(await readFile(exposed, 'utf8'), 'accessible');
    console.log('PASS negative control: actual Cezar check could read the synthetic OpenCode-home credential file');
  }
});
