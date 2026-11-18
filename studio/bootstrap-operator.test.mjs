import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bootstrap, repairedWorkflow } from './bootstrap-operator.mjs';
import { bootstrapRepairChoice } from './once.mjs';

const old = 'a'.repeat(40), first = 'b'.repeat(40), next = 'c'.repeat(40), main = 'd'.repeat(40), merge = 'e'.repeat(40);

function fixture(candidates = [first, next]) {
  const calls = [];
  const pr = {
    number: 1, url: 'https://github.com/GabrielMrqs/game-studio/pull/1', isCrossRepository: false,
    state: 'OPEN', isDraft: true, headRefName: 'migration/github-first-bootstrap',
    headRefOid: old, baseRefName: 'main', baseRefOid: main,
  };
  const options = {
    candidates, signal: new AbortController().signal, wait: async () => {}, report() {},
    local: {
      async validate(previous, base, head) { calls.push(['validate', previous, base, head]); },
      async verifyMerge(commit, head) { calls.push(['verify', commit, head]); return merge; },
    },
    remote: {
      async pr() { return { ...pr }; },
      async protect() {},
      async push(sha) { calls.push(['push', sha]); pr.headRefOid = sha; },
      async check(sha) {
        return { id: 1, run_attempt: 1, status: 'completed', conclusion: sha === next ? 'success' : 'failure' };
      },
      async passingTest(run, sha) { return run?.conclusion === 'success' && sha === next; },
      async ready(sha) { calls.push(['ready', sha]); pr.isDraft = false; },
      async merge(sha) { calls.push(['merge', sha]); pr.state = 'MERGED'; pr.mergeCommit = { oid: merge }; },
    },
    async diagnose(run, sha) { calls.push(['diagnose', sha]); },
    async deploy(commit) { calls.push(['deploy', commit]); },
  };
  return { options, pr, calls };
}

test('operator validates each authorized fallback, then readies, merges and deploys exactly once', async () => {
  const { options, calls } = fixture();
  await bootstrap(options);
  assert.deepEqual(calls, [
    ['validate', old, main, first], ['push', first], ['diagnose', first],
    ['validate', first, main, next], ['push', next], ['ready', next],
    ['merge', next], ['verify', merge, next], ['deploy', merge],
  ]);
  calls.length = 0;
  await bootstrap(options);
  assert.deepEqual(calls, [['verify', merge, next], ['deploy', merge]]);
});

test('transient hosted runs are retried twice; exhausted failure never readies or merges', async () => {
  const { options, calls } = fixture([first]);
  let attempts = 1;
  options.remote.check = async () => ({ id: 5, run_attempt: attempts, status: 'completed', conclusion: 'startup_failure' });
  options.remote.rerun = async () => { attempts++; };
  await assert.rejects(bootstrap(options), /candidates exhausted/);
  assert.equal(attempts, 3);
  assert.deepEqual(calls, [['validate', old, main, first], ['push', first], ['diagnose', first]]);
});

test('unapproved head and moved base both fail closed before merge', async () => {
  for (const field of ['headRefOid', 'baseRefOid']) {
    const { options, calls, pr } = fixture([next]);
    options.remote.ready = async () => { pr.isDraft = false; pr[field] = old; };
    await assert.rejects(bootstrap(options), /changed/);
    assert.ok(!calls.some(([action]) => action === 'merge' || action === 'deploy'));
  }
});

test('model can select a single fixed repair, not a patch or a test bypass', () => {
  const recipe = 'pin-nested-runner';
  const event = text => JSON.stringify({ type: 'text', part: { text } });
  const original = '    runs-on: ubuntu-latest\n      - run: npm test\n';
  const evidence = 'bwrap: No permissions to create a new namespace';
  assert.equal(bootstrapRepairChoice(event(recipe), [recipe]), recipe);
  assert.equal(bootstrapRepairChoice(event(`${recipe}\nremove npm test`), [recipe]), undefined);
  assert.equal(repairedWorkflow(recipe, original, 'unrelated error'), undefined);
  assert.equal(repairedWorkflow(recipe, original + original, evidence), undefined);
  assert.equal(repairedWorkflow(recipe, original, evidence), original.replace('ubuntu-latest', 'ubuntu-24.04'));
});

test('generated repair must pass independent validation before it can be pushed', async () => {
  const { options, calls } = fixture([first]);
  options.diagnose = async (_run, sha, allowed) => {
    assert.equal(sha, first);
    assert.equal(allowed, true);
    return next;
  };
  options.local.authorizedRepair = async (parent, child) => parent === first && child === next;
  const validate = options.local.validate;
  options.local.validate = async (...args) => {
    await validate(...args);
    if (args[2] === next) throw new Error('independent validation failed');
  };
  await assert.rejects(bootstrap(options), /independent validation failed/);
  assert.deepEqual(calls, [['validate', old, main, first], ['push', first], ['validate', first, main, next]]);
});
