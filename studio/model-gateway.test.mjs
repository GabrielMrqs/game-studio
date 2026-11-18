import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, rename, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { createGateway } from './model-gateway.mjs';

test('gateway forwards only bounded model requests and retains its quota across restarts', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'studio-gateway-'));
  let requests = 0, authorization, leakedHeader;
  const upstream = createServer(async (req, res) => {
    requests++;
    authorization = req.headers.authorization;
    leakedHeader = req.headers['x-agent-header'];
    for await (const _chunk of req) { /* consume request */ }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'set-cookie': 'private=1' });
    res.end('data: ok\n\n');
  });
  await new Promise((done) => upstream.listen(0, '127.0.0.1', done));
  const config = { key: 'private-fixture-key', model: 'approved-model', maxRequests: 2, maxOutputTokens: 64, stateFile: join(root, 'quota.sqlite'), upstream: `http://127.0.0.1:${upstream.address().port}/v1/responses` };
  let gateway = await createGateway({ ...config, initialize: true });
  const start = async () => { await new Promise((done) => gateway.server.listen(0, '127.0.0.1', done)); return `http://127.0.0.1:${gateway.server.address().port}`; };
  let url = await start();
  t.after(async () => { await gateway.close(); await new Promise((done) => upstream.close(done)); await rm(root, { recursive: true, force: true }); });
  const send = (body, path = '/v1/responses') => fetch(url + path, { method: 'POST', headers: { authorization: 'Bearer dummy', 'x-agent-header': 'must-not-forward' }, body: JSON.stringify(body) });
  assert.equal((await send({ model: 'wrong', max_output_tokens: 20 })).status, 400);
  assert.equal((await send({ model: 'approved-model', max_output_tokens: 65 })).status, 400);
  assert.equal((await send({ model: 'approved-model', max_output_tokens: 20, tools: [{ type: 'web_search' }] })).status, 400);
  assert.equal((await send({ model: 'approved-model', max_output_tokens: 20, background: true })).status, 400);
  assert.equal((await send({ model: 'approved-model', max_output_tokens: 20, background: 'false' })).status, 400);
  assert.equal((await send({ model: 'approved-model', max_output_tokens: 20 }, '/v1/files')).status, 404);
  const response = await send({ model: 'approved-model', max_output_tokens: 20, input: 'hello', stream: true, background: false });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'data: ok\n\n');
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(authorization, 'Bearer private-fixture-key');
  assert.equal(leakedHeader, undefined);
  await gateway.close();
  gateway = await createGateway(config);
  url = await start();
  assert.equal((await send({ model: 'approved-model', max_output_tokens: 20 })).status, 200);
  assert.equal((await send({ model: 'approved-model', max_output_tokens: 20 })).status, 429);
  assert.equal(requests, 2);
});

test('uncertain upstream requests consume quota and cannot be retried after restart', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'studio-gateway-fail-'));
  const config = { key: 'fixture-key', model: 'approved-model', maxRequests: 1, maxOutputTokens: 64, stateFile: join(root, 'quota.sqlite'), fetcher: async () => { throw new Error('connection lost'); } };
  let gateway = await createGateway({ ...config, initialize: true });
  const start = async () => { await new Promise((done) => gateway.server.listen(0, '127.0.0.1', done)); return `http://127.0.0.1:${gateway.server.address().port}/v1/responses`; };
  let url = await start();
  t.after(async () => { await gateway.close(); await rm(root, { recursive: true, force: true }); });
  const send = () => fetch(url, { method: 'POST', body: JSON.stringify({ model: 'approved-model', max_output_tokens: 20 }) });
  assert.equal((await send()).status, 502);
  await gateway.close();
  gateway = await createGateway(config);
  url = await start();
  assert.equal((await send()).status, 429);
});

test('gateway refuses changed quota configuration and preserves legacy state', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'studio-gateway-config-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = { key: 'fixture', model: 'approved-model', maxRequests: 2, maxOutputTokens: 64, stateFile: join(root, 'quota.sqlite'), upstream: 'http://127.0.0.1:8081/v1/responses' };
  const gateway = await createGateway({ ...config, initialize: true });
  await gateway.close();
  for (const change of [{ maxRequests: 3 }, { maxOutputTokens: 65 }, { model: 'other' }, { upstream: 'http://127.0.0.1:8082/v1/responses' }]) {
    await assert.rejects(createGateway({ ...config, ...change }), /configuration or state does not match/);
  }
  const reopened = await createGateway(config);
  await reopened.close();
  const legacyFile = join(root, 'legacy.sqlite');
  const legacy = new DatabaseSync(legacyFile);
  legacy.exec('CREATE TABLE quota (id INTEGER PRIMARY KEY, used INTEGER NOT NULL); INSERT INTO quota VALUES (1,7)');
  legacy.close();
  await assert.rejects(createGateway({ ...config, stateFile: legacyFile }), /legacy or incomplete/);
  const check = new DatabaseSync(legacyFile, { readOnly: true });
  assert.equal(check.prepare('SELECT used FROM quota').get().used, 7);
  assert.equal(check.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='gateway_config'").get().n, 0);
  check.close();
});

