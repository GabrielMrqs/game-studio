import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readlink } from 'node:fs/promises';
import { createServer } from 'node:net';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

test('deferred Cezar fixture bootstraps and binds in a private network namespace', { timeout: 40000, skip: process.platform !== 'linux' || process.arch !== 'x64' }, async (t) => {
  if (spawnSync('unshare', ['--version']).error?.code === 'ENOENT') return t.skip('unshare unavailable');
  const listener = createServer();
  await new Promise((done) => listener.listen(0, '127.0.0.1', done));
  t.after(() => new Promise((done) => listener.close(done)));
  const hostNetwork = await readlink('/proc/self/ns/net');
  const script = `
    import assert from 'node:assert/strict';
    import { readlinkSync } from 'node:fs';
    import { connect } from 'node:net';
    import { execFileSync, spawnSync } from 'node:child_process';
    execFileSync('/usr/bin/ip', ['link', 'set', 'lo', 'up']);
    assert.notEqual(readlinkSync('/proc/self/ns/net'), process.argv[1]);
    const result = await new Promise((done) => {
      const socket = connect({ host: '127.0.0.1', port: Number(process.argv[2]) });
      socket.once('connect', () => { socket.destroy(); done('connected'); });
      socket.once('error', (error) => done(error.code));
      socket.setTimeout(2000, () => { socket.destroy(); done('timeout'); });
    });
    assert.equal(result, 'ECONNREFUSED');
    console.log('PASS fixture: host loopback listener unreachable from private network namespace');
    const env = { ...process.env, STUDIO_TEST_HOST_NETNS: process.argv[1] };
    delete env.NODE_TEST_CONTEXT;
    const child = spawnSync(process.execPath, ['--test', '--test-name-pattern', '^Cezar kernel exec fixture (holds execs before deferred launch|interrupts deferred launch before release|starts a disabled deferred task manually|interrupts a disabled task after manual launch|blocks restart after a released agent side effect)$', process.argv[3]], {
      encoding: 'utf8', timeout: 25000, env,
    });
    process.stdout.write(child.stdout || '');
    process.stderr.write(child.stderr || '');
    if (child.status !== 0) process.exit(1);
  `;
  const result = spawnSync('unshare', [
    '--user', '--map-root-user', '--net', process.execPath, '--input-type=module', '-e', script,
    hostNetwork, String(listener.address().port), resolve('studio/cezar-exec-gate.test.mjs'),
  ], { encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /host loopback listener unreachable/);
  assert.match(result.stdout, /real deferred-start reserved ID under universal exec hold/);
  assert.match(result.stdout, /startup guard refused interrupted deferred launch/);
  assert.match(result.stdout, /disabled deferred task manually triggered, then Cezar enabled it/);
  assert.match(result.stdout, /interrupts a disabled task after manual launch/);
  assert.match(result.stdout, /startup guard refused restart after released simulated agent side effect/);
  console.log('PASS: private-network Cezar deferred binding fixture; host loopback isolated');
});
