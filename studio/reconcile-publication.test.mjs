import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { reconcilePublication } from './reconcile-publication.mjs';

test('publication recovery marks only an evidenced existing PR and comment done', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'studio-publication-recovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const db = new DatabaseSync(join(root, 'publish.sqlite'));
  db.exec('CREATE TABLE publications (repo TEXT, branch TEXT, issue TEXT, sha TEXT, phase TEXT, pr_url TEXT, PRIMARY KEY(repo,branch))');
  const issue = '12345678-1234-1234-1234-123456789012', sha = 'a'.repeat(40), url = 'https://github.com/acme/game/pull/42';
  db.prepare('INSERT INTO publications VALUES (?,?,?,?,?,?)').run('acme/game', 'cez/fixture', issue, sha, 'comment_pending', url);
  db.exec("ALTER TABLE publications ADD COLUMN base_branch TEXT; UPDATE publications SET base_branch='main'");
  let comments = [`Draft PR ready for review: ${url}`], prSha = sha, prBase = 'main', writes = 0, changeReceipt = false;
  const fetcher = async (target, options) => {
    if (String(target).includes('api.github.com')) {
      assert.equal(options.method, undefined);
      return Response.json({ html_url: url, draft: true, head: { ref: 'cez/fixture', sha: prSha, repo: { full_name: 'acme/game' } }, base: { ref: prBase, repo: { full_name: 'acme/game' } } });
    }
    const body = JSON.parse(options.body);
    if (!body.query.startsWith('query ')) writes++;
    assert.equal(body.variables.id, issue);
    if (changeReceipt) db.exec("UPDATE publications SET phase='conflict'");
    return Response.json({ data: { issue: { id: issue, comments: { nodes: comments.map((body) => ({ body })), pageInfo: { hasNextPage: false, endCursor: null } } } } });
  };
  const args = { state: root, repo: 'acme/game', branch: 'cez/fixture', githubToken: 'fixture', linearKey: 'fixture', fetcher };
  assert.equal((await reconcilePublication(args)).matchingComments, 1);
  assert.equal(db.prepare('SELECT phase FROM publications').get().phase, 'comment_pending');
  comments = [];
  await assert.rejects(reconcilePublication({ ...args, confirmStopped: true }), /exactly one/);
  comments = [1, 2].map(() => `Draft PR ready for review: ${url}`);
  await assert.rejects(reconcilePublication({ ...args, confirmStopped: true }), /exactly one/);
  comments.pop();
  prSha = 'b'.repeat(40);
  await assert.rejects(reconcilePublication({ ...args, confirmStopped: true }), /does not match/);
  prSha = sha;
  prBase = 'wrong';
  await assert.rejects(reconcilePublication({ ...args, confirmStopped: true }), /base does not match/);
  prBase = 'main';
  changeReceipt = true;
  await assert.rejects(reconcilePublication({ ...args, confirmStopped: true }), /receipt changed/);
  db.exec("UPDATE publications SET phase='comment_pending'");
  changeReceipt = false;
  assert.equal((await reconcilePublication({ ...args, confirmStopped: true })).phase, 'done');
  assert.equal(db.prepare('SELECT phase FROM publications').get().phase, 'done');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM publication_recovery_audit').get().n, 1);
  await assert.rejects(reconcilePublication({ ...args, confirmStopped: true }), /only claimed, pushing, pr_pending and comment_pending/);
  assert.equal(writes, 0);
  db.close();
});

