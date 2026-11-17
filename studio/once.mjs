import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  accessSync, constants, closeSync, lstatSync, mkdirSync, mkdtempSync,
  openSync, readdirSync, readFileSync, realpathSync, writeFileSync,
} from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { setImmediate, setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { linearSource } from './linear-source.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const watch = process.argv.includes('--watch');
const active = 'refs/studio/active';
const develop = 'refs/heads/studio/develop';
const paths = ['game/main.gd', 'game/tests/smoke.gd'];
const git = (cwd, ...args) => gitWithInput(cwd, undefined, ...args);
const gitWithInput = (cwd, input, ...args) => execFileSync('git', [
  '-c', 'core.hooksPath=/dev/null', '-C', cwd, ...args,
], { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] });
const updateRefs = (...commands) => gitWithInput(root, `${commands.join('\n')}\n`, 'update-ref', '--no-deref', '--stdin');

function lockRepo() {
  const fd = openSync(git(root, 'rev-parse', '--path-format=absolute', '--git-common-dir').trim(), 'r');
  try {
    // flock locks the open file description, which Node keeps until this command exits.
    execFileSync('flock', ['-n', '-E', '75', '3'], { stdio: ['ignore', 'pipe', 'pipe', fd] });
    return fd;
  } catch (error) {
    closeSync(fd);
    if (error.status === 75) throw new Error('Another studio:once or studio:watch is active.');
    throw error;
  }
}

