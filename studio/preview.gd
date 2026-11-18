extends SceneTree


func _initialize() -> void:
	call_deferred("validate")


func fail(reason: String) -> void:
	push_error("Visual QA: " + reason)
	quit(1)


func button(node: Node, text: String) -> Button:
	if node is Button and node.text == text and node.is_visible_in_tree():
		return node
	for child in node.get_children():
		var match_button := button(child, text)
		if match_button:
			return match_button
	return null


func drawn() -> void:
	await process_frame
	await RenderingServer.frame_post_draw
	await RenderingServer.frame_post_draw


func click(text: String) -> bool:
	var target := button(root, text)
	if not target or target.disabled:
		fail("Missing or disabled button: " + text)
		return false
	var bounds := target.get_global_rect()
	if not root.get_visible_rect().has_point(bounds.get_center()) or bounds.get_area() <= 0:
		fail("Button has no on-screen click target: " + text)
		return false
	var event := InputEventMouseButton.new()
	event.button_index = MOUSE_BUTTON_LEFT
	event.position = bounds.get_center()
	event.global_position = event.position
	event.pressed = true
	root.push_input(event, true)
	event = event.duplicate()
	event.pressed = false
	root.push_input(event, true)
	await drawn()
	return true


func nonblank(image: Image) -> bool:
	if not image or image.get_size() != Vector2i(960, 640):
		return false
	image.convert(Image.FORMAT_RGBA8)
	var pixels := image.get_data()
	# Ignore stray pixels and alpha-only differences without assuming a light or dark palette.
	# shortcut: contrast is not legibility; inspect both screens in visual review.
	var histogram := PackedInt32Array()
	histogram.resize(256 * 3)
	for i in range(0, pixels.size(), 4 * 13):
		if pixels[i + 3] < 250:
			continue
		for channel in range(3):
			histogram[channel * 256 + pixels[i + channel]] += 1
	for channel in range(3):
		var low := 0
		var high := 0
		var first := 255
		for value in range(256):
			low += histogram[channel * 256 + value]
			if low >= 150:
				first = value
				break
		for value in range(255, first + 11, -1):
			high += histogram[channel * 256 + value]
			if high >= 150:
				return true
	return false


func capture(path: String) -> bool:
	if "--display-capture" in OS.get_cmdline_user_args():
		print("DISPLAY FRAME ", path)
		if OS.read_string_from_stdin().strip_edges() != "captured":
			fail("No acknowledgment from the display capture process")
			return false
		return true
	var image := root.get_texture().get_image()
	if not nonblank(image) or FileAccess.file_exists(path) or image.save_png(path) != OK:
		fail("Could not save a new nonblank 960×640 screenshot: " + path)
		return false
	print("Captured rendered frame: ", path)
	return true


func validate() -> void:
	var args := OS.get_cmdline_user_args()
	if args.size() >= 2 and args[0] == "--verify":
		var frames: Array[PackedByteArray] = []
		for path in args.slice(1):
			var image := Image.new()
			if image.load(path) != OK or not nonblank(image) or image.get_data() in frames:
				fail("Missing, invalid, blank or duplicate screenshot: " + path)
				return
			frames.append(image.get_data())
		print("PASS: decoded nonblank, distinct 960×640 screenshots")
		quit()
		return
	if args.is_empty() or DisplayServer.get_name() != "X11" or RenderingServer.get_video_adapter_name().is_empty():
		fail("An X11 graphical renderer is required")
		return
	var scene := load(ProjectSettings.get_setting("application/run/main_scene")) as PackedScene
	if not scene:
		fail("Main scene did not load")
		return
	root.add_child(scene.instantiate())
	await drawn()
	var has_menu := button(root, "New Game") != null
	if args.has("--require-menu") and not has_menu:
		fail("Main menu did not show New Game")
		return
	if not args.has("--require-menu"):
		if not capture(args[0]):
			return
	else:
		var external := args.has("--display-capture")
		if not capture("main-menu" if external else args[0].get_base_dir().path_join("main-menu.png")):
			return
		if not await click("Continue"):
			return
		if button(root, "New Game"):
			fail("Continue did not leave the main menu")
			return
		if not await click("Back") or not await click("New Game"):
			return
		if not await click("Review Case File") or not await click("Close"):
			return
		if button(root, "New Game") or not await click("Pause"):
			fail("New Game did not reach gameplay")
			return
		if button(root, "Case File") or not await click("Resume"):
			fail("Pause did not block gameplay")
			return
		if not button(root, "Case File") or button(root, "Resume"):
			fail("Resume did not restore gameplay")
			return
		if not capture("gameplay" if external else args[0]):
			return
		if not await click("Pause") or not await click("Return to Main Menu"):
			return
		if not button(root, "New Game") or button(root, "Case File"):
			fail("Return to Main Menu did not restore the menu")
			return
		print("PASS: Continue/Back, New Game, pause/resume and return to main menu")
	quit()
