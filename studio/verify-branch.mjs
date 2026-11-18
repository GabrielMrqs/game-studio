import { spawnSync } from 'node:child_process';

const base = process.env.CEZ_BASE;
const branch = process.env.CEZ_BRANCH;
function git(...args) {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  if (result.error) throw result.error;
  return result;
}
try {
  if (!base || !branch || base === branch) throw new Error('missing or unsafe base/feature branch');
  const current = git('branch', '--show-current');
  if (current.status !== 0 || current.stdout.trim() !== branch) throw new Error('not on the expected feature branch');
  if (git('merge-base', '--is-ancestor', base, 'HEAD').status !== 0) throw new Error('base is not an ancestor');
  const diff = git('diff', '--quiet', base, 'HEAD', '--');
  if (diff.status !== 1) throw new Error('no committed feature changes, or cannot compare to base');
  const status = git('status', '--porcelain');
  if (status.status !== 0 || status.stdout.trim()) throw new Error('feature worktree has uncommitted changes');
  console.log(`Verified committed changes on ${branch} against ${base}`);
} catch (error) {
  console.error(`Branch verification failed: ${error.message}`);
  process.exitCode = 1;
}
