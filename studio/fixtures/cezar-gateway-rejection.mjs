import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { scan } from '/project/studio/inbox.mjs';
import { checkRuns } from '/project/studio/watchdog.mjs';
import { checkStartup } from '/fixture/startup-guard.mjs';

const root = '/workspace/repo', url = 'http://127.0.0.1:14321';
const config = { model: 'local/fixture', providers: { local: { name: 'Fixture gateway', package: '@opencode/ai/providers/openai-compatible/responses', settings: { baseURL: 'http://127.0.0.1:18080/v1', apiKey: 'fixture-placeholder' }, body: { max_output_tokens: 64 }, models: { fixture: { modelID: 'fixture-model', capabilities: { tools: true, input: ['text'], output: ['text'] }, limit: { context: 200000, output: 64 } } } } } };
const env = { ...process.env, HOME: '/workspace', CEZ_HOME: '/workspace/cezar-home', CEZ_DRY_RUN: '0', CEZ_AGENT_MODELS_LOCKED: '1', CEZ_OPENCODE_BIN: '/workspace/opencode-fixture-wrapper', CEZ_ENV_PASSTHROUGH: 'OPENCODE_CONFIG_CONTENT', CEZ_TELEMETRY: '0', CEZ_RELAY: '0', CEZ_TERMINAL: '0', CEZ_DISPATCH: '0', CEZ_MANAGERS: '0', CEZ_AUTOMATIONS: '0', OPENCODE_CONFIG_CONTENT: JSON.stringify(config) };
const git = (...args) => {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};
const baseline = git('rev-parse', 'HEAD');
await checkStartup(root);
await writeFile('/workspace/escaped-fixture.cjs', "const fs=require('fs');fs.writeFileSync('/workspace/escaped-pid',String(process.pid));setInterval(()=>fs.appendFileSync('/workspace/escaped-heartbeat','tick\\n'),100);\n", { flag: 'wx' });
await writeFile('/workspace/opencode-fixture-wrapper', '#!/bin/sh\nif [ "$1" = serve ]; then setsid node /workspace/escaped-fixture.cjs </dev/null >/dev/null 2>&1 & fi\nexec /usr/local/bin/opencode "$@"\n', { flag: 'wx', mode: 0o755 });
const relay = spawn('socat', ['TCP-LISTEN:18080,bind=127.0.0.1,reuseaddr,fork', 'UNIX-CONNECT:/gateway/model.sock'], { stdio: 'ignore' });
const cezar = spawn(process.execPath, ['/project/node_modules/@open-mercato/cezar/dist/index.js', '--no-open', '--port', '14321'], { cwd: root, env, stdio: 'ignore' });
try {
  let ready = false;
  for (let i = 0; i < 150 && !ready; i++) {
    try { ready = (await fetch(`${url}/api/v1/health`)).ok; } catch {}
    if (!ready) await new Promise((done) => setTimeout(done, 100));
  }
  assert.ok(ready, 'Cezar did not start');
  await scan({ inbox: `${root}/ideas`, state: `${root}/state`, url, repoRoot: root, workflow: 'studio-feature' });
  const db = new DatabaseSync(`${root}/state/inbox.sqlite`, { readOnly: true });
  const receipts = db.prepare('SELECT status,run_id FROM receipts').all();
  db.close();
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].status, 'submitted');
  const id = receipts[0].run_id;
  let run;
  for (let i = 0; i < 100; i++) {
    run = await (await fetch(`${url}/api/v1/runs/${id}`)).json();
    assert.ok(!['done', 'review'].includes(run.status), 'rejected model request reached successful workflow state');
    assert.ok(!run.graphState?.taken?.some((edge) => edge.includes('->commit') || edge.startsWith('commit.')), 'workflow reached commit');
    await new Promise((done) => setTimeout(done, 100));
  }
  assert.ok(run.steps?.some((step) => step.id === 'plan' && step.sessionId), 'OpenCode planning session did not start');
  assert.ok(run.worktreePath, 'worktree path was not recorded');
  const registry = `${env.CEZ_HOME}/opencode-servers`;
  const records = await Promise.all((await readdir(registry)).filter((name) => /^\d+\.json$/.test(name)).map(async (name) => JSON.parse(await readFile(`${registry}/${name}`, 'utf8'))));
  const owned = records.filter((record) => record.ownerPid === cezar.pid);
  assert.equal(owned.length, 1, 'expected one Cezar-owned OpenCode server');
  const server = owned[0];
  const procStat = async (pid) => {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      return { state: fields[0], parent: Number(fields[1]), group: Number(fields[2]), start: fields[19] };
    } catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') return null; throw error; }
  };
  const before = await procStat(server.pid);
  assert.ok(before && before.state !== 'Z' && before.start === server.start && before.group === server.pid, 'registered server was not alive in its own process group');
  const cmdline = (await readFile(`/proc/${server.pid}/cmdline`, 'utf8')).replaceAll('\0', ' ');
  assert.match(cmdline, /opencode.*serve/);
  const escapedPid = Number(await readFile('/workspace/escaped-pid', 'utf8'));
  assert.ok(Number.isSafeInteger(escapedPid) && escapedPid > 1);
  const escapedBefore = await procStat(escapedPid);
  assert.ok(escapedBefore && escapedBefore.parent === server.pid && escapedBefore.group === escapedPid && escapedBefore.group !== server.pid, 'fixture descendant did not leave the server group');
  assert.match((await readFile(`/proc/${escapedPid}/cmdline`, 'utf8')).replaceAll('\0', ' '), /node \/workspace\/escaped-fixture\.cjs/);
  await checkRuns({ state: `${root}/state`, url, repoRoot: root, maxSeconds: 1, maxTokens: 100000 });
  const watchdog = new DatabaseSync(`${root}/state/watchdog.sqlite`, { readOnly: true });
  const cancellation = watchdog.prepare('SELECT reason,result FROM cancellations WHERE run_id=?').get(id);
  watchdog.close();
  assert.equal(cancellation?.reason, 'wall-clock limit');
  assert.equal(cancellation?.result, 'accepted');
  for (let i = 0; i < 100; i++) {
    run = await (await fetch(`${url}/api/v1/runs/${id}`)).json();
    if (run.status === 'cancelled') break;
    await new Promise((done) => setTimeout(done, 100));
  }
  assert.equal(run.status, 'cancelled', 'Cezar did not settle the cancelled run');
  let members = [];
  for (let i = 0; i < 100; i++) {
    const pids = (await readdir('/proc')).filter((name) => /^\d+$/.test(name));
    members = (await Promise.all(pids.map(async (pid) => ({ pid, stat: await procStat(pid) })))).filter(({ stat }) => stat && stat.group === server.pid && !['Z', 'X'].includes(stat.state));
    if (!members.length) break;
    await new Promise((done) => setTimeout(done, 100));
  }
  assert.deepEqual(members, [], 'Cezar-owned OpenCode process group still has live members');
  const after = await procStat(server.pid);
  assert.ok(!after || after.start !== server.start || ['Z', 'X'].includes(after.state), 'original OpenCode server is still executing');
  const heartbeatBefore = (await readFile('/workspace/escaped-heartbeat', 'utf8')).length;
  await new Promise((done) => setTimeout(done, 1000));
  const escapedAfter = await procStat(escapedPid);
  assert.ok(escapedAfter && escapedAfter.start === escapedBefore.start && !['Z', 'X'].includes(escapedAfter.state), 'escaped fixture descendant did not survive');
  assert.ok((await readFile('/workspace/escaped-heartbeat', 'utf8')).length > heartbeatBefore, 'escaped fixture descendant did not continue executing');
  console.log('PASS synthetic escaped OpenCode descendant continued running after watchdog cancellation');
  const stillCancelled = await (await fetch(`${url}/api/v1/runs/${id}`)).json();
  assert.equal(stillCancelled.status, 'cancelled');
  assert.ok(!stillCancelled.graphState?.taken?.some((edge) => edge.includes('->commit') || edge.startsWith('commit.')));
  assert.ok(!run.autoResumeAt, 'cancelled run has an auto-resume scheduled');
  assert.ok(!run.graphState?.taken?.some((edge) => edge.includes('->commit') || edge.startsWith('commit.')), 'cancelled workflow reached commit');
  assert.equal(git('rev-parse', 'HEAD'), baseline);
  if (run.worktreePath) assert.equal(git('-C', run.worktreePath, 'rev-parse', 'HEAD'), baseline);
  const publish = spawnSync(process.execPath, ['/project/studio/publish-run.mjs', id], { cwd: root, env: { PATH: process.env.PATH }, encoding: 'utf8' });
  assert.notEqual(publish.status, 0);
  assert.match(publish.stderr, /RUN_ID --approve/);
  console.log(`PASS rejected gateway: watchdog cancellation accepted, Cezar status=${run.status}; owned OpenCode group exited; no commit or unapproved publication`);
  console.log('READY per-run container termination; escaped descendant is alive');
  await new Promise(() => {});
} finally {
  if (cezar.exitCode === null && cezar.signalCode === null) {
    const exited = new Promise((done) => cezar.once('exit', done));
    cezar.kill('SIGTERM');
    await exited;
  }
  relay.kill('SIGTERM');
}
