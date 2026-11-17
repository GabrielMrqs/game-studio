#!/bin/sh
set -eu

godot=${GODOT_BIN:-godot}
"$godot" --headless --editor --path game --import
"$godot" --headless --path game --quit-after 3
"$godot" --headless --path game --script res://tests/smoke.gd
