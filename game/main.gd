extends Control

class SceneTarget extends Button:
	var silhouettes: Array[PackedVector2Array] = []
	var anchors := PackedVector2Array()
	var art_bounds := Rect2()
	var art_scale := 0.0

	func set_silhouette(points: Array, anchor: Vector2) -> void:
		art_bounds = Rect2(Vector2(points[0], points[1]), Vector2.ZERO)
		add_silhouette(points, anchor)

	func add_silhouette(points: Array, anchor: Vector2) -> void:
		var shape := PackedVector2Array()
		for i in range(0, points.size(), 2):
			var point := Vector2(points[i], points[i + 1])
			shape.append(point)
			art_bounds = art_bounds.expand(point)
		silhouettes.append(shape)
		anchors.append(anchor)

	func fit(origin: Vector2, scale_factor: float) -> void:
		art_scale = scale_factor
		position = origin + art_bounds.position * art_scale
		size = art_bounds.size * art_scale

	func _has_point(point: Vector2) -> bool:
		return silhouette_at(point) != -1

	func silhouette_at(point: Vector2) -> int:
		if art_scale <= 0.0:
			return -1
		var art_point := point / art_scale + art_bounds.position
		for i in range(silhouettes.size()):
			if Geometry2D.is_point_in_polygon(art_point, silhouettes[i]):
				return i
		return -1


class RoomCanvas extends Control:
	const ART := {
		"observatory": preload("res://art/office.svg"),
		"aurora": preload("res://art/aurora.svg"),
		"lantern": preload("res://art/lantern.svg")
	}
	const RECTIFICATION_FORM := preload("res://art/form.svg")
	# Curated silhouettes and reticles share the uncropped illustration coordinates.
	const ART_SIZE := Vector2(960, 500)
	var picture: TextureRect
	var frame: Panel
	var art_rect := Rect2()
	var art_scale := 1.0
	var cue: SceneTarget
	var cue_anchor := Vector2.ZERO

	func present(room_id: String, lit: bool, show_form := false) -> void:
		picture.texture = ART[room_id]
		var surface := picture.material as ShaderMaterial
		surface.set_shader_parameter("lit", room_id == "lantern" and lit)
		surface.set_shader_parameter("show_form", room_id == "aurora" and show_form)
		layout_art()

	func layout_art() -> void:
		var available := (size - Vector2(28, 24)).max(Vector2.ZERO)
		art_scale = minf(available.x / ART_SIZE.x, available.y / ART_SIZE.y)
		var fitted := ART_SIZE * art_scale
		art_rect = Rect2((size - fitted) * .5, fitted)
		picture.position = position + art_rect.position
		picture.size = art_rect.size
		frame.position = picture.position - Vector2(2, 2)
		frame.size = picture.size + Vector2(4, 4)
		for target in get_children():
			var button := target as SceneTarget
			button.fit(art_rect.position, art_scale)
		queue_redraw()

	func _draw() -> void:
		if not is_instance_valid(cue) or art_scale <= 0.0:
			return
		var center := art_rect.position + cue_anchor * art_scale
		var radius := clampf(12.0 * art_scale, 5.0, 14.0)
		var edge := Color("ffe0a3")
		var shade := Color("171e28")
		draw_circle(center, radius + 5.0, Color(edge, .10), true, -1.0, true)
		draw_circle(center, radius + 1.0, Color(shade, .55), true, -1.0, true)
		for quadrant in range(4):
			var angle: float = quadrant * TAU / 4.0
			draw_arc(center, radius, angle + .16, angle + TAU / 4.0 - .16, 8, edge, 1.4, true)
		draw_circle(center, 1.6, edge, true, -1.0, true)
		# Draw the caption on the canvas, not the button: it can float beyond small
		# props without becoming another mouse target or spilling outside the art.
		var font := get_theme_default_font()
		const FONT_SIZE := 13
		var width := ceilf(font.get_string_size(cue.text, HORIZONTAL_ALIGNMENT_LEFT, -1, FONT_SIZE).x) + 16.0
		if width + 8.0 > art_rect.size.x or art_rect.size.y < 68.0:
			return
		var inner := art_rect.grow(-4.0)
		var x := clampf(center.x - width * .5, inner.position.x, inner.end.x - width)
		var y := center.y - radius - 30.0
		if y < inner.position.y:
			y = center.y + radius + 8.0
		var tag := Rect2(x, clampf(y, inner.position.y, inner.end.y - 22.0), width, 22.0)
		draw_rect(tag, Color(shade, .94))
		draw_line(tag.position + Vector2(0, 22), tag.end, edge, 1.0)
		draw_string(font, tag.position + Vector2(8, 15), cue.text, HORIZONTAL_ALIGNMENT_LEFT, -1.0, FONT_SIZE, edge)

const HUD_HEIGHT := 178.0
const INK := Color("161e26")
const BRASS := Color("b08d63")
const Sound := preload("res://sfx.gd")

