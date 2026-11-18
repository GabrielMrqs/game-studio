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

export function github(repository, token, signal, fetcher = fetch) {
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
    if (!response.ok) throw new Error(`GitHub ${method} failed (HTTP ${response.status}).`);
    try { return await response.json(); }
    catch { throw new Transient(`GitHub ${method} response was incomplete.`); }
  }
  const get = path => retry(() => call('GET', path), signal);
  const byHead = branch => get(`/pulls?state=all&head=${encodeURIComponent(`${owner}:${branch}`)}&per_page=100`);
  const validUrl = pr => pr.html_url === `https://github.com/${repository}/pull/${pr.number}` &&
    Number.isSafeInteger(pr.number) && pr.number > 0;
  return {
    async preflight() {
      const repo = await get('');
      if (repo.default_branch !== 'main' || !(await get('/branches/main')).protected) {
        throw new Error('GitHub default main must be protected before the watcher runs.');
      }
      if (!repo.allow_merge_commit || repo.allow_squash_merge || repo.allow_rebase_merge) {
        throw new Error('Enable merge commits only; stacked PR ancestry must survive parent integration.');
      }
    },
    async status(job) {
      const pr = await get(`/pulls/${job.pr}`);
      if (!validUrl(pr) || pr.head.ref !== job.branch || pr.head.sha !== job.sha ||
          pr.head.repo && pr.head.repo.full_name !== repository) throw new Error('Published PR head changed.');
      return pr;
    },
    async draft(job, base, body) {
      const marker = `<!-- studio-issue:${job.id} -->`;
      const title = `${job.identifier}: ${job.title}`.slice(0, 240);
      return retry(async () => {
        const prs = await byHead(job.branch);
        if (prs.length > 1) throw new Error('Multiple PRs already use this issue branch.');
        let [pr] = prs;
        if (!pr) {
          pr = await call('POST', '/pulls', { base, head: job.branch, title, body: `${marker}\n${body}`, draft: true });
          if (!pr.draft) throw new Error('GitHub did not create a Draft PR.');
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
