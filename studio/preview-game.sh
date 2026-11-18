#!/bin/sh
set -eu

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ] || { [ "$#" -eq 2 ] && [ "$2" != --require-menu ]; }; then
  echo 'Usage: sh studio/preview-game.sh /absolute/new-preview.png [--require-menu]' >&2
  exit 1
fi
case "$1" in /*.png) ;; *) echo 'Use an absolute .png path.' >&2; exit 1 ;; esac
if [ -e "$1" ] || [ -L "$1" ]; then
  echo 'Preview path already exists; refusing to overwrite it.' >&2
  exit 1
fi
godot=${GODOT_BIN:-godot}
here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
"$godot" --display-driver x11 --audio-driver Dummy --rendering-method gl_compatibility --resolution 960x640 --path game --script "$here/preview.gd" -- "$@"
