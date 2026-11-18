import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function reconcilePublication({ state, repo, branch, githubToken, linearKey, confirmStopped = false, fetcher = fetch }) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo || '') || !/^cez\/[A-Za-z0-9._/-]+$/.test(branch || '') || branch.includes('..') || branch.includes('//') || branch.endsWith('/') || !githubToken || !linearKey) throw new Error('valid repository, feature branch and read credentials are required');
  const db = new DatabaseSync(`${pathToFileURL(resolve(state, 'publish.sqlite')).href}?mode=${confirmStopped ? 'rw' : 'ro'}`, { readOnly: !confirmStopped });
  try {
    const baseColumn = db.prepare('PRAGMA table_info(publications)').all().some((column) => column.name === 'base_branch') ? 'base_branch' : 'NULL';
    const receipt = db.prepare(`SELECT repo,branch,issue,sha,phase,pr_url,${baseColumn} AS base_branch FROM publications WHERE repo=? AND branch=?`).get(repo, branch);
    if (!receipt || !['claimed', 'pushing', 'pr_pending', 'comment_pending'].includes(receipt.phase)) throw new Error('only claimed, pushing, pr_pending and comment_pending receipts can be reconciled');
    const prefix = `https://github.com/${repo}/pull/`;
    if (!/^[0-9a-f]{40,64}$/i.test(receipt.sha) || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(receipt.issue)) throw new Error('publication receipt is invalid');
    if (receipt.phase === 'pushing') {
      if (receipt.pr_url !== null) throw new Error('pushing receipt unexpectedly contains a PR URL');
      const ref = `refs/heads/${branch}`;
      const path = branch.split('/').map(encodeURIComponent).join('/');
      const response = await fetcher(`https://api.github.com/repos/${repo}/git/ref/heads/${path}`, { headers: { authorization: `Bearer ${githubToken}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' }, signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error(`GitHub ref lookup failed: HTTP ${response.status}`);
      const found = await response.json();
      if (found.ref !== ref || found.object?.type !== 'commit' || found.object?.sha !== receipt.sha) throw new Error('remote feature ref does not match the recorded commit');
      if (confirmStopped) {
        db.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
        try {
          db.exec('CREATE TABLE IF NOT EXISTS publication_push_recovery_audit (repo TEXT NOT NULL, branch TEXT NOT NULL, sha TEXT NOT NULL, confirmed_at TEXT NOT NULL)');
          const changed = db.prepare(`UPDATE publications SET phase='pr_pending' WHERE repo=? AND branch=? AND issue=? AND sha=? AND phase='pushing' AND pr_url IS NULL AND ${baseColumn} IS ?`).run(repo, branch, receipt.issue, receipt.sha, receipt.base_branch);
          if (changed.changes !== 1) throw new Error('publication receipt changed during reconciliation');
          db.prepare('INSERT INTO publication_push_recovery_audit VALUES (?,?,?,?)').run(repo, branch, receipt.sha, new Date().toISOString());
          db.exec('COMMIT');
        } catch (error) { db.exec('ROLLBACK'); throw error; }
      }
      return { ...receipt, phase: confirmStopped ? 'pr_pending' : receipt.phase, remote_ref: ref };
    }
    if (['claimed', 'pr_pending'].includes(receipt.phase)) {
      if (receipt.pr_url !== null) throw new Error('receipt unexpectedly contains a PR URL');
      const query = new URL(`https://api.github.com/repos/${repo}/pulls`);
      query.searchParams.set('state', 'all');
      query.searchParams.set('head', `${repo.split('/')[0]}:${branch}`);
      query.searchParams.set('per_page', '100');
      const response = await fetcher(query, { headers: { authorization: `Bearer ${githubToken}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' }, signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error(`GitHub lookup failed: HTTP ${response.status}`);
      const pulls = await response.json();
      if (!Array.isArray(pulls) || pulls.length !== 1 || response.headers.has('link')) throw new Error('expected exactly one complete PR result; reconcile manually');
      const pr = pulls[0];
      const number = pr.html_url?.startsWith(prefix) && pr.html_url.slice(prefix.length);
      if (!number || !/^[1-9]\d*$/.test(number) || pr.draft !== true || pr.state !== 'open' || pr.head?.ref !== branch || pr.head?.sha !== receipt.sha || pr.head?.repo?.full_name !== repo || pr.body !== `Linear issue: ${receipt.issue}\n\nReview and merge manually.`) throw new Error('GitHub PR does not match the recorded publication');
      if (receipt.base_branch && (pr.base?.ref !== receipt.base_branch || pr.base?.repo?.full_name !== repo)) throw new Error('GitHub PR base does not match the recorded publication');
      if (confirmStopped) {
        if (!receipt.base_branch) throw new Error('legacy receipt has no recorded base; reconcile manually');
        db.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
        try {
          const audit = receipt.phase === 'claimed' ? 'publication_claim_recovery_audit' : 'publication_pr_recovery_audit';
          db.exec(`CREATE TABLE IF NOT EXISTS ${audit} (repo TEXT NOT NULL, branch TEXT NOT NULL, pr_url TEXT NOT NULL, confirmed_at TEXT NOT NULL)`);
          const changed = db.prepare(`UPDATE publications SET phase='comment_pending', pr_url=? WHERE repo=? AND branch=? AND issue=? AND sha=? AND phase=? AND pr_url IS NULL AND ${baseColumn} IS ?`).run(pr.html_url, repo, branch, receipt.issue, receipt.sha, receipt.phase, receipt.base_branch);
          if (changed.changes !== 1) throw new Error('publication receipt changed during reconciliation');
          db.prepare(`INSERT INTO ${audit} VALUES (?,?,?,?)`).run(repo, branch, pr.html_url, new Date().toISOString());
          db.exec('COMMIT');
        } catch (error) { db.exec('ROLLBACK'); throw error; }
      }
      return { ...receipt, phase: confirmStopped ? 'comment_pending' : receipt.phase, found_pr_url: pr.html_url, observed_base: pr.base?.ref ?? null };
    }
    const number = receipt.pr_url?.startsWith(prefix) && receipt.pr_url.slice(prefix.length);
    if (!number || !/^[1-9]\d*$/.test(number)) throw new Error('publication receipt is invalid');
    const gh = await fetcher(`https://api.github.com/repos/${repo}/pulls/${number}`, { headers: { authorization: `Bearer ${githubToken}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' }, signal: AbortSignal.timeout(15000) });
    if (!gh.ok) throw new Error(`GitHub lookup failed: HTTP ${gh.status}`);
    const pr = await gh.json();
    if (pr.html_url !== receipt.pr_url || pr.draft !== true || pr.head?.ref !== branch || pr.head?.sha !== receipt.sha || pr.head?.repo?.full_name !== repo) throw new Error('GitHub PR does not match the recorded feature branch and commit');
    if (receipt.base_branch && (pr.base?.ref !== receipt.base_branch || pr.base?.repo?.full_name !== repo)) throw new Error('GitHub PR base does not match the recorded publication');
    let cursor = null, count = 0;
    const seen = new Set();
    do {
      const response = await fetcher('https://api.linear.app/graphql', { method: 'POST', headers: { authorization: linearKey, 'content-type': 'application/json' }, body: JSON.stringify({ query: 'query StudioComments($id: String!, $cursor: String) { issue(id: $id) { id comments(first: 50, after: $cursor) { nodes { body } pageInfo { hasNextPage endCursor } } } }', variables: { id: receipt.issue, cursor } }), signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error(`Linear lookup failed: HTTP ${response.status}`);
      const data = await response.json();
      const issue = data.data?.issue, page = issue?.comments;
      if (data.errors?.length || issue?.id !== receipt.issue || !Array.isArray(page?.nodes) || typeof page.pageInfo?.hasNextPage !== 'boolean') throw new Error('Linear comment history is invalid');
      count += page.nodes.filter((comment) => comment.body === `Draft PR ready for review: ${receipt.pr_url}`).length;
      if (!page.pageInfo.hasNextPage) break;
      cursor = page.pageInfo.endCursor;
      if (typeof cursor !== 'string' || !cursor || seen.has(cursor)) throw new Error('Linear pagination cursor invalid');
      seen.add(cursor);
    } while (true);
    if (count !== 1) throw new Error('expected exactly one matching Linear comment; reconcile manually');
    if (confirmStopped) {
      if (!receipt.base_branch) throw new Error('legacy receipt has no recorded base; reconcile manually');
      db.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
      try {
        db.exec('CREATE TABLE IF NOT EXISTS publication_recovery_audit (repo TEXT NOT NULL, branch TEXT NOT NULL, pr_url TEXT NOT NULL, confirmed_at TEXT NOT NULL)');
        const changed = db.prepare(`UPDATE publications SET phase='done' WHERE repo=? AND branch=? AND issue=? AND sha=? AND phase='comment_pending' AND pr_url=? AND ${baseColumn} IS ?`).run(repo, branch, receipt.issue, receipt.sha, receipt.pr_url, receipt.base_branch);
        if (changed.changes !== 1) throw new Error('publication receipt changed during reconciliation');
        db.prepare('INSERT INTO publication_recovery_audit VALUES (?,?,?,?)').run(repo, branch, receipt.pr_url, new Date().toISOString());
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    }
    return { ...receipt, phase: confirmStopped ? 'done' : receipt.phase, matchingComments: count };
  } finally { db.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length < 2 || args.length > 3 || (args[2] && args[2] !== '--confirm-publisher-stopped')) throw new Error('usage: node studio/reconcile-publication.mjs REPO BRANCH [--confirm-publisher-stopped]');
    const result = await reconcilePublication({ repo: args[0], branch: args[1], confirmStopped: args[2] === '--confirm-publisher-stopped', state: resolve(process.env.STUDIO_STATE || '.studio-state'), githubToken: process.env.GITHUB_TOKEN, linearKey: process.env.LINEAR_API_KEY });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) { console.error(`Publication reconciliation stopped: ${error.message}`); process.exitCode = 1; }
}