var sfx := Sound.new()
var room := "observatory"
var has_lens := false
var selected_lens := false
var lit := false
var aurora_clues := [false, false, false]
var interview_flags := [false, false, false, false, false, false, false, false]
var evidence_flags := [false, false, false, false]
var reconstruction_solved := [false, false]
var rectification := ""
var board_panel: PanelContainer
var board_feedback: Label
var board_cards: Array = []
const RECONSTRUCTION = [
	[
		["Eva absent; wall has no exit", "Eva exists; photos show exit"],
		["Jonas saves Paula: main entrance", "Eva opens exit; saves Paula"],
		["Jonas and Paula become partners", "Jonas continues bus journey"]
	],
	[
		["Eva absent; wall has no exit", "Eva exists; photos show exit"],
		["Jonas saves Paula: main entrance", "Eva opens exit; saves Paula"],
		["Jonas and Paula become partners", "Jonas continues bus journey"]
	]
]
const EVIDENCE = [
	["19:42 call", "19:42 CALL — RECORDING TRANSCRIPT\n\n[Telephone / recorded audio]\nTheatre to Jonas, 19:42. A woman's voice, identified as Eva's: “A Paula tá lá dentro”.", "19:42 call, theatre to Jonas: Eva's recorded voice says “A Paula tá lá dentro”."],
	["Eva's traces", "EVA'S TRACES\n\n[Blurred photograph]  [Cup]  [Musical instrument]  [Letter]\nA blurred photo, a cup, a musical instrument and a letter from Marina are traces of Eva. Together with the old door photos, they conflict with accounts and records in which Eva is absent or unknown.", "Eva's traces: old door photos, a blurred photo, a cup, a musical instrument and Marina's letter conflict with Eva's absence from other accounts."],
	["Rescue photo", "RESCUE PHOTOGRAPH\n\n[Photograph: the rescue]\nA photograph records the rescue. Its account of the rescue does not align with the journey and accident records across the two causal versions.", "Rescue photograph: the rescue pictured does not align with the journey and accident records across the two causal versions."],
	["Bus and accident records", "BUS AND ACCIDENT RECORDS\n\n[Bus ticket / accident report]\nRecords involving Jonas and Ricardo Almeida describe a journey and accident that do not align with the rescue photograph across the two causal versions. The discrepancy remains unresolved.", "Bus and accident records: Jonas and Ricardo Almeida's journey conflicts with the rescue photograph across the two causal versions."]
]
const INTERVIEWS = [
	["Marina", "54, theatre manager", "The exit?", "Marina: The registry lists a second emergency exit, but it doesn't exist.", "Eva?", "Marina: I don't know anyone named Eva."],
	["Paula", "28", "The fire?", "Paula: I still have this scar from the fire on 17 July 2021.", "Who rescued you?", "Paula: Jonas rescued me. He's my partner."],
	["Jonas", "30", "Paula?", "Jonas: Paula is my partner.", "The fire?", "Jonas: I rescued Paula from the theatre fire."],
	["Augusto", "67", "The door?", "Augusto: I remember the emergency door in that corridor.", "Eva?", "Augusto: I remember the name Eva, but I can't recall who she is."]
]
var save_path := "user://quiet_observatory_save.json"
var save_directory := "user://"
var message: Label
var title: Label
var room_label: Label
var indicated_target: SceneTarget
var inventory: Button
var hotspots: RoomCanvas
var choices: HBoxContainer
var gameplay_panel: PanelContainer
var menu: VBoxContainer
var document_panel: PanelContainer
var case_panel: PanelContainer
var intake_panel: PanelContainer
var pause_overlay: Control
var pause_menu: VBoxContainer
var pause_feedback: Label
var paused_panel: Control
var audio_panel: PanelContainer
var audio_from: Control
var audio_launcher: Button
var sfx_slider: HSlider
var sfx_mute: CheckButton
var case_data := {
	"number": "MR-014",
	"description": "Case 01 — The Aurora Theatre Fire. Marina Azevedo reports a second emergency exit in the municipal registry that does not exist. Old photos show a door; inspection threatens closure.",
	"objective": "Investigate the disputed emergency exit at Teatro Aurora.",
	"status": "Open"
}


func _surface(fill: Color, edge: Color, inset_x: float, inset_y: float) -> StyleBoxFlat:
	var surface := StyleBoxFlat.new()
	surface.bg_color = fill
	surface.border_color = edge
	surface.set_border_width_all(1)
	surface.content_margin_left = inset_x
	surface.content_margin_right = inset_x
	surface.content_margin_top = inset_y
	surface.content_margin_bottom = inset_y
	return surface


func _install_theme() -> void:
	var dossier := Theme.new()
	dossier.default_font_size = 15
	dossier.set_color("font_color", "Label", Color("eee1cc"))
	dossier.set_stylebox("panel", "PanelContainer", _surface(INK, Color("766651"), 16, 8))
	dossier.set_stylebox("normal", "Button", _surface(Color("29363c"), Color("655e50"), 12, 3))
	dossier.set_stylebox("hover", "Button", _surface(Color("3e5150"), BRASS, 12, 3))
	dossier.set_stylebox("pressed", "Button", _surface(Color("58473a"), BRASS, 12, 3))
	var focus := _surface(Color.TRANSPARENT, Color("e8c997"), 0, 0)
	dossier.set_stylebox("focus", "Button", focus)
	for state in ["font_color", "font_hover_color", "font_pressed_color", "font_focus_color", "font_hover_pressed_color"]:
		dossier.set_color(state, "Button", Color("eee1cc"))
	theme = dossier


