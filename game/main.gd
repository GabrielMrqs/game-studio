extends Control

class RoomCanvas extends Control:
	var scene := "observatory"
	var objects: Array = []

	func _draw() -> void:
		var s := size
		draw_rect(Rect2(Vector2.ZERO, s), Color("4b4545") if scene == "aurora" else Color("354958"))
		draw_rect(Rect2(0, s.y * 0.77, s.x, s.y * 0.23), Color("64564b"))
		draw_line(Vector2(0, s.y * 0.77), Vector2(s.x, s.y * 0.77), Color("c5aa80"), 3.0)
		for item in objects:
			var r := Rect2(item[0].position * s, item[0].size * s)
			draw_rect(r, Color("221f22"))
			draw_rect(r.grow(-3), item[1])
			var ink := Color("d9c69d")
			match item[2]:
				"KEEPER", "PEOPLE":
					draw_circle(r.position + Vector2(r.size.x * .5, r.size.y * .38), r.size.x * .17, ink)
					draw_rect(Rect2(r.position + r.size * Vector2(.28, .57), r.size * Vector2(.44, .32)), Color("454e50"))
				"LANTERN →", "AURORA →", "← OFFICE":
					draw_rect(r.grow(-10), Color("3d3633"), false, 2.0)
					draw_circle(r.position + r.size * Vector2(.82, .56), 3.0, ink)
				"OLD PHOTOS", "WALL / PLAN", "RECONSTRUCTION":
					draw_rect(Rect2(r.position + r.size * Vector2(.14, .28), r.size * Vector2(.72, .55)), ink, false, 2.0)
					draw_line(r.position + r.size * Vector2(.22, .65), r.position + r.size * Vector2(.75, .42), ink, 2.0)
				"EVIDENCE":
					for y in [.38, .62, .84]:
						draw_line(r.position + r.size * Vector2(.08, y), r.position + r.size * Vector2(.92, y), ink, 3.0)
				"DESK / LENS", "RECORDS", "DELIVERY RECORD", "RECTIFICATION":
					draw_line(r.position + r.size * Vector2(.15, .48), r.position + r.size * Vector2(.8, .48), ink, 2.0)
					draw_line(r.position + r.size * Vector2(.15, .67), r.position + r.size * Vector2(.7, .67), ink, 2.0)
			draw_string(ThemeDB.fallback_font, r.position + Vector2(8, 20), item[2], HORIZONTAL_ALIGNMENT_LEFT, r.size.x - 12, 14, Color("f1e4c8"))

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
var theatre_backdrop: ColorRect
var case_data := {
	"number": "MR-014",
	"description": "Case 01 — The Aurora Theatre Fire. Marina Azevedo reports a second emergency exit in the municipal registry that does not exist. Old photos show a door; inspection threatens closure.",
	"objective": "Investigate the disputed emergency exit at Teatro Aurora.",
	"status": "Open"
}


