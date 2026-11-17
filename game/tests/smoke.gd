extends SceneTree

var game
var failures := 0


func _initialize() -> void:
	call_deferred("run_test")


func check(condition: bool, description: String) -> void:
	if not condition:
		push_error("FAIL: " + description)
		failures += 1


func press(container: Node, text: String) -> void:
	for button in container.get_children():
		if button.text == text:
			button.pressed.emit()
			return
	check(false, "button exists: " + text)


func run_test() -> void:
	game = load("res://main.tscn").instantiate()
	root.add_child(game)
	game.save_path = "user://smoke_%d.json" % Time.get_ticks_usec()
	check(game.room == "observatory", "starting room")
	press(game.hotspots, "Talk to keeper")
	press(game.choices, "Why light it?")
	check("guides" in game.message.text, "first dialogue branch")
	press(game.hotspots, "Talk to keeper")
	press(game.choices, "Where is the lens?")
	check("desk" in game.message.text, "second dialogue branch")
	press(game.hotspots, "Lantern room →")
	press(game.hotspots, "Examine lantern")
	check(not game.lit and "socket" in game.message.text, "lantern needs lens")
	press(game.hotspots, "← Observatory")
	press(game.hotspots, "Examine desk")
	check(game.has_lens, "collect lens")
	game.save_game()
	press(game.hotspots, "Lantern room →")
	game.inventory.pressed.emit()
	press(game.hotspots, "Examine lantern")
	check(game.lit and not game.has_lens, "use lens to light lantern")
	game.load_game()
	check(game.room == "observatory" and game.has_lens and not game.lit, "load restores progress")
	var bad := FileAccess.open(game.save_path, FileAccess.WRITE)
	bad.store_string("not json")
	bad.close()
	game.load_game()
	check(game.has_lens and game.room == "observatory", "invalid save preserves progress")
	DirAccess.remove_absolute(ProjectSettings.globalize_path(game.save_path))
	game.queue_free()
	if failures == 0:
		print("PASS: dialogue, rooms, hotspots, inventory, puzzle and save/load")
	quit(1 if failures else 0)
