import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { draftGit } from './draft-git.mjs';
import { journal, pipeline } from './draft-pipeline.mjs';
import { github, retry, Transient } from './github.mjs';
import { git } from './once.mjs';

test('bounded backoff honors retry hints', async () => {
  const delays = [];
  let calls = 0;
  await assert.rejects(retry(() => {
    calls++;
    throw new Transient('offline', 600);
  }, new AbortController().signal, async delay => delays.push(delay)), /offline/);
  assert.deepEqual(delays, [600, 1000, 2000]);
  assert.equal(calls, 4);
});

test('imports recovery edits across unrelated histories only with a matching baseline and untouched paths', t => {
  const root = mkdtempSync(join(tmpdir(), 'draft-bootstrap-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const g = (...args) => git(root, ...args).trim();
  g('init', '-qb', 'legacy');
  g('config', 'user.name', 'Studio Fixture');
  g('config', 'user.email', 'fixture@example.invalid');
  mkdirSync(join(root, 'game'));
  const source = join(root, 'game/main.gd');
  writeFileSync(source, '# baseline\n');
  g('add', 'game');
  g('commit', '-qm', 'legacy');
  const base = g('rev-parse', 'HEAD');
  const tree = g('rev-parse', 'HEAD^{tree}');
  const imported = g('commit-tree', tree, '-m', 'unrelated bootstrap');
  writeFileSync(source, '# recovered\n');
  const dir = join(root, '.git', 'drafts');
  const ids = ['match', 'wrong-tree', 'overlap'];
  const repo = draftGit(root, dir, 'owner/game', '/unused', new AbortController().signal,
    new Map(ids.map(id => [id, { base, work: root }])));
  assert.equal(repo.contains(base, imported), false);
  const work = repo.workspace({ id: 'match', base: imported });
  assert.equal(readFileSync(join(work, 'game/main.gd'), 'utf8'), '# recovered\n');
  assert.equal(readFileSync(source, 'utf8'), '# recovered\n');

  g('add', 'game');
  const changed = g('write-tree');
  g('read-tree', base);
  const unrelated = g('commit-tree', changed, '-m', 'unrelated and different');
  assert.throws(() => repo.workspace({ id: 'wrong-tree', base: unrelated }), /exact recovery game tree/);
  const overlap = g('commit-tree', changed, '-p', imported, '-m', 'main touched the same path');
  assert.throws(() => repo.workspace({ id: 'overlap', base: overlap }), /overlap changes/);
});

test('resumes after commit and ambiguous PR creation; tests, stacks and retargets exact commits', async t => {
  const root = mkdtempSync(join(tmpdir(), 'draft-studio-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const g = (...args) => git(root, ...args).trim();
  g('init', '-qb', 'main');
  g('config', 'user.name', 'Studio Fixture');
  g('config', 'user.email', 'fixture@example.invalid');
  g('commit', '--allow-empty', '-qm', 'main');
  const main = g('rev-parse', 'HEAD');
  const issue = n => ({
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    identifier: `GAB-${n}`, title: `Game item ${n}`, url: `https://linear.app/team/issue/GAB-${n}`,
  });
  const [parent, child, broken, independent] = [1, 2, 3, 4].map(issue);
  const issueList = [parent];
  const attachments = new Map();
  const blockers = new Map();
  const calls = [];
  const linear = {
    async *ready() { yield* issueList; },
    async dependencies(id) { return id === child.id ? [parent] : []; },
    async state(id, state) { calls.push([id, state]); },
    async attach(id, url) { attachments.set(id, url); },
    async blocker(id, reason) { blockers.set(id, reason); },
  };
  const prs = [];
  let postCount = 0;
  let edits = 0;
  let validations = 0;
  let controller;
  let crash = true;
  const remote = new Map();
  const game = {
    async edit(work, dir, idea) {
      edits++;
      writeFileSync(join(work, `game-${idea.at(-1)}`), idea);
    },
    async validate(work) {
      validations++;
      if (validations === 1) throw new Error('Godot error');
      if (git(work, 'status', '--short').includes('game-3')) throw new Error('Persistent Godot error');
      git(work, 'add', '.');
      return { tree: git(work, 'write-tree').trim() };
    },
  };
  const fetcher = async (input, options) => {
    const url = new URL(input);
    if (options.method === 'POST') {
      const { head, base, draft, body } = JSON.parse(options.body);
      assert.equal(draft, true);
      assert.match(body, /Visual quality is unverified/);
      const pr = {
        number: ++postCount, state: 'open', body, head: { ref: head, sha: remote.get(head) },
        base: { ref: base }, draft, html_url: `https://github.com/owner/game/pull/${postCount}`,
      };
      prs.push(pr);
      if (postCount === 1) throw new Error('connection lost after PR creation');
      return Response.json(pr);
    }
    if (url.searchParams.has('head')) return Response.json(prs.filter(pr => `owner:${pr.head.ref}` === url.searchParams.get('head')));
    const pr = prs[Number(url.pathname.split('/').at(-1)) - 1];
    if (options.method === 'PATCH') pr.base.ref = JSON.parse(options.body).base;
    return Response.json(pr);
  };
  function restart() {
    controller = new AbortController();
    const signal = controller.signal;
    const repo = draftGit(root, root, 'owner/game', '/unused', signal, new Map());
    const adapters = {
      ...repo, remoteTip: branch => remote.get(branch),
      push: async job => {
        assert.equal(g('rev-parse', `refs/heads/${job.branch}`), job.sha);
        remote.set(job.branch, job.sha);
      },
      commit: job => {
        const sha = repo.commit(job);
        if (crash) {
          crash = false;
          controller.abort();
          throw new Error('killed before saving SHA');
        }
        return sha;
      },
    };
    return pipeline({
      storage: journal(root), dir: root, git: adapters, github: github('owner/game', 'github_pat_fixture', signal, fetcher),
      linear, game, signal, report: () => {},
    });
  }
  let tick = restart();
  await tick(main);
  assert.equal(journal(root).jobs()[0].attempts, 1);
  await assert.rejects(tick(main), { name: 'AbortError' });
  const saved = journal(root).jobs()[0];
  assert.ok(saved.tree);
  assert.equal(saved.sha, undefined);
  const committed = g('rev-parse', saved.branch);
  assert.equal(edits, 2);
  tick = restart();
  await tick(main);
  assert.equal(journal(root).jobs()[0].sha, committed);
  assert.equal(validations, 2);
  assert.equal(edits, 2);
  assert.equal(postCount, 1);
  assert.equal(attachments.get(parent.id), prs[0].html_url);
  assert.deepEqual(calls, [[parent.id, 'progress'], [parent.id, 'review']]);

  issueList.push(child, broken, independent);
  await tick(main);
  const childPR = prs.find(pr => pr.head.ref.startsWith('feature/GAB-2'));
  assert.equal(childPR.base.ref, saved.branch);
  assert.equal(g('diff', '--name-only', committed, childPR.head.sha), 'game-2');
  assert.equal(prs.find(pr => pr.head.ref.startsWith('feature/GAB-4')).base.ref, 'main');
  for (let i = 0; i < 5; i++) await tick(committed);
  assert.equal(childPR.base.ref, 'main');
  assert.equal(postCount, 3);
  assert.match(blockers.get(broken.id), /after four checkpoints/);
});
