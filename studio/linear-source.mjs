const endpoint = 'https://api.linear.app/graphql';
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const query = `query StudioReady($filter: IssueFilter!, $after: String) {
  issues(first: 20, after: $after, filter: $filter) {
    nodes { id identifier title description }
    pageInfo { hasNextPage endCursor }
  }
}`;

export function linearSource(config, key, shutdown, fetcher = fetch) {
  const { teamId, projectId, labelId, readyId, inProgressId, doneId, pollSeconds = 60 } = config;
  if (![teamId, labelId, readyId, inProgressId, doneId, ...(projectId ? [projectId] : [])]
    .every(value => typeof value === 'string' && uuid.test(value)) ||
    new Set([readyId, inProgressId, doneId].map(id => id.toLowerCase())).size !== 3 ||
    !Number.isSafeInteger(pollSeconds) || pollSeconds < 15 || pollSeconds > 3600) {
    throw new Error('Invalid Linear configuration: expected UUIDs, distinct statuses and pollSeconds (15–3600).');
  }
  if (!/^[\x21-\x7e]+$/.test(key)) throw new Error('Invalid Linear API key file.');
  const filter = {
    team: { id: { eq: teamId } }, labels: { id: { eq: labelId } }, state: { id: { eq: readyId } },
    ...(projectId ? { project: { id: { eq: projectId } } } : {}),
  };
  let nextPoll = 0;
  let limitedUntil = 0;

  async function request(operation, query, variables, polling = false) {
    if (Date.now() < limitedUntil) {
      if (polling) return;
      throw new Error(`Linear ${operation} blocked by rate limit; review required.`);
    }
    let response;
    let body;
    try {
      response = await fetcher(endpoint, {
        method: 'POST', redirect: 'error',
        headers: { 'content-type': 'application/json', authorization: key },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.any([shutdown, AbortSignal.timeout(15000)]),
      });
      body = await response.json().catch(() => null);
    } catch {
      throw new Error(`Linear ${operation} request did not complete.`);
    }
    const throttled = response.status === 429 ||
      body?.errors?.some(error => error.extensions?.code === 'RATELIMITED');
    if (throttled) {
      const retry = response.headers.get('retry-after');
      const until = /^\d{1,9}$/.test(retry) ? Date.now() + Number(retry) * 1000 : Date.parse(retry);
      limitedUntil = Math.max(limitedUntil, until > Date.now() ? until : Date.now() + 60000);
      if (polling) {
        console.warn(`Linear polling rate-limited until ${new Date(limitedUntil).toISOString()}.`);
        return;
      }
      throw new Error(`Linear ${operation} rate-limited; review required.`);
    }
    for (const bucket of ['requests', 'endpoint-requests', 'complexity']) {
      if (response.headers.get(`x-ratelimit-${bucket}-remaining`) === '0') {
        limitedUntil = Math.max(limitedUntil,
          Number(response.headers.get(`x-ratelimit-${bucket}-reset`)) || Date.now() + 60000);
      }
    }
    if (!response.ok || !body?.data || body.errors?.length) {
      throw new Error(`Linear ${operation} failed (HTTP ${response.status}); no automatic retry.`);
    }
    return body.data;
  }

  return {
    async next(claimed) {
      if (Date.now() < Math.max(nextPoll, limitedUntil)) return;
      nextPoll = Date.now() + pollSeconds * 1000;
      const seen = new Set();
      let after = null;
      do {
        const data = await request('Ready query', query, { filter, after }, true);
        if (!data) return;
        const { nodes, pageInfo } = data.issues ?? {};
        if (!Array.isArray(nodes) || typeof pageInfo?.hasNextPage !== 'boolean') {
          throw new Error('Invalid Linear Ready page.');
        }
        for (const issue of nodes) {
          if (!uuid.test(issue.id) || !/^[A-Z0-9]+-\d+$/i.test(issue.identifier) ||
            typeof issue.title !== 'string' || (issue.description != null && typeof issue.description !== 'string')) {
            throw new Error('Invalid Linear issue in Ready page.');
          }
          const receipt = `refs/studio/linear/${issue.id.toLowerCase()}`;
          if (!claimed.has(receipt)) return {
            id: issue.id, name: `Linear ${issue.identifier}`, title: issue.title.replace(/\s+/g, ' ').trim(),
            idea: `${issue.title}\n\n${issue.description ?? ''}`.trim(), receipt,
          };
        }
        if (!pageInfo.hasNextPage) return;
        after = pageInfo.endCursor;
        if (typeof after !== 'string' || !after || seen.has(after)) throw new Error('Invalid Linear cursor.');
        seen.add(after);
      } while (true);
    },
    async setState(id, done) {
      const state = done ? doneId : inProgressId;
      const data = await request(done ? 'Done update' : 'In Progress update', `mutation StudioState($id: String!, $state: String!) {
        issueUpdate(id: $id, input: { stateId: $state }) { success issue { id state { id } } }
      }`, { id, state });
      const result = data.issueUpdate;
      if (!result?.success || result.issue?.id !== id || result.issue.state?.id?.toLowerCase() !== state.toLowerCase()) {
        throw new Error('Linear did not confirm the state change; review required.');
      }
    },
    async comment(id, body) {
      const data = await request('commit comment', `mutation StudioComment($id: String!, $body: String!) {
        commentCreate(input: { issueId: $id, body: $body }) { success comment { id } }
      }`, { id, body });
      if (!data.commentCreate?.success || !uuid.test(data.commentCreate.comment?.id)) {
        throw new Error('Linear did not confirm the comment; review required.');
      }
      return data.commentCreate.comment.id;
    },
  };
}
