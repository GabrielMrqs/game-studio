import { DatabaseSync } from 'node:sqlite';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { readFile, realpath } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { publish } from './publish.mjs';
import { checkReviewEvidence } from './review-evidence.mjs';

export async function publishRun({ id, url, state, repoRoot, repo, githubToken, linearKey, approvedSha, evidence, signature, publicKey, fetcher = fetch, publisher = publish }) {
  if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id || '')) throw new Error('invalid run ID');
  const target = new URL(url);
  if (target.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) || target.username || target.password || target.pathname !== '/' || target.search || target.hash) throw new Error('Cezar URL must be a loopback HTTP origin');
  const db = new DatabaseSync(join(state, 'inbox.sqlite'), { readOnly: true });
  let receipts;
  try { receipts = db.prepare("SELECT source_id, workflow FROM receipts WHERE run_id=? AND status='submitted'").all(id); }
  finally { db.close(); }
  if (receipts.length !== 1 || !receipts[0].source_id || receipts[0].workflow !== 'studio-feature') throw new Error('run has no unique Linear feature-workflow binding');
  const get = async (path) => {
    const response = await fetcher(new URL(path, target), { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`Cezar request failed: HTTP ${response.status}`);
    return response.json();
  };
  const health = await get('/api/v1/health');
  if (health.version !== '0.20.0' || health.repoRoot !== repoRoot) throw new Error('Cezar version or project root does not match');
  const run = await get(`/api/v1/runs/${id}`);
  const taken = run.graphState?.taken;
  if (run.id !== id || run.workflow !== 'studio-feature' || !['done', 'review'].includes(run.status) || !Array.isArray(taken) || !taken.includes('game.pass->qa') || !taken.includes('qa.pass->review') || !taken.includes('review.approve->commit') || !taken.includes('branch_check.pass->done')) throw new Error('feature workflow has not passed Godot checks, QA, review and branch check');
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(approvedSha || '')) throw new Error('full reviewed commit SHA is required');
  const worktree = await realpath(run.worktreePath);
  const root = await realpath(join(repoRoot, '.ai/cezar/worktrees'));
  const rel = relative(root, worktree);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('worktree is outside the studio worktree directory');
  if (execFileSync('git', ['branch', '--show-current'], { cwd: worktree, encoding: 'utf8' }).trim() !== run.branch) throw new Error('worktree branch no longer matches the workflow');
  if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktree, encoding: 'utf8' }).trim() !== approvedSha) throw new Error('worktree HEAD does not match the reviewed commit SHA');
  if (!checkReviewEvidence({ evidence, signature, publicKey, runId: id, commit: approvedSha })) throw new Error('trusted review evidence required');
  return publisher({ worktree, state, repo, base: run.baseBranch, issue: receipts[0].source_id, title: run.title, githubToken, linearKey, approvedSha });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 6 || process.argv[3] !== '--approve' || !process.env.STUDIO_REVIEW_PUBLIC_KEY_FILE) throw new Error('usage: STUDIO_REVIEW_PUBLIC_KEY_FILE=/trusted/public.pem node studio/publish-run.mjs RUN_ID --approve REVIEWED_COMMIT_SHA EVIDENCE.json');
    const { evidence, signature } = JSON.parse(await readFile(process.argv[5], 'utf8'));
    const publicKey = await readFile(process.env.STUDIO_REVIEW_PUBLIC_KEY_FILE, 'utf8');
    const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
    const url = await publishRun({ id: process.argv[2], url: process.env.CEZ_API_URL || 'http://127.0.0.1:4321', state: resolve(process.env.STUDIO_STATE || '.studio-state'), repoRoot, repo: process.env.GITHUB_REPO, githubToken: process.env.GITHUB_TOKEN, linearKey: process.env.LINEAR_API_KEY, approvedSha: process.argv[4], evidence, signature, publicKey });
    console.log(`Draft PR created and Linear notified: ${url}`);
  } catch (error) { console.error(`Publication stopped: ${error.message}`); process.exitCode = 1; }
}
