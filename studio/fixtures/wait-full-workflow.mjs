import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync('/handoff/inbox.sqlite', { readOnly: true });
const receipt = db.prepare('SELECT run_id, source_id FROM receipts').get();
db.close();
assert.equal(receipt.source_id, '12345678-1234-1234-1234-123456789012');
for (let i = 0; i < 480; i++) {
  const run = await (await fetch(`http://127.0.0.1:14321/api/v1/runs/${receipt.run_id}`)).json();
  if (['done', 'review', 'failed', 'cancelled'].includes(run.status)) {
    assert.ok(['done', 'review'].includes(run.status), `workflow ${run.status}: ${run.error}`);
    for (const edge of ['implement.done->narrative', 'narrative.done->art_ui', 'art_ui.done->install', 'test.fail->retry', 'game.pass->qa', 'qa.pass->review', 'review.changes->retry', 'review.approve->commit', 'branch_check.pass->done']) assert.ok(run.graphState.taken.includes(edge), `missing ${edge}`);
    const sessions = ['plan', 'implement', 'narrative', 'art_ui', 'qa', 'review'].map((id) => run.steps.find((step) => step.id === id));
    assert.ok(sessions.every((step) => step.backend === 'opencode' && step.sessionId.startsWith('ses_')));
    assert.equal(new Set(sessions.map((step) => step.sessionId)).size, sessions.length);
    assert.equal(execFileSync('git', ['show', 'HEAD:game/fixture-status.txt'], { cwd: run.worktreePath, encoding: 'utf8' }), 'works');
    console.log('PASS real OpenCode sessions: test failure → fix → Godot → QA → review changes → fix → approved feature commit');
    process.exit(0);
  }
  await new Promise((done) => setTimeout(done, 500));
}
throw new Error('feature fixture exceeded its 240-second deadline');
