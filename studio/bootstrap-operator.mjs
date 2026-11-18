import { execFile, execFileSync } from 'node:child_process';
import { closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync,
  readFileSync, realpathSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { adviseBootstrap, privateDir } from './once.mjs';
import { retry, Transient } from './github.mjs';

const repo = 'GabrielMrqs/game-studio';
const branch = 'migration/github-first-bootstrap';
const prNumber = 1;
const shaPattern = /^[0-9a-f]{40}$/;
const github = `https://github.com/${repo}`;
const headRef = `refs/heads/${branch}`;
const exec = promisify(execFile);
const workflow = '.github/workflows/ci.yml';
const download = 'curl -fsSL -o "$RUNNER_TEMP/godot.zip" https://github.com/godotengine/godot/releases/download/4.3-stable/Godot_v4.3-stable_linux.x86_64.zip';
const recipes = {
  'pin-nested-runner': {
    evidence: /bwrap: No permissions to create a new namespace/,
    from: '    runs-on: ubuntu-latest\n', to: '    runs-on: ubuntu-24.04\n',
  },
  'retry-godot-download': {
    evidence: /\tDownload Godot 4\.3\t[^\n]*curl: \((?:18|28|52|55|56)\)/,
    from: `          ${download}\n`,
    to: `          ${download.replace('curl -fsSL ', 'curl -fsSL --retry 3 --retry-all-errors --retry-max-time 45 --max-time 60 ')}\n`,
  },
};

export function repairedWorkflow(name, source, logs) {
  if (!Object.hasOwn(recipes, name)) return;
  const { evidence, from, to } = recipes[name];
  if (logs !== undefined && !evidence.test(logs)) return;
  if (source.split(from).length !== 2) return;
  return source.replace(from, to);
}

export async function bootstrap({ candidates, remote, local, deploy, diagnose, signal, wait,
  report = console.log }) {
  if (!candidates.length || candidates.length > 3 || !candidates.every(x => shaPattern.test(x)) ||
      new Set(candidates).size !== candidates.length) throw new Error('Authorize one to three exact commit SHAs.');
  const confirm = async expected => {
    const pr = await remote.pr();
    if (pr.number !== prNumber || pr.url !== `${github}/pull/${prNumber}` || pr.isCrossRepository ||
        pr.headRefName !== branch || pr.baseRefName !== 'main' || !shaPattern.test(pr.headRefOid) ||
        (expected && pr.headRefOid !== expected) || !['OPEN', 'MERGED'].includes(pr.state)) {
      throw new Error('Bootstrap PR identity or exact head changed.');
    }
    return pr;
  };
  const authorized = [...candidates];
  const last = candidates.at(-1);
  const existing = await confirm();
  if (!authorized.includes(existing.headRefOid) && await local.authorizedRepair?.(last, existing.headRefOid)) {
    authorized.push(existing.headRefOid);
  }
  async function finish(pr) {
    if (!authorized.includes(pr.headRefOid) || !shaPattern.test(pr.mergeCommit?.oid)) {
      throw new Error('Merged PR does not match an authorized commit.');
    }
    const main = await local.verifyMerge(pr.mergeCommit.oid, pr.headRefOid);
    report(`Merged ${pr.url}: ${pr.mergeCommit.oid}; main ${main}`);
    await deploy(main);
  }
  let pr = existing;
  if (pr.state === 'MERGED') return finish(pr);
  if (!shaPattern.test(pr.baseRefOid)) throw new Error('Invalid bootstrap base.');
  const base = pr.baseRefOid;
  const current = authorized.indexOf(pr.headRefOid);
  let previous = pr.headRefOid;
  for (let index = Math.max(0, current); index < authorized.length; index++) {
    const sha = authorized[index];
    signal.throwIfAborted();
    await remote.protect();
    await local.validate(previous, base, sha);
    const before = await confirm(previous);
    if (before.state === 'MERGED') return finish(before);
    if (before.baseRefOid !== base) throw new Error('Main moved; refusing to publish or merge a stale bootstrap.');
    if (sha !== previous) await remote.push(sha);
    previous = sha;
    report(`Waiting for exact PR head ${sha}`);
    let failed;
    for (let poll = 0, reruns = 0; poll < 90; poll++) {
      signal.throwIfAborted();
      pr = await confirm(sha);
      if (pr.state === 'MERGED') return finish(pr);
      if (pr.baseRefOid !== base) throw new Error('Main moved during CI.');
      const run = await remote.check(sha);
      if (!run || run.status !== 'completed') { await wait(); continue; }
      if (!Number.isSafeInteger(run.id) || run.id <= 0) throw new Error('Invalid workflow run.');
      if (run.conclusion === 'success' && await remote.passingTest(run, sha)) {
        await remote.protect();
        pr = await confirm(sha);
        if (pr.state === 'MERGED') return finish(pr);
        if (pr.baseRefOid !== base) throw new Error('Main moved before merge.');
        if (pr.isDraft) await remote.ready(sha);
        const latest = await remote.check(sha);
        if (latest?.id !== run.id || latest.run_attempt !== run.run_attempt ||
            !await remote.passingTest(latest, sha)) { await wait(); continue; }
        pr = await confirm(sha);
        if (pr.state === 'MERGED') return finish(pr);
        if (pr.isDraft || pr.baseRefOid !== base) throw new Error('PR changed after required checks.');
        await remote.merge(sha);
        for (let i = 0; i < 6; i++) {
          const merged = await confirm(sha);
          if (merged.state === 'MERGED') return finish(merged);
          await wait();
        }
        throw new Error('Merge not yet confirmed; rerun activation to reconcile.');
      }
      failed = run;
      if (['startup_failure', 'timed_out', 'stale'].includes(run.conclusion) && run.run_attempt < 3 && reruns++ < 2) {
        await remote.rerun(run);
        await wait();
        continue;
      }
      break;
    }
    if (!failed) throw new Error('Timed out waiting for the exact hosted check; no merge attempted.');
    const repair = await diagnose(failed, sha, sha === last && authorized.length === candidates.length);
    if (repair && sha === last && authorized.length === candidates.length) {
      if (!shaPattern.test(repair) || !await local.authorizedRepair?.(sha, repair)) {
        throw new Error('Rejected repair outside the authorized workflow recipes.');
      }
      authorized.push(repair);
    }
  }
  throw new Error('Authorized candidates exhausted; failing PR retained. Diagnosis saved locally.');
}

async function main(args) {
  if (args[0] !== '--activate' || !args[1] || args.slice(1).some(s => !shaPattern.test(s))) {
    throw new Error('Owner activation: node studio/bootstrap-operator.mjs --activate FULL_COMMIT_SHA [FALLBACK_SHA ...]');
  }
  const baseDir = realpathSync(resolve(homedir(), 'Projects/game-studio-reconciled'));
  const state = privateDir(join(baseDir, '.studio-state'));
  const signal = AbortSignal.timeout(60 * 60 * 1000);
  const output = await command('git', ['-C', baseDir, 'rev-parse', '--path-format=absolute', '--git-common-dir']);
  const lock = openSync(join(output.trim(), 'studio-bootstrap.lock'), 'a', 0o600);
  try {
    execFileSync('flock', ['-n', '3'], { stdio: ['ignore', 'pipe', 'pipe', lock] });
    await runOperator(baseDir, state, args.slice(1), signal);
  } finally { closeSync(lock); }
}

async function command(bin, args, options = {}) {
  try {
    return (await exec(bin, args, { timeout: 30_000, maxBuffer: 8 * 1024 * 1024, ...options })).stdout;
  } catch (error) {
    if (error.killed || /HTTP (429|5\d\d)|i\/o timeout|TLS handshake timeout|Could not resolve|connection reset/i.test(error.stderr)) {
      throw new Transient(`${bin} temporarily unavailable.`);
    }
    throw new Error(`${bin} ${args[0]} failed (${error.code ?? error.signal ?? 'unknown'}).`);
  }
}

async function runOperator(root, state, candidates, signal) {
  const read = (bin, args, opts) => retry(() => command(bin, args, opts), signal);
  const git = (...args) => command('git', ['-c', 'core.hooksPath=/dev/null', '-C', root, ...args], { signal });
  const gh = (...args) => read('gh', args, { signal });
  const api = async path => JSON.parse(await gh('api', `repos/${repo}${path}`));
  const pr = async () => JSON.parse(await gh('pr', 'view', String(prNumber), '--repo', repo, '--json',
    'number,url,state,isDraft,isCrossRepository,headRefName,headRefOid,baseRefName,baseRefOid,mergeCommit'));
  const service = 'game-studio.service';
  const system = (...args) => command('systemctl', ['--user', ...args], { signal });
  const status = () => system('show', service, '-p', 'MainPID', '-p', 'ControlGroup', '-p', 'ActiveState');
  const config = JSON.parse(readFileSync(join(state, 'once.json'), 'utf8'));
  if (config.github?.repository !== repo || !config.github.autoMerge || !config.linear?.doneId) {
    throw new Error('Expected repository-scoped auto-merge and Linear Done configuration.');
  }
  checkWatcherKey();
  const protect = async () => {
    const [settings, rules] = await Promise.all([api(''), api('/rules/branches/main')]);
    if (settings.default_branch !== 'main' || !settings.allow_merge_commit ||
        settings.allow_squash_merge || settings.allow_rebase_merge ||
        !['pull_request', 'deletion', 'non_fast_forward'].every(type => rules.some(rule => rule.type === type)) ||
        !rules.some(rule => rule.type === 'required_status_checks' && rule.parameters.strict_required_status_checks_policy &&
          rule.parameters.required_status_checks.some(check => check.context === 'test' && check.integration_id === 15368))) {
      throw new Error('Bootstrap requires protected main with strict GitHub Actions checks and merge commits only.');
    }
  };
  const fetchRef = () => read('git', ['-c', 'core.hooksPath=/dev/null', '-C', root, 'fetch',
    '--no-tags', `${github}.git`, 'refs/heads/main:refs/remotes/origin/main', `${headRef}:refs/remotes/origin/${branch}`], { signal });
  // Set by the owner, not inherited by OpenCode. GitHub CLI is only used host-side.
  await read('gh', ['auth', 'status', '--hostname', 'github.com'], { signal });
  // Make an already-published repair available for restart reconciliation.
  await fetchRef();
  const workflowAt = sha => git('show', `${sha}:${workflow}`);
  await bootstrap({
    candidates, signal, wait: () => setTimeout(15_000, undefined, { signal }),
    remote: {
      pr, protect,
      push: sha => retry(async () => {
        if ((await pr()).headRefOid === sha) return;
        await git('-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential',
          'push', `${github}.git`, `${sha}:${headRef}`);
      }, signal),
      async check(sha) {
      const data = await api(`/actions/workflows/ci.yml/runs?event=pull_request&head_sha=${sha}&per_page=10`);
        return data.workflow_runs.find(run => run.head_sha === sha && run.event === 'pull_request' &&
          run.head_branch === branch && run.head_repository?.full_name === repo &&
          run.path === '.github/workflows/ci.yml');
      },
      async passingTest(run, sha) {
        if (run.head_sha !== sha || run.status !== 'completed' || run.conclusion !== 'success' ||
            !Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1) return false;
        const { jobs, total_count } = await api(`/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`);
        return total_count === jobs.length && jobs.some(job => job.name === 'test') &&
          jobs.every(job => job.head_sha === sha && job.status === 'completed' && job.conclusion === 'success');
      },
      rerun: run => command('gh', ['run', 'rerun', String(run.id), '--repo', repo], { signal }),
      ready: async sha => {
        if ((await pr()).headRefOid !== sha) throw new Error('PR changed before ready.');
        await command('gh', ['pr', 'ready', String(prNumber), '--repo', repo], { signal });
      },
      merge: async sha => {
        try {
          await command('gh', ['pr', 'merge', String(prNumber), '--repo', repo, '--merge', '--match-head-commit', sha], { signal });
        } catch (error) {
          if ((await pr()).state !== 'MERGED') throw error;
        }
      },
    },
    local: {
      async authorizedRepair(parent, child) {
        const retained = (await git('for-each-ref', '--format=%(objectname)', `refs/studio/bootstrap-repairs/${child}`)).trim();
        if (retained !== child) return false;
        if ((await git('show', '-s', '--format=%P', child)).trim() !== parent ||
            (await git('diff-tree', '--no-commit-id', '-r', '--no-renames', '--name-status', parent, child)).trim() !== `M\t${workflow}` ||
            !/^100644 blob [a-f0-9]{40}\t/.test(await git('ls-tree', child, '--', workflow))) return false;
        const [before, after] = await Promise.all([workflowAt(parent), workflowAt(child)]);
        return Object.keys(recipes).some(name => repairedWorkflow(name, before) === after);
      },
      async validate(previous, base, sha) {
        await fetchRef();
        for (const parent of [previous, base]) await git('merge-base', '--is-ancestor', parent, sha);
        if ((await git('rev-parse', 'refs/remotes/origin/main')).trim() !== base) throw new Error('Main moved.');
        await git('diff', '--check', `${base}...${sha}`);
        const archive = mkdtempSync(join(state, 'bootstrap-local-'));
        const checkout = join(archive, 'work');
        await git('worktree', 'add', '--detach', checkout, sha);
        const log = join(archive, 'validation.log');
        const run = async (bin, args, timeout, env = process.env) => {
          try {
            const out = await command(bin, args, { cwd: checkout, timeout, signal, env });
            writeFileSync(log, out, { flag: 'a', mode: 0o600 });
          } catch (error) { throw new Error(`${error.message} Local validation checkout: ${checkout}`); }
        };
        const validationHome = join(archive, 'home');
        mkdirSync(validationHome, { mode: 0o700 });
        const env = { PATH: process.env.PATH, HOME: validationHome, GIT_TERMINAL_PROMPT: '0' };
        await run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], 120_000, env);
        await run('npm', ['test'], 180_000,
          { ...env, STUDIO_TEST_GRAPHICS: '1', GODOT_BIN: config.godot ?? '/usr/bin/godot' });
      },
      async verifyMerge(merge, head) {
        await fetchRef();
        const main = (await git('rev-parse', 'refs/remotes/origin/main')).trim();
        await git('merge-base', '--is-ancestor', merge, main);
        const parents = (await git('show', '-s', '--format=%P', merge)).trim().split(' ');
        if (main !== merge || parents.length !== 2 || parents[1] !== head ||
            (await git('rev-parse', `${merge}^{tree}`)).trim() !== (await git('rev-parse', `${head}^{tree}`)).trim()) {
          throw new Error('Expected main at the exact merge commit with the same tree as the checked head.');
        }
        return main;
      },
    },
    async diagnose(run, sha, canRepair) {
      const evidence = mkdtempSync(join(state, 'bootstrap-ci-'));
      const logs = await gh('run', 'view', String(run.id), '--repo', repo, '--log-failed');
      writeFileSync(join(evidence, 'failure.log'), logs, { mode: 0o600, flag: 'wx' });
      const categories = [
        [/No permissions to create a new namespace|Can't mount proc/i, 'Nested Bubblewrap namespace or mount setup failed.'],
        [/godot|xvfb/i, 'GitHub reported a Godot or graphical QA failure.'],
        [/timed out/i, 'The hosted check reported a timeout.'],
      ].filter(([pattern]) => pattern.test(logs)).map(([, text]) => text);
      const source = await workflowAt(sha);
      const allowed = canRepair ? Object.keys(recipes).filter(name => repairedWorkflow(name, source, logs)) : [];
      let choice;
      try {
        choice = await adviseBootstrap(config, evidence, `${sha}: ${categories.join(' ') || 'Unknown CI failure.'}`, allowed);
      } catch (error) { console.warn(`OpenCode diagnosis did not complete: ${error.message}`); }
      console.log(`Hosted failure evidence and model advice: ${evidence}`);
      if (!allowed.includes(choice)) return;
      const env = { ...process.env, GIT_INDEX_FILE: join(evidence, 'repair-index') };
      const gitIndex = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', root, ...args],
        { env, encoding: 'utf8', timeout: 10_000 }).trim();
      gitIndex('read-tree', sha);
      const data = repairedWorkflow(choice, source, logs);
      const blob = execFileSync('git', ['-C', root, 'hash-object', '-w', '--stdin'],
        { input: data, encoding: 'utf8', timeout: 10_000 }).trim();
      gitIndex('update-index', '--cacheinfo', `100644,${blob},${workflow}`);
      const commit = gitIndex('-c', 'commit.gpgsign=false', 'commit-tree', gitIndex('write-tree'),
        '-p', sha, '-m', `Apply bounded bootstrap repair: ${choice}`);
      // Retain the candidate, even if the independent local validation fails.
      gitIndex('update-ref', `refs/studio/bootstrap-repairs/${commit}`, commit, '0'.repeat(40));
      return commit;
    },
    deploy: main => deployWatcher({ state, main, git, system, status, signal }),
  });
}

