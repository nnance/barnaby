#!/usr/bin/env bash
# Build the face and push it to the Pi's kiosk.
#
# The sibling of ./deploy.sh, same conventions and for the same reason: one way
# to deploy, so a human and an agent cannot end up doing it differently. Both
# kiosk units are *user* units — `systemctl --user`, never sudo.
#
#   ./deploy-face.sh              build, rsync, restart the kiosk
#   ./deploy-face.sh --no-restart build and rsync only
#   ./deploy-face.sh --logs       ... then follow the kiosk log
#
# First time on a fresh Pi, install the units and the browser:
#   ./deploy-face.sh --install
#
# --install does NOT set the video mode. 480x480 is a non-standard mode and
# lives in /boot/firmware/cmdline.txt, which needs sudo and a reboot — see
# face/README.md. Do that once, by hand, before the panel will show anything.
set -euo pipefail

HOST="${BARNABY_HOST:-admin@barnaby.local}"
REMOTE="${BARNABY_FACE_PATH:-~/face}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

restart=1
logs=0
install=0
for a in "$@"; do
  case "$a" in
    --no-restart) restart=0 ;;
    --logs)       logs=1 ;;
    --install)    install=1 ;;
    -h|--help)    sed -n '2,18p' "$0"; exit 0 ;;
    *) echo "unknown option: $a" >&2; exit 2 ;;
  esac
done

# Build here, ship dist/. The Pi never runs pnpm, tsc or vite — none of that
# belongs on an appliance, and `build` runs check-fit, so a layout change that
# clips off the round panel fails on this machine rather than silently
# deploying geometry the display cannot show.
echo "==> build"
( cd "$HERE/face" && pnpm build )

echo "==> rsync $HERE/face/dist/ -> $HOST:$REMOTE"
ssh "$HOST" "mkdir -p $REMOTE"
rsync -a --delete "$HERE/face/dist/" "$HOST:$REMOTE/"

if [ "$install" = 1 ]; then
  # `admin` needs a password for sudo, so this cannot be done unattended — the
  # same reason the units are user units in the first place. Check rather than
  # firing off an ssh that hangs on an invisible password prompt.
  # libgles2 is checked separately: --no-install-recommends leaves it out, and
  # without it cog starts, loads the page, and *then* the renderer crashes in a
  # loop on a missing libGLESv2.so.2. The unit looks like it is running.
  if ssh "$HOST" "command -v cog >/dev/null" && ssh "$HOST" "ldconfig -p | grep -q libGLESv2.so.2"; then
    echo "==> cog and the GLES runtime are installed"
  else
    echo "!! cog is not installed, and installing it needs sudo on the Pi." >&2
    echo "   Run this by hand, then re-run --install:" >&2
    echo "     ssh -t $HOST 'sudo apt update && sudo apt install -y --no-install-recommends cog libgles2'" >&2
    exit 1
  fi

  echo "==> installing the user units"
  rsync -a "$HERE/face/barnaby-face-server.service" "$HERE/face/barnaby-kiosk.service" "$HOST:$REMOTE/"
  # enable-linger is what makes these start at boot rather than at login. The
  # orchestrator's install already does this; repeating it is harmless and
  # means either script can be the first one run on a fresh Pi.
  ssh "$HOST" "mkdir -p ~/.config/systemd/user \
    && cp $REMOTE/barnaby-face-server.service $REMOTE/barnaby-kiosk.service ~/.config/systemd/user/ \
    && systemctl --user daemon-reload \
    && systemctl --user enable barnaby-face-server barnaby-kiosk \
    && loginctl enable-linger \$USER \
    && echo 'installed; lingering enabled'"
fi

if [ "$restart" = 1 ]; then
  echo "==> restart"
  ssh "$HOST" "systemctl --user restart barnaby-face-server barnaby-kiosk"
  sleep 2
  # `is-active` is the honest check — `restart` returns 0 for a unit that
  # started and immediately died. The kiosk dying is the expected failure when
  # the panel is unplugged or the mode is wrong, so check it by name.
  for unit in barnaby-face-server barnaby-kiosk; do
    if ! ssh "$HOST" "systemctl --user is-active --quiet $unit"; then
      echo "!! $unit is not running — last 30 log lines:" >&2
      ssh "$HOST" "journalctl --user-unit $unit -n 30 --no-pager" >&2
      exit 1
    fi
  done
  ssh "$HOST" "systemctl --user status barnaby-kiosk --no-pager -n 5" || true
fi

[ "$logs" = 1 ] && exec ssh "$HOST" "journalctl --user-unit barnaby-kiosk -f"
echo "==> done"
