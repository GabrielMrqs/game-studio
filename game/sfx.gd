extends Node
## Original synthesized foley (no third-party samples). Render once into short
## PCM streams in memory; no audio files, generators or disk reads on playback.

signal cue_started(cue: String)

const RATE := 22050
const DEFAULT_LEVEL := 0.65
const HOVER_GAP := 115
const ACTION_QUIET := 160
const VOICE_GAP := 36
const DURATIONS := {
	"hover": 0.045, "target": 0.057, "confirm": 0.085, "back": 0.096,
	"open": 0.145, "close": 0.108, "door": 0.235, "clue": 0.218,
	"result": 0.107,
}

var settings_path := "user://cartorio_audio.cfg"
var level := DEFAULT_LEVEL
var muted := false
var clock: Callable = Time.get_ticks_msec
var _clips: Dictionary = {}
var _voices: Array[AudioStreamPlayer] = []
var _active := -1
var _active_is_hover := false
var _fade: Tween
var _save_delay: Timer
var _mix_dirty := false
var _hover_ready := 0
var _action_ready := 0
var _voice_ready := 0
var _hovered := 0
var _focused := 0


func _ready() -> void:
	process_mode = Node.PROCESS_MODE_ALWAYS
	load_settings()
	for cue in DURATIONS:
		_clips[cue] = _render(cue, DURATIONS[cue])
	for i in range(2):
		var voice := AudioStreamPlayer.new()
		add_child(voice)
		_voices.append(voice)
	_save_delay = Timer.new()
	_save_delay.one_shot = true
	_save_delay.wait_time = 0.25
	_save_delay.timeout.connect(save_settings)
	add_child(_save_delay)


func _exit_tree() -> void:
	if _mix_dirty:
		save_settings()


func load_settings() -> void:
	var config := ConfigFile.new()
	if config.load(settings_path) == OK:
		var saved: Variant = config.get_value("sfx", "level", DEFAULT_LEVEL)
		if (saved is float or saved is int) and is_finite(float(saved)):
			level = clampf(float(saved), 0.0, 1.0)
		muted = config.get_value("sfx", "muted", false) == true
	_apply_mix()


func save_settings() -> void:
	_mix_dirty = false
	if _save_delay and _save_delay.is_inside_tree():
		_save_delay.stop()
	var config := ConfigFile.new()
	config.set_value("sfx", "level", level)
	config.set_value("sfx", "muted", muted)
	config.save(settings_path)


func set_mix(new_level: float, new_muted: bool) -> void:
	level = clampf(new_level, 0.0, 1.0)
	muted = new_muted
	_apply_mix()
	_mix_dirty = true
	_save_delay.start()


func _gain() -> float:
	# -6 dB maximum before the individual clip's peak trim.
	return linear_to_db(maxf(level * 0.5, 0.0001))


func _apply_mix() -> void:
	if muted or level == 0.0:
		if _fade and _fade.is_valid():
			_fade.kill()
		for voice in _voices:
			voice.stop()
	elif _active >= 0:
		_voices[_active].volume_db = _gain()


func wire_hover(button: BaseButton, cue: String) -> void:
	button.mouse_entered.connect(_enter.bind(button, cue, false))
	button.focus_entered.connect(_enter.bind(button, cue, true))
	var id := button.get_instance_id()
	button.mouse_exited.connect(_leave.bind(id, false))
	button.focus_exited.connect(_leave.bind(id, true))
	button.visibility_changed.connect(_visibility_changed.bind(button, id))
	# Godot treats callables to the same method as the same connection,
	# even when their bound arguments differ.
	button.tree_exiting.connect(_clear_target.bind(id))


func _visibility_changed(button: BaseButton, id: int) -> void:
	if not button.is_visible_in_tree():
		_clear_target(id)


func _clear_target(id: int) -> void:
	_leave(id, false)
	_leave(id, true)


func _leave(id: int, focus: bool) -> void:
	if focus and _focused == id:
		_focused = 0
	elif not focus and _hovered == id:
		_hovered = 0


func _enter(button: BaseButton, cue: String, focus: bool) -> void:
	if button.disabled or not button.is_visible_in_tree() or not button.can_process():
		return
	var id := button.get_instance_id()
	if focus:
		if _focused == id:
			return
		_focused = id
		# A pointer click commonly gives focus to the already hovered button.
		if _hovered == id or Input.is_mouse_button_pressed(MOUSE_BUTTON_LEFT):
			return
	else:
		if _hovered == id:
			return
		_hovered = id
	var now: int = clock.call()
	if now < _hover_ready:
		return
	if _play(cue, now, true):
		_hover_ready = now + HOVER_GAP


