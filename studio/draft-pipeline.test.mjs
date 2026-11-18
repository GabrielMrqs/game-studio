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

test('automatic merge requires the exact GitHub Actions check, strict protection and the PR head', async () => {
  const repo = 'owner/game';
  const sha = 'a'.repeat(40);
  const main = 'b'.repeat(40);
  const job = { id: 'linear-id', sha, branch: 'feature/GAB-1-demo', pr: 1 };
  const pr = {
    number: 1, html_url: `https://github.com/${repo}/pull/1`, body: '<!-- studio-issue:linear-id -->',
    head: { ref: job.branch, sha, repo: { full_name: repo } },
    base: { ref: 'main', sha: main, repo: { full_name: repo } },
    state: 'open', draft: false, mergeable: true, mergeable_state: 'clean',
  };
  let runs = [];
  let writes = 0;
  let protectedMain = false;
  const gh = github(repo, 'github_pat_fixture', new AbortController().signal, async (url, options) => {
    const path = new URL(url).pathname.replace(`/repos/${repo}`, '');
    if (options.method === 'PUT') {
      assert.equal(path, '/pulls/1/merge');
      assert.deepEqual(JSON.parse(options.body), { sha, merge_method: 'merge' });
      writes++;
      return Response.json({ merged: true, sha });
    }
    if (path === '/pulls/1') return Response.json(pr);
    if (path.endsWith('/check-runs')) return Response.json({ total_count: runs.length, check_runs: runs });
    if (path === '/actions/jobs/123') return Response.json({ steps: [{ name: 'Godot QA', conclusion: 'failure' }] });
    if (path === '/actions/jobs/123/logs') return new Response(null, { status: 302, headers: {
      location: 'https://example.blob.core.windows.net/log',
    } });
    if (new URL(url).hostname === 'example.blob.core.windows.net') {
      assert.equal(options.headers, undefined);
      return new Response('ERROR: UI assertion failed\nAuthorization: fake value');
    }
    if (path === '/branches/main') return Response.json({ protected: protectedMain });
    if (path === '/rules/branches/main') return Response.json([
      ...['pull_request', 'deletion', 'non_fast_forward'].map(type => ({ type })),
      { type: 'required_status_checks', parameters: {
        strict_required_status_checks_policy: true, required_status_checks: [{ context: 'test', integration_id: 15368 }],
      } },
    ]);
    assert.equal(path, '');
    return Response.json({ default_branch: 'main', allow_merge_commit: true });
  });
  await gh.advance(job, main);
  const check = { id: 123, details_url: `https://github.com/${repo}/actions/runs/456/job/123`,
    name: 'test', app: { id: 15368 }, head_sha: sha, status: 'completed', conclusion: 'success' };
  runs = [{ ...check, head_sha: main }];
  await gh.advance(job, main);
  runs = [{ ...check, conclusion: 'failure' }];
  const { failure } = await gh.advance(job, main);
  assert.match(failure, /Godot QA[\s\S]*UI assertion failed/);
  assert.doesNotMatch(failure, /fake value/);
  runs = [check];
  await assert.rejects(gh.advance(job, main), /protected/);
  assert.equal(writes, 0);
  protectedMain = true;
  assert.deepEqual(await gh.advance(job, main), { merge: sha });
  assert.equal(writes, 1);
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

test('resumes after commit and ambiguous PR creation; repairs hosted failures and writes Done only after fetching the merge', async t => {
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
  const [parent, child] = [1, 2].map(issue);
  const issueList = [child, parent];
  const attachments = new Map();
  const calls = [];
  const linear = {
    async *ready() { yield* issueList; },
    async dependencies(id) { return id === child.id && !attachments.has(parent.id) ? [parent] : []; },
    async start(id) { calls.push(id); },
    async integrated(id, url, sha) { attachments.set(id, { url, sha }); },
    async blocker(id, reason) { assert.fail(`${id}: ${reason}`); },
  };
  const prs = [];
  let postCount = 0;
  let edits = 0;
  let validations = 0;
  let controller;
  let crash = true;
  const remote = new Map();
  const game = {
    async edit(work, dir, idea, feedback) {
      edits++;
      writeFileSync(join(work, `game-${idea.at(-1)}`), idea + feedback);
    },
    async validate(work) {
      validations++;
      if (validations === 1) throw new Error('Godot error');
      git(work, 'add', '.');
      return { tree: git(work, 'write-tree').trim() };
    },
  };
  let confirmation;
  let hostedFailed = false;
  const fetcher = async (input, options) => {
    const url = new URL(input);
    if (options.method === 'POST') {
      const { head, base, draft, body } = JSON.parse(options.body);
      assert.equal(draft, undefined);
      assert.equal(base, 'main');
      assert.match(body, /Godot QA/);
      const pr = {
        number: ++postCount, state: 'open', body, head: { ref: head, repo: { full_name: 'owner/game' } },
        base: { ref: base, repo: { full_name: 'owner/game' } }, draft, html_url: `https://github.com/owner/game/pull/${postCount}`,
      };
      prs.push(pr);
      if (postCount === 1) throw new Error('connection lost after PR creation');
    }
    const matching = prs.filter(pr => `owner:${pr.head.ref}` === url.searchParams.get('head'))
      .map(pr => ({ ...pr, head: { ...pr.head, sha: remote.get(pr.head.ref) } }));
    return Response.json(options.method === 'POST' ? {
      ...prs.at(-1), head: { ...prs.at(-1).head, sha: remote.get(prs.at(-1).head.ref) },
    } : matching);
  };
  function restart() {
    controller = new AbortController();
    const signal = controller.signal;
    const repo = draftGit(root, root, 'owner/game', '/unused', signal, new Map());
    const adapters = {
      ...repo, remoteTip: branch => remote.get(branch),
      push: async job => {
        assert.equal(g('rev-parse', `refs/heads/${job.branch}`), job.sha);
        assert.equal(remote.get(job.branch), job.previous);
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
    const gh = github('owner/game', 'github_pat_fixture', signal, fetcher);
    gh.advance = async job => {
      if (job.identifier !== parent.identifier) return;
      if (!hostedFailed) {
        hostedFailed = true;
        return { failure: 'Repair hosted Godot failure.' };
      }
      return confirmation;
    };
    return pipeline({
      storage: journal(root), dir: root, git: adapters, github: gh, linear, game, signal,
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
  assert.equal(journal(root).jobs()[0].previous, committed);
  assert.equal(validations, 2);
  assert.equal(edits, 2);
  assert.equal(postCount, 1);
  assert.equal(attachments.size, 0);
  await tick(main);
  const repaired = journal(root).jobs()[0].sha;
  assert.equal(g('show', '-s', '--format=%P', repaired), committed);
  assert.equal(postCount, 1);
  confirmation = { merge: g('commit-tree', `${repaired}^{tree}`, '-p', main, '-p', repaired, '-m', 'merge') };
  await tick(main);
  assert.equal(attachments.size, 0);
  await tick(confirmation.merge);
  assert.deepEqual(attachments.get(parent.id), { url: prs[0].html_url, sha: confirmation.merge });
  assert.deepEqual(calls, [parent.id, child.id]);
  assert.equal(journal(root).jobs().find(job => job.id === child.id).base, confirmation.merge);
  assert.equal(postCount, 2);
});