func _ready() -> void:
	_install_theme()
	add_child(sfx)
	var matte := ColorRect.new()
	matte.color = Color("10151c")
	matte.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	matte.mouse_filter = Control.MOUSE_FILTER_IGNORE
	add_child(matte)
	hotspots = RoomCanvas.new()
	hotspots.frame = Panel.new()
	hotspots.frame.add_theme_stylebox_override("panel", _surface(Color("5f5144"), BRASS, 0, 0))
	hotspots.frame.mouse_filter = Control.MOUSE_FILTER_IGNORE
	add_child(hotspots.frame)
	hotspots.picture = TextureRect.new()
	hotspots.picture.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
	hotspots.picture.mouse_filter = Control.MOUSE_FILTER_IGNORE
	var art_material := ShaderMaterial.new()
	art_material.shader = preload("res://art/paper.gdshader")
	art_material.set_shader_parameter("form", RoomCanvas.RECTIFICATION_FORM)
	hotspots.picture.material = art_material
	add_child(hotspots.picture)
	hotspots.clip_contents = true
	hotspots.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	hotspots.offset_bottom = -HUD_HEIGHT
	hotspots.mouse_filter = Control.MOUSE_FILTER_IGNORE
	add_child(hotspots)
	var panel := PanelContainer.new()
	gameplay_panel = panel
	panel.set_anchors_and_offsets_preset(Control.PRESET_BOTTOM_WIDE)
	panel.offset_top = -HUD_HEIGHT
	add_child(panel)
	var layout := VBoxContainer.new()
	layout.add_theme_constant_override("separation", 3)
	panel.add_child(layout)
	title = Label.new()
	title.add_theme_font_size_override("font_size", 13)
	title.add_theme_color_override("font_color", Color("cfb287"))
	layout.add_child(title)
	room_label = Label.new()
	room_label.add_theme_font_size_override("font_size", 20)
	layout.add_child(room_label)
	message = Label.new()
	message.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	message.custom_minimum_size.y = 45
	layout.add_child(message)
	# Before: Save/Load duplicated pause and save selection in the HUD.
	# Now: scene objects handle local actions; Case File and Pause are global.
	# Pause saves or returns to the menu; Continue selects a save there.
	panel.visibility_changed.connect(_sync_hotspots)
	choices = HBoxContainer.new()
	layout.add_child(choices)
	var tools := HBoxContainer.new()
	layout.add_child(tools)
	inventory = _button(tools, "Inventory: empty", _select_lens, "")
	_button(tools, "Case File", _open_case, "")
	_button(tools, "Pause", _pause_game, "")
	_show_room("The observatory is quiet. Explore the room.")
	hotspots.resized.connect(hotspots.layout_art)
	document_panel = PanelContainer.new()
	document_panel.set_anchors_and_offsets_preset(Control.PRESET_CENTER)
	document_panel.offset_left = -320
	document_panel.offset_right = 320
	document_panel.grow_vertical = Control.GROW_DIRECTION_BOTH
	add_child(document_panel)
	var document := VBoxContainer.new()
	document_panel.add_child(document)
	var record := Label.new()
	record.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	record.add_theme_font_size_override("font_size", 18)
	record.text = "OBSERVATORY DELIVERY RECORD\n\nItem: Lamp oil, 2 tins\nRecipient: Observatory keeper\nDelivery address: 14 Harbour Road\nBilling address: 41 Harbour Road\n\nFiled by: M. Ellis"
	document.add_child(record)
	_button(document, "Close", _close_document, "close")
	document_panel.hide()
	case_panel = PanelContainer.new()
	case_panel.set_anchors_and_offsets_preset(Control.PRESET_CENTER)
	case_panel.offset_left = -350
	case_panel.offset_right = 350
	case_panel.offset_top = 0
	case_panel.offset_bottom = 0
	case_panel.grow_vertical = Control.GROW_DIRECTION_BOTH
	add_child(case_panel)
	var case_layout := VBoxContainer.new()
	case_panel.add_child(case_layout)
	var case_text := Label.new()
	case_text.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	case_text.add_theme_font_size_override("font_size", 14)
	case_text.text = "CASE FILE: %s\n\nDescription: %s\n\nObjective: %s\n\nStatus: %s" % [case_data.number, case_data.description, case_data.objective, case_data.status]
	case_layout.add_child(case_text)
	_button(case_layout, "Close", _close_case, "close")
	case_panel.hide()
	intake_panel = PanelContainer.new()
	intake_panel.set_anchors_and_offsets_preset(Control.PRESET_CENTER)
	intake_panel.offset_left = -350
	intake_panel.offset_right = 350
	intake_panel.offset_top = 0
	intake_panel.offset_bottom = 0
	intake_panel.grow_vertical = Control.GROW_DIRECTION_BOTH
	add_child(intake_panel)
	var intake_layout := VBoxContainer.new()
	intake_panel.add_child(intake_layout)
	var assignment := Label.new()
	assignment.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	assignment.text = "CARTÓRIO DOS ESQUECIDOS — INTAKE, 2026\n\nCase 01 / MR-014 — The Aurora Theatre Fire\n\nMarina Azevedo reports that the municipal registry shows a second emergency exit at Teatro Aurora that does not exist. Old photos show a door; an inspection threatens to close the theatre.\n\nNext: review the case file and visit Teatro Aurora."
	intake_layout.add_child(assignment)
	_button(intake_layout, "Review Case File", _review_case, "")
	intake_panel.hide()
	board_panel = PanelContainer.new()
	board_panel.set_anchors_and_offsets_preset(Control.PRESET_CENTER)
	board_panel.offset_left = -430
	board_panel.offset_right = 430
	board_panel.grow_vertical = Control.GROW_DIRECTION_BOTH
	add_child(board_panel)
	var board := VBoxContainer.new()
	board_panel.add_child(board)
	var board_heading := Label.new()
	board_heading.text = "AURORA — RECONSTRUCTION BOARD"
	board.add_child(board_heading)
	var anchors := Label.new()
	anchors.text = "Anchors: 19:42 Eva call • missing door / old photos • rescue photo • bus / Ricardo Almeida accident records"
	anchors.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	board.add_child(anchors)
	for lane in range(2):
		var label := Label.new()
		label.text = "A — Recognized continuity" if lane == 0 else "B — Alternative continuity"
		board.add_child(label)
		var row := HBoxContainer.new()
		board.add_child(row)
		var cards := []
		for slot in range(3):
			var card := OptionButton.new()
			card.add_item("Select scene…")
			for option in RECONSTRUCTION[lane][slot]:
				card.add_item(option)
			card.size_flags_horizontal = Control.SIZE_EXPAND_FILL
			row.add_child(card)
			sfx.wire_hover(card, "hover")
			card.pressed.connect(sfx.action.bind("confirm"))
			card.item_selected.connect(func(_index: int): sfx.action("confirm"))
			cards.append(card)
		board_cards.append(cards)
	board_feedback = Label.new()
	board_feedback.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	board.add_child(board_feedback)
	var board_actions := HBoxContainer.new()
	board.add_child(board_actions)
	_button(board_actions, "Check sequences", _check_reconstruction, "")
	_button(board_actions, "Close", _close_board, "close")
	board_panel.hide()
	var menu_panel := PanelContainer.new()
	menu_panel.set_anchors_and_offsets_preset(Control.PRESET_CENTER)
	add_child(menu_panel)
	menu = VBoxContainer.new()
	menu_panel.add_child(menu)
	audio_launcher = _button(self, "Audio Settings", _open_audio.bind(menu_panel), "open")
	audio_launcher.set_anchors_and_offsets_preset(Control.PRESET_TOP_RIGHT, Control.PRESET_MODE_MINSIZE, 18)
	menu_panel.visibility_changed.connect(func(): audio_launcher.visible = menu_panel.visible)
	pause_overlay = Control.new()
	pause_overlay.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	pause_overlay.mouse_filter = Control.MOUSE_FILTER_STOP
	add_child(pause_overlay)
	var shade := ColorRect.new()
	shade.color = Color(0, 0, 0, 0.7)
	shade.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	shade.mouse_filter = Control.MOUSE_FILTER_IGNORE
	pause_overlay.add_child(shade)
	var pause_panel := PanelContainer.new()
	pause_panel.set_anchors_and_offsets_preset(Control.PRESET_CENTER)
	pause_overlay.add_child(pause_panel)
	pause_menu = VBoxContainer.new()
	pause_panel.add_child(pause_menu)
	var pause_heading := Label.new()
	pause_heading.text = "Paused"
	pause_menu.add_child(pause_heading)
	_button(pause_menu, "Resume", _resume_game, "")
	_button(pause_menu, "Save Game", _pause_save)
	_button(pause_menu, "Audio Settings", _open_audio.bind(pause_overlay), "open")
	_button(pause_menu, "Return to Main Menu", _pause_main_menu, "back")
	pause_feedback = Label.new()
	pause_menu.add_child(pause_feedback)
	pause_overlay.hide()
	_build_audio_panel()
	_show_menu()


