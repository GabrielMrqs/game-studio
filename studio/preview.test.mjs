import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('preview refuses relative and existing paths before launching Godot', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'studio-preview-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'existing.png');
  await writeFile(path, 'preserve this file');
  const run = (output) => spawnSync('sh', ['studio/preview-game.sh', output], { env: { ...process.env, GODOT_BIN: '/nonexistent-godot' }, encoding: 'utf8' });
  assert.notEqual(run('relative.png').status, 0);
  const result = run(path);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /refusing to overwrite/);
  assert.equal(await readFile(path, 'utf8'), 'preserve this file');
});
