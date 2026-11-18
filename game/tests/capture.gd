extends SceneTree
## Graphical screenshot helper. User arguments: office|aurora, then a new
## absolute PNG path outside the project. It never writes save data.


func _initialize() -> void:
	call_deferred("_capture")


func _press(parent: Node, caption: String) -> bool:
	for child in parent.get_children():
		if child is Button and child.text == caption:
			child.pressed.emit()
			return true
	push_error("Missing preview action: " + caption)
	return false


func _capture() -> void:
	var args := OS.get_cmdline_user_args()
	if args.size() != 2 or args[0] not in ["office", "aurora"] or not args[1].is_absolute_path() or not args[1].ends_with(".png") or FileAccess.file_exists(args[1]):
		push_error("Expected office or aurora, followed by a new absolute .png path.")
		quit(1)
		return
	if DisplayServer.get_name() == "headless":
		push_error("Room capture requires a graphical display.")
		quit(1)
		return
	root.size = Vector2i(960, 640)
	var game = load("res://main.tscn").instantiate()
	root.add_child(game)
	if not _press(game.menu, "New Game") or not _press(game.intake_panel.get_child(0), "Review Case File") or not _press(game.case_panel.get_child(0), "Close"):
		quit(1)
		return
	if args[0] == "aurora" and not _press(game.hotspots, "Teatro Aurora →"):
		quit(1)
		return
	if not game.gameplay_panel.visible or game.room != ("observatory" if args[0] == "office" else "aurora"):
		push_error("Capture did not reach the requested room in gameplay.")
		quit(1)
		return
	await process_frame
	var focused := root.gui_get_focus_owner()
	if focused:
		focused.release_focus()
	root.warp_mouse(Vector2(950, 630))
	await RenderingServer.frame_post_draw
	await RenderingServer.frame_post_draw
	var image := root.get_texture().get_image()
	if image == null or image.get_size() != Vector2i(960, 640) or image.save_png(args[1]) != OK:
		push_error("Could not save the 960×640 gameplay capture.")
		quit(1)
		return
	print("Captured ", args[0], " gameplay to ", args[1])
	quit()
