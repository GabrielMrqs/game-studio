import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import { closeSync, openSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

test('verified exec fixture denies later exec from another PID namespace', { timeout: 30000, skip: process.platform !== 'linux' || process.arch !== 'x64' }, async (t) => {
  if (spawnSync('gcc', ['--version']).error?.code === 'ENOENT' || spawnSync('unshare', ['--version']).error?.code === 'ENOENT') return t.skip('gcc or unshare unavailable');
  const dir = await mkdtemp(join(tmpdir(), 'studio-exec-namespace-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const gate = join(dir, 'gate'), bindingFile = join(dir, 'binding.sqlite'), definitionFile = join(dir, 'automations.json');
  const contextFile = join(dir, 'context.json'), marker = join(dir, 'escaped');
  const id = '12345678-1234-1234-1234-123456789012';
  execFileSync('gcc', ['-O2', '-Wall', '-Wextra', '-Werror', resolve('studio/fixtures/exec-gate.c'), '-o', gate], { stdio: 'pipe' });
  await writeFile(definitionFile, JSON.stringify({ automations: [{ id, deferredStart: { status: 'launching', runIds: [id] } }] }));
  await writeFile(contextFile, JSON.stringify({ automationId: id, definitionFile, bindingFile }), { mode: 0o600, flag: 'wx' });
  const child = spawn(gate, [
    '--verify', resolve('studio/fixtures/verify-exec-binding.mjs'), contextFile, '--',
    '/usr/bin/unshare', '--user', '--map-root-user', '--pid', '--fork', '--kill-child',
    '/bin/sh', '-c', '/usr/bin/readlink /proc/self/ns/pid; IFS= read -r line; exec /usr/bin/touch "$1"', 'fixture', marker,
  ], { stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  let line = '';
  for await (const chunk of child.stdout) {
    line += chunk.toString();
    if (line.includes('\n')) break;
  }
  const foreignNamespace = line.trim();
  const ownedNamespace = await readlink('/proc/self/ns/pid');
  assert.match(foreignNamespace, /^pid:\[\d+\]$/);
  assert.notEqual(foreignNamespace, ownedNamespace);
  const children = (await readFile(`/proc/${child.pid}/task/${child.pid}/children`, 'utf8')).trim().split(/\s+/).map(Number);
  assert.equal(children.length, 1);
  const rootPid = children[0];
  const start = (await readFile(`/proc/${rootPid}/stat`, 'utf8')).split(') ')[1].split(' ')[19];
  closeSync(openSync(bindingFile, 'wx', 0o600));
  const db = new DatabaseSync(bindingFile);
  db.exec('PRAGMA synchronous=FULL; CREATE TABLE binding (run_id TEXT PRIMARY KEY, pid INTEGER, start_time TEXT, namespace TEXT)');
  db.prepare('INSERT INTO binding VALUES (?,?,?,?)').run(id, rootPid, start, ownedNamespace);
  db.close();
  const held = once(child.stdio[3], 'data');
  child.stdio[3].write('H');
  assert.equal((await held)[0].toString(), 'H');
  const released = once(child.stdio[3], 'data');
  child.stdio[3].write('R');
  assert.equal((await released)[0].toString(), 'R');
  const exited = once(child, 'exit');
  child.stdin.write('\n');
  const [code] = await exited;
  assert.notEqual(code, 0, 'foreign namespace unexpectedly executed the fixture command');
  assert.match(stderr, /Operation not permitted/);
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
});
