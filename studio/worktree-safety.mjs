import { lstat } from 'node:fs/promises';
import { join } from 'node:path';

export async function hasUnrecordedWorktree(run, repoRoot) {
  if (!['queued', 'running', 'waiting'].includes(run.status) || (typeof run.worktreePath === 'string' && run.worktreePath.trim().length > 0) || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(run.id || '')) return false;
  try {
    await lstat(join(repoRoot, '.ai/cezar/worktrees', run.id, '.git'));
    return true;
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) return false;
    throw error;
  }
}
