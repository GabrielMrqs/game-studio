import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

test('watch locks out once, exits on Ctrl+C, and refuses an unresolved run', { timeout: 8000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'studio-watch-test-'));
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
  const start = (...args) => [join(root, 'studio/once.mjs'), ...args];
  try {
    git('init', '-q');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
      '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', 'Baseline');
    mkdirSync(join(root, 'ideas'));
    mkdirSync(join(root, 'studio'));
    copyFileSync(new URL('./once.mjs', import.meta.url), start()[0]);
    copyFileSync(new URL('./linear-source.mjs', import.meta.url), join(root, 'studio/linear-source.mjs'));
    const watcher = spawn(process.execPath, start('--watch'));
    const closed = once(watcher, 'close');
    try {
      const [out] = await once(watcher.stdout, 'data');
      assert.match(String(out), /Watching ideas/);
      const blocked = spawnSync(process.execPath, start(), { encoding: 'utf8' });
      assert.equal(blocked.status, 1);
      assert.match(blocked.stderr, /Another studio:once or studio:watch is active/);
    } finally {
      watcher.kill('SIGINT');
      assert.deepEqual(await closed, [130, null]);
    }
    assert.equal(spawnSync(process.execPath, start()).status, 0);
    git('update-ref', 'refs/studio/active', 'HEAD');
    const uncertain = spawnSync(process.execPath, start('--watch'), { encoding: 'utf8' });
    assert.equal(uncertain.status, 1);
    assert.match(uncertain.stderr, /A previous run needs review/);

    git('update-ref', '-d', 'refs/studio/active');
    writeFileSync(join(root, 'ideas/new.md'), '# A pending idea');
    const missing = spawnSync(process.execPath, start(), { encoding: 'utf8' });
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /Create a local studio\/develop branch/);
    writeFileSync(join(root, 'ideas/other.md'), '# Another pending idea');
    const multiple = spawnSync(process.execPath, start(), { encoding: 'utf8' });
    assert.equal(multiple.status, 1);
    assert.match(multiple.stderr, /Leave exactly one unclaimed Markdown idea/);
    rmSync(join(root, 'ideas/other.md'));
    git('checkout', '-qb', 'studio/develop');
    const checkedOut = spawnSync(process.execPath, start(), { encoding: 'utf8' });
    assert.equal(checkedOut.status, 1);
    assert.match(checkedOut.stderr, /studio\/develop is checked out/);
    git('checkout', '--detach', '-q');
    const invalid = spawnSync(process.execPath, start(), { encoding: 'utf8' });
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /studio\/develop has no playable Godot project/);
    assert.equal(git('for-each-ref', 'refs/studio').toString(), '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('once accepts a Ready Linear issue with an empty ideas folder', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'studio-linear-test-'));
  const root = join(fixture, 'repo');
  const home = join(fixture, 'home');
  const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  try {
    for (const dir of ['repo/ideas', 'repo/studio', 'repo/.studio-state', 'repo/profile', 'home/.config/game-studio']) {
      mkdirSync(join(fixture, dir), { recursive: true, mode: 0o700 });
    }
    execFileSync('git', ['-C', root, 'init', '-q']);
    for (const file of ['once.mjs', 'linear-source.mjs']) {
      copyFileSync(new URL(`./${file}`, import.meta.url), join(root, 'studio', file));
    }
    writeFileSync(join(home, '.config/game-studio/linear.key'), 'fixture-key', { mode: 0o600 });
    writeFileSync(join(root, '.studio-state/once.json'), JSON.stringify({
      opencodeHome: 'profile',
      linear: { teamId: id(1), labelId: id(2), readyId: id(3), inProgressId: id(4), doneId: id(5) },
    }));
    const preload = `
      import os from 'node:os';
      import { syncBuiltinESMExports } from 'node:module';
      os.userInfo = () => ({ homedir: ${JSON.stringify(home)} });
      syncBuiltinESMExports();
      globalThis.fetch = async () => Response.json({ data: { issues: {
        nodes: [{ id: ${JSON.stringify(id(6))}, identifier: 'TEST-1', title: 'Room names' }],
        pageInfo: { hasNextPage: false },
      } } });
    `;
    const result = spawnSync(process.execPath, [
      '--import', `data:text/javascript,${encodeURIComponent(preload)}`, join(root, 'studio/once.mjs'),
    ], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Create a local studio\/develop branch/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
