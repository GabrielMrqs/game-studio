import { readFile, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

export async function checkStartup(repoRoot) {
  const data = join(repoRoot, '.ai/cezar');
  let raw;
  try {
    raw = await readFile(join(data, 'runs.json'), 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    for (const dir of ['runs', 'worktrees']) {
      try {
        if ((await readdir(join(data, dir))).length) throw new Error('run index missing while Cezar state exists');
      } catch (cause) {
        if (cause.code !== 'ENOENT') throw cause;
      }
    }
    return;
  }
  const runs = JSON.parse(raw);
  if (!Array.isArray(runs)) throw new Error('invalid Cezar run index');
  const ids = new Set();
  let registered, commonDir;
  const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd();
  for (const run of runs) {
    if (!run || typeof run !== 'object' || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(run.id || '') || ids.has(run.id.toLowerCase()) || !['queued', 'running', 'waiting', 'review', 'done', 'failed', 'cancelled'].includes(run.status)) {
      throw new Error('unrecognized Cezar run record');
    }
    ids.add(run.id.toLowerCase());
    const recoverable = ['queued', 'running', 'waiting', 'review'].includes(run.status) || (run.status === 'failed' && run.autoResumeAt);
    if (recoverable && (typeof run.worktreePath !== 'string' || !run.worktreePath.trim())) {
      throw new Error(`active run ${run.id} has no recorded worktree path`);
    }
    if (recoverable) {
      try {
        const root = await realpath(repoRoot);
        const expected = join(root, '.ai/cezar/worktrees', run.id);
        if (!isAbsolute(run.worktreePath) || resolve(run.worktreePath) !== expected || await realpath(expected) !== expected) throw new Error('unexpected path');
        if (!registered) {
          registered = git(root, ['worktree', 'list', '--porcelain', '-z']).split('\0').filter((field) => field.startsWith('worktree ')).map((field) => field.slice(9));
          commonDir = await realpath(git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
        }
        if (!registered.includes(expected) || await realpath(git(expected, ['rev-parse', '--path-format=absolute', '--show-toplevel'])) !== expected || await realpath(git(expected, ['rev-parse', '--path-format=absolute', '--git-common-dir'])) !== commonDir) throw new Error('not a registered worktree');
        if ((run.status === 'review' && (typeof run.branch !== 'string' || !run.branch.trim())) || (run.branch && git(expected, ['branch', '--show-current']) !== run.branch)) throw new Error('branch mismatch');
      } catch {
        throw new Error(`active run ${run.id} has an invalid or mismatched worktree`);
      }
    }
    if (['queued', 'running', 'waiting'].includes(run.status) || (run.status === 'failed' && run.autoResumeAt)) {
      throw new Error(`interrupted run ${run.id} requires operator review before startup`);
    }
  }
  let worktrees;
  try { worktrees = await readdir(join(data, 'worktrees')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; worktrees = []; }
  if (worktrees.some((name) => !ids.has(name.toLowerCase()))) throw new Error('unindexed Cezar worktree requires operator review');
  let events;
  try { events = await readdir(join(data, 'runs')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; events = []; }
  if (events.some((name) => /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}\.ndjson$/i.test(name) && !ids.has(name.slice(0, -7).toLowerCase()))) throw new Error('unindexed Cezar event log requires operator review');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await checkStartup(process.cwd());
  } catch (error) {
    console.error(`Cezar startup blocked: ${error.message}. Investigate persisted state before restarting.`);
    process.exitCode = 1;
  }
}
