import { execFile } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { isFeature, retry, Transient } from './github.mjs';
import { git } from './once.mjs';
import { requiredGame, validatedPaths } from './once-paths.mjs';

const exec = promisify(execFile);
const zero = '0'.repeat(40);

export function draftGit(root, dir, repository, keyPath, signal, legacy) {
  const remote = `https://github.com/${repository}.git`;
  const local = (...args) => git(root, ...args).trim();
  function resolve(ref) {
    try { return local('rev-parse', '--verify', ref); }
    catch (error) { if (error.status === 128) return undefined; throw error; }
  }
  const refs = 'refs/studio/github';
  const remoteTip = branch => resolve(`${refs}/${branch}`);
  const contains = (ancestor, tip) => {
    try { local('merge-base', '--is-ancestor', ancestor, tip); return true; }
    catch (error) { if (error.status === 1) return false; throw error; }
  };
  async function network(...args) {
    try {
      const { stdout } = await exec('git', [
        '-c', 'credential.helper=', '-c', 'credential.interactive=false',
        '-c', 'credential.helper=!f() { [ "$1" = get ] || return 0; host= protocol=; while IFS="=" read -r k v && [ -n "$k" ]; do case "$k" in host) host=$v;; protocol) protocol=$v;; esac; done; [ "$host" = github.com ] && [ "$protocol" = https ] || return 0; printf "username=x-access-token\\npassword="; cat "$STUDIO_GITHUB_KEY"; printf "\\n"; }; f',
        '-c', 'core.hooksPath=/dev/null', '-c', 'http.followRedirects=false',
        '-C', root, ...args,
      ], { signal, timeout: 30_000, env: {
        PATH: '/usr/bin:/bin', HOME: '/nonexistent', GIT_CONFIG_NOSYSTEM: '1',
        GIT_TERMINAL_PROMPT: '0', STUDIO_GITHUB_KEY: keyPath, LANG: 'C',
      } });
      return stdout;
    } catch (error) {
      signal.throwIfAborted();
      if (error.killed || /timed out|Could not resolve|Failed to connect|HTTP (?:429|5\d\d)|unexpected disconnect|Connection reset|remote end hung up|TLS connection was non-properly terminated/i.test(error.stderr)) {
        throw new Transient(`Git ${args[0]} temporarily unavailable.`);
      }
      if (/stale info|already exists/.test(error.stderr)) throw new Transient('Branch appeared during push; will reconcile.');
      throw new Error(`Git ${args[0]} rejected; check remote access and branch ownership.`);
    }
  }
  return {
    repository, contains, remoteTip,
    claimed: id => Boolean(resolve(`refs/studio/linear/${id.toLowerCase()}`)),
    async refresh() {
      await retry(() => network('fetch', '--no-tags', '--prune', remote,
        `+refs/heads/main:${refs}/main`, `+refs/heads/feature/*:${refs}/feature/*`), signal);
      const main = remoteTip('main');
      if (!main || !requiredGame.every(path => resolve(`${main}:${path}`))) {
        throw new Error('GitHub main has no playable baseline. Land the migration PR first.');
      }
      return main;
    },
    workspace(job) {
      const work = join(dir, job.id, 'work');
      mkdirSync(dirname(work), { recursive: true, mode: 0o700 });
      if (!existsSync(work)) local('worktree', 'add', '--detach', work, job.base);
      if (!lstatSync(work).isDirectory() ||
          !local('worktree', 'list', '--porcelain', '-z').split('\0\0').some(
            entry => entry === `worktree ${work}\0HEAD ${job.base}\0detached`)) {
        throw new Error('Workspace does not match its recorded base.');
      }
      const recovery = legacy.get(job.id);
      const seed = join(dirname(work), 'seeded');
      if (recovery && !existsSync(seed)) {
        // The one-time bootstrap imports the exact game tree without grafting unrelated history.
        if (!contains(recovery.base, job.base)) {
          const game = resolve(`${recovery.base}:game`);
          const history = local('log', '--full-history', '--format=%H', job.base, '--', 'game').split('\n');
          if (!game || !history.some(commit => commit && resolve(`${commit}:game`) === game)) {
            throw new Error('Migration history does not contain the exact recovery game tree.');
          }
        }
        const status = (cwd) => git(cwd, 'status', '--porcelain=v1', '-z',
          '--untracked-files=all', '--ignored', '--no-renames').split('\0').filter(Boolean);
        const edits = validatedPaths(recovery.work, status(recovery.work));
        for (const path of edits) {
          const source = join(recovery.work, path);
          const dest = join(work, path);
          if (status(work).some(item => item.slice(3) === path) &&
              git(root, 'hash-object', '--no-filters', dest) !== git(root, 'hash-object', '--no-filters', source)) {
            throw new Error('Recovery target differs from existing work.');
          }
          if (local('ls-tree', '-r', recovery.base, '--', path) !== local('ls-tree', '-r', job.base, '--', path)) {
            throw new Error('Recovery edits overlap changes already in the new base.');
          }
          mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
          copyFileSync(source, dest);
        }
        writeFileSync(seed, '', { flag: 'wx', mode: 0o600, flush: true });
      }
      return work;
    },
    commit(job) {
      if (!isFeature(job.branch) || !/^[a-f0-9]{40}$/.test(job.tree)) throw new Error('Invalid validated commit inputs.');
      const ref = `refs/heads/${job.branch}`;
      let sha = resolve(ref);
      const marker = `Studio-Issue: ${job.id}`;
      if (!sha) {
        sha = local('-c', 'commit.gpgsign=false', 'commit-tree', job.tree, '-p', job.base,
          '-m', `Gameplay: Linear ${job.identifier}`, '-m', marker);
        local('update-ref', '--no-deref', ref, sha, zero);
      }
      if (local('show', '-s', '--format=%P %T%n%B', sha) !==
          `${job.base} ${job.tree}\nGameplay: Linear ${job.identifier}\n\n${marker}`) {
        throw new Error('Existing feature branch is not the tested commit.');
      }
      return sha;
    },
    async push(job) {
      if (!isFeature(job.branch) || !/^[a-f0-9]{40}$/.test(job.sha)) throw new Error('Refusing non-feature push.');
      const ref = `refs/heads/${job.branch}`;
      await retry(async () => {
        const tip = (await network('ls-remote', remote, ref)).split(/\s/)[0];
        if (tip === job.sha) return;
        if (tip) throw new Error('Remote feature branch exists with a different commit; refusing overwrite.');
        await network('push', `--force-with-lease=${ref}:`, remote, `${job.sha}:${ref}`);
      }, signal);
      local('update-ref', `${refs}/${job.branch}`, job.sha);
    },
  };
}
