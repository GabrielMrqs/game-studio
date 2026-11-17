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