test('gateway requires explicit first initialization and refuses a missing or empty quota on restart', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'studio-gateway-init-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = { key: 'fixture', model: 'approved-model', maxRequests: 2, maxOutputTokens: 64, stateFile: join(root, 'quota.sqlite') };
  await assert.rejects(createGateway(config), { code: 'ENOENT' });
  await assert.rejects(access(config.stateFile), { code: 'ENOENT' });
  const gateway = await createGateway({ ...config, initialize: true });
  await gateway.close();
  await assert.rejects(createGateway({ ...config, initialize: true }), { code: 'EEXIST' });
  await rename(config.stateFile, join(root, 'retained.sqlite'));
  await assert.rejects(createGateway(config), { code: 'ENOENT' });
  await assert.rejects(access(config.stateFile), { code: 'ENOENT' });
  const empty = new DatabaseSync(config.stateFile);
  empty.close();
  await assert.rejects(createGateway(config), /empty gateway quota state/);
  const retained = new DatabaseSync(join(root, 'retained.sqlite'), { readOnly: true });
  assert.equal(retained.prepare('SELECT used FROM quota').get().used, 0);
  retained.close();
});

test('gateway refuses runtime quota corruption and changed pinned configuration', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'studio-gateway-integrity-'));
  let forwarded = 0;
  const stateFile = join(root, 'quota.sqlite');
  const gateway = await createGateway({ key: 'fixture', model: 'fixture-model', maxRequests: 3, maxOutputTokens: 64, stateFile, initialize: true, fetcher: async () => { forwarded++; return new Response('fixture'); } });
  await new Promise((done) => gateway.server.listen(0, '127.0.0.1', done));
  const state = new DatabaseSync(stateFile);
  t.after(async () => { state.close(); await gateway.close(); await rm(root, { recursive: true, force: true }); });
  const send = async () => {
    const response = await fetch(`http://127.0.0.1:${gateway.server.address().port}/v1/responses`, { method: 'POST', body: JSON.stringify({ model: 'fixture-model', max_output_tokens: 20 }) });
    await response.text();
    return response.status;
  };
  state.exec('UPDATE quota SET used=-1');
  assert.equal(await send(), 429);
  state.exec("UPDATE quota SET used='invalid'");
  assert.equal(await send(), 429);
  state.exec('UPDATE quota SET used=0; UPDATE gateway_config SET max_requests=99');
  assert.equal(await send(), 429);
  state.exec("UPDATE gateway_config SET max_requests=3, upstream='http://other.invalid'");
  assert.equal(await send(), 429);
  assert.equal(forwarded, 0);
  state.prepare('UPDATE gateway_config SET upstream=?').run('https://api.openai.com/v1/responses');
  assert.equal(await send(), 200);
  assert.equal(forwarded, 1);
  assert.equal(state.prepare('SELECT used FROM quota').get().used, 1);
});

test('concurrent gateway processes share one persistent request ceiling', { timeout: 20000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'studio-gateway-concurrent-'));
  let forwarded = 0;
  const upstream = createServer(async (req, res) => {
    forwarded++;
    for await (const _chunk of req) { /* consume request */ }
    res.end('fixture');
  });
  await new Promise((done) => upstream.listen(0, '127.0.0.1', done));
  const stateFile = join(root, 'quota.sqlite');
  const upstreamUrl = `http://127.0.0.1:${upstream.address().port}/v1/responses`;
  const initial = await createGateway({ key: 'fixture', model: 'fixture-model', maxRequests: 3, maxOutputTokens: 64, stateFile, upstream: upstreamUrl, initialize: true });
  await initial.close();
  const children = [];
  t.after(async () => {
    for (const child of children) if (child.exitCode === null) child.kill();
    await new Promise((done) => upstream.close(done));
    await rm(root, { recursive: true, force: true });
  });
  for (let i = 0; i < 2; i++) children.push(fork(resolve('studio/fixtures/gateway-quota-child.mjs'), [], { silent: true, env: { ...process.env, FIXTURE_QUOTA: stateFile, FIXTURE_UPSTREAM: upstreamUrl } }));
  const ports = await Promise.all(children.map(async (child) => (await once(child, 'message'))[0]));
  const statuses = await Promise.all(Array.from({ length: 12 }, async (_, i) => {
    const response = await fetch(`http://127.0.0.1:${ports[i % 2]}/v1/responses`, { method: 'POST', body: JSON.stringify({ model: 'fixture-model', max_output_tokens: 20 }) });
    await response.text();
    return response.status;
  }));
  assert.equal(statuses.filter((status) => status === 200).length, 3);
  assert.equal(statuses.filter((status) => status === 429).length, 9);
  assert.equal(forwarded, 3);
  const exits = children.map((child) => once(child, 'exit'));
  for (const child of children) child.send('stop');
  await Promise.all(exits);
  const quota = new DatabaseSync(stateFile, { readOnly: true });
  assert.equal(quota.prepare('SELECT used FROM quota').get().used, 3);
  quota.close();
});
