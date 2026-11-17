#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  echo 'Usage: sh studio/preview-game.sh /absolute/new-preview.png' >&2
  exit 1
fi
case "$1" in /*.png) ;; *) echo 'Use an absolute .png path.' >&2; exit 1 ;; esac
if [ -e "$1" ] || [ -L "$1" ]; then
  echo 'Preview path already exists; refusing to overwrite it.' >&2
  exit 1
fi
godot=${GODOT_BIN:-godot}
"$godot" --audio-driver Dummy --rendering-method gl_compatibility --resolution 960x640 --path game --script res://tests/preview.gd -- "$1"
