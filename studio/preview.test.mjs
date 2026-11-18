import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { screenshotPaths } from './once-validation.mjs';

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

test('required evidence must exist and cannot be empty or a symlink', async t => {
  const root = await mkdtemp(join(tmpdir(), 'studio-evidence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const menu = join(root, 'main-menu.png');
  const gameplay = join(root, 'gameplay.png');
  assert.throws(() => screenshotPaths(root), /Missing or unsafe screenshot: main-menu/);
  await writeFile(menu, 'menu');
  await writeFile(gameplay, '');
  assert.throws(() => screenshotPaths(root), /Missing or unsafe screenshot: gameplay/);
  await rm(gameplay);
  await symlink(menu, gameplay);
  assert.throws(() => screenshotPaths(root), /unsafe screenshot: gameplay/);
});

test('Xvfb captures real frames, blocks candidate PNG substitution, and detects broken UI', {
  skip: !process.env.STUDIO_TEST_GRAPHICS && 'Set STUDIO_TEST_GRAPHICS=1 with Godot 4, Xvfb, Bubblewrap and ImageMagick.',
  timeout: 90_000,
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'studio-graphics-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const game = join(root, 'game');
  const scripts = new URL('./', import.meta.url);
  await mkdir(game);
  for (const name of ['xvfb-preview.sh', 'preview.gd']) await copyFile(new URL(name, scripts), join(root, name));
  for (const name of ['project.godot', 'main.tscn']) await copyFile(new URL(`../game/${name}`, scripts), join(game, name));
  const fixture = `
extends Control

func _ready() -> void:
	substitute_png("startup")
	show_page(["New Game", "Continue"])

func substitute_png(phase: String) -> void:
	var fake := Image.create(960, 640, false, Image.FORMAT_RGBA8)
	fake.fill(Color.MAGENTA)
	fake.fill_rect(Rect2i(480, 0, 480, 640), Color.GREEN)
	# The fake is a valid, nonblank PNG. The same write must fail on both evidence paths.
	if fake.save_png("/tmp/substitute.png") != OK:
		push_error("Test could not generate its substitute")
	for path in ["/evidence/main-menu.png", "/evidence/gameplay.png"]:
		var output := FileAccess.open(path, FileAccess.WRITE)
		if output:
			output.store_buffer(fake.save_png_to_buffer())
			output.close()
			push_error("Candidate wrote evidence: " + path)
		else:
			print("Candidate evidence write blocked (", phase, "): ", path)
	if FileAccess.file_exists("/tmp/framebuffer/Xvfb_screen0"):
		push_error("Candidate can see the framebuffer file")

func show_page(labels: Array) -> void:
	for child in get_children():
		remove_child(child)
		child.queue_free()
	var background := ColorRect.new()
	background.size = Vector2(960, 640)
	background.color = Color("304758")
	add_child(background)
	var panel := VBoxContainer.new()
	panel.position = Vector2(120, 120)
	add_child(panel)
	for text in labels:
		var button := Button.new()
		button.text = text
		button.custom_minimum_size = Vector2(260, 50)
		button.pressed.connect(navigate.bind(text))
		panel.add_child(button)

func navigate(text: String) -> void:
	match text:
		"New Game": show_page(["Review Case File"])
		"Continue": show_page(["Back"])
		"Review Case File": show_page(["Close"])
		"Close", "Resume": show_page(["Case File", "Pause"])
		"Pause": show_page(["Resume", "Return to Main Menu"])
		"Back": show_page(["New Game", "Continue"])
		"Return to Main Menu":
			substitute_png("after capture")
			show_page(["New Game", "Continue"])
`;
  const main = join(game, 'main.gd');
  await writeFile(main, fixture);
  const run = (bin, args) => {
    const env = { ...process.env, HOME: root, XDG_DATA_HOME: root, LIBGL_ALWAYS_SOFTWARE: '1' };
    const result = spawnSync(bin, args, { cwd: root, env, timeout: 25_000, encoding: 'utf8' });
    assert.ifError(result.error);
    return { code: result.status, output: result.stdout + result.stderr };
  };
  const godot = process.env.GODOT_BIN ?? '/usr/bin/godot';
  const render = output => run('timeout', ['--kill-after=3s', '20s', 'sh', 'xvfb-preview.sh',
    process.env.XVFB_BIN ?? '/usr/bin/Xvfb', godot, game, output]);
  const verify = (...files) => run(godot, ['--headless', '--script', 'preview.gd', '--', '--verify', ...files]);
  const evidence = join(root, 'evidence');
  await mkdir(evidence);
  const gameplay = join(evidence, 'gameplay.png');
  const menu = join(evidence, 'main-menu.png');
  const rendered = render(evidence);
  assert.equal(rendered.code, 0, rendered.output);
  assert.match(rendered.output, /PASS: Continue\/Back,/);
  assert.doesNotMatch(rendered.output, /(?:SCRIPT )?ERROR:/);
  for (const file of ['main-menu', 'gameplay']) {
    for (const phase of ['startup', 'after capture']) {
      assert.ok(rendered.output.includes(`Candidate evidence write blocked (${phase}): /evidence/${file}.png`), rendered.output);
    }
    assert.ok(rendered.output.includes(`Captured Xvfb framebuffer: ${file}`), rendered.output);
    const probe = run('convert', [join(evidence, `${file}.png`), '-crop', '1x1+8+8', '+repage', '-depth', '8', 'txt:-']);
    assert.equal(probe.code, 0, probe.output);
    assert.match(probe.output, /#304758\b/i);
  }
  assert.deepEqual(screenshotPaths(evidence), ['main-menu.png', 'gameplay.png']);
  const verified = verify(menu, gameplay);
  assert.equal(verified.code, 0, verified.output);
  for (const invalid of [menu, join(root, 'missing.png'), join(root, 'corrupt.png')]) {
    await writeFile(join(root, 'corrupt.png'), 'not a png');
    const result = verify(menu, invalid);
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /Missing, invalid, blank or duplicate/);
  }
  await writeFile(join(root, 'blank.gd'), `extends SceneTree
func _initialize():
	var image := Image.create(960, 640, false, Image.FORMAT_RGBA8)
	image.fill(Color("#444444"))
	quit(image.save_png("blank.png"))
`);
  assert.equal(run(godot, ['--headless', '--script', 'blank.gd']).code, 0);
  assert.equal(verify(menu, join(root, 'blank.png')).code, 1);
  await rm(menu);
  await rm(gameplay);
  await writeFile(main, fixture.replace('"Continue": show_page(["Back"])', '"Continue": pass'));
  const broken = render(evidence);
  assert.equal(broken.code, 1, broken.output);
  assert.match(broken.output, /Continue did not leave the main menu/);
  assert.throws(() => screenshotPaths(evidence), /Missing or unsafe screenshot: gameplay/);
});
