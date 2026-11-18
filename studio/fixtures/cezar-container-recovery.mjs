import { spawn, spawnSync } from 'node:child_process';
import { access, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { scan } from '/project/studio/inbox.mjs';
import { checkStartup } from '/fixture/startup-guard.mjs';

const root = '/workspace/repo', state = `${root}/state`, inbox = `${root}/ideas`, url = 'http://127.0.0.1:14321';
const config = { model: 'local/fixture', providers: { local: { name: 'Fixture gateway', package: '@opencode/ai/providers/openai-compatible/responses', settings: { baseURL: 'http://127.0.0.1:18080/v1', apiKey: 'fixture-placeholder' }, body: { max_output_tokens: 64 }, models: { fixture: { modelID: 'fixture-model', capabilities: { tools: true, input: ['text'], output: ['text'] }, limit: { context: 200000, output: 64 } } } } } };
const relay = spawn('socat', ['TCP-LISTEN:18080,bind=127.0.0.1,reuseaddr,fork', 'UNIX-CONNECT:/gateway/model.sock'], { stdio: 'ignore' });
const env = { ...process.env, HOME: '/workspace', CEZ_HOME: '/workspace/cezar-home', CEZ_DRY_RUN: '0', CEZ_AGENT_MODELS_LOCKED: '1', CEZ_OPENCODE_BIN: '/usr/local/bin/opencode', CEZ_ENV_PASSTHROUGH: 'OPENCODE_CONFIG_CONTENT', CEZ_TELEMETRY: '0', CEZ_RELAY: '0', CEZ_TERMINAL: '0', CEZ_DISPATCH: '0', CEZ_MANAGERS: '0', CEZ_AUTOMATIONS: '0', OPENCODE_CONFIG_CONTENT: JSON.stringify(config) };
let previous;
try { previous = JSON.parse(await readFile('/workspace/cezar-fixture.json', 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
if (previous && existsSync('/workspace/observe-unguarded')) {
  // Fixture-only negative control: the production startup guard stays enabled.
  const cezar = spawn(process.execPath, ['/project/node_modules/@open-mercato/cezar/dist/index.js', '--no-open', '--port', '14321'], { cwd: root, env, stdio: 'ignore' });
  try {
    let replaced = false, attempted = false;
    for (let i = 0; i < 200; i++) {
      if (cezar.exitCode !== null) throw new Error('negative-control Cezar exited before observation');
      try {
        const response = await fetch(`${url}/api/v1/runs/${previous.id}`, { signal: AbortSignal.timeout(1000) });
        if (response.ok) {
          const run = await response.json();
          replaced = run.steps?.some((step) => step.sessionId && step.sessionId !== previous.session) ?? false;
        }
        attempted = (await readFile('/workspace/cezar-tool-attempts', 'utf8')).split('\n').filter(Boolean).length > 1;
        if (replaced && attempted) break;
      } catch {}
      await new Promise((done) => setTimeout(done, 100));
    }
    if (!replaced || !attempted) throw new Error(`negative control failed: sessionReplaced=${replaced}, duplicateToolAttempt=${attempted}`);
    if (await readFile('/workspace/cezar-agent-output', 'utf8') !== 'one completed tool') throw new Error('exclusive fixture output changed');
    const db = new DatabaseSync(`${state}/inbox.sqlite`, { readOnly: true });
    const receipts = db.prepare('SELECT status,run_id FROM receipts').all();
    db.close();
    if (receipts.length !== 1 || receipts[0].run_id !== previous.id || receipts[0].status !== 'submitted') throw new Error('negative control changed the receipt');
    const publish = spawnSync(process.execPath, ['/project/studio/publish-run.mjs', previous.id], { cwd: root, env: { PATH: process.env.PATH }, encoding: 'utf8' });
    if (publish.status === 0 || !publish.stderr.includes('RUN_ID --approve')) throw new Error('publication approval gate missing');
    console.log('PASS unguarded Cezar replaced session and attempted duplicate tool; exclusive fixture preserved output and approval gate');
  } finally {
    if (cezar.exitCode === null && cezar.signalCode === null) {
      const exited = new Promise((done) => cezar.once('exit', done));
      cezar.kill('SIGTERM');
      await exited;
    }
    relay.kill('SIGTERM');
  }
} else if (previous) {
  let blocked = false;
  try { await checkStartup(root); }
  catch (error) { if (!error.message.includes('requires operator review')) throw error; blocked = true; }
  if (!blocked) throw new Error('startup guard did not block the interrupted run');
  const indexBefore = await readFile(`${root}/.ai/cezar/runs.json`, 'utf8');
  const runs = JSON.parse(indexBefore);
  const run = runs.find((entry) => entry.id === previous.id);
  if (runs.length !== 1 || !run || !run.steps?.some((step) => step.sessionId === previous.session) || run.worktreePath !== previous.worktree) throw new Error('persisted Cezar run/session correlation lost');
  const db = new DatabaseSync(`${state}/inbox.sqlite`, { readOnly: true });
  const receipts = db.prepare('SELECT status,run_id FROM receipts').all();
  db.close();
  if (receipts.length !== 1 || receipts[0].status !== 'submitted' || receipts[0].run_id !== previous.id) throw new Error('fixture receipt changed after restart');
  const listed = spawnSync('opencode', ['--standalone', 'session', 'list', '--format', 'json'], { cwd: previous.worktree, env, encoding: 'utf8', timeout: 15000 });
  if (listed.status !== 0 || !listed.stdout.includes(previous.session)) throw new Error('OpenCode did not retain the recorded session');
  const resumed = spawnSync('opencode', ['--standalone', 'run', '--model', 'local/fixture', '--session', previous.session, '--format', 'json', 'Continue the interrupted fixture without repeating completed work.'], { cwd: previous.worktree, env, encoding: 'utf8', timeout: 30000 });
  if (resumed.status !== 0 || !resumed.stdout.includes('ISOLATION_FIXTURE_COMPLETE')) throw new Error('explicit OpenCode session continuation did not complete');
  if (await readFile(`${root}/.ai/cezar/runs.json`, 'utf8') !== indexBefore) throw new Error('Cezar run index changed during independent session continuation');
  const publish = spawnSync(process.execPath, ['/project/studio/publish-run.mjs', previous.id], { cwd: root, env: { PATH: process.env.PATH }, encoding: 'utf8' });
  if (publish.status === 0 || !publish.stderr.includes('RUN_ID --approve')) throw new Error('publication approval gate missing');
  if (await readFile('/workspace/cezar-agent-output', 'utf8') !== 'one completed tool') throw new Error('fixture tool output changed');
  relay.kill('SIGTERM');
  console.log('PASS startup blocked Cezar replay; explicit OpenCode continuation retained run/session binding; no duplicate receipt or publication');
} else {
const cezar = spawn(process.execPath, ['/project/node_modules/@open-mercato/cezar/dist/index.js', '--no-open', '--port', '14321'], { cwd: root, env, stdio: 'ignore' });
try {
  let ready = false;
  for (let i = 0; i < 150 && !ready; i++) {
    if (cezar.exitCode !== null) throw new Error('Cezar exited before startup');
    try { ready = (await fetch(`${url}/api/v1/health`)).ok; } catch {}
    if (!ready) await new Promise((done) => setTimeout(done, 100));
  }
  if (!ready) throw new Error('Cezar did not become healthy');
  await scan({ inbox, state, url, repoRoot: root, workflow: 'studio-plan' });
  const db = new DatabaseSync(`${state}/inbox.sqlite`, { readOnly: true });
  const receipts = db.prepare('SELECT status,run_id FROM receipts').all();
  db.close();
  if (receipts.length !== 1 || receipts[0].status !== 'submitted') throw new Error('fixture receipt not submitted');
  const id = receipts[0].run_id;
    let recorded, diagnostic;
    for (let i = 0; i < 200; i++) {
      const run = await (await fetch(`${url}/api/v1/runs/${id}`)).json();
      diagnostic = { status: run.status, steps: run.steps?.map((step) => ({ id: step.id, status: step.status, session: Boolean(step.sessionId) })), worktree: Boolean(run.worktreePath), tool: false, error: run.error };
      try {
        await access('/workspace/cezar-agent-output');
        diagnostic.tool = true;
        const disk = JSON.parse(await readFile(`${root}/.ai/cezar/runs.json`, 'utf8')).find((entry) => entry.id === id);
        const session = run.steps?.find((step) => step.sessionId)?.sessionId;
        if (session && disk?.worktreePath && disk.steps?.some((step) => step.sessionId === session)) {
          recorded = { id, session, worktree: disk.worktreePath };
          break;
        }
      } catch {}
      await new Promise((done) => setTimeout(done, 100));
    }
    if (!recorded) throw new Error(`Cezar did not persist the run, worktree and OpenCode session after the tool: ${JSON.stringify(diagnostic)}`);
    const dbPath = spawnSync('opencode', ['debug', 'paths', 'db'], { cwd: root, env, encoding: 'utf8', timeout: 15000 });
    if (dbPath.status !== 0 || !dbPath.stdout.trim().startsWith('/workspace/')) throw new Error('OpenCode fixture database path unavailable');
    recorded.opencodeDb = dbPath.stdout.trim();
    await writeFile('/workspace/cezar-fixture.json', JSON.stringify(recorded), { flag: 'wx' });
    console.log('PASS Cezar persisted run and OpenCode session; awaiting abrupt container stop');
    await new Promise(() => {});
} finally {
  if (cezar.exitCode === null && cezar.signalCode === null) {
    const exited = new Promise((done) => cezar.once('exit', done));
    cezar.kill('SIGTERM');
    await exited;
  }
  relay.kill('SIGTERM');
}
}