func _build_audio_panel() -> void:
	audio_panel = PanelContainer.new()
	audio_panel.set_anchors_and_offsets_preset(Control.PRESET_CENTER)
	audio_panel.offset_left = -170
	audio_panel.offset_right = 170
	audio_panel.grow_vertical = Control.GROW_DIRECTION_BOTH
	add_child(audio_panel)
	var layout := VBoxContainer.new()
	audio_panel.add_child(layout)
	var heading := Label.new()
	heading.text = "Audio Settings"
	heading.add_theme_font_size_override("font_size", 20)
	layout.add_child(heading)
	var level_readout := Label.new()
	layout.add_child(level_readout)
	sfx_slider = HSlider.new()
	sfx_slider.max_value = 100
	sfx_slider.step = 1
	sfx_slider.value = sfx.level * 100.0
	layout.add_child(sfx_slider)
	sfx_mute = CheckButton.new()
	sfx_mute.text = "Mute sound effects"
	sfx_mute.button_pressed = sfx.muted
	layout.add_child(sfx_mute)
	sfx.wire_hover(sfx_mute, "hover")
	var update_level := func(value: float):
		level_readout.text = "Sound effects: %d%%" % int(value)
	update_level.call(sfx_slider.value)
	sfx_slider.value_changed.connect(func(value: float):
		update_level.call(value)
		sfx.set_mix(value / 100.0, sfx.muted)
	)
	sfx_slider.drag_ended.connect(func(changed: bool):
		if changed:
			sfx.action("confirm")
	)
	sfx_mute.toggled.connect(func(enabled: bool):
		sfx.set_mix(sfx.level, enabled)
		sfx.save_settings()
		sfx.action("confirm")
	)
	_button(layout, "Back", _close_audio, "")
	audio_panel.hide()


func _open_audio(origin: Control) -> void:
	audio_from = origin
	origin.hide()
	audio_panel.show()
	sfx_slider.grab_focus()


func _close_audio() -> void:
	sfx.save_settings()
	sfx.action("back")
	audio_panel.hide()
	audio_from.show()
	if audio_from == pause_overlay:
		pause_menu.get_child(1).grab_focus()
	else:
		audio_launcher.grab_focus()


func _review_case() -> void:
	intake_panel.hide()
	_open_case()


func _input(event: InputEvent) -> void:
	if event is InputEventKey and event.pressed and not event.echo and event.keycode == KEY_ESCAPE:
		if audio_panel.visible:
			_close_audio()
		elif pause_overlay.visible:
			_resume_game()
		elif not menu.get_parent().visible:
			_pause_game()
		else:
			return
		get_viewport().set_input_as_handled()


func _pause_game() -> void:
	sfx.action("confirm")
	paused_panel = intake_panel if intake_panel.visible else document_panel if document_panel.visible else case_panel if case_panel.visible else board_panel if board_panel.visible else gameplay_panel
	paused_panel.hide()
	pause_feedback.text = ""
	pause_overlay.show()
	pause_menu.get_child(1).grab_focus()


func _resume_game() -> void:
	sfx.action("back")
	pause_overlay.hide()
	paused_panel.show()


func _pause_save() -> void:
	save_game()
	pause_feedback.text = message.text


func _pause_main_menu() -> void:
	pause_overlay.hide()
	_show_menu()
	menu.get_parent().show()
	menu.get_child(1).grab_focus()


func _show_menu() -> void:
	intake_panel.hide()
	document_panel.hide()
	case_panel.hide()
	board_panel.hide()
	gameplay_panel.hide()
	hotspots.present("observatory", false)
	_clear(menu)
	var heading := Label.new()
	heading.text = "O Cartório dos Esquecidos"
	heading.add_theme_font_size_override("font_size", 26)
	menu.add_child(heading)
	_button(menu, "New Game", _new_game, "open")
	_button(menu, "Continue", _show_saves)
	_button(menu, "Exit", func(): get_tree().quit(), "back")


