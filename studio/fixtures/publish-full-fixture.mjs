// Explicit approval in a disposable fixture; endpoints and keys are synthetic.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { generateKeyPairSync, sign } from 'node:crypto';
import { publishRun } from '../publish-run.mjs';
import { publish } from '../publish.mjs';

if (process.argv[2] !== '--approve') throw new Error('fixture publication requires --approve');
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const db = new DatabaseSync('/handoff/inbox.sqlite', { readOnly: true });
const { run_id: id, source_id: issue } = db.prepare('SELECT run_id, source_id FROM receipts').get();
db.close();
const run = await (await fetch(`http://127.0.0.1:14321/api/v1/runs/${id}`)).json();
git('/project', 'init', '--bare', '/tmp/mock-remote.git');
git('/project', '--git-dir', '/tmp/mock-remote.git', 'fetch', '/project', 'main:main');
git('/project', 'remote', 'add', 'origin', 'https://github.com/fixture/game.git');
const missing = execFileSync('git', ['--git-dir', '/tmp/mock-remote.git', 'show-ref'], { encoding: 'utf8' });
assert.ok(!missing.includes(`refs/heads/${run.branch}`), 'feature branch existed before approval');
const requests = [];
const mock = createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  requests.push({ method: req.method, path: req.url, body: raw && JSON.parse(raw) });
  res.setHeader('content-type', 'application/json');
  if (req.method === 'GET') res.end('[]');
  else if (req.url.startsWith('/repos/')) { res.statusCode = 201; res.end(JSON.stringify({ draft: true, html_url: 'https://github.com/fixture/game/pull/42' })); }
  else res.end(JSON.stringify({ data: { commentCreate: { success: true } } }));
});
await new Promise((done) => mock.listen(0, '127.0.0.1', done));
try {
  const fixtureFetch = (url, options) => {
    const original = new URL(url);
    return fetch(`http://127.0.0.1:${mock.address().port}${original.pathname}${original.search}`, options);
  };
  const publisher = (options) => publish({ ...options, fetcher: fixtureFetch, push: async ({ worktree, sha, branch }) => git(worktree, 'push', '/tmp/mock-remote.git', `${sha}:refs/heads/${branch}`) });
  const approvedSha = git(run.worktreePath, 'rev-parse', 'HEAD');
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const evidence = { runId: id, commit: approvedSha, verdict: 'approve' };
  const signature = sign(null, Buffer.from(JSON.stringify(evidence)), privateKey).toString('hex');
  const result = await publishRun({ id, url: 'http://127.0.0.1:14321', state: '/handoff', repoRoot: '/project', repo: 'fixture/game', githubToken: 'fixture-only', linearKey: 'fixture-only', approvedSha, evidence, signature, publicKey, publisher });
  assert.equal(result, 'https://github.com/fixture/game/pull/42');
  assert.equal(requests.length, 3);
  assert.equal(requests[1].body.draft, true);
  assert.equal(requests[2].body.variables.input.issueId, issue);
  assert.equal(git('/project', '--git-dir', '/tmp/mock-remote.git', 'rev-parse', `refs/heads/${run.branch}`), git(run.worktreePath, 'rev-parse', 'HEAD'));
  console.log('PASS explicit approval → isolated feature push → mock draft PR → bound mock Linear comment');
} finally { await new Promise((done) => mock.close(done)); }