function checkWatcherKey() {
  const key = join(homedir(), '.config/game-studio/github.key');
  const token = lstatSync(key, { throwIfNoEntry: false });
  if (!token?.isFile() || token.uid !== process.getuid() || token.mode & 0o077 ||
      !/^(github_pat_|ghs_)[A-Za-z0-9_]+$/.test(readFileSync(key, 'utf8').trim())) {
    throw new Error('Activation needs the repository-scoped watcher credential at ~/.config/game-studio/github.key (0600).');
  }
}

async function deployWatcher({ state, main, git, system, status, signal }) {
  const home = homedir();
  const checkout = join(home, 'Projects/game-studio-github-first');
  if (!existsSync(checkout)) await git('worktree', 'add', '--detach', checkout, main);
  const gitIn = (...args) => git('-C', checkout, ...args);
  if (realpathSync(checkout) !== checkout ||
      (await gitIn('rev-parse', '--show-toplevel')).trim() !== checkout ||
      (await gitIn('rev-parse', '--path-format=absolute', '--git-common-dir')).trim() !==
        (await git('rev-parse', '--path-format=absolute', '--git-common-dir')).trim()) {
    throw new Error('Deployment checkout is not the linked studio worktree.');
  }
  const runtimeState = join(checkout, '.studio-state');
  if (!lstatSync(runtimeState, { throwIfNoEntry: false })) symlinkSync(state, runtimeState);
  if (realpathSync(runtimeState) !== state) throw new Error('Deployment checkout points to unexpected studio state.');
  const unitDir = join(process.env.XDG_CONFIG_HOME ?? join(home, '.config'), 'systemd/user');
  const unitPath = join(unitDir, 'game-studio.service');
  const now = await status();
  if (!/^MainPID=0$/m.test(now) || !/^ControlGroup=$/m.test(now)) {
    if ((await gitIn('rev-parse', 'HEAD')).trim() === main && /^ActiveState=active$/m.test(now) &&
        (await system('show', 'game-studio.service', '-p', 'ExecStart', '-p', 'WorkingDirectory')).includes('studio/draft-watch.mjs --watch') &&
        (await system('show', 'game-studio.service', '-p', 'WorkingDirectory')).trim() === `WorkingDirectory=${checkout}`) {
      console.log(`Watcher already active at verified main ${main}`);
      return;
    }
    throw new Error('Existing watcher is not idle; its checkout and service were not changed.');
  }
  if ((await gitIn('status', '--porcelain', '--untracked-files=no')).trim()) throw new Error('Deployment checkout has tracked changes.');
  await gitIn('checkout', '--detach', main);
  const output = await command('/usr/bin/node', ['studio/draft-watch.mjs', '--check'], { cwd: checkout, signal, timeout: 180_000 });
  if (!output.includes(`protected main ${main}`)) throw new Error('Watcher did not confirm exact merged main.');
  console.log(output.trim());
  mkdirSync(unitDir, { recursive: true, mode: 0o700 });
  const backup = mkdtempSync(join(state, 'bootstrap-unit-'));
  if (existsSync(unitPath)) copyFileSync(unitPath, join(backup, 'game-studio.service'));
  const staging = mkdtempSync(join(unitDir, '.studio-unit-'));
  const file = join(staging, 'game-studio.service');
  writeFileSync(file, readFileSync(join(checkout, 'studio/game-studio.service'), 'utf8')
    .replaceAll('%h/Projects/game-studio-reconciled', '%h/Projects/game-studio-github-first'), { mode: 0o644 });
  await command('systemd-analyze', ['--user', 'verify', file], { signal });
  renameSync(file, unitPath);
  await system('daemon-reload');
  await system('enable', '--now', 'game-studio.service');
  for (let poll = 0; poll < 18; poll++) {
    const current = await status();
    const pid = /^MainPID=([1-9]\d*)$/m.exec(current)?.[1];
    if (/^ActiveState=active$/m.test(current) && pid) {
      const log = join(state, 'watch-service.log');
      if (existsSync(log) && (await command('tail', ['-n', '100', log], { signal }))
        .includes(`Watcher ready pid=${pid} main=${main}`)) {
        console.log(`Watcher active (PID ${pid}); completed its first poll.`);
        return;
      }
    }
    await setTimeout(5000, undefined, { signal });
  }
  throw new Error(`Watcher did not confirm a successful poll; inspect ${join(state, 'watch-service.log')}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2)).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
