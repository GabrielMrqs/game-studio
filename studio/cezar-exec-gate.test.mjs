import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import { closeSync, fsyncSync, openSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { checkStartup } from './startup-guard.mjs';

function startupGuard(project) {
  return spawnSync('bwrap', [
    '--unshare-all', '--die-with-parent', '--new-session',
    '--ro-bind', '/usr', '/usr', '--ro-bind', '/lib', '/lib', '--ro-bind-try', '/lib64', '/lib64',
    '--symlink', 'usr/bin', '/bin', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
    '--bind', project, '/project', '--ro-bind', resolve('studio/startup-guard.mjs'), '/startup-guard.mjs',
    '--chdir', '/project', '--clearenv', '--setenv', 'HOME', '/tmp', '--setenv', 'PATH', '/usr/bin:/bin',
    '/usr/bin/node', '/startup-guard.mjs',
  ], { encoding: 'utf8', timeout: 10000 });
}

for (const mode of ['H', 'G', 'S', 'D', 'X', 'M', 'MX', 'MR']) test(`Cezar kernel exec fixture ${mode === 'H' ? 'holds all execs' : mode === 'G' ? 'allows fixture Git bootstrap' : mode === 'S' ? 'holds execs before task body' : mode === 'D' ? 'holds execs before deferred launch' : mode === 'X' ? 'interrupts deferred launch before release' : mode === 'M' ? 'starts a disabled deferred task manually' : mode === 'MX' ? 'interrupts a disabled task after manual launch' : 'blocks restart after a released agent side effect'}`, { timeout: 30000, skip: process.platform !== 'linux' || process.arch !== 'x64' }, async (t) => {
  if (spawnSync('gcc', ['--version']).error?.code === 'ENOENT' || spawnSync('bwrap', ['--version']).error?.code === 'ENOENT') return t.skip('gcc or bubblewrap unavailable');
  const root = await mkdtemp(join(tmpdir(), 'studio-cezar-exec-gate-'));
  let child;
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await new Promise((done) => child.once('exit', done));
    }
    await rm(root, { recursive: true, force: true });
  });
  const project = join(root, 'project'), baseline = join(root, 'baseline'), guard = join(root, 'guard'), binary = join(root, 'exec-gate');
  const contextFile = join(root, 'binding-context.json');
  const manual = ['M', 'MX', 'MR'].includes(mode);
  const deferredMode = ['D', 'X', 'M', 'MX', 'MR'].includes(mode);
  await mkdir(join(project, '.ai/cezar/workflows'), { recursive: true });
  await mkdir(guard);
  execFileSync('gcc', ['-O2', '-Wall', '-Wextra', '-Werror', resolve('studio/fixtures/exec-gate.c'), '-o', binary], { stdio: 'pipe' });
  const check = deferredMode
    ? `test ! -e /proc/self/fd/3 && if touch /protected/probe 2>/dev/null; then exit 1; fi && printf executed > check-marker && printf fixture > autosave-fixture && /usr/bin/node --input-type=module -e "import {autosaveCommit} from '/tools/node_modules/@open-mercato/cezar/dist/git-worktree.js'; if (await autosaveCommit(process.cwd(), 'turn end') !== 'committed') process.exit(1)"`
    : 'test ! -e /proc/self/fd/3 && printf executed > check-marker';
  await writeFile(join(project, '.ai/cezar/workflows/gate.yaml'), `version: 2
name: gate
nodes:
  - { id: start, type: start }
  - { id: check, type: check, command: ${JSON.stringify(check)} }
  - { id: agent, type: agent, runner: claude, prompt: fixture }
  - { id: done, type: end, status: success }
edges:
  - { from: start, to: check }
  - { from: check.pass, to: agent }
  - { from: agent.done, to: done }
`);
  await writeFile(join(guard, 'claude'), `#!/usr/bin/node
require('node:fs').${mode === 'MR' ? 'appendFileSync' : 'writeFileSync'}('/project/agent-marker', (process.env.CEZ_TASK_ID || 'missing')${mode === 'MR' ? " + '\\n'" : ''});
${mode === 'MR' ? 'setInterval(() => {}, 1000);' : ''}
`, { mode: 0o755 });
  for (const args of [['init', '-b', 'main'], ['config', 'user.name', 'Fixture'], ['config', 'user.email', 'fixture@example.invalid'], ['add', '.'], ['commit', '-m', 'fixture']]) {
    execFileSync('git', args, { cwd: project, stdio: 'ignore' });
  }
  const baselineSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: project, encoding: 'utf8' }).trim();
  execFileSync('git', ['clone', '--no-hardlinks', project, baseline], { stdio: 'ignore' });
  execFileSync('git', ['remote', 'remove', 'origin'], { cwd: baseline, stdio: 'ignore' });
  if (manual) {
    const setup = `
      import assert from 'node:assert/strict';
      import { randomUUID } from 'node:crypto';
      import { AutomationStore } from '/tools/node_modules/@open-mercato/cezar/dist/automations/store.js';
      import { resolveDeferredExecution, digest } from '/tools/node_modules/@open-mercato/cezar/dist/automations/deferred-start.js';
      import { ScheduleRunner } from '/tools/node_modules/@open-mercato/cezar/dist/automations/schedule-runner.js';
      const task = { workflow: 'gate', task: 'fixture', runner: 'opencode', worktree: true, autonomous: false, variants: 1 };
      const { binding } = await resolveDeferredExecution('/project', task);
      const { task: prompt, ...fields } = task;
      const store = AutomationStore.open('/project/.ai/cezar');
      const definition = store.create({
        name: 'fixture', kind: 'schedule', enabled: false,
        schedule: { type: 'once', date: '2000-01-01', hour: 0, minute: 0 },
        task: { ...fields, prompt },
        deferredStart: { origin: 'composer', reason: 'at', notBefore: '2000-01-01T00:00:00.000Z', timeZone: 'UTC',
          binding, creationKey: randomUUID(), requestDigest: digest(task), status: 'pending', runIds: [] },
      });
      assert.equal(new ScheduleRunner({ store }).dueAt(definition), null);
      console.log('PASS disabled, already-due deferred fixture has no automatic due time');
    `;
    const prepared = spawnSync('bwrap', [
      '--unshare-all', '--die-with-parent', '--ro-bind', '/usr', '/usr', '--ro-bind', '/lib', '/lib', '--ro-bind-try', '/lib64', '/lib64',
      '--symlink', 'usr/bin', '/bin', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--dir', '/tmp/.claude',
      '--bind', project, '/project', '--ro-bind', resolve('node_modules'), '/tools/node_modules', '--chdir', '/project',
      '--clearenv', '--setenv', 'HOME', '/tmp', '--setenv', 'PATH', '/usr/bin:/bin',
      '--setenv', 'CEZ_HOME', '/tmp/cezar', '--setenv', 'CEZ_DRY_RUN', '1', '--setenv', 'CEZ_AUTONAME', '0',
      '/usr/bin/node', '--input-type=module', '-e', setup,
    ], { encoding: 'utf8', timeout: 10000 });
    assert.equal(prepared.status, 0, prepared.stderr);
    assert.match(prepared.stdout, /disabled, already-due deferred fixture has no automatic due time/);
    await checkStartup(project);
  }
  const socket = createServer();
  await new Promise((done) => socket.listen(0, '127.0.0.1', done));
  const port = socket.address().port;
  await new Promise((done) => socket.close(done));
  child = spawn(binary, [
    ...(deferredMode ? ['--verify', resolve('studio/fixtures/verify-exec-binding.mjs'), contextFile, '--'] : []),
    'bwrap', '--unshare-all', '--share-net', '--die-with-parent', '--new-session', '--info-fd', '4',
    '--ro-bind', '/usr', '/usr', '--ro-bind', '/lib', '/lib', '--ro-bind-try', '/lib64', '/lib64',
    '--symlink', 'usr/bin', '/bin', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--dir', '/tmp/.claude',
    '--bind', project, '/project', '--ro-bind', baseline, '/protected', '--ro-bind', guard, '/guard',
    '--ro-bind', resolve('node_modules'), '/tools/node_modules', '--chdir', '/project',
    '--clearenv', '--setenv', 'HOME', '/tmp', '--setenv', 'PATH', '/usr/bin:/bin',
    '--setenv', 'CEZ_HOME', '/tmp/cezar', '--setenv', 'CEZ_DRY_RUN', '1', '--setenv', 'CEZ_AUTONAME', '0',
    '--setenv', 'CEZ_CLAUDE_BIN', '/guard/claude', '--setenv', 'CEZ_TELEMETRY', '0', '--setenv', 'CEZ_RELAY', '0',
    '/usr/bin/node', '/tools/node_modules/@open-mercato/cezar/dist/index.js', '--no-open', '--port', String(port),
  ], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
  let diagnostics = '';
  child.stderr.on('data', (chunk) => { diagnostics += chunk.toString(); });
  let info = '';
  child.stdio[4].on('data', (chunk) => { info += chunk.toString(); });
  const url = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('fixture supervisor exited before readiness');
    try { ready = (await fetch(`${url}/api/v1/health`)).ok; } catch {}
    if (!ready) await new Promise((done) => setTimeout(done, 100));
  }
  assert.ok(ready);
  const providers = await fetch(`${url}/api/v1/providers/status`, { signal: AbortSignal.timeout(5000) });
  assert.ok(providers.ok, `provider preflight returned ${providers.status}`);
  const payload = JSON.stringify({ workflow: 'gate', task: 'fixture', runner: 'opencode', worktree: true, autonomous: false });
  let deferred;
  if (mode === 'D' || mode === 'X') {
    const request = { task: JSON.parse(payload), start: { kind: 'at', date: '2099-01-01', hour: 0, minute: 0 } };
    const previewResponse = await fetch(`${url}/api/v1/deferred-start/preview`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request),
    });
    assert.equal(previewResponse.status, 200);
    const preview = await previewResponse.json();
    assert.ok(preview.available, JSON.stringify(preview));
    const createResponse = await fetch(`${url}/api/v1/deferred-start`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...request, previewRevision: preview.previewRevision, idempotencyKey: randomUUID() }),
    });
    assert.equal(createResponse.status, 201, await createResponse.text().catch(() => ''));
    const definitions = JSON.parse(await readFile(join(project, '.ai/cezar/automations.json'), 'utf8'));
    deferred = definitions.automations.find((item) => item.deferredStart?.status === 'pending');
    assert.ok(deferred);
    assert.deepEqual(deferred.deferredStart.runIds, []);
    assert.equal(deferred.enabled, true);
    const pause = await fetch(`${url}/api/v1/automations/${deferred.id}/pause`, { method: 'POST' });
    assert.equal(pause.status, 409);
    assert.match((await pause.json()).error, /scheduled task actions/);
    const afterPause = JSON.parse(await readFile(join(project, '.ai/cezar/automations.json'), 'utf8')).automations.find((item) => item.id === deferred.id);
    assert.equal(afterPause.enabled, true);
    console.log('PASS negative control: Cezar created an enabled deferred task and its pause endpoint refused it');
  }
  if (manual) {
    const definitions = JSON.parse(await readFile(join(project, '.ai/cezar/automations.json'), 'utf8'));
    deferred = definitions.automations.find((item) => item.deferredStart?.status === 'pending');
    assert.ok(deferred);
    assert.equal(deferred.enabled, false);
    assert.deepEqual(deferred.deferredStart.runIds, []);
    await new Promise((done) => setTimeout(done, 300));
    assert.deepEqual(await (await fetch(`${url}/api/v1/runs`)).json(), []);
    await assert.rejects(readFile(join(project, 'agent-marker')), { code: 'ENOENT' });
  }
  if (deferredMode) {
    await writeFile(contextFile, JSON.stringify({
      automationId: deferred.id,
      bindingFile: join(root, 'binding.sqlite'),
      definitionFile: join(project, '.ai/cezar/automations.json'),
    }), { mode: 0o600, flag: 'wx' });
  }
  let streamed, streamedResponse;
  if (mode === 'S') {
    streamed = httpRequest(`${url}/api/v1/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(3000) });
    streamedResponse = new Promise((resolveResponse, reject) => {
      streamed.on('response', (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolveResponse({ status: res.statusCode, json: async () => JSON.parse(body) }));
      });
      streamed.on('error', reject);
    });
    streamed.write(payload.slice(0, 1));
    await new Promise((done) => setTimeout(done, 300));
  }
  const held = once(child.stdio[3], 'data');
  child.stdio[3].write(mode === 'S' || deferredMode ? 'H' : mode);
  assert.equal((await held)[0].toString(), mode === 'S' || deferredMode ? 'H' : mode);
  if (deferredMode) {
    for (const command of ['G', 'B', 'R']) {
      const rejected = once(child.stdio[3], 'data');
      child.stdio[3].write(command);
      assert.equal((await rejected)[0].toString(), 'E', `${command} must not release without verification`);
    }
  }
  if (mode === 'S') streamed.end(payload.slice(1));
  const submit = () => fetch(`${url}/api/v1/runs`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: payload,
    signal: AbortSignal.timeout(mode === 'H' ? 2000 : 8000),
  });
  if (mode === 'H') {
    await assert.rejects(submit(), { name: 'TimeoutError' });
    let runs = [];
    try { runs = JSON.parse(await readFile(join(project, '.ai/cezar/runs.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    assert.deepEqual(runs, []);
    await assert.rejects(readFile(join(project, 'agent-marker')), { code: 'ENOENT' });
    assert.match(diagnostics, /held exec: \/usr\/bin\/git/);
    console.log('PASS negative control: held /usr/bin/git; Cezar POST timed out without a persisted run');
    return;
  }
  if (mode === 'S') {
    await assert.rejects(streamedResponse, { name: 'AbortError' });
    let runs = [];
    try { runs = JSON.parse(await readFile(join(project, '.ai/cezar/runs.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    assert.deepEqual(runs, []);
    assert.match(diagnostics, /held exec: \/usr\/bin\/git/);
    await assert.rejects(readFile(join(project, 'agent-marker')), { code: 'ENOENT' });
    console.log('PASS negative control: streaming body before hold still requires Git after hold, without a persisted run');
    return;
  }
  if (deferredMode) {
    const launch = fetch(`${url}/api/v1/automations/${deferred.id}/run?expectedRevision=${deferred.revision}`, {
      method: 'POST', signal: AbortSignal.timeout(10000),
    });
    void launch.catch(() => {});
    const definitionFile = join(project, '.ai/cezar/automations.json');
    let saved;
    for (let i = 0; i < 100; i++) {
      const definitions = JSON.parse(await readFile(definitionFile, 'utf8'));
      saved = definitions.automations.find((item) => item.id === deferred.id);
      if (saved?.deferredStart.runIds.length) break;
      await new Promise((done) => setTimeout(done, 50));
    }
    assert.equal(saved.deferredStart.status, 'launching');
    assert.equal(saved.deferredStart.runIds.length, 1);
    if (manual) assert.equal(saved.enabled, true, 'Cezar changes the manually triggered fixture to enabled');
    const id = saved.deferredStart.runIds[0];
    for (let i = 0; i < 100 && !diagnostics.includes('held exec: /usr/bin/git'); i++) {
      await new Promise((done) => setTimeout(done, 50));
    }
    assert.match(diagnostics, /held exec: \/usr\/bin\/git/);
    const marker = join(project, '.ai/cezar/worktrees', id, 'check-marker');
    await assert.rejects(readFile(marker), { code: 'ENOENT' });
    await assert.rejects(readFile(join(project, 'agent-marker')), { code: 'ENOENT' });
    const sandbox = JSON.parse(info);
    const pid = sandbox['child-pid'];
    if (process.env.STUDIO_TEST_HOST_NETNS) {
      const network = await readlink('/proc/self/ns/net');
      assert.notEqual(network, process.env.STUDIO_TEST_HOST_NETNS);
      assert.equal(await readlink(`/proc/${pid}/ns/net`), network);
    }
    const namespace = await readlink(`/proc/${pid}/ns/pid`);
    assert.equal(namespace, `pid:[${sandbox['pid-namespace']}]`);
    const startTime = (await readFile(`/proc/${pid}/stat`, 'utf8')).split(') ')[1].split(' ')[19];
    const definitionFd = openSync(definitionFile, 'r');
    try { fsyncSync(definitionFd); } finally { closeSync(definitionFd); }
    const definitionsDir = openSync(join(project, '.ai/cezar'), 'r');
    try { fsyncSync(definitionsDir); } finally { closeSync(definitionsDir); }
    const bindingPath = join(root, 'binding.sqlite');
    closeSync(openSync(bindingPath, 'wx', 0o600));
    const binding = new DatabaseSync(bindingPath);
    binding.exec('PRAGMA synchronous=FULL; CREATE TABLE binding (run_id TEXT PRIMARY KEY, pid INTEGER NOT NULL, start_time TEXT NOT NULL, namespace TEXT NOT NULL)');
    binding.prepare('INSERT INTO binding VALUES (?,?,?,?)').run(randomUUID(), pid, startTime, namespace);
    binding.close();
    let rejected = once(child.stdio[3], 'data');
    child.stdio[3].write('R');
    assert.equal((await rejected)[0].toString(), 'E', 'wrong run ID must not release the gate');
    await assert.rejects(readFile(marker), { code: 'ENOENT' });
    const corrected = new DatabaseSync(bindingPath);
    corrected.exec('PRAGMA synchronous=FULL');
    corrected.prepare('UPDATE binding SET run_id=?, namespace=?').run(id, 'pid:[0]');
    corrected.close();
    rejected = once(child.stdio[3], 'data');
    child.stdio[3].write('R');
    assert.equal((await rejected)[0].toString(), 'E', 'wrong namespace must not release the gate');
    await assert.rejects(readFile(marker), { code: 'ENOENT' });
    const fixedNamespace = new DatabaseSync(bindingPath);
    fixedNamespace.exec('PRAGMA synchronous=FULL');
    fixedNamespace.prepare('UPDATE binding SET namespace=? WHERE run_id=?').run(namespace, id);
    fixedNamespace.close();
    const directory = openSync(root, 'r');
    try { fsyncSync(directory); } finally { closeSync(directory); }
    const verify = new DatabaseSync(join(root, 'binding.sqlite'), { readOnly: true });
    assert.equal(verify.prepare('SELECT run_id FROM binding WHERE pid=? AND start_time=? AND namespace=?').get(pid, startTime, namespace).run_id, id);
    verify.close();
    const reread = JSON.parse(await readFile(definitionFile, 'utf8')).automations.find((item) => item.id === deferred.id);
    assert.deepEqual(reread.deferredStart.runIds, [id]);
    assert.equal(await readlink(`/proc/${pid}/ns/pid`), namespace);
    assert.equal((await readFile(`/proc/${pid}/stat`, 'utf8')).split(') ')[1].split(' ')[19], startTime);
    if (mode === 'X' || mode === 'MX') {
      child.kill('SIGKILL');
      await new Promise((done) => child.once('exit', done));
      const after = JSON.parse(await readFile(definitionFile, 'utf8')).automations.find((item) => item.id === deferred.id);
      assert.equal(after.deferredStart.status, 'launching');
      assert.deepEqual(after.deferredStart.runIds, [id]);
      await assert.rejects(readFile(marker), { code: 'ENOENT' });
      await assert.rejects(readFile(join(project, 'agent-marker')), { code: 'ENOENT' });
      const guardResult = startupGuard(project);
      assert.notEqual(guardResult.status, 0);
      assert.match(guardResult.stderr, /deferred launch requires operator review/);
      const preserved = new DatabaseSync(join(root, 'binding.sqlite'), { readOnly: true });
      assert.equal(preserved.prepare('SELECT run_id FROM binding').get().run_id, id);
      preserved.close();
      console.log('PASS fixture: startup guard refused interrupted deferred launch; reserved ID and binding survived');
      return;
    }
    const released = once(child.stdio[3], 'data');
    child.stdio[3].write('R');
    assert.equal((await released)[0].toString(), 'R');
    const response = await launch;
    assert.equal(response.status, 202);
    assert.equal((await response.json()).runId, id);
    let checked, agent;
    for (let i = 0; i < 150; i++) {
      try { checked = await readFile(marker, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      try { agent = await readFile(join(project, 'agent-marker'), 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (checked && agent) break;
      await new Promise((done) => setTimeout(done, 50));
    }
    assert.equal(checked, 'executed');
    assert.equal(agent, mode === 'MR' ? `${id}\n` : id);
    const branch = `refs/heads/cez/${id.slice(0, 8)}`;
    const log = execFileSync('git', ['log', '--format=%s', `${baselineSha}..${branch}`], { cwd: project, encoding: 'utf8' });
    assert.match(log, /cezar autosave \(turn end\)/);
    assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: baseline, encoding: 'utf8' }).trim(), baselineSha);
    await assert.rejects(readFile(join(baseline, 'probe')), { code: 'ENOENT' });
    if (mode === 'MR') {
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
      const guardResult = startupGuard(project);
      assert.notEqual(guardResult.status, 0);
      assert.match(guardResult.stderr, /Cezar startup blocked/);
      assert.equal(await readFile(join(project, 'agent-marker'), 'utf8'), `${id}\n`);
      const preserved = new DatabaseSync(join(root, 'binding.sqlite'), { readOnly: true });
      assert.equal(preserved.prepare('SELECT run_id FROM binding').get().run_id, id);
      preserved.close();
      console.log('PASS fixture: startup guard refused restart after released simulated agent side effect; one marker and binding preserved');
      return;
    }
    console.log(`PASS fixture: ${mode === 'M' ? 'disabled deferred task manually triggered, then Cezar enabled it; ' : ''}real deferred-start reserved ID under universal exec hold; SQLite namespace binding preceded check and simulated agent; explicit autosave stayed in scratch`);
    return;
  }
  let response;
  try { response = await submit(); } catch (error) { throw new Error(`fixture bootstrap failed: ${diagnostics}`, { cause: error }); }
  assert.equal(response.status, 201);
  const { id } = await response.json();
  const marker = join(project, '.ai/cezar/worktrees', id, 'check-marker');
  for (let i = 0; i < 100 && !diagnostics.includes('held exec: /usr/bin/bash'); i++) {
    await new Promise((done) => setTimeout(done, 50));
  }
  assert.match(diagnostics, /held exec: \/usr\/bin\/bash/);
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
  await assert.rejects(readFile(join(project, 'agent-marker')), { code: 'ENOENT' });
  const sandbox = JSON.parse(info);
  const pid = sandbox['child-pid'];
  const namespace = await readlink(`/proc/${pid}/ns/pid`);
  assert.equal(namespace, `pid:[${sandbox['pid-namespace']}]`);
  const startTime = (await readFile(`/proc/${pid}/stat`, 'utf8')).split(') ')[1].split(' ')[19];
  const binding = new DatabaseSync(join(root, 'binding.sqlite'));
  binding.exec('PRAGMA synchronous=FULL; CREATE TABLE binding (run_id TEXT PRIMARY KEY, pid INTEGER NOT NULL, start_time TEXT NOT NULL, namespace TEXT NOT NULL)');
  binding.prepare('INSERT INTO binding VALUES (?,?,?,?)').run(id, pid, startTime, namespace);
  binding.close();
  const directory = openSync(root, 'r');
  try { fsyncSync(directory); } finally { closeSync(directory); }
  const verify = new DatabaseSync(join(root, 'binding.sqlite'), { readOnly: true });
  assert.equal(verify.prepare('SELECT run_id FROM binding WHERE pid=? AND start_time=? AND namespace=?').get(pid, startTime, namespace).run_id, id);
  verify.close();
  assert.equal(await readlink(`/proc/${pid}/ns/pid`), namespace);
  assert.equal((await readFile(`/proc/${pid}/stat`, 'utf8')).split(') ')[1].split(' ')[19], startTime);
  const checkReleased = once(child.stdio[3], 'data');
  child.stdio[3].write('B');
  assert.equal((await checkReleased)[0].toString(), 'B');
  let checked;
  for (let i = 0; i < 150; i++) {
    try { checked = await readFile(marker, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (checked && diagnostics.includes('held exec: /guard/claude')) break;
    await new Promise((done) => setTimeout(done, 50));
  }
  assert.equal(checked, 'executed');
  assert.match(diagnostics, /held exec: \/guard\/claude/);
  await assert.rejects(readFile(join(project, 'agent-marker')), { code: 'ENOENT' });
  const released = once(child.stdio[3], 'data');
  child.stdio[3].write('R');
  assert.equal((await released)[0].toString(), 'R');
  let agent;
  for (let i = 0; i < 100; i++) {
    try { agent = await readFile(join(project, 'agent-marker'), 'utf8'); break; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await new Promise((done) => setTimeout(done, 50));
  }
  assert.equal(agent, id);
  console.log('PASS fixture: Git bootstrap allowed; check and alternate simulated runner waited until SQLite namespace binding');
});