func _ready() -> void:
	var background := TextureRect.new()
	background.texture = load("res://art/observatory.svg")
	background.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
	background.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_COVERED
	background.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	background.mouse_filter = Control.MOUSE_FILTER_IGNORE
	add_child(background)
	theatre_backdrop = ColorRect.new()
	theatre_backdrop.color = Color("51484a")
	theatre_backdrop.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	theatre_backdrop.mouse_filter = Control.MOUSE_FILTER_IGNORE
	add_child(theatre_backdrop)
	theatre_backdrop.hide()
	var panel := PanelContainer.new()
	gameplay_panel = panel
	panel.set_anchors_and_offsets_preset(Control.PRESET_BOTTOM_WIDE)
	panel.offset_top = -250
	add_child(panel)
	var layout := VBoxContainer.new()
	panel.add_child(layout)
	title = Label.new()
	layout.add_child(title)
	room_label = Label.new()
	room_label.add_theme_font_size_override("font_size", 12)
	layout.add_child(room_label)
	message = Label.new()
	message.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	message.custom_minimum_size.y = 52
	layout.add_child(message)
	hotspots = RoomCanvas.new()
	hotspots.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	hotspots.offset_bottom = -250
	hotspots.mouse_filter = Control.MOUSE_FILTER_IGNORE
	add_child(hotspots)
	move_child(hotspots, panel.get_index())
	# Before: Save/Load duplicated pause and save selection in the HUD.
	# Now: scene objects handle local actions; Case File and Pause are global.
	# Pause saves or returns to the menu; Continue selects a save there.
	panel.visibility_changed.connect(_sync_hotspots)
	choices = HBoxContainer.new()
	layout.add_child(choices)
	var tools := HBoxContainer.new()
	layout.add_child(tools)
	inventory = _button(tools, "Inventory: empty", _select_lens)
	_button(tools, "Case File", _open_case)
	_button(tools, "Pause", _pause_game)
	_show_room("The observatory is quiet. Explore the room.")
	document_panel = PanelContainer.new()
	document_panel.set_anchors_and_offsets_preset(Control.PRESET_CENTER)
	document_panel.custom_minimum_size = Vector2(500, 0)
	add_child(document_panel)
	var document := VBoxContainer.new()
	document_panel.add_child(document)
	var record := Label.new()
	record.add_theme_font_size_override("font_size", 20)
	record.text = "OBSERVATORY DELIVERY RECORD\n\nItem: Lamp oil, 2 tins\nRecipient: Observatory keeper\nDelivery address: 14 Harbour Road\nBilling address: 41 Harbour Road\n\nFiled by: M. Ellis"
	document.add_child(record)
	_button(document, "Close", _close_document)
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
	_button(case_layout, "Close", _close_case)
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
	_button(intake_layout, "Review Case File", func():
		intake_panel.hide()
		_open_case()
	)
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
			cards.append(card)
		board_cards.append(cards)
	board_feedback = Label.new()
	board_feedback.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	board.add_child(board_feedback)
	var board_actions := HBoxContainer.new()
	board.add_child(board_actions)
	_button(board_actions, "Check sequences", _check_reconstruction)
	_button(board_actions, "Close", _close_board)
	board_panel.hide()
	var menu_panel := PanelContainer.new()
	menu_panel.set_anchors_and_offsets_preset(Control.PRESET_CENTER)
	add_child(menu_panel)
	menu = VBoxContainer.new()
	menu_panel.add_child(menu)
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
	_button(pause_menu, "Resume", _resume_game)
	_button(pause_menu, "Save Game", _pause_save)
	_button(pause_menu, "Return to Main Menu", _pause_main_menu)
	pause_feedback = Label.new()
	pause_menu.add_child(pause_feedback)
	pause_overlay.hide()
	_show_menu()


func _input(event: InputEvent) -> void:
	if event is InputEventKey and event.pressed and not event.echo and event.keycode == KEY_ESCAPE:
		if pause_overlay.visible:
			_resume_game()
		elif not menu.get_parent().visible:
			_pause_game()
		else:
			return
		get_viewport().set_input_as_handled()


func _pause_game() -> void:
	paused_panel = intake_panel if intake_panel.visible else document_panel if document_panel.visible else case_panel if case_panel.visible else board_panel if board_panel.visible else gameplay_panel
	paused_panel.hide()
	pause_feedback.text = ""
	pause_overlay.show()
	pause_menu.get_child(1).grab_focus()


func _resume_game() -> void:
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
	_clear(menu)
	var heading := Label.new()
	heading.text = "The Quiet Observatory"
	menu.add_child(heading)
	_button(menu, "New Game", _new_game)
	_button(menu, "Continue", _show_saves)
	_button(menu, "Exit", func(): get_tree().quit())


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
	_button(menu, "Back", _show_menu)


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


func _button(parent: Node, text: String, action: Callable) -> Button:
	var button := Button.new()
	button.text = text
	button.pressed.connect(action)
	parent.add_child(button)
	if parent == hotspots:
		button.mouse_default_cursor_shape = Control.CURSOR_POINTING_HAND
		button.tooltip_text = text
		var invisible := StyleBoxEmpty.new()
		var highlight := StyleBoxFlat.new()
		highlight.bg_color = Color(1, 1, 1, 0.16)
		highlight.border_color = Color("e8c997")
		highlight.set_border_width_all(2)
		button.add_theme_stylebox_override("normal", invisible)
		button.add_theme_stylebox_override("hover", highlight)
		button.add_theme_stylebox_override("pressed", highlight)
		button.add_theme_stylebox_override("focus", highlight)
		button.add_theme_font_size_override("font_size", 1)
		for state in ["normal", "hover", "pressed", "focus"]:
			button.add_theme_color_override("font_" + state + "_color", Color.TRANSPARENT)
		button.mouse_entered.connect(func(): room_label.text = _room_name() + " — " + text)
		button.mouse_exited.connect(func(): room_label.text = _room_name())
		button.focus_entered.connect(func(): room_label.text = _room_name() + " — " + text)
		button.focus_exited.connect(func(): room_label.text = _room_name())
	return button