test('push recovery records only the exact existing remote feature ref', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'studio-push-recovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const db = new DatabaseSync(join(root, 'publish.sqlite'));
  db.exec('CREATE TABLE publications (repo TEXT, branch TEXT, issue TEXT, sha TEXT, phase TEXT, pr_url TEXT, PRIMARY KEY(repo,branch))');
  const issue = '12345678-1234-1234-1234-123456789012', sha = 'a'.repeat(40);
  db.prepare('INSERT INTO publications VALUES (?,?,?,?,?,?)').run('acme/game', 'cez/fixture', issue, sha, 'pushing', null);
  let status = 200, ref = { ref: 'refs/heads/cez/fixture', object: { type: 'commit', sha } }, change = false;
  const fetcher = async (target, options) => {
    assert.equal(options.method, undefined);
    assert.equal(String(target), 'https://api.github.com/repos/acme/game/git/ref/heads/cez/fixture');
    if (change) db.exec("UPDATE publications SET phase='conflict'");
    return Response.json(ref, { status });
  };
  const args = { state: root, repo: 'acme/game', branch: 'cez/fixture', githubToken: 'fixture', linearKey: 'fixture', fetcher };
  await assert.rejects(reconcilePublication({ ...args, branch: 'cez/../main' }), /valid repository/);
  assert.equal((await reconcilePublication(args)).remote_ref, 'refs/heads/cez/fixture');
  assert.equal(db.prepare('SELECT phase FROM publications').get().phase, 'pushing');
  status = 404;
  await assert.rejects(reconcilePublication({ ...args, confirmStopped: true }), /HTTP 404/);
  status = 200;
  for (const wrong of [{ ref: 'refs/heads/main', object: { type: 'commit', sha } }, { ref: 'refs/heads/cez/fixture', object: { type: 'commit', sha: 'b'.repeat(40) } }, { ref: 'refs/heads/cez/fixture', object: { type: 'tag', sha } }]) {
    ref = wrong;
    await assert.rejects(reconcilePublication({ ...args, confirmStopped: true }), /does not match/);
  }
  ref = { ref: 'refs/heads/cez/fixture', object: { type: 'commit', sha } }; change = true;
  await assert.rejects(reconcilePublication({ ...args, confirmStopped: true }), /receipt changed/);
  db.exec("UPDATE publications SET phase='pushing'");
  change = false;
  assert.equal((await reconcilePublication({ ...args, confirmStopped: true })).phase, 'pr_pending');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM publication_push_recovery_audit').get().n, 1);
  assert.equal(db.prepare('SELECT phase FROM publications').get().phase, 'pr_pending');
  db.close();
});

test('PR recovery records only one matching existing draft without remote writes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'studio-pr-recovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const db = new DatabaseSync(join(root, 'publish.sqlite'));
  db.exec('CREATE TABLE publications (repo TEXT, branch TEXT, issue TEXT, sha TEXT, phase TEXT, pr_url TEXT, PRIMARY KEY(repo,branch))');
  const issue = '12345678-1234-1234-1234-123456789012', sha = 'a'.repeat(40), url = 'https://github.com/acme/game/pull/42';
  db.prepare('INSERT INTO publications VALUES (?,?,?,?,?,?)').run('acme/game', 'cez/fixture', issue, sha, 'pr_pending', null);
  db.exec("ALTER TABLE publications ADD COLUMN base_branch TEXT; UPDATE publications SET base_branch='main'");
  const pr = { html_url: url, draft: true, state: 'open', body: `Linear issue: ${issue}\n\nReview and merge manually.`, head: { ref: 'cez/fixture', sha, repo: { full_name: 'acme/game' } }, base: { ref: 'main', repo: { full_name: 'acme/game' } } };
  let pulls = [pr], linked = false, calls = 0, change = false;
  const fetcher = async (target, options) => {
    calls++;
    assert.equal(options.method, undefined);
    assert.equal(new URL(target).searchParams.get('state'), 'all');
    if (change === 'base') db.exec("UPDATE publications SET base_branch='changed'");
    else if (change) db.exec("UPDATE publications SET phase='conflict'");
    return Response.json(pulls, { headers: linked ? { link: '<https://example.invalid>; rel="next"' } : {} });
  };
  const args = { state: root, repo: 'acme/game', branch: 'cez/fixture', githubToken: 'fixture', linearKey: 'fixture', fetcher };
  assert.equal((await reconcilePublication(args)).found_pr_url, url);
  assert.equal(db.prepare('SELECT phase FROM publications').get().phase, 'pr_pending');
  db.exec('UPDATE publications SET base_branch=NULL');
  assert.equal((await reconcilePublication(args)).observed_base, 'main');
  await assert.rejects(reconcilePublication({ ...args, confirmStopped: true }), /legacy receipt has no recorded base/);
  db.exec("UPDATE publications SET base_branch='main'");
  for (const variants of [[], [pr, pr], [{ ...pr, draft: false }], [{ ...pr, body: 'different issue' }], [{ ...pr, head: { ...pr.head, sha: 'b'.repeat(40) } }], [{ ...pr, base: { ...pr.base, ref: 'other' } }], [{ ...pr, base: { ...pr.base, repo: { full_name: 'other/game' } } }]]) {
    pulls = variants;
    await assert.rejects(reconcilePublication({ ...args, confirmStopped: true }));
  }
  pulls = [pr]; linked = true;
  await assert.rejects(reconcilePublication({ ...args, confirmStopped: true }), /complete PR result/);
  linked = false; change = true;
  await assert.rejects(reconcilePublication({ ...args, confirmStopped: true }), /receipt changed/);
  db.exec("UPDATE publications SET phase='pr_pending'");
  change = 'base';
  await assert.rejects(reconcilePublication({ ...args, confirmStopped: true }), /receipt changed/);
  db.exec("UPDATE publications SET base_branch='main'");
  change = false;
  assert.equal((await reconcilePublication({ ...args, confirmStopped: true })).phase, 'comment_pending');
  const receipt = db.prepare('SELECT phase, pr_url FROM publications').get();
  assert.equal(receipt.phase, 'comment_pending');
  assert.equal(receipt.pr_url, url);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM publication_pr_recovery_audit').get().n, 1);
  assert.ok(calls >= 9);
  db.close();
});