func _new_game() -> void:
	document_panel.hide()
	case_panel.hide()
	room = "observatory"
	has_lens = false
	selected_lens = false
	lit = false
	aurora_clues = [false, false, false]
	interview_flags = [false, false, false, false, false, false, false, false]
	evidence_flags = [false, false, false, false]
	reconstruction_solved = [false, false]
	rectification = ""
	for cards in board_cards:
		for card in cards:
			card.select(0)
	var slot := Time.get_unix_time_from_system()
	save_path = save_directory.path_join("quiet_observatory_save_%d.json" % int(slot))
	while FileAccess.file_exists(save_path):
		slot += 1
		save_path = save_directory.path_join("quiet_observatory_save_%d.json" % int(slot))
	menu.get_parent().hide()
	gameplay_panel.hide()
	_show_room("The observatory is quiet. Explore the room.")
	intake_panel.show()


func _show_saves() -> void:
	_clear(menu)
	var heading := Label.new()
	heading.text = "Choose a saved game"
	menu.add_child(heading)
	var saves: Array[String] = []
	var directory := DirAccess.open(save_directory)
	if directory:
		directory.list_dir_begin()
		var filename := directory.get_next()
		while filename != "":
			if not directory.current_is_dir() and filename.begins_with("quiet_observatory_save") and filename.ends_with(".json"):
				saves.append(filename)
			filename = directory.get_next()
		directory.list_dir_end()
	saves.sort()
	if saves.is_empty():
		var empty := Label.new()
		empty.text = "No saved games yet. Start a new game and save your progress."
		menu.add_child(empty)
	for filename in saves:
		_button(menu, filename, _continue_save.bind(save_directory.path_join(filename)))
	_button(menu, "Back", _show_menu, "back")


func _continue_save(path: String) -> void:
	var previous_path := save_path
	save_path = path
	if load_game():
		intake_panel.hide()
		menu.get_parent().hide()
		gameplay_panel.show()
	else:
		save_path = previous_path
		var error := Label.new()
		error.text = message.text
		menu.add_child(error)


func _button(parent: Node, text: String, action: Callable, cue := "confirm") -> Button:
	var button := Button.new()
	_wire_button(button, parent, text, action, cue)
	return button


func _wire_button(button: Button, parent: Node, text: String, action: Callable, cue: String) -> void:
	button.text = text
	if not cue.is_empty():
		button.pressed.connect(sfx.action.bind(cue))
	button.pressed.connect(action)
	parent.add_child(button)
	sfx.wire_hover(button, "target" if parent == hotspots else "hover")


func _scene_object(text: String, action: Callable, points: Array, anchor: Vector2, cue := "") -> SceneTarget:
	var button := SceneTarget.new()
	button.set_silhouette(points, anchor)
	button.mouse_default_cursor_shape = Control.CURSOR_POINTING_HAND
	# Keep a real button for tab/accept and assistive text. The canvas draws feedback.
	var invisible := StyleBoxEmpty.new()
	for state in ["normal", "hover", "pressed", "hover_pressed", "focus", "disabled"]:
		button.add_theme_stylebox_override(state, invisible)
	button.add_theme_font_size_override("font_size", 1)
	button.text_overrun_behavior = TextServer.OVERRUN_TRIM_CHAR
	for state in ["font_color", "font_hover_color", "font_pressed_color", "font_focus_color", "font_hover_pressed_color", "font_disabled_color"]:
		button.add_theme_color_override(state, Color.TRANSPARENT)
	_wire_button(button, hotspots, text, action, cue)
	button.mouse_entered.connect(_indicate.bind(button))
	button.focus_entered.connect(_indicate.bind(button))
	button.mouse_exited.connect(_unindicate.bind(button))
	button.focus_exited.connect(_unindicate.bind(button))
	button.gui_input.connect(_track_target_pointer.bind(button))
	return button


func _track_target_pointer(event: InputEvent, target: SceneTarget) -> void:
	if event is InputEventMouseMotion and indicated_target == target and target.silhouettes.size() > 1:
		var part := target.silhouette_at(event.position)
		if part != -1 and hotspots.cue_anchor != target.anchors[part]:
			hotspots.cue_anchor = target.anchors[part]
			hotspots.queue_redraw()


func _indicate(target: SceneTarget) -> void:
	if target and not target.is_visible_in_tree():
		return
	indicated_target = target
	hotspots.cue = target
	hotspots.cue_anchor = target.anchors[0] if target else Vector2.ZERO
	hotspots.queue_redraw()
	room_label.text = _room_name()
	if target:
		room_label.text += " — " + target.text


func _unindicate(target: SceneTarget) -> void:
	if indicated_target == target:
		_indicate(null)


func _sync_hotspots() -> void:
	if hotspots and gameplay_panel:
		hotspots.visible = gameplay_panel.visible
		if not hotspots.visible:
			_indicate(null)


func _clear(parent: Node) -> void:
	for child in parent.get_children():
		parent.remove_child(child)
		child.queue_free()


func _room_name() -> String:
	return {"observatory": "Observatory", "lantern": "Lantern room", "aurora": "Teatro Aurora"}.get(room, "Observatory")


