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
          (job.sha !== undefined && !oid.test(job.sha))) throw new Error(`Invalid studio journal: ${n}`);
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

export async function chooseBase(dependencies, jobs, main, git, github) {
  const parents = [];
  for (const dep of dependencies) {
    const parent = jobs.find(job => job.id === dep.id);
    if (!parent?.pr) {
      if (dep.state?.type !== 'completed') return;
      continue;
    }
    if (git.contains(parent.sha, main)) continue;
    const pr = await github.status(parent);
    if (pr.state !== 'open' || git.remoteTip(parent.branch) !== parent.sha) return;
    parents.push(parent);
  }
  if (!parents.length) return { base: main, target: 'main' };
  const tip = parents.find(parent => parents.every(other => git.contains(other.sha, parent.sha)));
  // shortcut: one ancestry chain per PR, wait for divergent prerequisites to integrate.
  if (tip) return { base: tip.sha, target: tip.branch };
}

export function pipeline({ storage, dir, git, github, linear, game, signal, legacy, report = console.log }) {
  const save = (job, changes) => storage.save(Object.assign(job, changes));
  async function advance(job, main) {
    if (!job.sha) {
      const recovered = legacy?.get(job.id);
      const workspace = git.workspace(job);
      if (!job.started) {
        if (!recovered) await linear.state(job.id, 'progress');
        save(job, { started: true });
      }
      const jobDir = join(dir, job.id);
      mkdirSync(jobDir, { recursive: true, mode: 0o700 });
      // A crash after validation resumes from the tested tree without invoking the model again.
      if (!job.tree) {
        const attempt = mkdtempSync(join(jobDir, 'attempt-'));
        if ((job.attempts ?? 0) >= 4) throw new Error('Validation or model failed after four checkpoints.');
        save(job, { attempts: (job.attempts ?? 0) + 1 });
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
            save(job, { feedback: 'The last model checkpoint ended early. Continue from existing edits.' });
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
          save(job, { feedback: `Repair the failed checks: ${error.message}\n${lines.join('\n').slice(-2400)}` });
          report(`${job.identifier}: validation failed; evidence at ${evidence}`);
          return;
        }
      }
      const sha = git.commit(job);
      save(job, { sha });
    }
    signal.throwIfAborted();
    if (!job.pr) {
      const target = git.contains(job.base, main) ? 'main' : job.target;
      if (target === 'main' && !git.contains(job.base, main)) throw new Error('Validated base is not in main.');
      if (target !== 'main' && git.remoteTip(target) !== job.base) {
        throw new Transient('Stack base moved or disappeared; waiting for its commit on main.', 300_000);
      }
      await git.push(job);
      const checks = `https://github.com/${git.repository}/actions?query=branch%3A${encodeURIComponent(job.branch)}`;
      const pr = await github.draft(job, target, [
        `Linear: ${job.linearUrl}`, `Validated commit: \`${job.sha}\``,
        '**Local checks passed:** Godot import, startup, gameplay/regression smoke, UI navigation, and screenshot integrity.',
        '**Visual quality is unverified.** See the main-menu and gameplay PNGs in the Godot QA artifact.',
        `[Commit checks](https://github.com/${git.repository}/commit/${job.sha}/checks) · [QA artifacts](${checks}) — CI results are separate from local checks.`,
      ].join('\n\n'));
      save(job, pr);
      report(`${job.identifier}: ${job.url} → ${job.sha}`);
    }
    if (!job.review) {
      await linear.attach(job.id, job.url);
      await linear.state(job.id, 'review');
      save(job, { review: true });
    }
    if (job.target !== 'main' && !job.retargeted && git.contains(job.base, main)) {
      const pr = await github.status(job);
      if (pr.state === 'open') await github.draft(job, 'main', '');
      save(job, { retargeted: true });
    }
    if (!job.integrated && git.contains(job.sha, main)) {
      const pr = await github.status(job);
      if (pr.merged && pr.base.ref === 'main') {
        await linear.integrated?.(job.id);
        save(job, { integrated: true });
      }
    } else if (!job.integrated && github.merge) {
      const merged = await github.merge(job, main);
      if (merged) report(`${job.identifier}: GitHub merged ${job.url} as ${merged}; waiting for fetched main.`);
    }
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
    if (github.merge && jobs.some(job => !job.blocked && !job.integrated)) return;
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
      let target;
      try { target = await chooseBase(await linear.dependencies(id), jobs, main, git, github); }
      catch (error) {
        signal.throwIfAborted();
        report(`${identifier}: dependency lookup failed: ${error.message}`);
        continue;
      }
      if (!target) continue;
      const idea = `${title}\n\n${description ?? ''}`.trim();
      const job = { id, identifier, title, linearUrl: url, idea, branch, ...target };
      if (!idea || Buffer.byteLength(idea) > 16_384) job.blocked = 'Issue must contain 1–16384 bytes.';
      save(job, {});
      jobs.push(job);
      await safely(job, main);
      if (github.merge && !job.blocked) return;
    }
  };
}
