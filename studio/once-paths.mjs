import { lstatSync } from 'node:fs';
import { join } from 'node:path';

export const requiredGame = ['game/project.godot', 'game/main.tscn', 'game/tests/smoke.gd'];
const story = 'game/CASE_01_AURORA.md';
const extensions = ['gd', 'tscn', 'tres', 'gdshader', 'gdshaderinc', 'svg', 'png', 'jpg', 'jpeg', 'webp', 'ttf', 'otf'];
const source = new RegExp(`^game/(?:[A-Za-z0-9_][A-Za-z0-9_-]*/)*[A-Za-z0-9_][A-Za-z0-9_.-]*\\.(?:${extensions.join('|')})$`);
const generated = ['godot', 'cache', 'build', 'dist', 'export', 'generated', 'node_modules'];
const reserved = 'game/tests/preview.gd';

export const editRules = ['', '/work/'].flatMap(prefix => [
  ...[...extensions.map(ext => `game/*.${ext}`), story].map(resource =>
    ({ action: 'edit', resource: prefix + resource, effect: 'allow' })),
  ...['game/.*', 'game/*/.*', reserved, ...generated.flatMap(dir => [`game/${dir}/*`, `game/*/${dir}/*`])].map(resource =>
    ({ action: 'edit', resource: prefix + resource, effect: 'deny' })),
]);

// Scripts and resources can change presentation without touching a scene.
export const needsVisualReview = paths => paths.some(path => path !== story);

export function validatedPaths(work, status) {
  if (!status.length) throw new Error('No game edits to validate.');
  return status.map(entry => {
    const code = entry.slice(0, 3);
    const path = entry.slice(3);
    const components = path.split('/');
    if (!(code === '?? ' || code === ' M ') ||
        !(path === story ? code === '?? ' :
          !/[^A-Za-z0-9_./-]/.test(path) && source.test(path) && path !== reserved &&
          !components.slice(1, -1).some(part => generated.includes(part.toLowerCase())))) {
      throw new Error(`Disallowed studio edit: ${JSON.stringify(entry)}`);
    }
    let current = work;
    for (const part of components.slice(0, -1)) {
      current = join(current, part);
      if (!lstatSync(current).isDirectory()) throw new Error(`Expected a real directory: ${current}`);
    }
    const stat = lstatSync(join(current, components.at(-1)));
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o7111)) {
      throw new Error(`Expected a regular, non-executable file without hard links: ${path}`);
    }
    return path;
  });
}
