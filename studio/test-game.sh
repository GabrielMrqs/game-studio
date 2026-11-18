#!/bin/sh
set -eu

godot=${GODOT_BIN:-godot}
case "${1-}" in
  '') "$godot" --headless --editor --path game --import ;;
  --import-only) "$godot" --headless --editor --path game --import; exit ;;
  --runtime-only) ;;
  *) exit 1 ;;
esac
"$godot" --headless --path game --quit-after 3
"$godot" --headless --path game --script res://tests/smoke.gd
