import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, cp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { scan } from './inbox.mjs';
import { DatabaseSync } from 'node:sqlite';
import { publishRun } from './publish-run.mjs';

test('bundled mock does not implement the normal-mode auth probe', { timeout: 5000 }, async () => {
  const mock = resolve('node_modules/@open-mercato/cezar/scripts/mock-opencode-serve.mjs');
  const child = spawn(process.execPath, [mock, 'auth', 'list'], { env: { PATH: process.env.PATH }, stdio: 'ignore' });
  try {
    await new Promise((done) => setTimeout(done, 300));
    assert.equal(child.exitCode, null, 'mock should still be running instead of answering auth list');
    assert.equal(child.signalCode, null);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      await exited;
    }
  }
});

for (const actual of [false, true]) test(`Cezar startup sweeps a registered orphan (${actual ? 'Cezar' : 'stand-in'} owner) without touching an unrelated mock server`, { timeout: 40000, skip: process.platform !== 'linux' }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'studio-orphan-'));
  const mock = join(root, 'mock-opencode.mjs');
  const home = join(root, 'cezar-home'), registry = join(home, 'opencode-servers');
  let child, owner, unrelated, orphan;
  const owners = new Set();
  async function proc(pid) {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      return { state: fields[0], start: fields[19], cmd: (await readFile(`/proc/${pid}/cmdline`, 'utf8')).replaceAll('\0', ' ') };
    } catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') return null; throw error; }
  }
  async function records() {
    try {
      const files = (await readdir(registry)).filter((file) => /^\d+\.json$/.test(file));
      return await Promise.all(files.map(async (file) => JSON.parse(await readFile(join(registry, file), 'utf8'))));
    } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }
  async function stop(processHandle, signal = 'SIGTERM') {
    if (processHandle && processHandle.exitCode === null && processHandle.signalCode === null) {
      const exited = once(processHandle, 'exit');
      processHandle.kill(signal);
      await exited;
    }
  }
  t.after(async () => {
    await stop(child);
    await stop(owner);
    await stop(unrelated);
    for (const record of [orphan, ...await records()].filter(Boolean)) {
      if (!owners.has(record.ownerPid)) continue;
      const current = await proc(record.pid);
      if (current?.start === record.start && current.cmd.includes(mock) && current.cmd.includes(`--port ${record.port}`)) {
        try { process.kill(-record.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
    }
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  });
  const source = await readFile(resolve('node_modules/@open-mercato/cezar/scripts/mock-opencode-serve.mjs'), 'utf8');
  assert.ok(source.includes('}), 20);'));
  await writeFile(mock, source.replace('}), 20);', '}), 30000);'), { mode: 0o755 });
  await mkdir(join(root, '.ai/cezar/workflows'), { recursive: true });
  await cp(resolve('.ai/cezar/workflows/studio-plan.yaml'), join(root, '.ai/cezar/workflows/studio-plan.yaml'));
  await mkdir(join(root, 'ideas'));
  await writeFile(join(root, 'ideas/idea.md'), 'Plan a harmless mock fixture');
  for (const args of [['init', '-b', 'main'], ['config', 'user.name', 'Test'], ['config', 'user.email', 'test@example.invalid'], ['add', '.'], ['commit', '-m', 'fixture']]) execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  const socket = createServer();
  await new Promise((done) => socket.listen(0, '127.0.0.1', done));
  const port = socket.address().port;
  await new Promise((done) => socket.close(done));
  const url = `http://127.0.0.1:${port}`;
  const env = { PATH: process.env.PATH, HOME: root, CEZ_HOME: home, CEZ_DRY_RUN: '0', CEZ_OPENCODE_BIN: mock, CEZ_AGENT_MODELS_LOCKED: '1', CEZ_TELEMETRY: '0', CEZ_RELAY: '0', CEZ_MANAGERS: '0', CEZ_AUTOMATIONS: '0', CEZ_DISPATCH: '0', CEZ_TERMINAL: '0' };
  async function start() {
    child = spawn(process.execPath, [resolve('node_modules/@open-mercato/cezar/dist/index.js'), '--no-open', '--port', String(port)], { cwd: root, env, stdio: 'ignore' });
    owners.add(child.pid);
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error('fixture Cezar exited before becoming healthy');
      try { if ((await fetch(`${url}/api/v1/health`)).ok) return; } catch {}
      await new Promise((done) => setTimeout(done, 100));
    }
    throw new Error('fixture Cezar did not start');
  }
  unrelated = spawn(process.execPath, [mock, 'serve', '--hostname', '127.0.0.1', '--port', '0'], { cwd: root, env: { PATH: process.env.PATH, HOME: root }, stdio: 'ignore' });
  let runId;
  if (actual) {
    await start();
    owner = child;
    await scan({ inbox: join(root, 'ideas'), state: join(root, 'state'), repoRoot: root, url });
    const db = new DatabaseSync(join(root, 'state/inbox.sqlite'), { readOnly: true });
    const receipt = db.prepare('SELECT status,run_id FROM receipts').get();
    db.close();
    assert.equal(receipt.status, 'submitted');
    assert.ok(receipt.run_id);
    runId = receipt.run_id;
  } else {
    const registryModule = new URL(`file://${resolve('node_modules/@open-mercato/cezar/dist/core/opencode-server-registry.js')}`).href;
    const script = `import { spawn } from 'node:child_process'; import { trackServer } from ${JSON.stringify(registryModule)}; const child = spawn(process.execPath, [${JSON.stringify(mock)}, 'serve', '--hostname', '127.0.0.1', '--port', '0'], { detached: true, stdio: 'ignore' }); trackServer(child, 0); setInterval(() => {}, 1000);`;
    owner = spawn(process.execPath, ['--input-type=module', '-e', script], { cwd: root, env, stdio: 'ignore' });
    owners.add(owner.pid);
  }
  for (let i = 0; i < 100; i++) {
    orphan = (await records()).find((record) => record.ownerPid === owner.pid);
    if (orphan) break;
    await new Promise((done) => setTimeout(done, 100));
  }
  assert.ok(orphan, 'fixture OpenCode server was not recorded');
  const before = await proc(orphan.pid);
  assert.equal(before?.start, orphan.start);
  assert.ok(before.cmd.includes(mock));
  assert.ok(before.cmd.includes(`--port ${orphan.port}`));
  assert.equal(unrelated.exitCode, null);
  assert.equal((await proc(owner.pid))?.start, orphan.ownerStart);
  await stop(owner, 'SIGKILL');
  const afterKill = await proc(orphan.pid);
  assert.equal(afterKill?.start, orphan.start, 'detached mock server should survive the abrupt parent stop');
  assert.notEqual(afterKill.state, 'Z');
  await start();
  for (let i = 0; i < 100; i++) {
    const current = await proc(orphan.pid);
    if (!current || current.start !== orphan.start || current.state === 'Z') break;
    await new Promise((done) => setTimeout(done, 100));
  }
  const swept = await proc(orphan.pid);
  assert.ok(!swept || swept.start !== orphan.start || swept.state === 'Z', 'orphaned fixture server survived restart');
  assert.equal(unrelated.exitCode, null);
  if (actual) {
    await scan({ inbox: join(root, 'ideas'), state: join(root, 'state'), repoRoot: root, url });
    const runs = await (await fetch(`${url}/api/v1/runs`)).json();
    assert.equal(runs.length, 1);
    assert.equal(runs[0].id, runId);
    let published = false;
    await assert.rejects(publishRun({ id: runId, url, state: join(root, 'state'), repoRoot: root, publisher: () => { published = true; } }), /no unique Linear/);
    assert.equal(published, false);
  }
  console.log('PASS Cezar startup swept the registered orphan and left an unregistered mock server alive');
});
