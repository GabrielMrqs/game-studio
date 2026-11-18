extends SceneTree


func _initialize() -> void:
	call_deferred("capture")


func capture() -> void:
	var args := OS.get_cmdline_user_args()
	if args.size() != 1 or not args[0].is_absolute_path() or not args[0].ends_with(".png") or FileAccess.file_exists(args[0]):
		push_error("Provide one new absolute .png path; existing files are not overwritten.")
		quit(1)
		return
	var game = load("res://main.tscn").instantiate()
	root.add_child(game)
	await RenderingServer.frame_post_draw
	await RenderingServer.frame_post_draw
	var image := root.get_texture().get_image()
	if image == null or image.get_width() != 960 or image.get_height() != 640:
		push_error("Preview renderer did not produce a 960x640 image.")
		quit(1)
		return
	var varied := false
	for y in range(0, 640, 80):
		for x in range(0, 960, 80):
			if image.get_pixel(x, y) != image.get_pixel(0, 0):
				varied = true
	if not varied:
		push_error("Preview appears blank; use a graphical display, not headless mode.")
		quit(1)
		return
	if image.save_png(args[0]) != OK:
		push_error("Could not save preview PNG.")
		quit(1)
		return
	print("PASS: rendered 960x640 observatory preview to ", args[0])
	quit()
