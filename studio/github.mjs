import { setTimeout } from 'node:timers/promises';

export const featureBranch = ({ identifier, title }) => {
  if (!/^[A-Z0-9]+-\d+$/.test(identifier)) throw new Error('Invalid issue identifier.');
  return `feature/${identifier}-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60)
    .replace(/^-|-$/g, '') || 'gameplay'}`;
};
export const isFeature = branch => /^feature\/[A-Z0-9]+-\d+-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(branch);

export class Transient extends Error {
  constructor(message, wait = 0) {
    super(message);
    this.wait = wait;
  }
}

export async function retry(operation, signal, pause = setTimeout) {
  for (let n = 0; ; n++) {
    signal.throwIfAborted();
    try { return await operation(); }
    catch (error) {
      if (!(error instanceof Transient) || n === 3 || error.wait > 30_000) throw error;
      await pause(Math.max(error.wait, 500 * 2 ** n), undefined, { signal });
    }
  }
}

export function retryAfter(response) {
  const header = response.headers.get('retry-after');
  const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000;
  return header ? Math.max(0, /^\d+$/.test(header) ? 1000 * Number(header) : Date.parse(header) - Date.now()) || 0
    : Math.max(0, reset - Date.now());
}

export function github(repository, token, signal, fetcher = fetch, autoMerge = false) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !/^(github_pat_|ghs_)[A-Za-z0-9_]+$/.test(token)) {
    throw new Error('GitHub requires owner/repo and a repository-scoped token (not the default gh login).');
  }
  const owner = repository.split('/')[0];
  async function call(method, path, body) {
    let response;
    try {
      response = await fetcher(`https://api.github.com/repos/${repository}${path}`, {
        method, redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
        headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw new Transient(`GitHub ${method} request did not complete.`);
    }
    if (response.status >= 500 || response.status === 429 ||
        (response.status === 403 && (response.headers.has('retry-after') ||
          response.headers.get('x-ratelimit-remaining') === '0'))) {
      throw new Transient(`GitHub ${method} temporarily unavailable (HTTP ${response.status}).`, retryAfter(response));
    }
    if (!response.ok) throw Object.assign(new Error(`GitHub ${method} failed (HTTP ${response.status}).`), { status: response.status });
    try { return await response.json(); }
    catch { throw new Transient(`GitHub ${method} response was incomplete.`); }
  }
  const get = path => retry(() => call('GET', path), signal);
  const byHead = branch => get(`/pulls?state=all&head=${encodeURIComponent(`${owner}:${branch}`)}&per_page=100`);
  const validUrl = pr => pr.html_url === `https://github.com/${repository}/pull/${pr.number}` &&
    Number.isSafeInteger(pr.number) && pr.number > 0;
  async function status(job) {
    const pr = await get(`/pulls/${job.pr}`);
    if (!validUrl(pr) || pr.head.ref !== job.branch || pr.head.sha !== job.sha ||
        pr.head.repo && pr.head.repo.full_name !== repository) throw new Error('Published PR head changed.');
    return pr;
  }
  const appId = 15368; // GitHub Actions
  async function preflight() {
    const repo = await get('');
    if (repo.default_branch !== 'main' || !(await get('/branches/main')).protected) {
      throw new Error('GitHub default main must be protected before the watcher runs.');
    }
    if (!repo.allow_merge_commit || repo.allow_squash_merge || repo.allow_rebase_merge) {
      throw new Error('Enable merge commits only; stacked PR ancestry must survive parent integration.');
    }
    if (autoMerge) {
      const rules = await get('/rules/branches/main');
      if (!['pull_request', 'deletion', 'non_fast_forward'].every(type => rules.some(rule => rule.type === type)) ||
          !rules.some(rule => rule.type === 'required_status_checks' &&
            rule.parameters.strict_required_status_checks_policy &&
            rule.parameters.required_status_checks.some(check => check.context === 'test' && check.integration_id === appId))) {
        throw new Error('Automatic merge requires a protected main with strict GitHub Actions test checks.');
      }
    }
  }
  return {
    preflight,
    status,
    merge: autoMerge ? async (job, main) => {
      if (!isFeature(job.branch)) throw new Error('Refusing to merge a non-studio branch.');
      const pr = await status(job);
      if (pr.merged && pr.base.ref === 'main') return;
      if (pr.state !== 'open') throw new Error('Studio PR was closed without merging to main; branch retained.');
      if (pr.base.ref !== 'main' || pr.base.sha !== main) return;
      if (pr.base.repo?.full_name !== repository || pr.head.repo?.full_name !== repository ||
          !pr.body?.startsWith(`<!-- studio-issue:${job.id} -->`)) throw new Error('Studio PR ownership changed.');
      if (pr.draft) throw new Error('Retained draft PR must be marked ready before automatic merge.');
      const { check_runs: runs, total_count: count } = await get(`/commits/${job.sha}/check-runs?check_name=test&per_page=100`);
      if (count > runs.length) throw new Error('Too many test runs to verify the exact commit.');
      const required = runs.filter(run => run.name === 'test' && run.app?.id === appId && run.head_sha === job.sha);
      if (!required.length || required.some(run => run.status !== 'completed')) return;
      if (required.some(run => run.conclusion !== 'success')) throw new Error('Required GitHub Actions test failed; PR retained.');
      if (pr.mergeable_state === 'behind' || pr.mergeable_state === 'dirty') {
        throw new Error('Main changed outside the watcher; PR retained rather than merging an unvalidated tree.');
      }
      if (pr.mergeable !== true || pr.mergeable_state !== 'clean') return;
      await preflight();
      try {
        const result = await call('PUT', `/pulls/${pr.number}/merge`, { sha: job.sha, merge_method: 'merge' });
        if (!result.merged) throw new Error('GitHub did not merge the PR.');
        return result.sha;
      } catch (error) {
        // A moved base, changed head or stricter rules can reject a just-checked PR.
        if (![405, 409].includes(error.status)) throw error;
      }
    } : undefined,
    async draft(job, base, body) {
      const marker = `<!-- studio-issue:${job.id} -->`;
      const title = `${job.identifier}: ${job.title}`.slice(0, 240);
      return retry(async () => {
        const prs = await byHead(job.branch);
        if (prs.length > 1) throw new Error('Multiple PRs already use this issue branch.');
        let [pr] = prs;
        if (!pr) {
          pr = await call('POST', '/pulls', { base, head: job.branch, title, body: `${marker}\n${body}`, draft: !autoMerge });
          if (pr.draft !== !autoMerge) throw new Error('GitHub did not confirm the expected PR readiness.');
        } else {
          if (!pr.body?.startsWith(marker) || pr.state !== 'open' || pr.head.sha !== job.sha) {
            throw new Error('Existing PR is closed or does not match the issue and validated commit.');
          }
          // Retarget only; preserve any reviewer edits to the title/body and ready state.
          if (pr.base.ref !== base) pr = await call('PATCH', `/pulls/${pr.number}`, { base });
        }
        if (!validUrl(pr) || pr.head.ref !== job.branch || pr.head.sha !== job.sha || pr.base.ref !== base ||
            !pr.body?.startsWith(marker)) throw new Error('GitHub did not confirm the expected PR.');
        return { pr: pr.number, url: pr.html_url };
      }, signal);
    },
  };
}
