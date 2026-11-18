import { execFileSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const verifyScript = join(dirname(fileURLToPath(import.meta.url)), 'verify-branch.mjs');

export async function publish({ worktree, state, repo, base, issue, title, githubToken, linearKey, approvedSha, fetcher = fetch, push }) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo || '') || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(issue || '') || !title?.trim() || title.length > 200 || !githubToken || !linearKey || !base || base.startsWith('-')) throw new Error('invalid repository, issue, title, base, or missing credentials');
  const git = (...args) => {
    try { return execFileSync('git', args, { cwd: worktree, encoding: 'utf8', timeout: 30000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
    catch { throw new Error(`Git ${args[0]} failed; check local configuration and authentication`); }
  };
  const branch = git('branch', '--show-current');
  if (!branch.startsWith('cez/') || branch === base) throw new Error('only a cez/ feature branch can be published');
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(approvedSha || '') || git('rev-parse', 'HEAD') !== approvedSha) throw new Error('worktree HEAD does not match the reviewed commit SHA');
  execFileSync(process.execPath, [verifyScript], { cwd: worktree, env: { ...process.env, CEZ_BASE: base, CEZ_BRANCH: branch }, stdio: 'pipe' });
  const remote = git('remote', 'get-url', '--push', '--all', 'origin').split('\n');
  const allowed = [`https://github.com/${repo}`, `https://github.com/${repo}.git`, `git@github.com:${repo}`, `git@github.com:${repo}.git`, `ssh://git@github.com/${repo}`, `ssh://git@github.com/${repo}.git`];
  if (remote.length !== 1 || !allowed.includes(remote[0])) throw new Error('origin push URL does not match the configured GitHub repository');
  const sha = git('rev-parse', 'HEAD');
  if (sha !== approvedSha) throw new Error('worktree HEAD changed after branch verification');
  await mkdir(state, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(state, 'publish.sqlite'));
  db.exec('PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS publications (repo TEXT NOT NULL, branch TEXT NOT NULL, issue TEXT NOT NULL, sha TEXT NOT NULL, phase TEXT NOT NULL, pr_url TEXT, PRIMARY KEY(repo, branch))');
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      if (!db.prepare('PRAGMA table_info(publications)').all().some((column) => column.name === 'base_branch')) db.exec('ALTER TABLE publications ADD COLUMN base_branch TEXT');
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    const claim = db.prepare('INSERT OR IGNORE INTO publications (repo,branch,issue,sha,phase,base_branch) VALUES (?,?,?,?,?,?)').run(repo, branch, issue, sha, 'claimed', base);
    // shortcut: a claimed publication requires operator reconciliation after any interruption, until remote writes have idempotency keys.
    if (!claim.changes) throw new Error('publication already claimed; inspect the receipt and reconcile before retrying');
    const mark = (phase, url = null) => db.prepare('UPDATE publications SET phase=?, pr_url=COALESCE(?,pr_url) WHERE repo=? AND branch=?').run(phase, url, repo, branch);
    const ghHeaders = { authorization: `Bearer ${githubToken}`, accept: 'application/vnd.github+json', 'content-type': 'application/json', 'x-github-api-version': '2022-11-28' };
    const gh = `https://api.github.com/repos/${repo}/pulls`;
    const query = new URL(gh);
    query.searchParams.set('state', 'open');
    query.searchParams.set('head', `${repo.split('/')[0]}:${branch}`);
    query.searchParams.set('base', base);
    const existing = await fetcher(query, { headers: ghHeaders, signal: AbortSignal.timeout(15000) });
    if (!existing.ok) throw new Error(`GitHub PR lookup failed: HTTP ${existing.status}`);
    const pulls = await existing.json();
    if (!Array.isArray(pulls) || pulls.length) throw new Error('an open PR already exists or lookup response was invalid; reconcile manually');
    mark('pushing');
    if (push) await push({ worktree, sha, branch });
    else git('push', '--', 'origin', `${sha}:refs/heads/${branch}`);
    mark('pr_pending');
    const created = await fetcher(gh, { method: 'POST', headers: ghHeaders, body: JSON.stringify({ title, head: branch, base, draft: true, body: `Linear issue: ${issue}\n\nReview and merge manually.` }), signal: AbortSignal.timeout(15000) });
    if (!created.ok) throw new Error(`GitHub PR creation failed or uncertain: HTTP ${created.status}`);
    const pr = await created.json();
    const expectedPrefix = `https://github.com/${repo}/pull/`;
    if (pr.draft !== true || typeof pr.html_url !== 'string' || !pr.html_url.startsWith(expectedPrefix) || !/^\d+$/.test(pr.html_url.slice(expectedPrefix.length))) throw new Error('GitHub returned an invalid draft PR response');
    mark('comment_pending', pr.html_url);
    const response = await fetcher('https://api.linear.app/graphql', { method: 'POST', headers: { authorization: linearKey, 'content-type': 'application/json' }, body: JSON.stringify({ query: 'mutation StudioComment($input: CommentCreateInput!) { commentCreate(input: $input) { success } }', variables: { input: { issueId: issue, body: `Draft PR ready for review: ${pr.html_url}` } } }), signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`Linear comment failed or uncertain: HTTP ${response.status}`);
    const data = await response.json();
    if (data.errors?.length || data.data?.commentCreate?.success !== true) throw new Error('Linear comment failed or returned an invalid response');
    mark('done', pr.html_url);
    return pr.html_url;
  } finally { db.close(); }
}