let logs;
let work;
let sha;
let child;
let interrupted;
const shutdown = new AbortController();
const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
function cancel(signal) {
  interrupted = signal;
  shutdown.abort();
  if (child) {
    // Signal timeout's process group; Bubblewrap tears down its private PID namespace.
    try { process.kill(-child.pid, 'SIGTERM'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
}

async function run(label, command, args) {
  const log = join(logs, label);
  const fd = openSync(log, 'wx', 0o600);
  console.log(`Running ${label}: ${log}`);
  try {
    await new Promise((resolve, reject) => {
      child = spawn(command, args, { detached: true, stdio: ['ignore', fd, fd] });
      child.once('error', reject);
      child.once('close', (code, signal) => {
        if (interrupted || code !== 0) {
          reject(new Error(`${label} failed (${interrupted || signal || `exit ${code}`})`));
        } else resolve();
      });
    });
  } finally {
    child = undefined;
    closeSync(fd);
  }
  return readFileSync(log, 'utf8');
}

function privateDir(path, create = false) {
  if (create) mkdirSync(path, { recursive: true, mode: 0o700 });
  const canonical = realpathSync(path);
  const stat = lstatSync(canonical);
  if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o077)) {
    throw new Error(`Expected a user-owned private directory (0700): ${path}`);
  }
  return canonical;
}

function developTip() {
  const refs = git(root, 'for-each-ref', '--format=%(refname) %(objectname) %(symref)', develop);
  const [, tip, target] = refs.split('\n').find(line => line.startsWith(`${develop} `))?.split(' ') ?? [];
  if (!tip || target) throw new Error('Create a local studio/develop branch from a validated game commit.');
  if (git(root, 'worktree', 'list', '--porcelain', '-z').split('\0').includes(`branch ${develop}`)) {
    throw new Error('studio/develop is checked out. Use a detached worktree to play it.');
  }
  return tip;
}

async function processIdea(config, linear) {
  const ideas = join(root, 'ideas');
  const receipts = 'refs/studio/ideas';
  const claimed = new Set(git(root, 'for-each-ref', '--format=%(refname)',
    receipts, 'refs/studio/linear').split('\n'));
  const files = readdirSync(ideas, { withFileTypes: true })
    .filter(file => file.isFile() && file.name.endsWith('.md'))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(({ name }) => {
      const idea = readFileSync(join(ideas, name), 'utf8').replace(/\r\n/g, '\n').trim();
      return { name, idea, receipt: `${receipts}/${createHash('sha256').update(idea).digest('hex')}` };
    }).filter(file => !claimed.has(file.receipt));
  const task = files[0] ?? await linear?.next(claimed);
  if (interrupted) return false;
  if (!task) {
    if (!watch) console.log(`No new ideas in ideas/${linear ? ' or Linear' : ''}; previously claimed ideas will not run again.`);
    return false;
  }
  if (!watch && files.length !== 1) throw new Error('Leave exactly one unclaimed Markdown idea in ideas/.');
  const { name, idea, receipt, id, title } = task;
  if (!idea || Buffer.byteLength(idea) > 16_384) {
    throw new Error('The idea must contain between 1 and 16384 bytes.');
  }

  const base = developTip();
  const game = git(root, 'ls-tree', '-r', '-z', '--name-only', base, '--', 'game')
    .split('\0').filter(Boolean);
  if (![...paths, 'game/project.godot'].every(path => game.includes(path))) {
    throw new Error('studio/develop has no playable Godot project.');
  }
  const profile = resolve(root, config.opencodeHome ?? join(homedir(), '.local/share/game-studio/opencode'));
  if (!lstatSync(profile, { throwIfNoEntry: false })) {
    throw new Error(`Dedicated OpenCode profile not found: ${profile}. Set opencodeHome in .studio-state/once.json.`);
  }
  const home = privateDir(profile);
  if (home === realpathSync(userInfo().homedir) || home === realpathSync(homedir())) {
    throw new Error('OpenCode needs a dedicated, user-owned 0700 sandbox home, not your regular home.');
  }
  const godot = realpathSync(resolve(root, config.godot ?? '/usr/bin/godot'));
  accessSync(godot, constants.X_OK);

  const logsDir = privateDir(resolve(root, config.logsDir ?? '.studio-state'), true);
  const workspaceDir = config.workspaceDir === undefined
    ? logsDir : privateDir(resolve(root, config.workspaceDir), true);
  // A crash leaves both the receipt and the review gate, never just one.
  updateRefs(`verify ${develop} ${base}`, `create ${receipt} ${base}`, `create ${active} ${base}`);
  logs = mkdtempSync(join(logsDir, 'once-'));
  const runId = basename(logs);
  const branch = `studio/${runId}`;
  work = join(workspaceDir, runId, 'work');
  console.log(`Claim: ${receipt}`);
  git(root, 'worktree', 'add', '-b', branch, work, base);
  console.log(`Idea: ${name}\nBase: ${base}\nBranch: ${branch}\nWorktree: ${work}`);
  const audit = line => writeFileSync(join(logs, 'linear.log'), `${line}\n`, {
    flag: 'a', mode: 0o600, flush: true,
  });
  if (id) {
    audit(`${name} (${id}): requesting In Progress`);
    await linear.setState(id, false);
    audit('In Progress confirmed');
    shutdown.signal.throwIfAborted();
  }
  const sandbox = (limit, ...args) => [
    '--signal=TERM', '--kill-after=5s', limit, 'bwrap',
    '--unshare-all', '--die-with-parent', '--new-session',
    '--ro-bind', '/usr', '/usr', '--ro-bind', '/lib', '/lib', '--ro-bind-try', '/lib64', '/lib64',
    '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/sbin', '/sbin',
    '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--dir', '/opt/bin',
    '--dir', '/work', '--chdir', '/work', '--clearenv',
    '--setenv', 'HOME', '/home/agent', '--setenv', 'PATH', '/opt/bin:/usr/bin:/bin',
    ...args,
  ];
  const agent = await run('agent.jsonl', 'flock', ['-n', '-F', home, 'timeout', ...sandbox('240s',
    '--share-net', '--ro-bind', '/etc/ssl', '/etc/ssl',
    '--ro-bind', '/etc/resolv.conf', '/etc/resolv.conf', '--ro-bind', '/etc/hosts', '/etc/hosts',
    '--bind', home, '/home/agent',
    '--ro-bind', join(root, 'studio/once-opencode.json'), '/home/agent/.config/opencode/opencode.json',
    '--bind', join(work, 'game'), '/work/game',
    '/usr/bin/opencode', '--standalone', 'run', '--format', 'json',
    '--model', 'openai/gpt-6.1-terra', '--agent', 'build',
    'Implement this one Godot gameplay idea. Make a minimal change in game/main.gd and add a ' +
    'behavioral check in game/tests/smoke.gd. Keep all existing checks. Do not run commands, ' +
    'ask questions, or commit. The runner will test and commit.\n\n' + idea,
  )]);
  const events = agent.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
  if (events.some(event => event.type === 'error') ||
      !events.some(event => event.type === 'step_finish' && event.part?.reason === 'stop')) {
    throw new Error('OpenCode did not complete successfully; see agent.jsonl.');
  }
  const status = git(work, 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored')
    .split('\0').filter(Boolean);
  if (status.length !== paths.length || !paths.every(path =>
    status.includes(` M ${path}`) && lstatSync(join(work, path)).isFile())) {
    throw new Error('Expected gameplay and smoke-test edits, with no other changes.');
  }
  git(work, 'add', '--', ...paths);
  git(work, 'diff', '--cached', '--check');
  const stagedTree = git(work, 'write-tree').trim();

  // Godot imports rewrite metadata; let it write to a copy of the staged game, not the worktree.
  const validation = join(logs, 'validation');
  git(work, 'checkout-index', `--prefix=${validation}/`, '--', ...game);
  const tests = await run('godot.log', 'timeout', sandbox('90s',
    '--dir', '/home/agent', '--bind', join(validation, 'game'), '/work/game',
    '--ro-bind-try', '/etc/fonts', '/etc/fonts',
    '--ro-bind', godot, '/opt/bin/godot',
    '--ro-bind', join(root, 'studio/test-game.sh'), '/opt/test-game.sh',
    '/bin/sh', '/opt/test-game.sh',
  ));
  if (/^\s*(?:SCRIPT )?ERROR:/m.test(tests) || !/^PASS: /m.test(tests)) {
    throw new Error('Godot reported errors or did not reach the smoke-test pass marker.');
  }
  git(work, '-c', 'commit.gpgsign=false', 'commit', '-m', `Gameplay: ${id ? name : name.slice(0, -3)}`);
  sha = git(work, 'rev-parse', 'HEAD').trim();
  if (git(work, 'show', '-s', '--format=%P %T', sha).trim() !== `${base} ${stagedTree}`) {
    throw new Error('Feature commit does not match the tested tree and parent; not advancing studio/develop.');
  }
  if (developTip() !== base) throw new Error('studio/develop moved during the run; not advancing it.');
  // The tested commit is a direct child of the baseline. Never merge an untested tree.
  updateRefs(`update ${develop} ${sha} ${base}`, `update ${receipt} ${sha} ${base}`,
    id ? `update ${active} ${sha} ${base}` : `delete ${active} ${base}`);
  if (id) {
    audit(`Validated and integrated ${sha}; requesting commit comment`);
    const comment = await linear.comment(id, `Implemented: ${title}\n\nLocal commit: \`${sha}\` on \`studio/develop\`.\nGodot import, startup and gameplay smoke tests passed.`);
    audit(`Comment confirmed (${comment}); requesting Done`);
    await linear.setState(id, true);
    audit('Done confirmed');
    updateRefs(`delete ${active} ${sha}`);
  }
  console.log(tests.trim());
  console.log(`SUCCESS: ${sha} (studio/develop)\nLogs: ${logs}`);
  return true;
}

let lock;
for (const signal of signals) process.on(signal, cancel);
try {
  lock = lockRepo();
  if (git(root, 'for-each-ref', '--format=%(refname)', active).split('\n').includes(active)) {
    throw new Error(`A previous run needs review (${active}). No ideas will start.`);
  }
  const configPath = join(root, '.studio-state/once.json');
  const config = lstatSync(configPath, { throwIfNoEntry: false })
    ? JSON.parse(readFileSync(configPath, 'utf8')) : {};
  let linear;
  if (config.linear) {
    const keyPath = join(userInfo().homedir, '.config/game-studio/linear.key');
    const stat = lstatSync(keyPath, { throwIfNoEntry: false });
    if (!stat?.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077)) {
      throw new Error(`Linear requires a private, user-owned key file at ${keyPath}.`);
    }
    const key = realpathSync(keyPath);
    const profile = realpathSync(resolve(root, config.opencodeHome ?? join(homedir(), '.local/share/game-studio/opencode')));
    if ([profile, resolve(root), '/usr', '/lib', '/lib64', '/etc'].some(dir => key.startsWith(dir + sep))) {
      throw new Error('Linear key must be outside the checkout and sandbox mounts.');
    }
    linear = linearSource(config.linear, readFileSync(key, 'utf8').trim(), shutdown.signal);
  }
  if (watch) console.log(`Watching ideas/${linear ? ' and Linear' : ''} (Ctrl+C to stop).`);
  do {
    logs = work = sha = undefined;
    const processed = await processIdea(config, linear);
    if (watch && !interrupted) {
      if (processed) await setImmediate();
      else await setTimeout(1000);
    }
  } while (watch && !interrupted);
} catch (error) {
  console.error(`${interrupted ? 'STOPPED' : 'FAILURE'}: ${error.stderr?.trim() || error.message}`);
  console.error(sha ? `Feature commit created: ${sha}` : 'No feature commit created.');
  if (logs) console.error(`Logs: ${logs}`);
  if (work) console.error(`Worktree: ${work}`);
  process.exitCode = 1;
} finally {
  if (interrupted) {
    console.log(`Studio stopped (${interrupted}).`);
    process.exitCode = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 }[interrupted];
  }
  if (lock !== undefined) closeSync(lock);
  for (const signal of signals) process.off(signal, cancel);
}
