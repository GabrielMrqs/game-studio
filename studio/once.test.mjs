import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, copyFileSync, linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { needsVisualReview, validatedPaths } from './once-paths.mjs';
import { stageGame } from './once-validation.mjs';

test('allows one existing script edit or new nested Godot sources and assets', t => {
  const work = mkdtempSync(join(tmpdir(), 'studio-paths-test-'));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const story = 'game/CASE_01_AURORA.md';
  const script = 'game/main.gd';
  const additions = [story, 'game/ui/menu.tscn', 'game/ui/skin.tres', 'game/ui/icon.svg', 'game/ui/logo.png'];
  mkdirSync(join(work, 'game/ui'), { recursive: true });
  for (const path of [script, ...additions]) writeFileSync(join(work, path), '');
  assert.deepEqual(validatedPaths(work, [` M ${script}`]), [script]);
  assert.deepEqual(validatedPaths(work, additions.map(path => `?? ${path}`)), additions);
  assert.equal(needsVisualReview(additions), true);
  assert.equal(needsVisualReview([script]), true);
  assert.equal(needsVisualReview([story]), false);
  assert.throws(() => validatedPaths(work, []), /No game edits/);
  for (const entry of [
    '?? studio/injected.gd', '?? game/../outside.gd', '?? /game/ui/menu.tscn',
    '?? game/ui\\menu.gd', '?? game/ui/name\n.gd', '?? game/.godot/imported/a.png',
    '?? game/build/splash.png', '?? game/project.godot', '?? game/extra.md',
    '?? game/ui/image.svg.import', '?? game/ui/file.gd.uid', '?? game/lib.gdextension',
    '?? game/.gitattributes', ' M game/tests/preview.gd', ` M ${story}`,
    `!! ${script}`, `A  ${script}`, ` D ${script}`, `R  ${script}`,
  ]) {
    assert.throws(() => validatedPaths(work, [entry]), /Disallowed studio edit/, entry);
  }
  symlinkSync('main.gd', join(work, 'game/link.gd'));
  symlinkSync('ui', join(work, 'game/linked-ui'));
  linkSync(join(work, script), join(work, 'game/hard.gd'));
  assert.throws(() => validatedPaths(work, ['?? game/link.gd']), /regular/);
  assert.throws(() => validatedPaths(work, ['?? game/linked-ui/menu.tscn']), /real directory/);
  assert.throws(() => validatedPaths(work, ['?? game/hard.gd']), /hard links/);
  chmodSync(join(work, story), 0o755);
  assert.throws(() => validatedPaths(work, [`?? ${story}`]), /non-executable/);
});

test('validation copies new files from the staged Git tree, not the agent working copy', t => {
  const work = mkdtempSync(join(tmpdir(), 'studio-staged-test-'));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', work, ...args], { encoding: 'utf8' });
  git('init', '-q');
  mkdirSync(join(work, 'game'));
  writeFileSync(join(work, 'game/new.tscn'), 'staged content');
  git('add', 'game/new.tscn');
  const tree = git('write-tree').trim();
  writeFileSync(join(work, 'game/new.tscn'), 'unstaged content');
  const validation = join(work, 'validation');
  const verifyImport = stageGame(work, tree, validation, git('ls-tree', '-r', '-z', tree, '--', 'game'));
  verifyImport();
  writeFileSync(join(validation, 'game/new.tscn'), 'modified after import');
  assert.throws(verifyImport, /changed the staged game/);
});

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
    copyFileSync(new URL('./once-paths.mjs', import.meta.url), join(root, 'studio/once-paths.mjs'));
    copyFileSync(new URL('./once-validation.mjs', import.meta.url), join(root, 'studio/once-validation.mjs'));
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
    for (const file of ['once.mjs', 'once-paths.mjs', 'once-validation.mjs', 'linear-source.mjs']) {
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

    const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
      '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', 'Baseline');
    git('branch', 'studio/develop');
    const run = 'once-ABC123';
    const dir = join(root, '.studio-state', run);
    const work = join(dir, 'work');
    mkdirSync(dir, { mode: 0o700 });
    writeFileSync(join(dir, 'linear.log'), `Linear TEST-1 (${id(6)}): requesting In Progress\nIn Progress confirmed\n`);
    git('worktree', 'add', '-qb', `studio/${run}`, work);
    const base = git('rev-parse', 'HEAD').trim();
    const receipt = `refs/studio/linear/${id(6)}`;
    git('update-ref', 'refs/studio/active', base);
    const preview = () => spawnSync(process.execPath, [
      join(root, 'studio/once.mjs'), '--recovery-preview', run,
    ], { encoding: 'utf8' });
    assert.match(preview().stderr, /claim and active gate must match/);
    git('update-ref', receipt, base);
    writeFileSync(join(work, 'unexpected.sh'), '#!/bin/sh\n');
    const before = git('-C', work, 'status', '--porcelain=v1');
    const rejected = preview();
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /Disallowed studio edit/);
    assert.equal(git('-C', work, 'status', '--porcelain=v1'), before);
    assert.deepEqual(git('rev-parse', 'studio/develop', receipt, 'refs/studio/active').trim().split('\n'),
      [base, base, base]);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
