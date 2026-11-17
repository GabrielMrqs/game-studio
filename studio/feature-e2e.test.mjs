import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { generateKeyPairSync, sign } from 'node:crypto';
import { scan } from './inbox.mjs';
import { publishRun } from './publish-run.mjs';
import { publish } from './publish.mjs';
import { publishReviewedFixture } from './fixtures/reviewed-publication.mjs';

test('Cezar feature graph gates commits and publication on planner and review decisions', { timeout: 60000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'studio-feature-'));
  let child;
  t.after(async () => {
    if (child && child.exitCode === null) { child.kill('SIGTERM'); await new Promise((done) => child.once('exit', done)); }
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(join(root, '.ai/cezar/workflows'), { recursive: true });
  await mkdir(join(root, 'studio'));
  await writeFile(join(root, '.gitignore'), 'state/\nideas/\nremote.git/\nfixture-godot\n');
  await cp(resolve('.ai/cezar/workflows/studio-feature.yaml'), join(root, '.ai/cezar/workflows/studio-feature.yaml'));
  await cp(resolve('studio/verify-branch.mjs'), join(root, 'studio/verify-branch.mjs'));
  await cp(resolve('studio/test-game.sh'), join(root, 'studio/test-game.sh'));
  await writeFile(join(root, 'fixture-godot'), '#!/bin/sh\ncase "$*" in *--script*) if [ -f game-fail.fixture ]; then exit 1; fi;; esac\nexit 0\n', { mode: 0o755 });
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', scripts: { test: 'node check.cjs' } }));
  await writeFile(join(root, 'check.cjs'), "const fs = require('fs'); if (!['works','approved'].includes(fs.readFileSync('feature.txt','utf8'))) process.exit(1);\n");
  execFileSync('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: root, stdio: 'ignore' });
  for (const args of [['init', '-b', 'main'], ['config', 'user.name', 'Test'], ['config', 'user.email', 'test@example.invalid'], ['add', '.'], ['commit', '-m', 'fixture']]) execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  const bare = join(root, 'remote.git');
  execFileSync('git', ['init', '--bare', bare], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['push', bare, 'main:main'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/game.git'], { cwd: root, stdio: 'ignore' });
  await mkdir(join(root, 'state'));
  await mkdir(join(root, 'ideas'));
  const issue = '12345678-1234-1234-1234-123456789012';
  const payload = JSON.stringify({ idea: 'Implement fixture' });
  const linear = new DatabaseSync(join(root, 'state/linear.sqlite'));
  linear.exec('CREATE TABLE issues (id TEXT PRIMARY KEY, payload TEXT NOT NULL, published INTEGER NOT NULL DEFAULT 0)');
  linear.prepare('INSERT INTO issues VALUES (?,?,1)').run(issue, payload);
  linear.close();
  await writeFile(join(root, 'ideas', `linear-${issue}.json`), payload);
  const socket = createServer();
  await new Promise((done) => socket.listen(0, '127.0.0.1', done));
  const port = socket.address().port;
  await new Promise((done) => socket.close(done));
  const url = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [resolve('studio/fixtures/cezar-controlled.mjs'), '--no-open', '--port', String(port)], {
    cwd: root, env: { ...process.env, HOME: root, CEZ_HOME: join(root, 'cezar-home'), CEZ_DRY_RUN: '1', CEZ_AUTOSAVE: '0', CEZ_TELEMETRY: '0', CEZ_RELAY: '0', GODOT_BIN: join(root, 'fixture-godot'), STUDIO_TEST_RUNNER: resolve('node_modules/@open-mercato/cezar/dist/core/opencode-server-runner.js'), STUDIO_TEST_CEZAR: resolve('node_modules/@open-mercato/cezar/dist/index.js') }, stdio: 'ignore',
  });
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) {
    if (child.exitCode !== null) throw new Error(`Cezar exited ${child.exitCode}`);
    try { ready = (await fetch(`${url}/api/v1/health`)).ok; } catch {}
    if (!ready) await new Promise((done) => setTimeout(done, 100));
  }
  assert.ok(ready);
  await scan({ inbox: join(root, 'ideas'), state: join(root, 'state'), repoRoot: root, url, workflow: 'studio-feature' });
  const receipt = new DatabaseSync(join(root, 'state/inbox.sqlite'), { readOnly: true });
  const { run_id: id, source_id } = receipt.prepare('SELECT run_id, source_id FROM receipts').get();
  receipt.close();
  assert.equal(source_id, issue);
  let run;
  for (let i = 0; i < 300; i++) {
    run = await (await fetch(`${url}/api/v1/runs/${id}`)).json();
    if (['done', 'review', 'failed', 'cancelled'].includes(run.status)) break;
    await new Promise((done) => setTimeout(done, 100));
  }
  assert.ok(['done', 'review'].includes(run.status), JSON.stringify(run));
  const path = run.worktreePath;
  assert.equal(execFileSync('git', ['show', 'HEAD:feature.txt'], { cwd: path, encoding: 'utf8' }), 'approved');
  assert.notEqual(run.branch, 'main');
  assert.equal(run.graphState.loops.retry, 2);
  assert.ok(run.graphState.taken.some((edge) => edge.includes('review.changes')));
  assert.ok(run.graphState.taken.includes('game.pass->qa'));
  assert.ok(run.graphState.taken.includes('qa.pass->review'));
  const calls = [];
  const fakeApi = async (target, options) => {
    calls.push({ target: String(target), method: options.method || 'GET', body: options.body && JSON.parse(options.body) });
    if (!options.method) return Response.json([]);
    if (String(target).includes('github.com')) return Response.json({ draft: true, html_url: 'https://github.com/acme/game/pull/42' }, { status: 201 });
    return Response.json({ data: { commentCreate: { success: true } } });
  };
  const publisher = (options) => publish({ ...options, fetcher: fakeApi, push: async ({ worktree, sha, branch }) => execFileSync('git', ['push', bare, `${sha}:refs/heads/${branch}`], { cwd: worktree, stdio: 'ignore' }) });
  const approvedSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: path, encoding: 'utf8' }).trim();
  await assert.rejects(publishRun({ id, url, state: join(root, 'state'), repoRoot: root, repo: 'acme/game', githubToken: 'fixture', linearKey: 'fixture', approvedSha: '0'.repeat(40), publisher }), /does not match the reviewed/);
  assert.equal(calls.length, 0);
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const evidence = { runId: id, commit: approvedSha, verdict: 'approve' };
  const signature = sign(null, Buffer.from(JSON.stringify(evidence)), privateKey).toString('hex');
  const reviewed = { id, url, state: join(root, 'state'), repoRoot: root, repo: 'acme/game', githubToken: 'fixture', linearKey: 'fixture', approvedSha, publisher, evidence, signature, publicKey, humanApproved: true };
  await assert.rejects(publishRun({ ...reviewed, evidence: undefined }), /trusted review evidence required/);
  await assert.rejects(publishRun({ ...reviewed, signature: '0'.repeat(128) }), /trusted review evidence required/);
  await assert.rejects(publishRun({ ...reviewed, publicKey: generateKeyPairSync('ed25519').publicKey }), /trusted review evidence required/);
  await assert.rejects(publishRun({ ...reviewed, evidence: { ...evidence, runId: '12345678-1234-1234-1234-123456789099' } }), /trusted review evidence required/);
  const evidencePath = join(root, 'state/review-evidence.json'), publicKeyPath = join(root, 'state/review-public.pem');
  await writeFile(evidencePath, JSON.stringify({ evidence, signature: '0'.repeat(128) }));
  await writeFile(publicKeyPath, publicKey.export({ type: 'spki', format: 'pem' }));
  const rejectedCli = spawnSync(process.execPath, [resolve('studio/publish-run.mjs'), id, '--approve', approvedSha, evidencePath], { cwd: root, env: { PATH: process.env.PATH, CEZ_API_URL: url, STUDIO_STATE: join(root, 'state'), STUDIO_REVIEW_PUBLIC_KEY_FILE: publicKeyPath }, encoding: 'utf8' });
  assert.notEqual(rejectedCli.status, 0);
  assert.match(rejectedCli.stderr, /trusted review evidence required/);
  await assert.rejects(publishReviewedFixture({ ...reviewed, humanApproved: false }), /explicit human approval/);
  await assert.rejects(publishReviewedFixture({ ...reviewed, evidence: undefined }), /trusted review evidence/);
  await assert.rejects(publishReviewedFixture({ ...reviewed, publicKey: generateKeyPairSync('ed25519').publicKey }), /trusted review evidence/);
  await assert.rejects(publishReviewedFixture({ ...reviewed, id: '12345678-1234-1234-1234-123456789099' }), /trusted review evidence/);
  await assert.rejects(publishReviewedFixture({ ...reviewed, approvedSha: '0'.repeat(40) }), /trusted review evidence/);
  const stale = { ...evidence, commit: '0'.repeat(40) };
  await assert.rejects(publishReviewedFixture({ ...reviewed, approvedSha: stale.commit, evidence: stale, signature: sign(null, Buffer.from(JSON.stringify(stale)), privateKey).toString('hex') }), /does not match the reviewed/);
  assert.equal(calls.length, 0, 'rejected evidence reached mock integrations');
  assert.equal(await publishReviewedFixture(reviewed), 'https://github.com/acme/game/pull/42');
  assert.equal(calls[2].body.variables.input.issueId, issue);
  assert.equal(execFileSync('git', ['--git-dir', bare, 'rev-parse', `refs/heads/${run.branch}`], { encoding: 'utf8' }).trim(), execFileSync('git', ['rev-parse', 'HEAD'], { cwd: path, encoding: 'utf8' }).trim());
  const second = await fetch(`${url}/api/v1/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workflow: 'studio-feature', task: 'EXHAUST_RETRIES', runner: 'opencode', worktree: true, autonomous: true }) });
  assert.equal(second.status, 201);
  const secondId = (await second.json()).id;
  let failed;
  for (let i = 0; i < 300; i++) {
    failed = await (await fetch(`${url}/api/v1/runs/${secondId}`)).json();
    if (['done', 'review', 'failed', 'cancelled'].includes(failed.status)) break;
    await new Promise((done) => setTimeout(done, 100));
  }
  assert.equal(failed.status, 'failed', JSON.stringify(failed));
  assert.ok(failed.graphState.taken.some((edge) => edge.includes('retry.exhausted')));
  const thirdIssue = '12345678-1234-1234-1234-123456789013';
  const thirdPayload = JSON.stringify({ idea: 'FAIL_GAME' });
  const linearAgain = new DatabaseSync(join(root, 'state/linear.sqlite'));
  linearAgain.prepare('INSERT INTO issues VALUES (?,?,1)').run(thirdIssue, thirdPayload);
  linearAgain.close();
  await writeFile(join(root, 'ideas', `linear-${thirdIssue}.json`), thirdPayload);
  await scan({ inbox: join(root, 'ideas'), state: join(root, 'state'), repoRoot: root, url, workflow: 'studio-feature' });
  const receiptAgain = new DatabaseSync(join(root, 'state/inbox.sqlite'), { readOnly: true });
  const thirdId = receiptAgain.prepare('SELECT run_id FROM receipts WHERE source_id=?').get(thirdIssue).run_id;
  receiptAgain.close();
  let gameFailed;
  for (let i = 0; i < 300; i++) {
    gameFailed = await (await fetch(`${url}/api/v1/runs/${thirdId}`)).json();
    if (['done', 'review', 'failed', 'cancelled'].includes(gameFailed.status)) break;
    await new Promise((done) => setTimeout(done, 100));
  }
  assert.equal(gameFailed.status, 'failed', JSON.stringify(gameFailed));
  assert.ok(gameFailed.graphState.taken.some((edge) => edge.includes('game.fail')));
  assert.ok(!gameFailed.graphState.taken.some((edge) => edge.includes('review.approve')));
  await assert.rejects(publishRun({ id: thirdId, url, state: join(root, 'state'), repoRoot: root, repo: 'acme/game', githubToken: 'fixture', linearKey: 'fixture', publisher }), /has not passed Godot checks/);
  assert.equal(calls.length, 3);
  for (const [suffix, idea, expectedEdge] of [
    ['014', 'BLOCK_PLAN', 'plan.blocked->blocked'],
    ['015', 'ALWAYS_REJECT', 'retry.exhausted->blocked'],
  ]) {
    const issueId = `12345678-1234-1234-1234-123456789${suffix}`;
    const payload = JSON.stringify({ idea });
    const tracker = new DatabaseSync(join(root, 'state/linear.sqlite'));
    tracker.prepare('INSERT INTO issues VALUES (?,?,1)').run(issueId, payload);
    tracker.close();
    await writeFile(join(root, 'ideas', `linear-${issueId}.json`), payload);
    await scan({ inbox: join(root, 'ideas'), state: join(root, 'state'), repoRoot: root, url, workflow: 'studio-feature' });
    const receipts = new DatabaseSync(join(root, 'state/inbox.sqlite'), { readOnly: true });
    const runId = receipts.prepare('SELECT run_id FROM receipts WHERE source_id=?').get(issueId).run_id;
    receipts.close();
    let blocked;
    for (let i = 0; i < 300; i++) {
      blocked = await (await fetch(`${url}/api/v1/runs/${runId}`)).json();
      if (['done', 'review', 'failed', 'cancelled'].includes(blocked.status)) break;
      await new Promise((done) => setTimeout(done, 100));
    }
    assert.equal(blocked.status, 'failed', JSON.stringify(blocked));
    assert.ok(blocked.graphState.taken.includes(expectedEdge), JSON.stringify(blocked.graphState.taken));
    if (idea === 'ALWAYS_REJECT') assert.ok(blocked.graphState.taken.includes('review.changes->retry'));
    assert.ok(!blocked.graphState.taken.includes('review.approve->commit'));
    const log = execFileSync('git', ['log', '--format=%s', 'main..HEAD'], { cwd: blocked.worktreePath, encoding: 'utf8' }).trim();
    assert.ok(log && log.split('\n').every((subject) => ['cezar autosave (run finalize)', 'cezar autosave (turn end)'].includes(subject)), `unexpected worktree commits: ${log}`);
    await assert.rejects(publishRun({ id: runId, url, state: join(root, 'state'), repoRoot: root, repo: 'acme/game', githubToken: 'fixture', linearKey: 'fixture', publisher }), /has not passed Godot checks/);
    const blockedSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: blocked.worktreePath, encoding: 'utf8' }).trim();
    const blockedEvidence = { runId, commit: blockedSha, verdict: 'approve' };
    await assert.rejects(publishReviewedFixture({ ...reviewed, id: runId, approvedSha: blockedSha, evidence: blockedEvidence, signature: sign(null, Buffer.from(JSON.stringify(blockedEvidence)), privateKey).toString('hex') }), /has not passed Godot checks/);
    const unapproved = spawnSync(process.execPath, [resolve('studio/publish-run.mjs'), runId], { cwd: root, env: { PATH: process.env.PATH }, encoding: 'utf8' });
    assert.notEqual(unapproved.status, 0);
    assert.match(unapproved.stderr, /RUN_ID --approve/);
    const remoteBranch = spawnSync('git', ['--git-dir', bare, 'show-ref', '--verify', '--quiet', `refs/heads/${blocked.branch}`]);
    assert.equal(remoteBranch.status, 1, 'failed feature branch was promoted to the disposable remote');
    assert.equal(calls.length, 3, 'blocked run invoked the mock publisher');
    console.log(`PASS ${idea}: ${expectedEdge}; no feature-commit node or publication; CEZ_AUTOSAVE=0 still yielded: ${[...new Set(log.split('\n'))].join(', ')}`);
  }
  assert.equal(execFileSync('git', ['rev-parse', 'main'], { cwd: root, encoding: 'utf8' }).trim(), execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim());
});
