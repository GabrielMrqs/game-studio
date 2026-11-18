// Test-only agent responses; the workflow runner, checks and Git operations are real.
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const { OpencodeServerRunner } = await import(pathToFileURL(process.env.STUDIO_TEST_RUNNER));
OpencodeServerRunner.prototype.startSession = function (spec, emit) {
  let resolve;
  const result = new Promise((done) => { resolve = done; });
  const session = { open: true, result, end() { this.open = false; resolve({ tokensUsed: 0 }); }, interrupt() { this.end(); }, sendMessage() {} };
  setImmediate(() => {
    let response = 'Done.';
    if (spec.userPrompt.includes('Act as producer.')) {
      writeFileSync(join(spec.cwd, 'plan.md'), 'Acceptance: feature is approved.\n');
      if (spec.userPrompt.includes('EXHAUST_RETRIES')) writeFileSync(join(spec.cwd, 'exhaust.fixture'), 'yes');
      if (spec.userPrompt.includes('FAIL_GAME')) writeFileSync(join(spec.cwd, 'game-fail.fixture'), 'yes');
      if (spec.userPrompt.includes('ALWAYS_REJECT')) writeFileSync(join(spec.cwd, 'reject.fixture'), 'yes');
      response = spec.userPrompt.includes('BLOCK_PLAN') ? 'Creative decision requires approval.\nCEZ:VERDICT blocked' : 'Planned.\nCEZ:VERDICT ready';
    } else if (spec.userPrompt.includes('Act as gameplay engineer')) {
      writeFileSync(join(spec.cwd, 'feature.txt'), 'broken');
    } else if (spec.userPrompt.includes('Fix the failing check')) {
      const file = join(spec.cwd, 'feature.txt');
      if (!existsSync(join(spec.cwd, 'exhaust.fixture'))) writeFileSync(file, readFileSync(file, 'utf8') === 'broken' ? 'works' : 'approved');
    } else if (spec.userPrompt.includes('Act as QA.')) {
      response = 'Checks verified.\nCEZ:VERDICT pass';
    } else if (spec.userPrompt.includes('Independently review')) {
      response = existsSync(join(spec.cwd, 'reject.fixture')) || readFileSync(join(spec.cwd, 'feature.txt'), 'utf8') === 'works'
        ? 'Needs improvement.\nCEZ:VERDICT changes' : 'Accepted.\nCEZ:VERDICT approve';
    }
    emit({ type: 'session', sessionId: `test-${Math.random()}` });
    emit({ type: 'text', text: response });
    emit({ type: 'turn-end' });
  });
  return session;
};
await import(pathToFileURL(process.env.STUDIO_TEST_CEZAR));