func _scene_object(text: String, action: Callable, region: Rect2, color: Color, caption: String) -> void:
	hotspots.objects.append([region, color, caption])
	var button := _button(hotspots, text, action)
	button.set_anchors_preset(Control.PRESET_TOP_LEFT)
	button.anchor_left = region.position.x
	button.anchor_top = region.position.y
	button.anchor_right = region.end.x
	button.anchor_bottom = region.end.y
	button.offset_left = 0
	button.offset_top = 0
	button.offset_right = 0
	button.offset_bottom = 0


func _sync_hotspots() -> void:
	if hotspots and gameplay_panel:
		hotspots.visible = gameplay_panel.visible


func _clear(parent: Node) -> void:
	for child in parent.get_children():
		parent.remove_child(child)
		child.queue_free()


func _room_name() -> String:
	return {"observatory": "Observatory", "lantern": "Lantern room", "aurora": "Teatro Aurora"}.get(room, "Observatory")


func _show_room(text: String) -> void:
	_clear(hotspots)
	_clear(choices)
	hotspots.objects.clear()
	hotspots.scene = room
	theatre_backdrop.visible = room == "aurora"
	title.text = "The Quiet Observatory — " + _room_name()
	room_label.text = _room_name()
	message.text = text
	inventory.text = "Inventory: lens" + (" (selected)" if selected_lens else "") if has_lens else "Inventory: empty"
	if room == "observatory":
		_scene_object("Examine desk", _desk, Rect2(.08, .64, .27, .28), Color("795438"), "DESK / LENS")
		_scene_object("Inspect delivery record", _open_document, Rect2(.12, .48, .18, .13), Color("b6a780"), "DELIVERY RECORD")
		_scene_object("Talk to keeper", _keeper, Rect2(.42, .30, .13, .45), Color("777e77"), "KEEPER")
		_scene_object("Lantern room →", func(): _transition("lantern"), Rect2(.63, .18, .13, .58), Color("604b3b"), "LANTERN →")
		_scene_object("Teatro Aurora →", func(): _transition("aurora"), Rect2(.81, .18, .14, .58), Color("604b3b"), "AURORA →")
	elif room == "lantern":
		_scene_object("Examine lantern", _lantern, Rect2(.38, .18, .24, .55), Color("a18b58"), "LANTERN")
		_scene_object("← Observatory", func(): _transition("observatory"), Rect2(.05, .18, .16, .58), Color("604b3b"), "← OFFICE")
	else:
		_scene_object("Wall and plan", func(): _aurora_evidence(0), Rect2(.23, .12, .19, .37), Color("8b7c6b"), "WALL / PLAN")
		_scene_object("Old door photos", func(): _aurora_evidence(1), Rect2(.44, .12, .13, .22), Color("ae9a7a"), "OLD PHOTOS")
		_scene_object("Building records", func(): _aurora_evidence(2), Rect2(.60, .55, .16, .18), Color("a79575"), "RECORDS")
		_scene_object("Interviews", _interviews, Rect2(.79, .33, .14, .43), Color("777e77"), "PEOPLE")
		_scene_object("Evidence shelf", _evidence_shelf, Rect2(.06, .37, .15, .39), Color("795d49"), "EVIDENCE")
		_scene_object("Reconstruction board", _open_board, Rect2(.60, .10, .21, .33), Color("8a755a"), "RECONSTRUCTION")
		if reconstruction_solved == [true, true] and rectification == "":
			_scene_object("Cartório rectification", _rectification_choice, Rect2(.33, .64, .22, .18), Color("a79575"), "RECTIFICATION")
		_scene_object("← Observatory", func(): _transition("observatory"), Rect2(.01, .04, .12, .24), Color("604b3b"), "← OFFICE")
	hotspots.queue_redraw()


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