func _show_room(text: String) -> void:
	_indicate(null)
	_clear(hotspots)
	_clear(choices)
	title.text = "CARTÓRIO DOS ESQUECIDOS   /   MR–014"
	room_label.text = _room_name()
	message.text = text
	inventory.text = "Inventory: lens" + (" (selected)" if selected_lens else "") if has_lens else "Inventory: empty"
	var form_ready := room == "aurora" and reconstruction_solved == [true, true] and rectification == ""
	if room == "observatory":
		_scene_object("Examine desk", _desk, [60, 411, 186, 368, 231, 374, 348, 362, 383, 337, 414, 339, 394, 417, 394, 473, 60, 476], Vector2(197, 386))
		_scene_object("Inspect delivery record", _open_document, [219, 347, 289, 325, 388, 331, 347, 361, 231, 373], Vector2(296, 349))
		_scene_object("Talk to keeper", _keeper, [422, 323, 425, 270, 438, 239, 470, 220, 473, 204, 462, 187, 459, 151, 470, 130, 493, 118, 519, 117, 539, 132, 545, 154, 535, 188, 524, 211, 527, 222, 557, 237, 571, 260, 582, 316, 570, 338, 433, 328], Vector2(503, 267), "confirm")
		_scene_object("Lantern room →", func(): _transition("lantern"), [595, 115, 735, 116, 750, 338, 600, 332], Vector2(710, 246))
		_scene_object("Teatro Aurora →", func(): _transition("aurora"), [774, 89, 911, 44, 925, 411, 793, 338], Vector2(852, 202))
	elif room == "lantern":
		_scene_object("Examine lantern", _lantern, [398, 344, 418, 320, 423, 207, 413, 186, 440, 152, 454, 132, 453, 110, 468, 94, 492, 89, 511, 99, 518, 122, 534, 150, 575, 186, 567, 208, 566, 306, 573, 323, 591, 340, 589, 352, 543, 366, 480, 371, 401, 360], Vector2(491, 257))
		_scene_object("← Observatory", func(): _transition("observatory"), [39, 95, 168, 135, 160, 361, 33, 427], Vector2(112, 278))
	else:
		_scene_object("Wall and plan", _aurora_evidence.bind(0), [404, 137, 433, 138, 438, 132, 462, 133, 465, 139, 498, 139, 502, 214, 407, 213], Vector2(448, 176))
		_scene_object("Old door photos", _aurora_evidence.bind(1), [527, 136, 581, 144, 575, 179, 583, 208, 528, 219, 519, 176], Vector2(550, 158))
		_scene_object("Building records", _aurora_evidence.bind(2), [623, 331, 679, 314, 719, 328, 731, 325, 775, 343, 712, 370, 623, 347], Vector2(681, 333))
		# The callboard and shelf index are opt-in lists; witnesses and props
		# themselves go straight to the relevant interview or document.
		_scene_object("Interviews", _interviews, [830, 91, 914, 75, 916, 106, 831, 118], Vector2(871, 95), "confirm")
		_scene_object("Talk to Marina", _interview.bind(0), [828, 428, 842, 411, 842, 349, 833, 342, 840, 317, 829, 314, 816, 297, 830, 245, 842, 227, 861, 218, 844, 208, 837, 181, 840, 155, 855, 141, 877, 136, 900, 144, 911, 160, 914, 177, 908, 199, 911, 211, 896, 218, 914, 229, 924, 248, 937, 295, 929, 305, 915, 308, 923, 345, 916, 365, 925, 410, 932, 425, 924, 434, 899, 428, 886, 371, 880, 371, 870, 427, 847, 434], Vector2(878, 264), "confirm")
		_scene_object("Talk to Paula", _interview.bind(1), [184, 277, 187, 258, 192, 249, 184, 232, 188, 213, 194, 206, 187, 197, 189, 175, 198, 163, 212, 159, 225, 168, 229, 184, 224, 200, 217, 205, 231, 213, 235, 232, 228, 250, 230, 272, 235, 282, 214, 284, 209, 253, 206, 280, 183, 284], Vector2(209, 220), "confirm")
		_scene_object("Talk to Jonas", _interview.bind(2), [268, 279, 274, 253, 272, 239, 261, 232, 264, 213, 271, 199, 282, 195, 275, 184, 273, 169, 278, 154, 294, 150, 309, 157, 311, 171, 306, 186, 300, 194, 313, 199, 322, 216, 326, 238, 315, 244, 315, 270, 320, 278, 319, 284, 302, 283, 294, 250, 289, 276, 285, 285, 264, 285], Vector2(294, 219), "confirm")
		_scene_object("Talk to Augusto", _interview.bind(3), [320, 347, 329, 331, 329, 296, 321, 278, 328, 249, 338, 233, 346, 230, 338, 214, 339, 196, 348, 181, 365, 180, 377, 190, 381, 204, 376, 221, 369, 231, 381, 241, 388, 266, 383, 283, 375, 289, 373, 324, 380, 343, 373, 352, 354, 347, 351, 309, 345, 342, 340, 352, 318, 354], Vector2(354, 259), "confirm")
		# The brass index occupies the front rail, not the telephone or tabletop.
		_scene_object("Evidence shelf", _evidence_shelf, [171, 336, 271, 335, 277, 339, 275, 356, 269, 360, 173, 363, 167, 358, 168, 340], Vector2(222, 349), "confirm")
		_scene_object("19:42 call", _inspect_evidence.bind(0), [173, 308, 187, 296, 212, 294, 230, 299, 240, 309, 238, 323, 227, 329, 183, 328, 173, 323], Vector2(205, 317))
		var traces := _scene_object("Eva's traces", _inspect_evidence.bind(1), [248, 308, 255, 303, 267, 304, 278, 307, 278, 317, 300, 322, 282, 334, 250, 330, 250, 319], Vector2(273, 323))
		# The cup and photo share evidence with the case below. Keep the shelf
		# index and the air between them out of this target, with one tab stop.
		traces.add_silhouette([160, 384, 170, 377, 188, 373, 204, 373, 237, 377, 271, 373, 285, 378, 276, 386, 233, 387, 198, 397, 178, 397, 166, 392], Vector2(207, 384))
		_scene_object("Rescue photo", _inspect_evidence.bind(2), [564, 343, 605, 332, 622, 348, 585, 361], Vector2(594, 345))
		_scene_object("Bus and accident records", _inspect_evidence.bind(3), [607, 363, 643, 354, 676, 364, 648, 382, 604, 379], Vector2(639, 368))
		_scene_object("Reconstruction board", _open_board, [643, 111, 799, 88, 807, 235, 648, 245], Vector2(731, 169), "open")
		if form_ready:
			_scene_object("Cartório rectification", _rectification_choice, [463, 381, 500, 356, 566, 364, 533, 387, 464, 396], Vector2(510, 375), "confirm")
		_scene_object("← Observatory", func(): _transition("observatory"), [14, 118, 103, 149, 100, 342, 11, 407], Vector2(48, 271))
	hotspots.present(room, lit, form_ready)


