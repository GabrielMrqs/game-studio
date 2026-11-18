import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { closeSync, openSync } from 'node:fs';

const uuid = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

// Fixture-only: the caller must keep this database outside the agent's access.
export function registerFixtureBinding({ bindingFile, containerId, token, runId }) {
  if (!/^[a-f0-9]{64}$/.test(containerId || '') || !uuid.test(token || '') || !uuid.test(runId || '')) throw new Error('invalid fixture identity');
  closeSync(openSync(bindingFile, 'wx', 0o600));
  const db = new DatabaseSync(bindingFile);
  try {
    db.exec('CREATE TABLE binding (run_id TEXT PRIMARY KEY, container_id TEXT UNIQUE NOT NULL, token TEXT UNIQUE NOT NULL, phase TEXT NOT NULL)');
    db.prepare('INSERT INTO binding VALUES (?,?,?,?)').run(runId, containerId, token, 'bound');
  } finally { db.close(); }
}

export function terminateRunContainer({ bindingFile, runId, state, docker = execFileSync }) {
  if (!uuid.test(runId || '')) throw new Error('invalid fixture identity');
  closeSync(openSync(bindingFile, 'r+'));
  const binding = new DatabaseSync(bindingFile);
  try {
  const row = binding.prepare('SELECT container_id,token,phase FROM binding WHERE run_id=?').get(runId);
  if (!row || !/^[a-f0-9]{64}$/.test(row.container_id) || !uuid.test(row.token) || !['bound', 'terminating', 'terminated'].includes(row.phase)) throw new Error('missing or invalid fixture binding');
  const { container_id: containerId, token } = row;
  const inbox = new DatabaseSync(join(state, 'inbox.sqlite'), { readOnly: true });
  let receipts;
  try { receipts = inbox.prepare("SELECT run_id FROM receipts WHERE run_id=? AND status='submitted'").all(runId); }
  finally { inbox.close(); }
  const watchdog = new DatabaseSync(join(state, 'watchdog.sqlite'), { readOnly: true });
  let cancellation;
  try { cancellation = watchdog.prepare('SELECT result FROM cancellations WHERE run_id=?').get(runId); }
  finally { watchdog.close(); }
  if (receipts.length !== 1 || cancellation?.result !== 'accepted') throw new Error('no unique submitted run with accepted cancellation');
  const inspect = () => {
    const result = JSON.parse(docker('docker', ['inspect', containerId], { encoding: 'utf8' }));
    if (!Array.isArray(result) || result.length !== 1) throw new Error('ambiguous fixture container inspection');
    return result[0];
  };
  const container = inspect();
  if (container?.Id !== containerId || container.Config?.Labels?.['studio.fixture.run-token'] !== token || container.Config.Labels['studio.fixture.kind'] !== 'per-run-cancellation' || container.HostConfig?.RestartPolicy?.Name !== 'no') throw new Error('fixture container identity or state mismatch');
  if (container.State?.Status === 'running' && row.phase !== 'terminated') {
    binding.prepare("UPDATE binding SET phase='terminating' WHERE run_id=?").run(runId);
    docker('docker', ['kill', '--signal=KILL', containerId], { encoding: 'utf8' });
  } else if (row.phase === 'bound' || container.State?.Status !== 'exited' || container.State.ExitCode !== 137) {
    throw new Error('fixture container identity or state mismatch');
  }
  const stopped = inspect();
  if (stopped?.State?.Status !== 'exited' || stopped.State.ExitCode !== 137) throw new Error('fixture container termination unconfirmed');
  binding.prepare("UPDATE binding SET phase='terminated' WHERE run_id=?").run(runId);
  } finally { binding.close(); }
}
