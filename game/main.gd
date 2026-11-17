extends Control

var room := "observatory"
var has_lens := false
var selected_lens := false
var lit := false
var save_path := "user://quiet_observatory_save.json"
var message: Label
var title: Label
var inventory: Button
var hotspots: HBoxContainer
var choices: HBoxContainer


func _ready() -> void:
	var background := TextureRect.new()
	background.texture = load("res://art/observatory.svg")
	background.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
	background.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_COVERED
	background.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	background.mouse_filter = Control.MOUSE_FILTER_IGNORE
	add_child(background)
	var panel := PanelContainer.new()
	panel.set_anchors_and_offsets_preset(Control.PRESET_BOTTOM_WIDE)
	panel.offset_top = -250
	add_child(panel)
	var layout := VBoxContainer.new()
	panel.add_child(layout)
	title = Label.new()
	layout.add_child(title)
	message = Label.new()
	message.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	message.custom_minimum_size.y = 52
	layout.add_child(message)
	hotspots = HBoxContainer.new()
	layout.add_child(hotspots)
	choices = HBoxContainer.new()
	layout.add_child(choices)
	var tools := HBoxContainer.new()
	layout.add_child(tools)
	inventory = _button(tools, "Inventory: empty", _select_lens)
	_button(tools, "Save", save_game)
	_button(tools, "Load", load_game)
	_show_room("The observatory is quiet. Explore the room.")


func _button(parent: Node, text: String, action: Callable) -> Button:
	var button := Button.new()
	button.text = text
	button.pressed.connect(action)
	parent.add_child(button)
	return button


func _clear(parent: Node) -> void:
	for child in parent.get_children():
		parent.remove_child(child)
		child.queue_free()


func _show_room(text: String) -> void:
	_clear(hotspots)
	_clear(choices)
	title.text = "The Quiet Observatory — " + ("Observatory" if room == "observatory" else "Lantern room")
	message.text = text
	inventory.text = "Inventory: lens" + (" (selected)" if selected_lens else "") if has_lens else "Inventory: empty"
	if room == "observatory":
		_button(hotspots, "Examine desk", _desk)
		_button(hotspots, "Talk to keeper", _keeper)
		_button(hotspots, "Lantern room →", func(): _transition("lantern"))
	else:
		_button(hotspots, "Examine lantern", _lantern)
		_button(hotspots, "← Observatory", func(): _transition("observatory"))


func _desk() -> void:
	if has_lens or lit:
		_show_room("The desk holds a notebook full of star charts.")
	else:
		has_lens = true
		_show_room("You found a glass lens. Select it in your inventory to use it.")


func _keeper() -> void:
	message.text = "Keeper: The lantern needs its missing lens. What would you like to ask?"
	_clear(choices)
	_button(choices, "Where is the lens?", func(): _answer("Keeper: I last saw it on the observatory desk."))
	_button(choices, "Why light it?", func(): _answer("Keeper: Its beam guides our friends safely home."))


func _answer(text: String) -> void:
	_clear(choices)
	message.text = text


func _select_lens() -> void:
	if has_lens:
		selected_lens = not selected_lens
		_show_room("Lens selected. Use it on a hotspot." if selected_lens else "Lens put away.")
	else:
		_clear(choices)
		message.text = "Your inventory is empty."


func _transition(destination: String) -> void:
	room = destination
	selected_lens = false
	_show_room("You enter the lantern room." if room == "lantern" else "You return to the observatory.")


func _lantern() -> void:
	if lit:
		_show_room("The lantern shines across the water. You did it!")
	elif has_lens and selected_lens:
		has_lens = false
		selected_lens = false
		lit = true
		_show_room("You fit the lens. The lantern shines across the water. You did it!")
	elif has_lens:
		_show_room("The lantern is dark. Select the lens in your inventory to use it.")
	else:
		_show_room("The lantern is dark. A round socket waits for a lens.")


func save_game() -> void:
	var temporary := save_path + ".tmp"
	var file := FileAccess.open(temporary, FileAccess.WRITE)
	if file == null:
		message.text = "Could not save the game."
		return
	file.store_string(JSON.stringify({"room": room, "has_lens": has_lens, "lit": lit}))
	if file.get_error() != OK:
		message.text = "Could not save the game."
		return
	file.close()
	if DirAccess.rename_absolute(ProjectSettings.globalize_path(temporary), ProjectSettings.globalize_path(save_path)) != OK:
		message.text = "Could not replace the saved game; previous save was kept."
		return
	message.text = "Game saved."


func load_game() -> void:
	if not FileAccess.file_exists(save_path):
		message.text = "No saved game found."
		return
	var file := FileAccess.open(save_path, FileAccess.READ)
	if file == null:
		message.text = "Could not read saved game."
		return
	var json := JSON.new()
	if json.parse(file.get_as_text()) != OK:
		message.text = "Save file is invalid; current progress was kept."
		return
	var data = json.data
	if not data is Dictionary or not data.has_all(["room", "has_lens", "lit"]) or data.room not in ["observatory", "lantern"] or not data.has_lens is bool or not data.lit is bool or (data.lit and data.has_lens):
		message.text = "Save file is invalid; current progress was kept."
		return
	room = data.room
	has_lens = data.has_lens
	lit = data.lit
	selected_lens = false
	_show_room("Game loaded.")