func action(cue: String) -> void:
	var now: int = clock.call()
	_hover_ready = maxi(_hover_ready, now + ACTION_QUIET)
	if now >= _action_ready and _play(cue, now, false):
		_action_ready = now + VOICE_GAP


func _play(cue: String, now: int, hover: bool) -> bool:
	if muted or level == 0.0 or not _clips.has(cue):
		return false
	# Confirm can interrupt a hover immediately. Short crossfade, two fixed
	# voices, and a burst gate: skipped events never queue for later.
	if now < _voice_ready and (hover or not _active_is_hover):
		return false
	var previous := _active
	_active = 0 if previous != 0 else 1
	_active_is_hover = hover
	_voice_ready = now + VOICE_GAP
	if _fade and _fade.is_valid():
		_fade.kill()
	var voice := _voices[_active]
	voice.stop()
	if previous >= 0 and _voices[previous].playing:
		var tail := _voices[previous]
		_fade = create_tween()
		_fade.tween_property(tail, "volume_db", -55.0, 0.022)
		_fade.tween_callback(tail.stop)
	voice.stream = _clips[cue]
	voice.volume_db = _gain()
	voice.play()
	cue_started.emit(cue)
	return true


func _tap(t: float, frequency: float, decay: float) -> float:
	if t < 0.0:
		return 0.0
	return sin(TAU * frequency * t) * exp(-t * decay) * minf(1.0, t * 850.0)


func _rustle(t: float, length: float, noise: float) -> float:
	if t <= 0.0 or t >= length:
		return 0.0
	return noise * pow(sin(PI * t / length), 2.0) * (0.7 + 0.3 * sin(TAU * 73.0 * t))


func _render(cue: String, duration: float) -> AudioStreamWAV:
	var random := RandomNumberGenerator.new()
	random.seed = 1741
	var count := int(duration * RATE)
	var samples := PackedFloat32Array()
	samples.resize(count)
	var peak := 0.0
	var low := 0.0
	for i in range(count):
		var t := float(i) / RATE
		var raw := random.randf_range(-1.0, 1.0)
		low = lerpf(low, raw, 0.24)
		var grain := (raw - low) * 0.36 + low
		var sample := 0.0
		match cue:
			"hover":
				sample = _tap(t, 620.0, 160.0) * 0.48 + _rustle(t, 0.030, grain)
			"target":
				sample = _tap(t, 435.0, 115.0) * 0.7 + _rustle(t, 0.050, grain) * 0.65
			"confirm":
				sample = _tap(t, 260.0, 94.0) + _tap(t - 0.019, 710.0, 195.0) * 0.48 + _rustle(t, 0.027, grain) * 0.5
			"back":
				sample = _tap(t, 365.0, 110.0) * 0.54 + _tap(t - 0.024, 223.0, 105.0) + _rustle(t, 0.051, grain) * 0.42
			"open":
				sample = _rustle(t, 0.125, grain) + _rustle(t - 0.033, 0.09, raw) * 0.35 + _tap(t - 0.081, 295.0, 95.0) * 0.42
			"close":
				sample = _rustle(t, 0.077, grain) * 0.68 + _tap(t - 0.045, 198.0, 84.0) * 0.84
			"door":
				sample = _tap(t, 484.0, 101.0) * 0.52 + _rustle(t - 0.020, 0.138, low) * 0.8 + _tap(t - 0.105, 132.0, 43.0) + _tap(t - 0.121, 287.0, 73.0) * 0.44
			"clue":
				sample = _rustle(t, 0.118, grain) * 0.71 + _tap(t - 0.019, 310.0, 95.0) * 0.81 + _tap(t - 0.061, 796.0, 28.0) * 0.35 + _tap(t - 0.077, 1191.0, 34.0) * 0.22
			"result":
				sample = _tap(t, 195.0, 80.0) + _tap(t - 0.012, 391.0, 91.0) * 0.35 + _rustle(t, 0.051, grain) * 0.68
		# Fade to zero before the end so short clips don't pop.
		sample *= minf(1.0, float(count - 1 - i) / (RATE * 0.009))
		samples[i] = sample
		peak = maxf(peak, absf(sample))
	var trim: float = {"hover": 0.14, "target": 0.15, "back": 0.23, "close": 0.27,
		"confirm": 0.29, "open": 0.32, "door": 0.37, "clue": 0.37, "result": 0.27}[cue]
	var pcm := PackedByteArray()
	pcm.resize(count * 2)
	for i in range(count):
		pcm.encode_s16(i * 2, int(samples[i] * (32767.0 * trim / maxf(peak, 0.0001))))
	var clip := AudioStreamWAV.new()
	clip.format = AudioStreamWAV.FORMAT_16_BITS
	clip.mix_rate = RATE
	clip.data = pcm
	return clip
