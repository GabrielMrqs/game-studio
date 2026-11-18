import { retry, retryAfter, Transient } from './github.mjs';

export const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

export function linearReview(config, key, signal, fetcher = fetch) {
  const { teamId, projectId, labelId, readyId, inProgressId, reviewId, doneId } = config;
  const statuses = [readyId, inProgressId, reviewId, ...(doneId ? [doneId] : [])];
  if (![teamId, labelId, ...statuses, ...(projectId ? [projectId] : [])].every(x => uuid.test(x)) ||
      new Set(statuses.map(x => x.toLowerCase())).size !== statuses.length ||
      !/^[\x21-\x7e]+$/.test(key)) throw new Error('Invalid Linear review configuration or key.');
  const filter = {
    team: { id: { eq: teamId } }, labels: { id: { eq: labelId } }, state: { id: { eq: readyId } },
    ...(projectId ? { project: { id: { eq: projectId } } } : {}),
  };
  async function call(query, variables) {
    let response;
    let body;
    try {
      response = await fetcher('https://api.linear.app/graphql', {
        method: 'POST', redirect: 'error',
        headers: { 'content-type': 'application/json', authorization: key },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      });
      body = await response.json();
    } catch { throw new Transient('Linear request did not complete.'); }
    if (response.status >= 500 || response.status === 429 ||
        body.errors?.some(e => e.extensions?.code === 'RATELIMITED')) {
      throw new Transient(`Linear temporarily unavailable (HTTP ${response.status}).`, retryAfter(response) || 1000);
    }
    if (!response.ok || !body.data || body.errors?.length) throw new Error(`Linear request failed (HTTP ${response.status}).`);
    return body.data;
  }
  const request = (query, variables) => retry(() => call(query, variables), signal);
  async function* pages(load) {
    const seen = new Set();
    let after = null;
    do {
      const { nodes, pageInfo } = await load(after) ?? {};
      if (!Array.isArray(nodes) || typeof pageInfo?.hasNextPage !== 'boolean') throw new Error('Invalid Linear page.');
      yield* nodes;
      if (!pageInfo.hasNextPage) return;
      after = pageInfo.endCursor;
      if (typeof after !== 'string' || !after || seen.has(after)) throw new Error('Invalid Linear cursor.');
      seen.add(after);
    } while (true);
  }
  const page = 'pageInfo { hasNextPage endCursor }';
  const fields = 'id identifier title description url state { id type }';
  async function setState(id, state) {
    const { issueUpdate: result } = await request(`mutation($id:String!,$state:String!){
      issueUpdate(id:$id,input:{stateId:$state}){success issue{id state{id}}} }`, { id, state });
    if (!result?.success || result.issue.id !== id || result.issue.state.id !== state) throw new Error('Linear did not confirm state.');
  }
  return {
    async issue(id) {
      return (await request(`query($id:String!){issue(id:$id){${fields}}}`, { id })).issue;
    },
    async verify() {
      const { team } = await request(`query($id:String!){ team(id:$id){states(first:100){nodes{id type}}} }`, { id: teamId });
      if (!statuses.every((id, i) => team?.states.nodes.some(
        state => state.id === id && state.type === ['unstarted', 'started', 'started', 'completed'][i]))) {
        throw new Error('Linear workflow state types do not match configuration.');
      }
    },
    async *ready() {
      yield* pages(async after => (await request(
        `query($filter: IssueFilter!, $after: String){ issues(first:20,filter:$filter,after:$after){nodes{${fields}} ${page}} }`,
        { filter, after })).issues);
    },
    async dependencies(id) {
      const deps = [];
      for await (const item of pages(async after => (await request(
        `query($id:String!,$after:String){issue(id:$id){inverseRelations(first:50,after:$after){
          nodes { type issue { id identifier state { type } } } ${page} }}}`,
        { id, after })).issue?.inverseRelations)) {
        if (item.type === 'blocks') deps.push(item.issue);
      }
      return deps;
    },
    state: (id, phase) => setState(id, phase === 'review' ? reviewId : inProgressId),
    integrated: id => doneId ? setState(id, doneId) : undefined,
    async attach(id, url) {
      // Linear upserts attachments with the same URL on the same issue.
      const { attachmentCreate: result } = await request(`mutation($id:String!,$url:String!){
        attachmentCreate(input:{issueId:$id,url:$url,title:"GitHub Draft PR"}){success attachment{url}} }`, { id, url });
      if (!result?.success || result.attachment?.url !== url) throw new Error('Linear did not confirm PR attachment.');
    },
    async blocker(id, reason) {
      const url = `https://linear.app/issue/${id}#studio-blocked`;
      const { attachmentCreate: result } = await request(`mutation($id:String!,$url:String!,$reason:String!){
        attachmentCreate(input:{issueId:$id,url:$url,title:"Game Studio blocked",subtitle:$reason}){success} }`,
      { id, url, reason: reason.slice(0, 180) });
      if (!result?.success) throw new Error('Linear did not confirm blocker attachment.');
    },
  };
}
