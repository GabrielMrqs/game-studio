import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  accessSync, constants, closeSync, lstatSync, mkdirSync, mkdtempSync,
  openSync, readdirSync, readFileSync, realpathSync, writeFileSync,
} from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { setImmediate, setTimeout } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { linearSource } from './linear-source.mjs';
import { editRules, needsVisualReview, requiredGame, validatedPaths } from './once-paths.mjs';
import { failedGodot, screenshotPaths, stageGame } from './once-validation.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const watch = process.argv[2] === '--watch';
const recovery = process.argv[2] === '--recovery-preview';
const active = 'refs/studio/active';
const develop = 'refs/heads/studio/develop';
export const git = (cwd, ...args) => gitWithInput(cwd, undefined, ...args);
const gitWithInput = (cwd, input, ...args) => runGit(cwd, input, process.env, args);
const runGit = (cwd, input, env, args) => execFileSync('git', [
  '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '--literal-pathspecs', '-C', cwd, ...args,
], { env, encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] });
const updateRefs = (...commands) => gitWithInput(root, `${commands.join('\n')}\n`, 'update-ref', '--no-deref', '--stdin');

export function lockRepo() {
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
export const shutdown = new AbortController();
class VisualReview extends Error {}
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

export function privateDir(path, create = false) {
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

export function validationTools(config) {
  const godot = realpathSync(resolve(root, config.godot ?? '/usr/bin/godot'));
  accessSync(godot, constants.X_OK);
  const xvfb = realpathSync(resolve(root, config.xvfb ?? '/usr/bin/Xvfb'));
  accessSync(xvfb, constants.X_OK);
  accessSync('/usr/bin/convert', constants.X_OK);
  return { godot, xvfb };
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
  if (!watch && files.length > 1) throw new Error('Leave exactly one unclaimed Markdown idea in ideas/.');
  const { name, idea, receipt, id, title } = task;
  if (!idea || Buffer.byteLength(idea) > 16_384) {
    throw new Error('The idea must contain between 1 and 16384 bytes.');
  }

  const base = developTip();
  const game = git(root, 'ls-tree', '-r', '-z', '--name-only', base, '--', 'game')
    .split('\0').filter(Boolean);
  if (!requiredGame.every(path => game.includes(path))) {
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
  const tools = validationTools(config);

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
  await editGame(home, idea, 'The runner will test and prepare a commit for visual review.');
  const { edits, stagedTree } = stageEdits(base, (...args) => git(work, ...args));
  const { tests, frames } = await validateTree(stagedTree, tools);
  shutdown.signal.throwIfAborted();
  git(work, '-c', 'commit.gpgsign=false', 'commit', '-m', `Gameplay: ${id ? name : name.slice(0, -3)}`);
  sha = git(work, 'rev-parse', 'HEAD').trim();
  if (git(work, 'show', '-s', '--format=%P %T', sha).trim() !== `${base} ${stagedTree}`) {
    throw new Error('Feature commit does not match the tested tree and parent; not advancing studio/develop.');
  }
  if (developTip() !== base) throw new Error('studio/develop moved during the run; not advancing it.');
  if (needsVisualReview(edits)) {
    writeFileSync(join(logs, 'visual-review.json'), JSON.stringify({
      base, receipt, branch, commit: sha, tree: stagedTree, linearIssueId: id ?? null,
      screenshots: frames.map(name => `screenshots/${name}`),
    }, null, 2) + '\n', { flag: 'wx', mode: 0o600, flush: true });
    if (id) audit(`Awaiting visual review of ${sha}; issue stays In Progress`);
    throw new VisualReview('Automated checks passed; inspect the screenshots before integrating. studio/develop was not advanced.');
  }
  // The tested commit is a direct child of the baseline. Never merge an untested tree.
  updateRefs(`update ${develop} ${sha} ${base}`, `update ${receipt} ${sha} ${base}`,
    id ? `update ${active} ${sha} ${base}` : `delete ${active} ${base}`);
  if (id) {
    audit(`Validated and integrated ${sha}; requesting commit comment`);
    const comment = await linear.comment(id, `Implemented: ${title}\n\nLocal commit: \`${sha}\` on \`studio/develop\`.\nGodot import, startup, gameplay smoke, UI navigation and screenshot verification passed.`);
    audit(`Comment confirmed (${comment}); requesting Done`);
    await linear.setState(id, true);
    audit('Done confirmed');
    updateRefs(`delete ${active} ${sha}`);
  }
  console.log(tests.trim());
  console.log(`SUCCESS: ${sha} (studio/develop)\nLogs: ${logs}`);
  return true;
}

async function editGame(home, idea, handoff) {
  const agentConfig = JSON.parse(readFileSync(join(root, 'studio/once-opencode.json'), 'utf8'));
  agentConfig.permissions = [...agentConfig.permissions.filter(rule => rule.action !== 'edit'), ...editRules];
  const policy = join(logs, 'opencode.json');
  writeFileSync(policy, JSON.stringify(agentConfig), { flag: 'wx', mode: 0o600 });
  const agent = await run('agent.jsonl', 'flock', ['-n', '-F', home, 'timeout', ...sandbox('240s',
    '--share-net', '--ro-bind', '/etc/ssl', '/etc/ssl',
    '--ro-bind', '/etc/resolv.conf', '/etc/resolv.conf', '--ro-bind', '/etc/hosts', '/etc/hosts',
    '--bind', home, '/home/agent',
    '--ro-bind', policy, '/home/agent/.config/opencode/opencode.json',
    '--bind', join(work, 'game'), '/work/game',
    '/usr/bin/opencode', '--standalone', 'run', '--format', 'json',
    '--model', 'openai/gpt-6.2-sol', '--agent', 'build',
    'Implement this Godot game idea. Edit or add only game scripts, scenes, resources, shaders, ' +
    'images or fonts. Keep all existing smoke checks; add a behavioral check if behavior changes. ' +
    'Use simple filenames and no generated files. If requested you may add game/CASE_01_AURORA.md. ' +
    'Keep New Game, Continue/Back and pause/resume/return working. Do not run commands, ' +
    `ask questions, or commit. ${handoff}\n\n` + idea,
  )]);
  const events = agent.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
  if (events.some(event => event.type === 'error') ||
      !events.some(event => event.type === 'step_finish' && event.part?.reason === 'stop')) {
    throw new Error('OpenCode did not complete successfully; see agent.jsonl.');
  }
}

export function gameRunner(config) {
  const home = privateDir(resolve(root, config.opencodeHome ?? join(homedir(), '.local/share/game-studio/opencode')));
  if (home === realpathSync(userInfo().homedir) || home === realpathSync(homedir())) {
    throw new Error('OpenCode needs a dedicated sandbox home.');
  }
  const tools = validationTools(config);
  return {
    async edit(worktree, dir, idea, feedback) {
      [work, logs] = [worktree, dir];
      await editGame(home, idea, 'Continue from files already on disk. Work in small, coherent edits. ' +
        'The runner validates and publishes Draft PRs. ' + feedback);
    },
    async validate(worktree, dir, base) {
      [work, logs] = [worktree, dir];
      const index = (...args) => runGit(work, undefined, { ...process.env, GIT_INDEX_FILE: join(logs, 'index') }, args);
      index('read-tree', base);
      const { stagedTree } = stageEdits(base, index, (...args) => git(work, ...args));
      return { tree: stagedTree, ...await validateTree(stagedTree, tools, base) };
    },
  };
}

export function bootstrapRepairChoice(output, allowed) {
  const text = output.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line))
    .filter(event => event.type === 'text').map(event => event.part?.text ?? '').join('').trim();
  return allowed.includes(text) ? text : undefined;
}

export async function adviseBootstrap(config, dir, summary, allowed = []) {
  const home = privateDir(resolve(root, config.opencodeHome ?? join(homedir(), '.local/share/game-studio/opencode')));
  if (home === realpathSync(homedir())) throw new Error('Expected a dedicated model profile.');
  const policy = join(dir, 'advice-policy.json');
  writeFileSync(policy, JSON.stringify({ plugins: [], permissions: [
    { action: '*', resource: '*', effect: 'deny' },
  ] }), { flag: 'wx', mode: 0o600 });
  logs = dir;
  const output = await run('opencode-advice.jsonl', 'flock', ['-n', '-F', home, 'timeout', ...sandbox('120s',
    '--share-net', '--ro-bind', '/etc/ssl', '/etc/ssl',
    '--ro-bind', '/etc/resolv.conf', '/etc/resolv.conf', '--ro-bind', '/etc/hosts', '/etc/hosts',
    '--bind', home, '/home/agent',
    '--ro-bind', policy, '/home/agent/.config/opencode/opencode.json',
    '/usr/bin/opencode', '--standalone', 'run', '--format', 'json', '--model', 'openai/gpt-6.2-sol',
    (allowed.length ? `Select one permitted CI repair, replying only with its identifier or NONE: ${allowed.join(', ')}. `
      : 'Suggest a minimal Game Studio CI fix without disabling any tests or sandbox boundaries. Advice only. ') +
    'Trusted operator failure classification: ' + summary,
  )]);
  return bootstrapRepairChoice(output, allowed);
}

function stageEdits(base, indexGit, statusGit = indexGit) {
  const status = statusGit('status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored', '--no-renames', '--ignore-submodules=none')
    .split('\0').filter(Boolean);
  const edits = validatedPaths(work, status);
  indexGit('add', '--', ...edits);
  indexGit('diff', '--cached', '--check');
  const stagedTree = indexGit('write-tree').trim();
  const staged = indexGit('diff-tree', '-r', '--no-commit-id', '--no-renames', '--name-only', '-z', base, stagedTree)
    .split('\0').filter(Boolean);
  if (staged.length !== edits.length || !edits.every(path => staged.includes(path))) {
    throw new Error('Staged changes do not match the validated paths.');
  }
  return { edits, stagedTree };
}

async function validateTree(stagedTree, { godot, xvfb }, base) {
  const validation = join(logs, 'validation');
  const verifyImport = stageGame(work, stagedTree, validation, git(work, 'ls-tree', '-r', '-z', stagedTree, '--', 'game'));
  const godotMounts = [
    '--dir', '/home/agent',
    '--ro-bind-try', '/etc/fonts', '/etc/fonts',
    '--ro-bind', godot, '/opt/bin/godot',
  ];
  const gameDir = join(validation, 'game');
  const smokeDeadline = performance.now() + 90_000;
  const smoke = (label, mount, phase) => {
    const remaining = smokeDeadline - performance.now();
    if (remaining <= 0) throw new Error('Godot validation exceeded its 90-second limit.');
    return run(label, 'timeout', sandbox(`${(remaining / 1000).toFixed(3)}s`,
      ...godotMounts, mount, gameDir, '/work/game',
      '--ro-bind', join(root, 'studio/test-game.sh'), '/opt/test-game.sh',
      '/bin/sh', '/opt/test-game.sh', phase,
    ));
  };
  const imported = await smoke('import.log', '--bind', '--import-only');
  if (failedGodot(imported)) throw new Error('Godot reported import errors.');
  verifyImport();
  const tests = await smoke('godot.log', '--ro-bind', '--runtime-only');
  if (failedGodot(tests) || !/^PASS: /m.test(tests)) {
    throw new Error('Godot reported errors or did not reach the smoke-test pass marker.');
  }
  if (base) {
    const regression = join(logs, 'baseline-smoke.gd');
    writeFileSync(regression, git(work, 'show', `${base}:game/tests/smoke.gd`), { flag: 'wx', mode: 0o600 });
    const output = await run('regression.log', 'timeout', sandbox('45s',
      ...godotMounts, '--ro-bind', gameDir, '/work/game',
      '--ro-bind', regression, '/opt/baseline-smoke.gd',
      '/opt/bin/godot', '--headless', '--path', 'game', '--script', '/opt/baseline-smoke.gd',
    ));
    if (failedGodot(output) || !/^PASS: /m.test(output)) throw new Error('Baseline regression did not pass.');
  }
  const evidence = join(logs, 'screenshots');
  mkdirSync(evidence, { mode: 0o700 });
  const preview = await run('preview.log', 'timeout', [
    '--signal=TERM', '--kill-after=5s', '60s', 'sh', join(root, 'studio/xvfb-preview.sh'),
    xvfb, godot, gameDir, evidence,
  ]);
  if (failedGodot(preview) || !/^PASS: Continue\/Back,/m.test(preview)) {
    throw new Error('Godot preview did not pass UI navigation.');
  }
  const frames = screenshotPaths(evidence);
  const verification = await run('screenshots.log', 'timeout', sandbox('30s',
    ...godotMounts,
    ...frames.flatMap(name => ['--ro-bind', join(evidence, name), `/evidence/${name}`]),
    '--ro-bind', join(root, 'studio/preview.gd'), '/opt/preview.gd',
    '/opt/bin/godot', '--headless', '--script', '/opt/preview.gd', '--', '--verify',
    ...frames.map(name => `/evidence/${name}`),
  ));
  if (failedGodot(verification) || !/^PASS: decoded nonblank, distinct /m.test(verification)) {
    throw new Error('Screenshot verification did not pass.');
  }
  return { tests, frames };
}

export async function qaCommit(config, commit, evidence) {
  [work, logs] = [root, evidence];
  const tree = git(root, 'rev-parse', `${commit}^{tree}`).trim();
  return validateTree(tree, validationTools(config));
}

async function previewRecovery(config) {
  const runId = process.argv[3];
  if (process.argv.length !== 4 || !/^once-[A-Za-z0-9]{6}$/.test(runId)) {
    throw new Error('Usage: studio:once -- --recovery-preview once-XXXXXX');
  }
  const base = developTip();
  const logsDir = privateDir(resolve(root, config.logsDir ?? '.studio-state'));
  const workspaceDir = config.workspaceDir === undefined
    ? logsDir : privateDir(resolve(root, config.workspaceDir));
  const original = privateDir(join(logsDir, runId));
  const [, issueId] = /^Linear [A-Z0-9]+-\d+ \(([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\): requesting In Progress\nIn Progress confirmed\n$/i
    .exec(readFileSync(join(original, 'linear.log'), 'utf8')) ?? [];
  if (!issueId) throw new Error('Expected a confirmed Linear claim with no later writeback.');
  const receipt = `refs/studio/linear/${issueId.toLowerCase()}`;
  const branch = `refs/heads/studio/${runId}`;
  const candidate = join(workspaceDir, runId, 'work');
  const checkClaim = () => {
    const refs = new Map(git(root, 'for-each-ref', '--format=%(refname) %(objectname) %(symref)', active, receipt, branch)
      .trimEnd().split('\n').map(line => [line.split(' ')[0], line]));
    if (![active, receipt, branch].every(ref => refs.get(ref)?.trimEnd() === `${ref} ${base}`) ||
        !git(root, 'worktree', 'list', '--porcelain', '-z').split('\0\0')
          .some(entry => entry === `worktree ${candidate}\0HEAD ${base}\0branch ${branch}`)) {
      throw new Error('Recovery worktree, claim and active gate must match studio/develop.');
    }
  };
  checkClaim();
  work = candidate;
  logs = mkdtempSync(join(original, 'preview-'));
  const index = (...args) => runGit(work, undefined, { ...process.env, GIT_INDEX_FILE: join(logs, 'index') }, args);
  index('read-tree', base);
  const { stagedTree } = stageEdits(base, index, (...args) => git(work, ...args));
  const { tests, frames } = await validateTree(stagedTree, validationTools(config));
  shutdown.signal.throwIfAborted();
  checkClaim();
  if (developTip() !== base) throw new Error('studio/develop moved during recovery.');
  writeFileSync(join(logs, 'checkpoint.json'), JSON.stringify({
    base, receipt, branch, tree: stagedTree,
    screenshots: frames.map(name => `screenshots/${name}`),
  }, null, 2) + '\n', { flag: 'wx', mode: 0o600, flush: true });
  console.log(tests.trim());
  throw new VisualReview('Recovery preview passed. Checkpoint only: no commit, integration or Linear writeback.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
let lock;
for (const signal of signals) process.on(signal, cancel);
try {
  if (!recovery && (process.argv.length !== (watch ? 3 : 2))) {
    throw new Error('Expected --watch or --recovery-preview once-XXXXXX.');
  }
  lock = lockRepo();
  if (!recovery && git(root, 'for-each-ref', '--format=%(refname)', active).split('\n').includes(active)) {
    throw new Error(`A previous run needs review (${active}). No ideas will start.`);
  }
  const configPath = join(root, '.studio-state/once.json');
  const config = lstatSync(configPath, { throwIfNoEntry: false })
    ? JSON.parse(readFileSync(configPath, 'utf8')) : {};
  if (recovery) await previewRecovery(config);
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
  console.error(`${interrupted ? 'STOPPED' : error instanceof VisualReview ? 'REVIEW REQUIRED' : 'FAILURE'}: ${error.stderr?.trim() || error.message}`);
  console.error(sha ? `Feature commit created: ${sha}` : 'No feature commit created.');
  if (logs) console.error(`Logs: ${logs}`);
  if (work) console.error(`Worktree: ${work}`);
  process.exitCode = error instanceof VisualReview ? 2 : 1;
} finally {
  if (interrupted) {
    console.log(`Studio stopped (${interrupted}).`);
    process.exitCode = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 }[interrupted];
  }
  if (lock !== undefined) closeSync(lock);
  for (const signal of signals) process.off(signal, cancel);
}
} else {
  for (const signal of signals) process.on(signal, cancel);
}
