#!/usr/bin/env bash
# Push the orchestrator to the Pi and restart it.
#
# The point of this script is that there is exactly one way to deploy, so a
# human and an agent cannot end up doing it differently — and so nobody has to
# remember that the service is a *user* unit (`systemctl --user`, no sudo).
#
#   ./deploy.sh              rsync, restart, show status
#   ./deploy.sh --no-restart just rsync
#   ./deploy.sh --logs       rsync, restart, then follow the log
#
# First time on a fresh Pi, install the unit:
#   ./deploy.sh --install
set -euo pipefail

HOST="${BARNABY_HOST:-admin@barnaby.local}"
REMOTE="${BARNABY_PATH:-~/barnaby}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

restart=1
logs=0
install=0
for a in "$@"; do
  case "$a" in
    --no-restart) restart=0 ;;
    --logs)       logs=1 ;;
    --install)    install=1 ;;
    -h|--help)    sed -n '2,14p' "$0"; exit 0 ;;
    *) echo "unknown option: $a" >&2; exit 2 ;;
  esac
done

# --delete keeps the Pi from accumulating files deleted here. The venv and
# barnaby.env are excluded because they live only on the Pi.
#
# config.yaml IS pushed, deliberately: it is checked in, and this session's
# real changes to it (the array as input_device, the follow-up window) live in
# git. The cost is that tuning done by editing the Pi's copy directly gets
# overwritten on the next deploy — so tune in the repo, not over ssh. If that
# ever stops being true, exclude it here and the Pi's copy becomes canonical.
echo "==> rsync $HERE/orchestrator/ -> $HOST:$REMOTE"
rsync -a --delete \
  --exclude '__pycache__' \
  --exclude '*.egg-info' \
  --exclude '.venv' \
  --exclude 'barnaby.env' \
  "$HERE/orchestrator/" "$HOST:$REMOTE/"

if [ "$install" = 1 ]; then
  echo "==> installing the user unit"
  # enable-linger is what makes it start at boot rather than at login.
  ssh "$HOST" "mkdir -p ~/.config/systemd/user \
    && cp $REMOTE/barnaby.service ~/.config/systemd/user/ \
    && systemctl --user daemon-reload \
    && systemctl --user enable barnaby \
    && loginctl enable-linger \$USER \
    && echo 'installed; lingering enabled'"
fi

if [ "$restart" = 1 ]; then
  echo "==> restart"
  ssh "$HOST" "systemctl --user restart barnaby"
  sleep 2
  # `is-active` is the honest check. `restart` returns 0 for a unit that
  # started and immediately died, so without this a broken deploy looks fine.
  if ! ssh "$HOST" "systemctl --user is-active --quiet barnaby"; then
    echo "!! barnaby is not running — last 30 log lines:" >&2
    ssh "$HOST" "journalctl --user -u barnaby -n 30 --no-pager" >&2
    exit 1
  fi
  ssh "$HOST" "systemctl --user status barnaby --no-pager -n 5" || true
fi

[ "$logs" = 1 ] && exec ssh "$HOST" "journalctl --user -u barnaby -f"
echo "==> done"
