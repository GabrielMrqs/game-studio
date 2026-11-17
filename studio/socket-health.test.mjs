import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as httpServer } from 'node:http';
import { createServer as netServer, connect } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createGateway } from './model-gateway.mjs';
import { socketHealthy } from './fixtures/socket-health.mjs';

test('socket fixture health detects a failed relay without consuming model quota', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'studio-health-'));
  const socket = join(root, 'gateway.sock'), stateFile = join(root, 'quota.sqlite');
  const gateway = await createGateway({ key: 'fixture', model: 'fixture-model', maxRequests: 3, maxOutputTokens: 64, stateFile, initialize: true });
  await new Promise((done) => gateway.server.listen(socket, done));
  let cezarStatus = 200;
  const cezar = httpServer((_req, res) => { res.writeHead(cezarStatus, { connection: 'close' }).end(); });
  await new Promise((done) => cezar.listen(0, '127.0.0.1', done));
  const sockets = new Set();
  const relay = netServer((client) => {
    const target = connect(socket);
    sockets.add(client); sockets.add(target);
    client.on('close', () => sockets.delete(client));
    target.on('close', () => sockets.delete(target));
    client.on('error', () => target.destroy());
    target.on('error', () => client.destroy());
    client.pipe(target).pipe(client);
  });
  await new Promise((done) => relay.listen(0, '127.0.0.1', done));
  t.after(async () => {
    for (const connection of sockets) connection.destroy();
    if (relay.listening) await new Promise((done) => relay.close(done));
    await new Promise((done) => cezar.close(done));
    await gateway.close();
    await rm(root, { recursive: true, force: true });
  });
  const endpoints = { cezar: `http://127.0.0.1:${cezar.address().port}/api/v1/health`, relay: `http://127.0.0.1:${relay.address().port}/` };
  assert.equal(await socketHealthy(endpoints), true);
  cezarStatus = 503;
  assert.equal(await socketHealthy(endpoints), false);
  cezarStatus = 200;
  for (const connection of sockets) connection.destroy();
  await new Promise((done) => relay.close(done));
  assert.equal(await socketHealthy(endpoints), false);
  const db = new DatabaseSync(stateFile, { readOnly: true });
  assert.equal(db.prepare('SELECT used FROM quota').get().used, 0);
  db.close();
});
