import { lstat, readFile, readlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const uuid = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

async function privateFile(path) {
  const info = await lstat(path);
  if (!info.isFile() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid()) throw new Error('untrusted fixture control file');
}

async function processInfo(pid) {
  const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
  const fields = stat.slice(stat.lastIndexOf(') ') + 2).split(' ');
  if (fields[0] === 'Z' || fields[0] === 'X') throw new Error('fixture process has exited');
  return { parent: Number(fields[1]), start: fields[19] };
}

export async function verifyExecBinding(contextFile, rootPid, pendingPids = []) {
  if (!Number.isSafeInteger(rootPid) || rootPid < 2) throw new Error('invalid fixture supervisor child');
  await privateFile(contextFile);
  const context = JSON.parse(await readFile(contextFile, 'utf8'));
  if (!uuid.test(context.automationId || '') || !context.bindingFile || !context.definitionFile) throw new Error('invalid fixture context');
  await privateFile(context.bindingFile);
  const db = new DatabaseSync(context.bindingFile, { readOnly: true });
  let rows;
  try { rows = db.prepare('SELECT run_id, pid, start_time, namespace FROM binding').all(); }
  finally { db.close(); }
  if (rows.length !== 1) throw new Error('missing or ambiguous fixture binding');
  const row = rows[0];
  if (!uuid.test(row.run_id || '') || !Number.isSafeInteger(row.pid) || row.pid < 2 || !/^pid:\[\d+\]$/.test(row.namespace || '')) throw new Error('invalid fixture binding');
  const definitions = JSON.parse(await readFile(context.definitionFile, 'utf8'));
  const matches = definitions.automations?.filter((item) => item.id === context.automationId) ?? [];
  if (matches.length !== 1 || matches[0].deferredStart?.status !== 'launching' || JSON.stringify(matches[0].deferredStart.runIds) !== JSON.stringify([row.run_id])) throw new Error('fixture deferred run does not match binding');
  const info = await processInfo(row.pid);
  if (info.start !== row.start_time || await readlink(`/proc/${row.pid}/ns/pid`) !== row.namespace) throw new Error('fixture sandbox identity changed');
  let pid = row.pid;
  for (let i = 0; i < 64 && pid !== rootPid; i++) {
    pid = (await processInfo(pid)).parent;
    if (pid < 2) throw new Error('fixture sandbox is not owned by supervisor');
  }
  if (pid !== rootPid) throw new Error('fixture sandbox ancestry is too deep');
  for (const pending of pendingPids) {
    if (!Number.isSafeInteger(pending) || pending < 2 || await readlink(`/proc/${pending}/ns/pid`) !== row.namespace) throw new Error('pending fixture exec is outside bound namespace');
    await processInfo(pending);
  }
  return row.namespace;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.stdout.write(await verifyExecBinding(process.argv[2], Number(process.argv[3]), process.argv.slice(4).map(Number))); }
  catch { process.exitCode = 1; }
}
