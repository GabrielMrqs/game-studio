import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { closeSync, openSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { verifyExecBinding } from './fixtures/verify-exec-binding.mjs';

test('fixture binding verifier rejects missing, stale, ambiguous and untrusted evidence', { skip: process.platform !== 'linux' }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'studio-verify-exec-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const id = '12345678-1234-1234-1234-123456789012', other = '12345678-1234-1234-1234-123456789013';
  const bindingFile = join(root, 'binding.sqlite'), definitionFile = join(root, 'automations.json'), context = join(root, 'context.json');
  const contents = (status, runIds) => JSON.stringify({ automations: [{ id, deferredStart: { status, runIds } }] });
  await writeFile(context, JSON.stringify({ automationId: id, bindingFile, definitionFile }), { mode: 0o600, flag: 'wx' });
  await writeFile(definitionFile, contents('launching', [id]));
  await assert.rejects(verifyExecBinding(context, process.pid));
  closeSync(openSync(bindingFile, 'wx', 0o600));
  const db = new DatabaseSync(bindingFile);
  db.exec('CREATE TABLE binding (run_id TEXT PRIMARY KEY, pid INTEGER, start_time TEXT, namespace TEXT)');
  const stat = (await readFile(`/proc/${process.pid}/stat`, 'utf8')).split(') ')[1].split(' ')[19];
  const namespace = await readlink(`/proc/${process.pid}/ns/pid`);
  db.prepare('INSERT INTO binding VALUES (?,?,?,?)').run(id, process.pid, stat, namespace);
  await verifyExecBinding(context, process.pid);
  db.prepare('INSERT INTO binding VALUES (?,?,?,?)').run(other, process.pid, stat, namespace);
  await assert.rejects(verifyExecBinding(context, process.pid), /ambiguous/);
  db.prepare('DELETE FROM binding WHERE run_id=?').run(other);
  db.prepare('UPDATE binding SET start_time=?').run('0');
  await assert.rejects(verifyExecBinding(context, process.pid), /identity changed/);
  db.prepare('UPDATE binding SET start_time=?, namespace=?').run(stat, 'pid:[0]');
  await assert.rejects(verifyExecBinding(context, process.pid), /identity changed/);
  db.prepare('UPDATE binding SET namespace=?').run(namespace);
  await writeFile(definitionFile, contents('launching', [other]));
  await assert.rejects(verifyExecBinding(context, process.pid), /does not match/);
  await writeFile(definitionFile, contents('pending', [id]));
  await assert.rejects(verifyExecBinding(context, process.pid), /does not match/);
  await writeFile(definitionFile, contents('launching', [id]));
  await assert.rejects(verifyExecBinding(context, 99999999), /not owned|ancestry/);
  if (!spawnSync('bwrap', ['--version']).error) {
    const child = spawn('bwrap', [
      '--unshare-all', '--die-with-parent', '--info-fd', '3',
      '--ro-bind', '/usr', '/usr', '--ro-bind', '/lib', '/lib', '--ro-bind-try', '/lib64', '/lib64',
      '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '/usr/bin/sleep', '10',
    ], { stdio: ['ignore', 'ignore', 'ignore', 'pipe'] });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
    let data = '';
    for await (const chunk of child.stdio[3]) data += chunk.toString();
    const foreignPid = JSON.parse(data)['child-pid'];
    assert.notEqual(await readlink(`/proc/${foreignPid}/ns/pid`), namespace);
    await assert.rejects(verifyExecBinding(context, process.pid, [foreignPid]), /outside bound namespace/);
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    await exited;
  }
  await chmod(context, 0o644);
  await assert.rejects(verifyExecBinding(context, process.pid), /untrusted/);
  await chmod(context, 0o600);
  await symlink(context, join(root, 'linked-context'));
  await assert.rejects(verifyExecBinding(join(root, 'linked-context'), process.pid), /untrusted/);
  db.close();
});
