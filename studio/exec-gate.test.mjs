import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';

test('kernel exec fixture holds every tested exec until released and fails closed on supervisor death', { timeout: 30000, skip: process.platform !== 'linux' || process.arch !== 'x64' }, async (t) => {
  if (spawnSync('gcc', ['--version']).error?.code === 'ENOENT') return t.skip('gcc unavailable');
  const dir = await mkdtemp(join(tmpdir(), 'studio-exec-gate-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const binary = join(dir, 'gate');
  execFileSync('gcc', ['-O2', '-Wall', '-Wextra', '-Werror', resolve('studio/fixtures/exec-gate.c'), '-o', binary], { stdio: 'pipe' });
  for (const mode of ['execve', 'execveat', 'supervisor-killed', 'controller-disconnected', 'release-before-hold']) {
    const marker = join(dir, mode);
    const program = mode === 'execveat'
      ? ['/usr/bin/python3', '-c', `import ctypes,os,sys\nassert not os.path.exists('/proc/self/fd/3')\nprint('ready', flush=True)\nsys.stdin.readline()\nlibc=ctypes.CDLL(None,use_errno=True)\nargs=(ctypes.c_char_p*3)(b'touch',sys.argv[1].encode(),None)\nenv=(ctypes.c_char_p*1)(None)\nlibc.syscall(322,-100,b'/usr/bin/touch',args,env,0)\nsys.exit(1)`, marker]
      : ['/bin/sh', '-c', 'test ! -e /proc/self/fd/3 || exit 1; printf ready; IFS= read -r line; exec /usr/bin/touch "$1"', 'fixture', marker];
    const child = spawn(binary, program, { stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
    const [ready] = await once(child.stdout, 'data');
    assert.match(ready.toString(), /ready/);
    if (mode === 'release-before-hold') {
      const exited = once(child, 'exit');
      child.stdio[3].write('R');
      const [code] = await exited;
      assert.notEqual(code, 0);
      await assert.rejects(readFile(marker), { code: 'ENOENT' });
      continue;
    }
    const held = once(child.stdio[3], 'data');
    child.stdio[3].write('H');
    assert.equal((await held)[0].toString(), 'H');
    child.stdin.write('\n');
    await new Promise((done) => setTimeout(done, 250));
    await assert.rejects(readFile(marker), { code: 'ENOENT' });
    if (mode === 'supervisor-killed') {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
      await new Promise((done) => setTimeout(done, 250));
      await assert.rejects(readFile(marker), { code: 'ENOENT' });
      continue;
    }
    if (mode === 'controller-disconnected') {
      const exited = once(child, 'exit');
      child.stdio[3].destroy();
      const [code] = await exited;
      assert.notEqual(code, 0);
      await new Promise((done) => setTimeout(done, 250));
      await assert.rejects(readFile(marker), { code: 'ENOENT' });
      continue;
    }
    const released = once(child.stdio[3], 'data');
    child.stdio[3].write('R');
    assert.equal((await released)[0].toString(), 'R');
    const [code] = await once(child, 'exit');
    assert.equal(code, 0);
    assert.equal(await readFile(marker, 'utf8'), '');
  }
});
