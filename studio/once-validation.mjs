import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const failedGodot = output => /^\s*(?:SCRIPT )?ERROR:/m.test(output);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export function stageGame(work, tree, validation, listing) {
  const files = new Map();
  for (const entry of listing.split('\0').filter(Boolean)) {
    const split = entry.indexOf('\t');
    const [mode, type, oid] = entry.slice(0, split).split(' ');
    const path = entry.slice(split + 1);
    if (mode !== '100644' || type !== 'blob' || /[^A-Za-z0-9_./-]/.test(path) ||
        !/^game\/(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(path)) {
      throw new Error(`Unsafe staged game entry: ${JSON.stringify(entry)}`);
    }
    const bytes = execFileSync('git', ['-C', work, 'cat-file', 'blob', oid], { maxBuffer: 32 * 1024 * 1024 });
    const dest = join(validation, path);
    mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
    writeFileSync(dest, bytes, { flag: 'wx', mode: 0o600 });
    files.set(path, hash(bytes));
  }
  // Editor import may create cache and sidecars, but must not replace staged sources.
  return () => {
    const seen = new Set();
    function check(path) {
      const full = join(validation, path);
      const stat = lstatSync(full);
      if (stat.isDirectory()) {
        if (path === 'game/.godot') return;
        for (const name of readdirSync(full)) check(`${path}/${name}`);
        return;
      }
      if (stat.isFile() && stat.nlink === 1 && !(stat.mode & 0o7111)) {
        const sidecar = /\.(?:import|uid)$/.test(path) && files.has(path.replace(/\.(?:import|uid)$/, ''));
        if (sidecar || (files.has(path) && stat.size <= 32 * 1024 * 1024 && hash(readFileSync(full)) === files.get(path))) {
          seen.add(path);
          return;
        }
      }
      throw new Error(`Godot import changed the staged game: ${JSON.stringify(path)} (${tree})`);
    }
    check('game');
    for (const path of files.keys()) {
      if (!seen.has(path)) throw new Error(`Godot import removed staged file: ${path}`);
    }
  };
}

export function screenshotPaths(evidence) {
  return ['main-menu.png', 'gameplay.png'].map(name => {
    const path = join(evidence, name);
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (!stat?.isFile() || stat.nlink !== 1 || stat.size < 1 || stat.size > 4 * 1024 * 1024) {
      throw new Error(`Missing or unsafe screenshot: ${name}`);
    }
    return name;
  });
}
