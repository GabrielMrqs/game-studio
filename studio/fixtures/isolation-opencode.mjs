import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { access, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const relay = spawn('socat', ['TCP-LISTEN:18080,bind=127.0.0.1,reuseaddr,fork', 'UNIX-CONNECT:/gateway/model.sock'], { stdio: ['ignore', 'ignore', 'pipe'] });
let relayErrors = '';
relay.stderr.on('data', (chunk) => { relayErrors += chunk; });
try {
  let ready = false;
  for (let i = 0; i < 50 && !ready; i++) {
    ready = await new Promise((done) => {
      const socket = createConnection({ host: '127.0.0.1', port: 18080 });
      socket.on('connect', () => { socket.destroy(); done(true); });
      socket.on('error', () => done(false));
    });
    if (!ready) await new Promise((done) => setTimeout(done, 100));
  }
  if (!ready) throw new Error('gateway relay did not start');
  const config = { model: 'local/fixture', providers: { local: { name: 'Offline gateway fixture', package: '@opencode/ai/providers/openai-compatible/responses', settings: { baseURL: 'http://127.0.0.1:18080/v1', apiKey: 'fixture-placeholder' }, body: { max_output_tokens: 64 }, models: { fixture: { modelID: 'fixture-model', capabilities: { tools: true, input: ['text'], output: ['text'] }, limit: { context: 200000, output: 64 } } } } } };
  const failure = process.env.FIXTURE_EXPECT_GATEWAY_FAILURE === '1';
  const recovery = process.env.FIXTURE_EXPECT_GATEWAY_RECOVERY === '1';
  const quota = process.env.FIXTURE_EXPECT_GATEWAY_QUOTA === '1';
  const restart = process.env.FIXTURE_EXPECT_PROCESS_RESTART === '1';
  const containerRestart = process.env.FIXTURE_EXPECT_CONTAINER_RESTART === '1';
  let session = `ses_${randomUUID().replaceAll('-', '')}`, resumingContainer = false;
  if (containerRestart) {
    try { session = await readFile('/workspace/fixture-session-id', 'utf8'); resumingContainer = true; }
    catch (error) { if (error.code !== 'ENOENT') throw error; await writeFile('/workspace/fixture-session-id', session, { flag: 'wx' }); }
  }
  const env = { ...process.env, OPENCODE_CONFIG_CONTENT: JSON.stringify(config) };
  const runArgs = ['--standalone', 'run', '--model', 'local/fixture', ...(restart || containerRestart ? ['--session', session, '--format', 'json'] : []), resumingContainer ? 'Continue the interrupted fixture without repeating completed work.' : 'Execute the isolation fixture check.'];
  const child = spawn('opencode', runArgs, { cwd: '/workspace', env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  let killedAfterTool = false;
  child.stdout.on('data', (chunk) => {
    output += chunk;
    if (restart && !killedAfterTool && output.includes('ISOLATION_TOOL_OK')) {
      killedAfterTool = true;
      child.kill('SIGKILL');
    }
    if (containerRestart && !resumingContainer && !killedAfterTool && output.includes('ISOLATION_TOOL_OK')) {
      killedAfterTool = true;
      console.log('PASS container fixture tool completed; awaiting abrupt container stop');
    }
  });
  child.stderr.on('data', (chunk) => { output += chunk; });
  let timedOut = false;
  const timeout = (failure || quota || recovery || restart || containerRestart) ? setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, failure || quota ? 7000 : 45000) : undefined;
  const { code, signal } = await new Promise((done, reject) => { child.once('error', reject); child.once('exit', (code, signal) => done({ code, signal })); });
  clearTimeout(timeout);
  if (quota) {
    if ((!timedOut && code === 0) || output.includes('ISOLATION_FIXTURE_COMPLETE')) throw new Error('quota exhaustion did not stop the session');
    try { await access('/workspace/agent-output'); throw new Error('tool ran despite exhausted quota'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    console.log('PASS exhausted gateway prevented OpenCode completion and tool execution');
  } else if (containerRestart) {
    if (!resumingContainer || timedOut || code !== 0 || !output.includes('ISOLATION_FIXTURE_COMPLETE') || await readFile('/workspace/agent-output', 'utf8') !== 'scratch works') throw new Error('container restart did not resume the persisted session');
    console.log('PASS restarted container continued the persisted OpenCode session');
  } else if (restart) {
    if (timedOut || !killedAfterTool || signal !== 'SIGKILL' || output.includes('ISOLATION_FIXTURE_COMPLETE') || await readFile('/workspace/agent-output', 'utf8') !== 'scratch works') throw new Error('first OpenCode process did not stop after its tool completed');
    console.log('PASS OpenCode process killed after completed tool; session state retained');
    let connected = false;
    for (let i = 0; i < 200 && !connected; i++) {
      try { connected = (await fetch('http://127.0.0.1:18080/health', { signal: AbortSignal.timeout(500) })).status === 404; } catch {}
      if (!connected) await new Promise((done) => setTimeout(done, 100));
    }
    if (!connected) throw new Error('gateway did not return');
    const resumed = spawn('opencode', ['--standalone', 'run', '--model', 'local/fixture', '--session', session, '--format', 'json', 'Continue the interrupted fixture without repeating completed work.'], { cwd: '/workspace', env, stdio: ['ignore', 'pipe', 'pipe'] });
    let resumedOutput = '';
    resumed.stdout.on('data', (chunk) => { resumedOutput += chunk; });
    resumed.stderr.on('data', (chunk) => { resumedOutput += chunk; });
    const resumeTimeout = setTimeout(() => resumed.kill('SIGTERM'), 30000);
    const resumedCode = await new Promise((done, reject) => { resumed.once('error', reject); resumed.once('exit', done); });
    clearTimeout(resumeTimeout);
    if (resumedCode !== 0 || !resumedOutput.includes('ISOLATION_FIXTURE_COMPLETE') || await readFile('/workspace/agent-output', 'utf8') !== 'scratch works') throw new Error('resumed OpenCode process did not complete');
    console.log('PASS restarted OpenCode process continued the same persisted session');
  } else if (failure) {
    if ((!timedOut && code === 0) || output.includes('ISOLATION_FIXTURE_COMPLETE') || await readFile('/workspace/agent-output', 'utf8') !== 'scratch works') throw new Error('gateway outage did not fail closed after the agent tool ran');
    console.log('PASS gateway outage prevented OpenCode session completion after tool execution');
  } else {
  if (timedOut || code !== 0 || await readFile('/workspace/agent-output', 'utf8') !== 'scratch works') throw new Error('OpenCode isolation fixture did not complete');
  if (recovery && (!relayErrors.includes('/gateway/model.sock') || !output.includes('ISOLATION_FIXTURE_COMPLETE'))) throw new Error('session did not encounter and recover from the gateway outage');
  console.log('PASS actual OpenCode shell tool executed synthetic isolation checks via gateway');
  }
} finally {
  relay.kill('SIGTERM');
}
