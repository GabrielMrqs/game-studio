import assert from 'node:assert/strict';
import { test } from 'node:test';
import { linearSource } from './linear-source.mjs';

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const config = { teamId: id(1), projectId: id(2), labelId: id(3), readyId: id(4),
  inProgressId: id(5), doneId: id(6) };
const issue = n => ({ id: id(n), identifier: `GAME-${n}`, title: 'Gameplay change', description: 'Details' });
const page = (nodes, endCursor = null) => ({ data: { issues: {
  nodes, pageInfo: { hasNextPage: endCursor !== null, endCursor },
} } });
const signal = new AbortController().signal;

test('Linear scopes the query, skips claimed UUIDs across pages and confirms writebacks', async () => {
  const calls = [];
  const responses = [
    page([issue(7)], 'page-2'), page([issue(8)]),
    { data: { issueUpdate: { success: true, issue: { id: id(8), state: { id: id(5) } } } } },
    { data: { commentCreate: { success: true, comment: { id: id(9) } } } },
    { data: { issueUpdate: { success: true, issue: { id: id(8), state: { id: id(6) } } } } },
  ];
  const linear = linearSource(config, 'test-key', signal, async (url, options) => {
    assert.equal(url, 'https://api.linear.app/graphql');
    assert.equal(options.redirect, 'error');
    calls.push(JSON.parse(options.body).variables);
    return Response.json(responses.shift());
  });
  const task = await linear.next(new Set([`refs/studio/linear/${id(7)}`]));
  assert.equal(task.receipt, `refs/studio/linear/${id(8)}`);
  assert.equal(task.idea, 'Gameplay change\n\nDetails');
  assert.deepEqual(calls[0].filter, {
    team: { id: { eq: id(1) } }, project: { id: { eq: id(2) } },
    labels: { id: { eq: id(3) } }, state: { id: { eq: id(4) } },
  });
  assert.equal(calls[1].after, 'page-2');
  assert.equal(await linear.next(new Set()), undefined);
  await linear.setState(task.id, false);
  assert.equal(await linear.comment(task.id, 'Validated commit'), id(9));
  await linear.setState(task.id, true);
  assert.deepEqual(calls.slice(2), [
    { id: id(8), state: id(5) }, { id: id(8), body: 'Validated commit' }, { id: id(8), state: id(6) },
  ]);
});

test('Linear backs off reads and never retries uncertain writes', async () => {
  let calls = 0;
  const linear = linearSource(config, 'test-key', signal, async () => {
    calls++;
    return Response.json({}, { status: 429, headers: { 'retry-after': '120' } });
  });
  assert.equal(await linear.next(new Set()), undefined);
  await assert.rejects(linear.setState(id(8), false), /blocked by rate limit/);
  assert.equal(calls, 1);
  const failedWrite = linearSource(config, 'test-key', signal, async () => {
    calls++;
    throw new Error('unknown network outcome');
  });
  await assert.rejects(failedWrite.setState(id(8), true), /did not complete/);
  assert.equal(calls, 2);
});
