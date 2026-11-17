import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { checkStartup } from './startup-guard.mjs';

test('startup refuses unsafe recovered state before launching the worker', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'studio-startup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = join(root, '.ai/cezar'), index = join(data, 'runs.json');
  const id = '12345678-1234-1234-1234-123456789012';
  const guard = resolve('studio/startup-guard.mjs');
  const marker = join(root, 'launched');
  await mkdir(join(data, 'worktrees', id), { recursive: true });
  await writeFile(join(data, 'worktrees', id, '.git'), 'preserve fixture');
  await assert.rejects(checkStartup(root), /index missing/);
  const indexText = JSON.stringify([{ id, status: 'queued' }]);
  await writeFile(index, indexText);
  const attempt = spawnSync('sh', ['-c', 'node "$1" && node -e "require(\'fs\').writeFileSync(process.argv[1], \'started\')" "$2"', 'fixture', guard, marker], { cwd: root, encoding: 'utf8' });
  assert.notEqual(attempt.status, 0);
  assert.match(attempt.stderr, /startup blocked.*no recorded worktree/);
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
  assert.equal(await readFile(index, 'utf8'), indexText);
  assert.equal(await readFile(join(data, 'worktrees', id, '.git'), 'utf8'), 'preserve fixture');
  for (const run of [{ id, status: 'review' }, { id, status: 'failed', autoResumeAt: '2026-01-01T00:00:00Z' }]) {
    await writeFile(index, JSON.stringify([run]));
    await assert.rejects(checkStartup(root), /no recorded worktree/);
  }
  for (const malformed of ['{', '{}', JSON.stringify([{ id, status: 'unknown' }])]) {
    await writeFile(index, malformed);
    await assert.rejects(checkStartup(root));
  }
  await writeFile(index, JSON.stringify([{ id, status: 'done' }]));
  const allowed = spawnSync('sh', ['-c', 'node "$1" && node -e "require(\'fs\').writeFileSync(process.argv[1], \'started\')" "$2"', 'fixture', guard, marker], { cwd: root, encoding: 'utf8' });
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(await readFile(marker, 'utf8'), 'started');
});

test('startup validates registered worktree identity and branch before launching', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'studio-worktree-check-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const args of [['init', '-b', 'main'], ['config', 'user.name', 'Test'], ['config', 'user.email', 'test@example.invalid'], ['commit', '--allow-empty', '-m', 'fixture']]) execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  const id = '12345678-1234-1234-1234-123456789012', other = '12345678-1234-1234-1234-123456789013';
  const index = join(root, '.ai/cezar/runs.json'), worktree = join(root, '.ai/cezar/worktrees', id);
  await mkdir(join(root, '.ai/cezar/worktrees'), { recursive: true });
  execFileSync('git', ['worktree', 'add', '-b', 'fixture-feature', worktree], { cwd: root, stdio: 'ignore' });
  const write = async (path, branch = 'fixture-feature') => writeFile(index, JSON.stringify([{ id, status: 'review', worktreePath: path, branch }]));
  await write(worktree);
  await checkStartup(root);
  for (const status of ['queued', 'running', 'waiting']) {
    await writeFile(index, JSON.stringify([{ id, status, worktreePath: worktree, branch: 'fixture-feature' }]));
    await assert.rejects(checkStartup(root), /requires operator review/);
  }
  await writeFile(index, JSON.stringify([{ id, status: 'failed', autoResumeAt: '2026-01-01T00:00:00Z', worktreePath: worktree, branch: 'fixture-feature' }]));
  await assert.rejects(checkStartup(root), /requires operator review/);
  for (const path of [root, join(root, '.ai/cezar/worktrees', other), 'relative/path', `${worktree}-missing`]) {
    await write(path);
    await assert.rejects(checkStartup(root), /invalid or mismatched worktree/);
  }
  await write(worktree, 'main');
  await assert.rejects(checkStartup(root), /invalid or mismatched worktree/);
  for (const branch of [null, '', '   ', 0]) {
    await writeFile(index, JSON.stringify([{ id, status: 'review', worktreePath: worktree, branch }]));
    await assert.rejects(checkStartup(root), /invalid or mismatched worktree/);
  }
  await writeFile(index, JSON.stringify([{ id, status: 'review', worktreePath: worktree }]));
  await assert.rejects(checkStartup(root), /invalid or mismatched worktree/);
  const marker = join(root, 'worker-started');
  const attempt = spawnSync('sh', ['-c', 'node "$1" && node -e "require(\'fs\').writeFileSync(process.argv[1], \'started\')" "$2"', 'fixture', resolve('studio/startup-guard.mjs'), marker], { cwd: root, encoding: 'utf8' });
  assert.notEqual(attempt.status, 0);
  assert.match(attempt.stderr, /startup blocked.*invalid or mismatched worktree/);
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
  const symlinkId = '12345678-1234-1234-1234-123456789014';
  await symlink(worktree, join(root, '.ai/cezar/worktrees', symlinkId));
  await writeFile(index, JSON.stringify([{ id: symlinkId, status: 'waiting', worktreePath: join(root, '.ai/cezar/worktrees', symlinkId) }]));
  await assert.rejects(checkStartup(root), /invalid or mismatched worktree/);
  await writeFile(index, JSON.stringify([{ id: other, status: 'review', worktreePath: join(root, '.ai/cezar/worktrees', other) }]));
  await mkdir(join(root, '.ai/cezar/worktrees', other));
  await assert.rejects(checkStartup(root), /invalid or mismatched worktree/);
  assert.equal(execFileSync('git', ['-C', worktree, 'branch', '--show-current'], { encoding: 'utf8' }).trim(), 'fixture-feature');
});