func _open_board() -> void:
	for lane in range(2):
		for card in board_cards[lane]:
			card.select(lane + 1 if reconstruction_solved[lane] else 0)
	board_feedback.text = "Choose a scene for each position, left to right. Check both sequences."
	if reconstruction_solved == [true, true]:
		board_feedback.text = "Contradiction established: both incompatible sequences are reconstructed. Its origin remains unknown."
	gameplay_panel.hide()
	board_panel.show()


func _check_reconstruction() -> void:
	var before := reconstruction_solved.duplicate()
	var feedback := []
	var current_valid := true
	for lane in range(2):
		var incomplete := false
		var correct := true
		for card in board_cards[lane]:
			if card.selected == 0:
				incomplete = true
			elif card.selected != lane + 1:
				correct = false
		var name := "A" if lane == 0 else "B"
		if incomplete:
			current_valid = false
			feedback.append(name + ": incomplete — select all three scenes.")
		elif not correct:
			current_valid = false
			feedback.append(name + ": incorrect — compare the rescue, door and journey evidence.")
		else:
			reconstruction_solved[lane] = true
			feedback.append(name + ": sequence reconstructed.")
	if reconstruction_solved == [true, true] and current_valid:
		feedback.append("Contradiction established: both incompatible sequences are reconstructed. Its origin remains unknown.")
	board_feedback.text = "\n".join(feedback)
	sfx.action("clue" if reconstruction_solved != before else "confirm" if current_valid else "result")


func _close_board() -> void:
	board_panel.hide()
	_show_room("The reconstruction board is closed.")
	gameplay_panel.show()


func _rectification_choice() -> void:
	if reconstruction_solved != [true, true] or rectification != "":
		return
	_clear(choices)
	message.text = "Cartório rectification: which incompatible continuity will be officially maintained? Recognized: Jonas rescues Paula and their relationship survives, but Eva and the door are erased. Alternative: Eva rescues Paula and Jonas takes a different route, implicating the bus accident and Ricardo's records. Neither choice is clean."
	_button(choices, "Maintain recognized", _rectify.bind("recognized"), "clue")
	_button(choices, "Maintain alternative", _rectify.bind("alternative"), "clue")


func _rectify(choice: String) -> void:
	if reconstruction_solved != [true, true] or rectification != "" or choice not in ["recognized", "alternative"]:
		return
	rectification = choice
	_show_room("The Cartório files the rectification. Read the completed case file for its aftermath.")


func _evidence_shelf() -> void:
	_clear(choices)
	message.text = "Evidence shelf: choose an item to inspect."
	for i in range(EVIDENCE.size()):
		_button(choices, EVIDENCE[i][0], _inspect_evidence.bind(i), "")


func _inspect_evidence(index: int) -> void:
	var discovered: bool = not evidence_flags[index]
	evidence_flags[index] = true
	_present_document(EVIDENCE[index][1], discovered)


func _interviews() -> void:
	_clear(choices)
	message.text = "Who would you like to interview?"
	for i in range(INTERVIEWS.size()):
		_button(choices, INTERVIEWS[i][0], _interview.bind(i))


func _interview(person: int) -> void:
	_clear(choices)
	var account: Array = INTERVIEWS[person]
	message.text = "[%s — %s]\nWhat would you like to ask?" % [account[0], account[1]]
	_button(choices, account[2], _statement.bind(person * 2), "")
	_button(choices, account[4], _statement.bind(person * 2 + 1), "")
	_button(choices, "Other people", _interviews, "back")


func _statement(index: int) -> void:
	sfx.action("confirm" if interview_flags[index] else "clue")
	interview_flags[index] = true
	var account: Array = INTERVIEWS[index / 2]
	message.text = "[%s — %s]\n%s" % [account[0], account[1], account[3 if index % 2 == 0 else 5]]


func _aurora_evidence(index: int) -> void:
	var notes := [
		"AURORA — WALL AND CURRENT PLAN\n\nThe corridor wall is uninterrupted. The current plan shows no second emergency exit here.",
		"AURORA — OLD DOOR PHOTOGRAPHS\n\nOld photographs show a second emergency door in the corridor, where the present wall has no opening.",
		"AURORA — BUILDING RECORDS\n\nThe available building records contain no documented masonry work closing a door. A fragment suggests Eva Azevedo was Marina's sister, though Eva is absent from official records."
	]
	var discovered: bool = not aurora_clues[index]
	aurora_clues[index] = true
	_present_document(notes[index], discovered)


func _open_document() -> void:
	_present_document("OBSERVATORY DELIVERY RECORD\n\nItem: Lamp oil, 2 tins\nRecipient: Observatory keeper\nDelivery address: 14 Harbour Road\nBilling address: 41 Harbour Road\n\nFiled by: M. Ellis")


func _present_document(text: String, discovered := false) -> void:
	# A discovery cue includes the paper attack: never layer it with "open".
	sfx.action("clue" if discovered else "open")
	document_panel.get_child(0).get_child(0).text = text
	gameplay_panel.hide()
	document_panel.show()


func _close_document() -> void:
	document_panel.hide()
	gameplay_panel.show()


