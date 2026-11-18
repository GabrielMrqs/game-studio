import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';

test('Cezar concurrency configuration cannot be used as a zero-capacity launch barrier', async () => {
  const require = createRequire(import.meta.url);
  const cezar = dirname(require.resolve('@open-mercato/cezar/package.json'));
  const { workspaceConfigSchema } = await import(pathToFileURL(join(cezar, 'dist/workspace/config.js')));
  const parsed = workspaceConfigSchema.parse({ resources: { maxParallel: 0 } });
  assert.equal(parsed.resources.maxParallel, 2);
});

test('feature graph validates with Cezar and cannot push or merge', async () => {
  const require = createRequire(import.meta.url);
  const cezar = dirname(require.resolve('@open-mercato/cezar/package.json'));
  const { parse } = await import('yaml');
  const { workflowGraphFileSchema, graphIssues } = await import(pathToFileURL(join(cezar, 'dist/workflows/graph.js')));
  const graph = workflowGraphFileSchema.parse(parse(await readFile('.ai/cezar/workflows/studio-feature.yaml', 'utf8')));
  assert.deepEqual(graphIssues(graph), []);
  assert.ok(!graph.nodes.some((node) => node.type.startsWith('github.') || node.type === 'git.push'));
  assert.ok(graph.edges.some((edge) => edge.from === 'review.approve' && edge.to === 'commit'));
  for (const [from, to] of [['implement.done', 'narrative'], ['narrative.done', 'art_ui'], ['art_ui.done', 'install']]) {
    assert.ok(graph.edges.some((edge) => edge.from === from && edge.to === to));
  }
  assert.ok(graph.edges.some((edge) => edge.from === 'test.pass' && edge.to === 'game'));
  assert.ok(graph.edges.some((edge) => edge.from === 'game.pass' && edge.to === 'qa'));
  assert.ok(graph.edges.some((edge) => edge.from === 'qa.pass' && edge.to === 'review'));
  assert.ok(graph.edges.some((edge) => edge.from === 'qa.fail' && edge.to === 'retry'));
  assert.ok(graph.edges.some((edge) => edge.from === 'game.fail' && edge.to === 'retry'));
  assert.ok(graph.edges.some((edge) => edge.from === 'retry.exhausted' && edge.to === 'blocked'));
});

test('Cezar routes check failures and independent review through bounded retries', async () => {
  const require = createRequire(import.meta.url);
  const cezar = dirname(require.resolve('@open-mercato/cezar/package.json'));
  const { parse } = await import('yaml');
  const { workflowGraphFileSchema, advance } = await import(pathToFileURL(join(cezar, 'dist/workflows/graph.js')));
  const graph = workflowGraphFileSchema.parse(parse(await readFile('.ai/cezar/workflows/studio-feature.yaml', 'utf8')));
  const counts = new Map();
  assert.equal(advance(graph, 'test', 'fail', counts).node.id, 'fix');
  assert.equal(advance(graph, 'fix', 'done', counts).node.id, 'test');
  assert.equal(advance(graph, 'review', 'changes', counts).node.id, 'fix');
  assert.equal(advance(graph, 'review', 'changes', counts).status, 'failed');
  assert.equal(advance(graph, 'review', 'approve', new Map()).node.id, 'commit');
  assert.equal(advance(graph, 'qa', 'fail', new Map()).node.id, 'fix');
  assert.equal(advance(graph, 'commit', 'nothing', new Map()).node.id, 'branch_check');
  assert.equal(advance(graph, 'branch_check', 'fail', new Map()).status, 'failed');
});

test('branch gate accepts autosaved commits but rejects empty, dirty and base branches', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'studio-branch-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  const check = (branch = 'feature') => spawnSync(process.execPath, [join(process.cwd(), 'studio/verify-branch.mjs')], { cwd: root, env: { ...process.env, CEZ_BASE: 'main', CEZ_BRANCH: branch }, encoding: 'utf8' });
  git('init', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
  await writeFile(join(root, 'file'), 'base');
  git('add', 'file');
  git('commit', '-m', 'base');
  assert.notEqual(check('main').status, 0);
  git('switch', '-c', 'feature');
  assert.notEqual(check().status, 0);
  await writeFile(join(root, 'file'), 'feature');
  git('add', 'file');
  git('commit', '-m', 'cezar autosave');
  assert.equal(check().status, 0);
  await writeFile(join(root, 'file'), 'dirty');
  assert.notEqual(check().status, 0);
});
