import { closeSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { draftGit } from './draft-git.mjs';
import { journal, pipeline } from './draft-pipeline.mjs';
import { github, Transient } from './github.mjs';
import { linearReview, uuid } from './linear-review.mjs';
import { gameRunner, git, lockRepo, privateDir, shutdown } from './once.mjs';

const root = realpathSync(fileURLToPath(new URL('../', import.meta.url)));
const { signal } = shutdown;
const watch = process.argv[2] === '--watch';
const check = process.argv[2] === '--check';
const safeConfig = resolve(root, '.studio-state');
const sleep = ms => setTimeout(ms, undefined, { signal });

function secret(name, profile) {
  const path = join(userInfo().homedir, '.config/game-studio', name);
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077)) {
    throw new Error(`Missing private repository credential or invalid permissions: ${path}`);
  }
  const canonical = realpathSync(path);
  if ([profile, root, '/usr', '/lib', '/lib64', '/etc'].some(dir => canonical.startsWith(dir + sep))) {
    throw new Error('Credentials must be outside all agent mounts.');
  }
  return [canonical, readFileSync(canonical, 'utf8').trim()];
}

async function recovery(config, linear) {
  const legacy = new Map();
  const ref = name => git(root, 'rev-parse', '--verify', name).trim();
  const hasGate = git(root, 'for-each-ref', '--format=%(refname)', 'refs/studio/active').trim() !== '';
  if (hasGate !== Boolean(config.recoveryRun)) throw new Error('Legacy active gate requires an explicit recoveryRun mapping.');
  if (!hasGate) return legacy;
  const run = config.recoveryRun;
  if (typeof run !== 'string' || !/^once-[A-Za-z0-9]{6}$/.test(run)) throw new Error('Invalid legacy run ID.');
  const original = privateDir(join(resolve(root, config.logsDir ?? '.studio-state'), run));
  const work = realpathSync(join(resolve(root, config.workspaceDir ?? config.logsDir ?? '.studio-state'), run, 'work'));
  const claim = /^Linear ([A-Z0-9]+-\d+) \(([a-f0-9-]+)\): requesting In Progress\nIn Progress confirmed\n$/
    .exec(readFileSync(join(original, 'linear.log'), 'utf8'));
  if (!claim || !uuid.test(claim[2])) throw new Error('Legacy claim is not confirmed.');
  const [, identifier, id] = claim;
  const base = ref('refs/studio/active');
  const branch = `refs/heads/studio/${run}`;
  if (ref(`refs/studio/linear/${id}`) !== base || ref(branch) !== base ||
      !git(root, 'worktree', 'list', '--porcelain', '-z').split('\0\0').includes(`worktree ${work}\0HEAD ${base}\0branch ${branch}`)) {
    throw new Error('Legacy claim, active gate and worktree must match.');
  }
  const issue = await linear.issue(id);
  if (issue?.id !== id || issue.identifier !== identifier) throw new Error('Legacy receipt does not match Linear.');
  legacy.set(id, { base, work, issue });
  return legacy;
}

let lock;
try {
  if (process.argv.length !== (watch || check ? 3 : 2)) throw new Error('Expected --watch or --check.');
  lock = lockRepo();
  const config = JSON.parse(readFileSync(join(safeConfig, 'once.json')));
  if (!config.github?.repository || !config.linear?.doneId) {
    throw new Error('Configure github.repository and Linear doneId in .studio-state/once.json.');
  }
  const profile = privateDir(resolve(root, config.opencodeHome ?? join(homedir(), '.local/share/game-studio/opencode')));
  const [keyPath, key] = secret('github.key', profile);
  const [, linearKey] = secret('linear.key', profile);
  const gh = github(config.github.repository, key, signal);
  const linear = linearReview(config.linear, linearKey, signal);
  const game = gameRunner(config);
  await gh.preflight();
  await linear.verify();
  const legacy = await recovery(config, linear);
  const dir = privateDir(join(safeConfig, 'github'), true);
  const repo = draftGit(root, dir, config.github.repository, keyPath, signal, legacy);
  const tick = pipeline({ storage: journal(dir), dir, git: repo, github: gh, linear, game, signal, legacy });
  const interval = config.linear.pollSeconds ?? 60;
  if (!Number.isSafeInteger(interval) || interval < 15 || interval > 3600) throw new Error('Invalid pollSeconds.');
  let announced = false;
  do {
    try {
      const main = await repo.refresh();
      if (check) console.log(`Preflight passed: protected main ${main}; ${legacy.size} legacy recovery mapping(s).`);
      else {
        await tick(main);
        if (!announced && watch) console.log(`Watcher ready pid=${process.pid} main=${main}`);
        announced = true;
      }
    } catch (error) {
      if (!watch || !(error instanceof Transient)) throw error;
      console.warn(error.message);
      await sleep(Math.max(interval * 1000, error.wait));
      continue;
    }
    if (watch && !signal.aborted) await sleep(interval * 1000);
  } while (watch && !signal.aborted);
} catch (error) {
  if (!signal.aborted) {
    console.error(`Studio stopped: ${error.message}`);
    process.exitCode = error instanceof Transient ? 75 : 1;
  }
} finally {
  if (lock !== undefined) closeSync(lock);
}
