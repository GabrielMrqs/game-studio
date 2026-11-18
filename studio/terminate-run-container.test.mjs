import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { registerFixtureBinding, terminateRunContainer } from './fixtures/terminate-run-container.mjs';

test('fixture container termination requires a submitted run and accepted cancellation', async (t) => {
  const state = await mkdtemp(join(tmpdir(), 'studio-termination-'));
  t.after(() => rm(state, { recursive: true, force: true }));
  const id = '12345678-1234-1234-1234-123456789012';
  const inbox = new DatabaseSync(join(state, 'inbox.sqlite'));
  inbox.exec('CREATE TABLE receipts (run_id TEXT, status TEXT)');
  inbox.prepare('INSERT INTO receipts VALUES (?,?)').run(id, 'submitted');
  inbox.close();
  const watchdog = new DatabaseSync(join(state, 'watchdog.sqlite'));
  watchdog.exec('CREATE TABLE cancellations (run_id TEXT, result TEXT)');
  watchdog.prepare('INSERT INTO cancellations VALUES (?,?)').run(id, 'pending');
  watchdog.close();
  let calls = 0;
  const bindingFile = join(state, 'binding.sqlite');
  const identity = { bindingFile, containerId: 'a'.repeat(64), token: '12345678-1234-1234-1234-123456789013', runId: id };
  registerFixtureBinding(identity);
  const args = { bindingFile, runId: id, state, docker: () => { calls++; throw new Error('unexpected Docker call'); } };
  assert.throws(() => terminateRunContainer(args), /accepted cancellation/);
  assert.throws(() => registerFixtureBinding({ ...identity, containerId: 'short' }), /invalid fixture identity/);
  assert.throws(() => registerFixtureBinding(identity), { code: 'EEXIST' });
  assert.throws(() => terminateRunContainer({ ...args, runId: '12345678-1234-1234-1234-123456789099' }), /missing or invalid fixture binding/);
  assert.equal(calls, 0);
  const update = new DatabaseSync(join(state, 'watchdog.sqlite'));
  update.exec("UPDATE cancellations SET result='accepted'");
  update.close();
  const badLabel = { Id: identity.containerId, Config: { Labels: { 'studio.fixture.run-token': 'wrong', 'studio.fixture.kind': 'per-run-cancellation' } }, HostConfig: { RestartPolicy: { Name: 'no' } }, State: { Status: 'running' } };
  assert.throws(() => terminateRunContainer({ ...args, docker: (_cmd, argv) => { assert.equal(argv[0], 'inspect'); return JSON.stringify([badLabel]); } }), /identity or state mismatch/);
});

test('fixture controller fails closed before binding and on ambiguous or missing container state', async (t) => {
  const state = await mkdtemp(join(tmpdir(), 'studio-termination-recovery-'));
  t.after(() => rm(state, { recursive: true, force: true }));
  const runId = '12345678-1234-1234-1234-123456789012';
  const containerId = 'a'.repeat(64), token = '12345678-1234-1234-1234-123456789013';
  const bindingFile = join(state, 'binding.sqlite');
  let kills = 0;
  const args = { bindingFile, runId, state, docker: (_command, argv) => { if (argv[0] === 'kill') kills++; throw new Error('container unavailable'); } };
  assert.throws(() => terminateRunContainer(args), { code: 'ENOENT' });
  const crash = spawnSync(process.execPath, ['-e', "require('fs').writeFileSync(process.argv[1], '', {flag:'wx',mode:0o600});process.kill(process.pid,'SIGKILL')", bindingFile]);
  assert.equal(crash.signal, 'SIGKILL');
  const before = await readFile(bindingFile);
  assert.throws(() => terminateRunContainer(args), /no such table/);
  assert.deepEqual(await readFile(bindingFile), before);
  assert.throws(() => registerFixtureBinding({ bindingFile, runId, containerId, token }), { code: 'EEXIST' });
  assert.equal(kills, 0);
  const validBinding = join(state, 'valid.sqlite');
  registerFixtureBinding({ bindingFile: validBinding, runId, containerId, token });
  const inbox = new DatabaseSync(join(state, 'inbox.sqlite'));
  inbox.exec('CREATE TABLE receipts (run_id TEXT, status TEXT)');
  inbox.prepare('INSERT INTO receipts VALUES (?,?)').run(runId, 'submitted');
  inbox.close();
  const watchdog = new DatabaseSync(join(state, 'watchdog.sqlite'));
  watchdog.exec('CREATE TABLE cancellations (run_id TEXT, result TEXT)');
  watchdog.prepare('INSERT INTO cancellations VALUES (?,?)').run(runId, 'accepted');
  watchdog.close();
  const inspectArgs = { ...args, bindingFile: validBinding };
  assert.throws(() => terminateRunContainer(inspectArgs), /container unavailable/);
  for (const result of [[], [{}, {}], {}, null]) {
    assert.throws(() => terminateRunContainer({ ...inspectArgs, docker: (_command, argv) => {
      if (argv[0] === 'kill') kills++;
      return JSON.stringify(result);
    } }), /ambiguous fixture container inspection/);
  }
  const existing = { Id: containerId, Config: { Labels: { 'studio.fixture.run-token': token, 'studio.fixture.kind': 'per-run-cancellation' } }, HostConfig: { RestartPolicy: { Name: 'no' } }, State: { Status: 'exited', ExitCode: 137 } };
  assert.throws(() => terminateRunContainer({ ...inspectArgs, docker: () => JSON.stringify([existing]) }), /identity or state mismatch/);
  const db = new DatabaseSync(validBinding, { readOnly: true });
  assert.equal(db.prepare('SELECT phase FROM binding WHERE run_id=?').get(runId).phase, 'bound');
  db.close();
  assert.equal(kills, 0);
  existing.State = { Status: 'running' };
  const script = `import { terminateRunContainer } from ${JSON.stringify(new URL('./fixtures/terminate-run-container.mjs', import.meta.url).href)};const [bindingFile,runId,state,container]=process.argv.slice(1);terminateRunContainer({bindingFile,runId,state,docker:(_c,a)=>{if(a[0]==='kill')process.kill(process.pid,'SIGKILL');return JSON.stringify([JSON.parse(container)])}})`;
  const interrupted = spawnSync(process.execPath, ['--input-type=module', '-e', script, validBinding, runId, state, JSON.stringify(existing)]);
  assert.equal(interrupted.signal, 'SIGKILL');
  const pending = new DatabaseSync(validBinding, { readOnly: true });
  assert.equal(pending.prepare('SELECT phase FROM binding').get().phase, 'terminating');
  pending.close();
  terminateRunContainer({ ...inspectArgs, docker: (_command, argv) => {
    if (argv[0] === 'kill') { kills++; existing.State = { Status: 'exited', ExitCode: 137 }; return ''; }
    return JSON.stringify([existing]);
  } });
  assert.equal(kills, 1);
  const done = new DatabaseSync(validBinding, { readOnly: true });
  assert.equal(done.prepare('SELECT phase FROM binding').get().phase, 'terminated');
  done.close();
});