func _close_board() -> void:
	board_panel.hide()
	_show_room("The reconstruction board is closed.")
	gameplay_panel.show()


func _rectification_choice() -> void:
	if reconstruction_solved != [true, true] or rectification != "":
		return
	_clear(choices)
	message.text = "Cartório rectification: which incompatible continuity will be officially maintained? Recognized: Jonas rescues Paula and their relationship survives, but Eva and the door are erased. Alternative: Eva rescues Paula and Jonas takes a different route, implicating the bus accident and Ricardo's records. Neither choice is clean."
	_button(choices, "Maintain recognized", _rectify.bind("recognized"))
	_button(choices, "Maintain alternative", _rectify.bind("alternative"))


func _rectify(choice: String) -> void:
	if reconstruction_solved != [true, true] or rectification != "" or choice not in ["recognized", "alternative"]:
		return
	rectification = choice
	_show_room("The Cartório files the rectification. Read the completed case file for its aftermath.")


func _evidence_shelf() -> void:
	_clear(choices)
	message.text = "Evidence shelf: choose an item to inspect."
	for i in range(EVIDENCE.size()):
		_button(choices, EVIDENCE[i][0], _inspect_evidence.bind(i))


func _inspect_evidence(index: int) -> void:
	evidence_flags[index] = true
	document_panel.get_child(0).get_child(0).text = EVIDENCE[index][1]
	gameplay_panel.hide()
	document_panel.show()


func _interviews() -> void:
	_clear(choices)
	message.text = "Who would you like to interview?"
	for i in range(INTERVIEWS.size()):
		_button(choices, INTERVIEWS[i][0], _interview.bind(i))


func _interview(person: int) -> void:
	_clear(choices)
	var account: Array = INTERVIEWS[person]
	# The name and description act as a simple character placeholder.
	message.text = "[%s — %s]\nWhat would you like to ask?" % [account[0], account[1]]
	_button(choices, account[2], _statement.bind(person * 2))
	_button(choices, account[4], _statement.bind(person * 2 + 1))
	_button(choices, "Other people", _interviews)


func _statement(index: int) -> void:
	interview_flags[index] = true
	var account: Array = INTERVIEWS[index / 2]
	message.text = "[%s — %s]\n%s" % [account[0], account[1], account[3 if index % 2 == 0 else 5]]


func _aurora_evidence(index: int) -> void:
	var notes := [
		"AURORA — WALL AND CURRENT PLAN\n\nThe corridor wall is uninterrupted. The current plan shows no second emergency exit here.",
		"AURORA — OLD DOOR PHOTOGRAPHS\n\nOld photographs show a second emergency door in the corridor, where the present wall has no opening.",
		"AURORA — BUILDING RECORDS\n\nThe available building records contain no documented masonry work closing a door. A fragment suggests Eva Azevedo was Marina's sister, though Eva is absent from official records."
	]
	aurora_clues[index] = true
	document_panel.get_child(0).get_child(0).text = notes[index]
	gameplay_panel.hide()
	document_panel.show()


func _open_document() -> void:
	document_panel.get_child(0).get_child(0).text = "OBSERVATORY DELIVERY RECORD\n\nItem: Lamp oil, 2 tins\nRecipient: Observatory keeper\nDelivery address: 14 Harbour Road\nBilling address: 41 Harbour Road\n\nFiled by: M. Ellis"
	gameplay_panel.hide()
	document_panel.show()


func _close_document() -> void:
	document_panel.hide()
	gameplay_panel.show()


func _open_case() -> void:
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
		_show_room("The desk holds a notebook full of star charts.")
	else:
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
		_show_room("Lens selected. Use it on a hotspot." if selected_lens else "Lens put away.")
	else:
		_clear(choices)
		message.text = "Your inventory is empty."


func _transition(destination: String) -> void:
	room = destination
	selected_lens = false
	_show_room("You enter the lantern room." if room == "lantern" else "You arrive at Teatro Aurora. The corridor is quiet." if room == "aurora" else "You return to the observatory.")


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