func _open_case() -> void:
	sfx.action("open")
	var text: String = "CASE FILE: %s\n\nDescription: %s\n\nObjective: %s\n\nStatus: %s" % [case_data.number, case_data.description, case_data.objective, case_data.status]
	if rectification != "":
		text = text.replace("Status: Open", "Status: Closed — rectified")
		if rectification == "recognized":
			text += "\n\nRectification — recognized continuity maintained: Jonas rescued Paula; their partnership remains. Eva and the door are erased from the official continuity."
		else:
			text += "\n\nRectification — alternative continuity maintained: Eva rescued Paula through the door. Jonas continued on the bus instead; the accident and Ricardo Almeida's records are implicated, and Jonas and Paula's partnership is no longer preserved."
		text += "\n\nThe following Sunday seems ordinary: Marina, Paula and Jonas spend the day together. In the dressing-room corridor, a door that should not exist quietly shuts. Neither the Cartório's origins nor which continuity is really correct is resolved."
	var evidence := []
	if aurora_clues[0]:
		evidence.append("Current wall and plan: no second exit.")
	if aurora_clues[1]:
		evidence.append("Old photographs: a second door is visible.")
	if aurora_clues[2]:
		evidence.append("Building records: no documented masonry work closing the door; a fragment suggests Eva Azevedo was Marina's sister, absent from official records.")
	for i in range(evidence_flags.size()):
		if evidence_flags[i]:
			evidence.append(EVIDENCE[i][2])
	if not evidence.is_empty():
		text += "\n\nEvidence:\n" + "\n".join(evidence)
	var statements := []
	for i in range(interview_flags.size()):
		if interview_flags[i]:
			statements.append(INTERVIEWS[i / 2][3 if i % 2 == 0 else 5])
	if not statements.is_empty():
		text += "\n\nInterview statements:\n" + "\n".join(statements)
	case_panel.get_child(0).get_child(0).text = text
	gameplay_panel.hide()
	case_panel.show()


func _close_case() -> void:
	case_panel.hide()
	gameplay_panel.show()


func _desk() -> void:
	if has_lens or lit:
		sfx.action("confirm")
		_show_room("The desk holds a notebook full of star charts.")
	else:
		sfx.action("clue")
		has_lens = true
		_show_room("You found a glass lens. Select it in your inventory to use it.")


func _keeper() -> void:
	_clear(choices)
	if lit:
		message.text = "Keeper: Thank you for lighting the lantern!"
		return
	message.text = "Keeper: The lantern needs its missing lens. What would you like to ask?"
	_button(choices, "Where is the lens?", func(): _answer("Keeper: I last saw it on the observatory desk."))
	_button(choices, "Why light it?", func(): _answer("Keeper: Its beam guides our friends safely home."))


func _answer(text: String) -> void:
	_clear(choices)
	message.text = text


func _select_lens() -> void:
	if has_lens:
		selected_lens = not selected_lens
		sfx.action("open" if selected_lens else "close")
		_show_room("Lens selected. Use it on a hotspot." if selected_lens else "Lens put away.")
	else:
		sfx.action("result")
		_clear(choices)
		message.text = "Your inventory is empty."


func _transition(destination: String) -> void:
	sfx.action("door")
	room = destination
	selected_lens = false
	_show_room("You enter the lantern room." if room == "lantern" else "You arrive at Teatro Aurora. The corridor is quiet." if room == "aurora" else "You return to the observatory.")


func _lantern() -> void:
	sfx.action("confirm" if lit else "clue" if has_lens and selected_lens else "result")
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
	file.store_string(JSON.stringify({"room": room, "has_lens": has_lens, "lit": lit, "aurora_clues": aurora_clues, "interview_flags": interview_flags, "evidence_flags": evidence_flags, "reconstruction_solved": reconstruction_solved, "rectification": rectification}))
	if file.get_error() != OK:
		message.text = "Could not save the game."
		return
	file.close()
	if DirAccess.rename_absolute(ProjectSettings.globalize_path(temporary), ProjectSettings.globalize_path(save_path)) != OK:
		message.text = "Could not replace the saved game; previous save was kept."
		return
	message.text = "Game saved."


func load_game() -> bool:
	if not FileAccess.file_exists(save_path):
		message.text = "No saved game found.\nUse Save to create one."
		return false
	var file := FileAccess.open(save_path, FileAccess.READ)
	if file == null:
		message.text = "Could not read saved game."
		return false
	var json := JSON.new()
	if json.parse(file.get_as_text()) != OK:
		message.text = "Save file is invalid; current progress was kept."
		return false
	var data = json.data
	if not data is Dictionary or not data.has_all(["room", "has_lens", "lit"]) or data.room not in ["observatory", "lantern", "aurora"] or not data.has_lens is bool or not data.lit is bool or (data.lit and data.has_lens):
		message.text = "Save file is invalid; current progress was kept."
		return false
	var clues = data.get("aurora_clues", [false, false, false])
	if not clues is Array or clues.size() != 3 or not clues[0] is bool or not clues[1] is bool or not clues[2] is bool:
		message.text = "Save file is invalid; current progress was kept."
		return false
	var interviews = data.get("interview_flags", [false, false, false, false, false, false, false, false])
	if not interviews is Array or interviews.size() != 8:
		message.text = "Save file is invalid; current progress was kept."
		return false
	for flag in interviews:
		if not flag is bool:
			message.text = "Save file is invalid; current progress was kept."
			return false
	var collected = data.get("evidence_flags", [false, false, false, false])
	if not collected is Array or collected.size() != 4:
		message.text = "Save file is invalid; current progress was kept."
		return false
	for flag in collected:
		if not flag is bool:
			message.text = "Save file is invalid; current progress was kept."
			return false
	var reconstructed = data.get("reconstruction_solved", [false, false])
	if not reconstructed is Array or reconstructed.size() != 2:
		message.text = "Save file is invalid; current progress was kept."
		return false
	for flag in reconstructed:
		if not flag is bool:
			message.text = "Save file is invalid; current progress was kept."
			return false
	var decision = data.get("rectification", "")
	if not decision is String or decision not in ["", "recognized", "alternative"] or (decision != "" and reconstructed != [true, true]):
		message.text = "Save file is invalid; current progress was kept."
		return false
	room = data.room
	has_lens = data.has_lens
	lit = data.lit
	aurora_clues = clues
	interview_flags = interviews
	evidence_flags = collected
	reconstruction_solved = reconstructed
	rectification = decision
	selected_lens = false
	_show_room("Game loaded.")
	return true