test('startup permits a fresh project and settled runs', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'studio-startup-fresh-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await checkStartup(root);
  await mkdir(join(root, '.ai/cezar'), { recursive: true });
  await writeFile(join(root, '.ai/cezar/runs.json'), JSON.stringify([{ id: '12345678-1234-1234-1234-123456789012', status: 'done' }]));
  await checkStartup(root);
});

test('startup refuses unresolved deferred launches even without a run index', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'studio-startup-deferred-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = join(root, '.ai/cezar'), file = join(data, 'automations.json');
  await mkdir(data, { recursive: true });
  const id = '12345678-1234-1234-1234-123456789012';
  const enabled = JSON.stringify({ version: 1, automations: [{ id, enabled: true, deferredStart: { status: 'pending', runIds: [] } }] });
  await writeFile(file, enabled);
  await assert.rejects(checkStartup(root), /deferred launch.*operator review/);
  assert.equal(await readFile(file, 'utf8'), enabled);
  for (const deferredStart of [
    { status: 'launching', runIds: [] },
    { status: 'launching', runIds: [id] },
    { status: 'failed', failureKind: 'ambiguous', runIds: [] },
    { status: 'failed', failureKind: 'ambiguous', runIds: [id] },
    { status: 'pending', runIds: [id] },
    { status: 'pending', manualRequested: true, runIds: [] },
  ]) {
    const content = JSON.stringify({ version: 1, automations: [{ id, deferredStart }] });
    await writeFile(file, content);
    await assert.rejects(checkStartup(root), /deferred launch.*operator review/);
    assert.equal(await readFile(file, 'utf8'), content);
  }
  const marker = join(root, 'worker-started');
  const attempt = spawnSync('sh', ['-c', 'node "$1" && node -e "require(\'fs\').writeFileSync(process.argv[1], \'started\')" "$2"', 'fixture', resolve('studio/startup-guard.mjs'), marker], { cwd: root, encoding: 'utf8' });
  assert.notEqual(attempt.status, 0);
  assert.match(attempt.stderr, /deferred launch.*operator review/);
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
  for (const content of ['{', '{}', JSON.stringify({ version: 1, automations: [{ id, deferredStart: { status: 'unknown', runIds: [] } }] })]) {
    await writeFile(file, content);
    await assert.rejects(checkStartup(root), /invalid.*automation|unrecognized.*deferred/);
    assert.equal(await readFile(file, 'utf8'), content);
  }
  await writeFile(file, JSON.stringify({ version: 1, automations: [
    { id, deferredStart: { status: 'pending', runIds: [] } },
    { id: 'ordinary' },
    { id: 'failed', deferredStart: { status: 'failed', failureKind: 'transient', runIds: [] } },
  ] }));
  await checkStartup(root);
});

test('startup refuses an on-disk worktree missing from a stale index without modifying it', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'studio-startup-unindexed-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const id = '12345678-1234-1234-1234-123456789012';
  const data = join(root, '.ai/cezar'), worktree = join(data, 'worktrees', id);
  await mkdir(worktree, { recursive: true });
  await writeFile(join(worktree, '.git'), 'preserve fixture');
  await writeFile(join(data, 'runs.json'), '[]');
  await assert.rejects(checkStartup(root), /unindexed Cezar worktree/);
  const marker = join(root, 'launched');
  const attempt = spawnSync('sh', ['-c', 'node "$1" && node -e "require(\'fs\').writeFileSync(process.argv[1], \'started\')" "$2"', 'fixture', resolve('studio/startup-guard.mjs'), marker], { cwd: root, encoding: 'utf8' });
  assert.notEqual(attempt.status, 0);
  assert.match(attempt.stderr, /unindexed Cezar worktree/);
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
  assert.equal(await readFile(join(data, 'runs.json'), 'utf8'), '[]');
  assert.equal(await readFile(join(worktree, '.git'), 'utf8'), 'preserve fixture');
});

test('startup refuses an unindexed Cezar event log and preserves it', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'studio-startup-events-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = join(root, '.ai/cezar'), id = '12345678-1234-1234-1234-123456789012';
  await mkdir(join(data, 'runs'), { recursive: true });
  await writeFile(join(data, 'runs.json'), '[]');
  const log = join(data, 'runs', `${id}.ndjson`);
  await writeFile(log, 'fixture event\n');
  await assert.rejects(checkStartup(root), /unindexed Cezar event log/);
  const marker = join(root, 'launched');
  const attempt = spawnSync('sh', ['-c', 'node "$1" && node -e "require(\'fs\').writeFileSync(process.argv[1], \'started\')" "$2"', 'fixture', resolve('studio/startup-guard.mjs'), marker], { cwd: root, encoding: 'utf8' });
  assert.notEqual(attempt.status, 0);
  assert.match(attempt.stderr, /unindexed Cezar event log/);
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
  assert.equal(await readFile(log, 'utf8'), 'fixture event\n');
  await writeFile(join(data, 'runs.json'), JSON.stringify([{ id, status: 'done' }]));
  await checkStartup(root);
});
