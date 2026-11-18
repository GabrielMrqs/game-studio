import { sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import assert from 'node:assert/strict';

// Scripted fixture reviewer; it is not an AI review or a production signer.
const [worktree, runId, commit] = process.argv.slice(2);
if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(runId || '') || !/^[a-f0-9]{40}$/.test(commit || '')) throw new Error('invalid fixture review identity');
const git = (...args) => execFileSync('git', ['-C', worktree, ...args], { encoding: 'utf8' }).trim();
if (git('rev-parse', `${commit}^{commit}`) !== commit || git('show', `${commit}:feature.txt`) !== 'fixture reviewed content') throw new Error('fixture review rejected');
assert.throws(() => writeFileSync(`${worktree}/feature.txt`, 'tamper'), (error) => ['EROFS', 'EACCES'].includes(error.code));
await new Promise((resolve, reject) => {
  const socket = connect({ host: '1.1.1.1', port: 443, timeout: 2000 });
  socket.on('connect', () => { socket.destroy(); reject(new Error('unexpected network access')); });
  socket.on('timeout', () => { socket.destroy(); reject(new Error('network check timed out')); });
  socket.on('error', (error) => error.code === 'ENETUNREACH' ? resolve() : reject(error));
});
const evidence = { runId, commit, verdict: 'approve' };
const signature = sign(null, Buffer.from(JSON.stringify(evidence)), readFileSync('/reviewer-key')).toString('hex');
console.log(JSON.stringify({ evidence, signature }));
