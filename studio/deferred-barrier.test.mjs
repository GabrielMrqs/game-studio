import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AutomationStore } from '../node_modules/@open-mercato/cezar/dist/automations/store.js';
import { fireDeferred } from '../node_modules/@open-mercato/cezar/dist/automations/deferred-lifecycle.js';

test('deferred launch reserves a run ID before the fixture launcher refuses an unbound sandbox', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'studio-deferred-barrier-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = AutomationStore.open(dir);
  const definition = store.create({
    name: 'Fixture',
    kind: 'schedule',
    enabled: true,
    schedule: { type: 'once', date: '2099-01-01', hour: 0, minute: 0 },
    task: { prompt: 'Fixture task', runner: 'opencode' },
    deferredStart: {
      origin: 'composer', reason: 'at', notBefore: '2099-01-01T00:00:00.000Z', timeZone: 'UTC',
      binding: { revision: 'fixture', runner: 'opencode', accounts: [] },
      creationKey: randomUUID(), requestDigest: 'fixture', status: 'pending', runIds: [],
    },
  });
  let launches = 0;
  const handle = {
    store,
    validateDeferred: async () => {},
    launch: async (claimed) => {
      launches++;
      const disk = JSON.parse(await readFile(join(dir, 'automations.json'), 'utf8'));
      const saved = disk.automations.find((item) => item.id === claimed.id).deferredStart;
      assert.equal(saved.status, 'launching');
      assert.equal(saved.runIds.length, 1);
      assert.match(saved.runIds[0], /^[0-9a-f-]{36}$/);
      throw new Error('fixture refuses launch without a sandbox binding');
    },
  };
  const result = await fireDeferred(handle, definition, true);
  assert.equal(result.result, 'failed');
  const failed = store.get(definition.id);
  assert.equal(failed.deferredStart.failureKind, 'ambiguous');
  assert.equal(failed.deferredStart.runIds.length, 1);
  const retry = await fireDeferred(handle, failed, false);
  assert.equal(retry.result, 'failed');
  assert.equal(launches, 1, 'an ambiguous launch must not be repeated automatically');
});
