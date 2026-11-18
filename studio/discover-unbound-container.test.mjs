import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { discoverUnboundFixture, reserveFixtureContainer } from './fixtures/discover-unbound-container.mjs';

test('pre-binding fixture discovery is read-only and refuses missing or ambiguous containers', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'studio-unbound-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const reservationFile = join(root, 'reservation.sqlite');
  const token = '12345678-1234-1234-1234-123456789012', id = 'a'.repeat(64), other = 'b'.repeat(64);
  let calls = [];
  const docker = (_bin, argv) => { calls.push(argv); return ''; };
  assert.throws(() => discoverUnboundFixture({ reservationFile, docker }));
  assert.equal(calls.length, 0);
  reserveFixtureContainer({ reservationFile, token });
  assert.throws(() => reserveFixtureContainer({ reservationFile, token }), { code: 'EEXIST' });
  const before = await readFile(reservationFile);
  const container = { Id: id, Config: { Labels: { 'studio.fixture.run-token': token, 'studio.fixture.kind': 'per-run-cancellation' } }, HostConfig: { RestartPolicy: { Name: 'no' } }, State: { Status: 'running' } };
  for (const listing of ['', `${id}\n${other}`, 'short']) {
    calls = [];
    assert.throws(() => discoverUnboundFixture({ reservationFile, docker: (_bin, argv) => { calls.push(argv); return listing; } }), /missing or ambiguous/);
    assert.deepEqual(calls.map((args) => args[0]), ['ps']);
  }
  const fake = (_bin, argv) => {
    calls.push(argv);
    return argv[0] === 'ps' ? `${id}\n` : JSON.stringify([container]);
  };
  calls = [];
  assert.deepEqual(discoverUnboundFixture({ reservationFile, docker: fake }), { containerId: id, status: 'running', disposition: 'operator_review' });
  assert.deepEqual(calls.map((args) => args[0]), ['ps', 'inspect']);
  container.Config.Labels['studio.fixture.run-token'] = 'mismatch';
  assert.throws(() => discoverUnboundFixture({ reservationFile, docker: fake }), /identity or state mismatch/);
  container.Config.Labels['studio.fixture.run-token'] = token;
  container.HostConfig.RestartPolicy.Name = 'always';
  assert.throws(() => discoverUnboundFixture({ reservationFile, docker: fake }), /identity or state mismatch/);
  assert.deepEqual(await readFile(reservationFile), before);
});
