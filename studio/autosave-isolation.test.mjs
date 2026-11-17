import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

test('Cezar autosave stays in a disposable repository when the baseline is read-only', { skip: process.platform !== 'linux' }, async (t) => {
  const available = spawnSync('bwrap', ['--version'], { encoding: 'utf8' });
  if (available.error?.code === 'ENOENT') return t.skip('bubblewrap is unavailable');
  assert.equal(available.status, 0, available.stderr);
  const dir = await mkdtemp(join(tmpdir(), 'studio-autosave-isolation-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const baseline = join(dir, 'baseline');
  const scratch = join(dir, 'scratch');
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  execFileSync('git', ['init', '-b', 'main', baseline], { stdio: 'ignore' });
  await writeFile(join(baseline, 'game.txt'), 'before\n');
  git(baseline, 'add', 'game.txt');
  git(baseline, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'baseline');
  const base = git(baseline, 'rev-parse', 'HEAD');
  execFileSync('git', ['clone', '--no-hardlinks', baseline, scratch], { stdio: 'ignore' });
  git(scratch, 'remote', 'remove', 'origin');
  git(scratch, 'switch', '-c', 'quarantine');
  await writeFile(join(scratch, 'game.txt'), 'changed\n');
  const script = `
    import { writeFileSync } from 'node:fs';
    import { autosaveCommit } from '/tools/node_modules/@open-mercato/cezar/dist/git-worktree.js';
    let blocked = false;
    try { writeFileSync('/protected/marker', 'unexpected'); } catch (error) { blocked = error.code === 'EROFS'; }
    if (!blocked) throw new Error('baseline was writable');
    const result = await autosaveCommit('/scratch', 'turn end');
    if (result !== 'committed') throw new Error('autosave failed: ' + result);
    console.log('PASS protected baseline read-only; actual Cezar autosave committed in scratch');
  `;
  const sandbox = spawnSync('bwrap', [
    '--unshare-all', '--die-with-parent', '--new-session',
    '--ro-bind', '/usr', '/usr', '--ro-bind', '/lib', '/lib', '--ro-bind-try', '/lib64', '/lib64',
    '--symlink', 'usr/bin', '/bin', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
    '--ro-bind', baseline, '/protected', '--bind', scratch, '/scratch',
    '--ro-bind', resolve('node_modules'), '/tools/node_modules',
    '--chdir', '/scratch', '--clearenv', '--setenv', 'HOME', '/tmp', '--setenv', 'PATH', '/usr/bin:/bin',
    '/usr/bin/node', '--input-type=module', '-e', script,
  ], { encoding: 'utf8', timeout: 30000 });
  assert.equal(sandbox.status, 0, sandbox.stderr);
  assert.match(sandbox.stdout, /PASS protected baseline read-only/);
  assert.equal(git(baseline, 'rev-parse', 'HEAD'), base);
  assert.equal(await readFile(join(baseline, 'game.txt'), 'utf8'), 'before\n');
  assert.notEqual(git(scratch, 'rev-parse', 'HEAD'), base);
  assert.equal(git(scratch, 'log', '-1', '--format=%s'), 'cezar autosave (turn end)');
  assert.equal(git(scratch, 'show', 'HEAD:game.txt'), 'changed');
});
