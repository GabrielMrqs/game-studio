import { execFileSync } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const uuid = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

// Fixture-only: reserve outside the container before asking Docker to create it.
export function reserveFixtureContainer({ reservationFile, token }) {
  if (!uuid.test(token || '')) throw new Error('invalid fixture token');
  closeSync(openSync(reservationFile, 'wx', 0o600));
  const db = new DatabaseSync(reservationFile);
  try {
    db.exec('CREATE TABLE reservation (token TEXT PRIMARY KEY)');
    db.prepare('INSERT INTO reservation VALUES (?)').run(token);
  } finally { db.close(); }
}

export function discoverUnboundFixture({ reservationFile, docker = execFileSync }) {
  const db = new DatabaseSync(reservationFile, { readOnly: true });
  let rows;
  try { rows = db.prepare('SELECT token FROM reservation').all(); }
  finally { db.close(); }
  if (rows.length !== 1 || !uuid.test(rows[0].token || '')) throw new Error('invalid fixture reservation');
  const token = rows[0].token;
  const output = docker('docker', ['ps', '-aq', '--no-trunc', '--filter', `label=studio.fixture.run-token=${token}`, '--filter', 'label=studio.fixture.kind=per-run-cancellation'], { encoding: 'utf8' }).trim();
  const ids = output ? output.split('\n') : [];
  if (ids.length !== 1 || !/^[a-f0-9]{64}$/.test(ids[0])) throw new Error('missing or ambiguous fixture container');
  const found = JSON.parse(docker('docker', ['inspect', ids[0]], { encoding: 'utf8' }));
  if (!Array.isArray(found) || found.length !== 1) throw new Error('ambiguous fixture container inspection');
  const container = found[0];
  if (container?.Id !== ids[0] || container.Config?.Labels?.['studio.fixture.run-token'] !== token || container.Config.Labels['studio.fixture.kind'] !== 'per-run-cancellation' || container.HostConfig?.RestartPolicy?.Name !== 'no' || !['created', 'running', 'exited'].includes(container.State?.Status)) throw new Error('fixture container identity or state mismatch');
  return { containerId: ids[0], status: container.State.Status, disposition: 'operator_review' };
}
