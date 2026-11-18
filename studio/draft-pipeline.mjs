import { closeSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync,
  renameSync, rmdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { featureBranch, isFeature, Transient } from './github.mjs';
import { uuid } from './linear-review.mjs';

const oid = /^[a-f0-9]{40}$/;

export function journal(dir) {
  const load = id => JSON.parse(readFileSync(join(dir, `${id}.json`), 'utf8'));
  return {
    jobs: () => readdirSync(dir).filter(n => n.endsWith('.json') && uuid.test(n.slice(0, -5))).map(n => {
      const job = load(n.slice(0, -5));
      if (`${job.id}.json` !== n || job.branch !== featureBranch(job) || !oid.test(job.base) ||
          [job.sha, job.previous, job.tree].some(sha => sha !== undefined && !oid.test(sha))) {
        throw new Error(`Invalid studio journal: ${n}`);
      }
      return job;
    }),
    save(job) {
      if (!uuid.test(job.id)) throw new Error('Invalid Linear ID.');
      const scratch = mkdtempSync(join(dir, 'write-'));
      const tmp = join(scratch, 'job');
      writeFileSync(tmp, JSON.stringify(job) + '\n', { flag: 'wx', mode: 0o600, flush: true });
      renameSync(tmp, join(dir, `${job.id}.json`));
      rmdirSync(scratch);
      const fd = openSync(dir, 'r');
      try { fsyncSync(fd); } finally { closeSync(fd); }
    },
  };
}

export function pipeline({ storage, dir, git, github, linear, game, signal, legacy, report = console.log }) {
  const save = (job, changes) => storage.save(Object.assign(job, changes));
  async function advance(job, main) {
    if (job.integrated) return;
    if (!job.sha) {
      const recovered = legacy?.get(job.id);
      const workspace = git.workspace(job);
      if (!job.started) {
        if (!recovered) await linear.start(job.id);
        save(job, { started: true });
      }
      const jobDir = join(dir, job.id);
      mkdirSync(jobDir, { recursive: true, mode: 0o700 });
      // A crash after validation resumes from the tested tree without invoking the model again.
      if (!job.tree) {
        const attempt = mkdtempSync(join(jobDir, 'attempt-'));
        if ((job.attempts ?? 0) >= 4) throw new Error('Validation or model failed after four checkpoints.');
        const failure = job.feedback;
        if (!job.editComplete || failure) {
          try {
            await game.edit(workspace, attempt, job.idea, failure ||
              (recovered ? 'Finish the legacy checkpoint already copied into this worktree.' : ''));
            signal.throwIfAborted();
            save(job, { editComplete: true, feedback: null });
          }
          catch (error) {
            signal.throwIfAborted();
            save(job, { attempts: (job.attempts ?? 0) + 1,
              feedback: 'The last model checkpoint ended early. Continue from existing edits.' });
            report(`${job.identifier}: ${error.message}; checkpoint retained at ${attempt}`);
            return;
          }
        }
        signal.throwIfAborted();
        const evidence = mkdtempSync(join(jobDir, 'qa-'));
        try {
          const result = await game.validate(workspace, evidence, job.base);
          signal.throwIfAborted();
          save(job, { tree: result.tree, evidence, feedback: null });
        } catch (error) {
          signal.throwIfAborted();
          const lines = ['import.log', 'godot.log', 'regression.log', 'preview.log'].flatMap(name => {
            try { return readFileSync(join(evidence, name), 'utf8').split('\n').filter(line => /ERROR|FAIL/.test(line)).slice(-8); }
            catch (e) { if (e.code !== 'ENOENT') throw e; return []; }
          });
          save(job, { attempts: (job.attempts ?? 0) + 1,
            feedback: `Repair the failed checks: ${error.message}\n${lines.join('\n').slice(-2400)}` });
          report(`${job.identifier}: validation failed; evidence at ${evidence}`);
          return;
        }
      }
      const sha = git.commit(job);
      save(job, { sha });
    }
    signal.throwIfAborted();
    if (!job.pr || job.previous) {
      if (!git.contains(job.base, main)) throw new Error('Validated base is not in main.');
      await git.push(job);
      const pr = await github.open(job, [
        `Linear: ${job.linearUrl}`,
        '**Local checks passed:** Godot import, startup, gameplay/regression smoke, UI navigation, and screenshot integrity.',
        'See the menu and gameplay screenshots in the GitHub Actions Godot QA artifact.',
      ].join('\n\n'));
      save(job, { ...pr, previous: undefined });
      report(`${job.identifier}: ${job.url} → ${job.sha}`);
    }
    const result = await github.advance(job, main);
    if (result?.failure) {
      save(job, { previous: job.sha, sha: undefined, tree: undefined, editComplete: false,
        attempts: (job.attempts ?? 0) + 1, feedback: result.failure });
      report(`${job.identifier}: hosted test failed; retrying on the same branch.`);
      return;
    }
    const merge = result?.merge;
    if (!merge || !git.contains(job.sha, main)) return;
    git.verifyMerge(job, merge, main);
    await linear.integrated(job.id, job.url, merge);
    save(job, { integrated: true });
    report(`${job.identifier}: Done — ${job.url} merged as ${merge}`);
  }

  async function safely(job, main) {
    if (job.next && job.next > Date.now()) return;
    try {
      if (!job.blocked) await advance(job, main);
      if (job.blocked && !job.reported) {
        await linear.blocker(job.id, job.blocked);
        save(job, { reported: true });
      }
    } catch (error) {
      signal.throwIfAborted();
      const reason = error.message.split('\n')[0].slice(0, 180);
      report(`${job.identifier}: ${reason}`);
      if (error instanceof Transient || job.blocked) {
        save(job, { next: Date.now() + Math.max(60_000, error.wait || 0) });
      } else save(job, { blocked: reason });
    }
  }

  return async function tick(main) {
    const jobs = storage.jobs();
    for (const job of jobs) {
      signal.throwIfAborted();
      await safely(job, main);
    }
    // Strict protection requires each feature to include the latest main. Keep one
    // PR in flight in automatic mode; an isolated failed job does not hold the queue.
    if (jobs.some(job => !job.blocked && !job.integrated)) return;
    async function* candidates() {
      for (const recovery of legacy?.values() ?? []) yield recovery.issue;
      yield* linear.ready();
    }
    for await (const issue of candidates()) {
      signal.throwIfAborted();
      const { id, identifier, title, url, description } = issue;
      if (!uuid.test(id) || typeof title !== 'string' || !/^[A-Z0-9]+-\d+$/.test(identifier) ||
          typeof url !== 'string' || !/^https:\/\/linear\.app\/[a-z0-9_-]+\/issue\/[A-Z0-9]+-\d+(?:\/[a-z0-9_%.-]+)?$/i.test(url)) {
        report('Skipping invalid issue data from Linear.');
        continue;
      }
      if (jobs.some(job => job.id === id) || (git.claimed(id) && !legacy?.has(id))) continue;
      const branch = featureBranch(issue);
      if (!isFeature(branch)) throw new Error('Invalid generated feature branch.');
      try {
        if ((await linear.dependencies(id)).some(dep => dep.state?.type !== 'completed')) continue;
      }
      catch (error) {
        signal.throwIfAborted();
        report(`${identifier}: dependency lookup failed: ${error.message}`);
        continue;
      }
      const idea = `${title}\n\n${description ?? ''}`.trim();
      const job = { id, identifier, title, linearUrl: url, idea, branch, base: main };
      if (!idea || Buffer.byteLength(idea) > 16_384) job.blocked = 'Issue must contain 1–16384 bytes.';
      save(job, {});
      jobs.push(job);
      await safely(job, main);
      if (!job.blocked) return;
    }
  };
}