test('claim recovery requires an existing unique matching draft and explicit confirmation', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'studio-claim-recovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const db = new DatabaseSync(join(root, 'publish.sqlite'));
  db.exec('CREATE TABLE publications (repo TEXT, branch TEXT, issue TEXT, sha TEXT, phase TEXT, pr_url TEXT, PRIMARY KEY(repo,branch))');
  const issue = '12345678-1234-1234-1234-123456789012', sha = 'a'.repeat(40), url = 'https://github.com/acme/game/pull/42';
  db.prepare('INSERT INTO publications VALUES (?,?,?,?,?,?)').run('acme/game', 'cez/fixture', issue, sha, 'claimed', null);
  db.exec("ALTER TABLE publications ADD COLUMN base_branch TEXT; UPDATE publications SET base_branch='main'");
  const pr = { html_url: url, draft: true, state: 'open', body: `Linear issue: ${issue}\n\nReview and merge manually.`, head: { ref: 'cez/fixture', sha, repo: { full_name: 'acme/game' } }, base: { ref: 'main', repo: { full_name: 'acme/game' } } };
  let pulls = [], change = false, writes = 0;
  const fetcher = async (target, options) => {
    if (options.method) writes++;
    assert.equal(new URL(target).searchParams.get('state'), 'all');
    if (change) db.exec("UPDATE publications SET phase='pushing'");
    return Response.json(pulls);
  };
  const args = { state: root, repo: 'acme/game', branch: 'cez/fixture', githubToken: 'fixture', linearKey: 'fixture', fetcher };
  await assert.rejects(reconcilePublication({ ...args, confirmStopped: true }), /exactly one/);
  pulls = [pr, pr];
  await assert.rejects(reconcilePublication({ ...args, confirmStopped: true }), /exactly one/);
  pulls = [{ ...pr, head: { ...pr.head, sha: 'b'.repeat(40) } }];
  await assert.rejects(reconcilePublication({ ...args, confirmStopped: true }), /does not match/);
  pulls = [pr];
  assert.equal((await reconcilePublication(args)).found_pr_url, url);
  assert.equal(db.prepare('SELECT phase FROM publications').get().phase, 'claimed');
  change = true;
  await assert.rejects(reconcilePublication({ ...args, confirmStopped: true }), /receipt changed/);
  db.exec("UPDATE publications SET phase='claimed'");
  change = false;
  assert.equal((await reconcilePublication({ ...args, confirmStopped: true })).phase, 'comment_pending');
  assert.equal(db.prepare('SELECT pr_url FROM publications').get().pr_url, url);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM publication_claim_recovery_audit').get().n, 1);
  assert.equal(writes, 0);
  db.close();
});
