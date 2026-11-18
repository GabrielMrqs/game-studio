#!/bin/sh
set -eu

if [ "${1-}" != --inside ]; then
  [ "$#" -eq 4 ]
  here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
  # Debian/Ubuntu's convert symlink goes through /etc/alternatives, outside these mounts.
  converter=$(readlink -e /usr/bin/convert)
  exec bwrap --unshare-all --die-with-parent --new-session \
    --ro-bind /usr /usr --ro-bind /lib /lib --ro-bind-try /lib64 /lib64 \
    --symlink usr/bin /bin --proc /proc --dev /dev --tmpfs /tmp --ro-bind-try /etc/fonts /etc/fonts \
    --clearenv --setenv PATH /opt/bin:/usr/bin:/bin --setenv HOME /tmp \
    --ro-bind "$1" /opt/bin/Xvfb --ro-bind "$2" /opt/bin/godot \
    --ro-bind "$converter" /opt/bin/convert \
    --ro-bind "$3" /work/game --bind "$4" /evidence \
    --ro-bind "$here/preview.gd" /opt/preview.gd \
    --ro-bind "$here/xvfb-preview.sh" /opt/xvfb-preview.sh \
    /bin/sh /opt/xvfb-preview.sh --inside
fi

umask 077
mkdir -m 1777 /tmp/.X11-unix
mkdir /tmp/framebuffer
isolated() {
  exec bwrap --unshare-all --unshare-user --disable-userns --die-with-parent --new-session \
    --ro-bind /usr /usr --ro-bind /lib /lib --ro-bind-try /lib64 /lib64 \
    --symlink usr/bin /bin --proc /proc --dev /dev --tmpfs /tmp \
    "$@"
}
# Xvfb can write its backing file, but only the capture process can write /evidence.
isolated --bind /tmp/.X11-unix /tmp/.X11-unix --bind /tmp/framebuffer /tmp/framebuffer \
  --ro-bind /opt/bin/Xvfb /opt/bin/Xvfb \
  Xvfb -displayfd 3 -screen 0 960x640x24 -nolisten tcp -ac -fbdir /tmp/framebuffer 3>/tmp/display &
server=$!
trap 'kill "$server" 2>/dev/null || :; wait "$server" || :' EXIT
for attempt in $(seq 1 50); do
  [ ! -s /tmp/display ] || break
  kill -0 "$server" || break
  sleep 0.1
done
if [ ! -s /tmp/display ]; then
  echo 'Xvfb failed to start' >&2
  exit 1
fi
mkfifo /tmp/checkpoints /tmp/ack

# The candidate sees the X socket and two pipes, never the framebuffer file or evidence mount.
isolated --ro-bind /tmp/.X11-unix /tmp/.X11-unix \
  --dir /home/agent --clearenv --setenv HOME /home/agent \
  --setenv PATH /opt/bin:/usr/bin:/bin --setenv DISPLAY ":$(cat /tmp/display)" \
  --setenv LIBGL_ALWAYS_SOFTWARE 1 --ro-bind-try /etc/fonts /etc/fonts \
  --ro-bind /opt/bin/godot /opt/bin/godot --ro-bind /opt/preview.gd /opt/preview.gd \
  --ro-bind /work/game /work/game --chdir /work \
  godot --display-driver x11 --audio-driver Dummy --rendering-method gl_compatibility \
  --position 0,0 --resolution 960x640 --fullscreen --path game \
  --script /opt/preview.gd -- --display-capture --require-menu \
  >/tmp/checkpoints </tmp/ack &
game=$!

next=main-menu
while IFS= read -r line; do
  case "$line" in
    'DISPLAY FRAME main-menu'|'DISPLAY FRAME gameplay')
      frame=${line#DISPLAY FRAME }
      [ "$frame" = "$next" ] || exit 1
      path=/evidence/$frame.png
      [ ! -e "$path" ] && [ ! -L "$path" ] || exit 1
      convert xwd:/tmp/framebuffer/Xvfb_screen0 "PNG24:$path"
      printf 'Captured Xvfb framebuffer: %s\n' "$frame"
      printf 'captured\n' >&3
      if [ "$frame" = main-menu ]; then next=gameplay; else next=done; fi
      ;;
    *) printf '%s\n' "$line" ;;
  esac
done </tmp/checkpoints 3>/tmp/ack
wait "$game"
[ "$next" = done ]
