#!/usr/bin/env bash
# Move the boot console off the panel, so Barnaby does not spend his first 30
# seconds showing kernel messages and cloud-init lines.
#
#   ./quiet-console.sh && sudo reboot
#
# cmdline.txt is ONE line and the kernel drops everything after the first
# newline, so this edits in place, backs up first, and checks the line count
# afterwards.
#
# This deliberately does NOT set framebuffer_depth. An earlier version did,
# on the theory that the panel was coming up RGB565 and cog was writing 32-bit
# pixels into it. That was wrong twice over: framebuffer_depth is a legacy
# firmware setting the KMS driver ignores outright, and the 16 bpp reading came
# from the *text console's* framebuffer rather than cog's, which was AR24 and
# correct all along. The real fault was cog falling back to its software
# renderer — fixed with `-O renderer=gles` in barnaby-kiosk.service.
set -euo pipefail

CMD=/boot/firmware/cmdline.txt
STAMP=$(date +%Y%m%d-%H%M%S)

# --- console off the panel ------------------------------------------------
if grep -q "console=tty3" "$CMD"; then
  echo "cmdline.txt: console already moved"
else
  sudo cp "$CMD" "$CMD.bak-$STAMP"
  echo "backup: $CMD.bak-$STAMP"
  # console=tty1 -> tty3, NOT an extra console= : two both apply and tty1 wins
  # the panel back.
  sudo sed -i 's/console=tty1/console=tty3/' "$CMD"
  sudo sed -i 's/$/ quiet logo.nologo vt.global_cursor_default=0/' "$CMD"
  echo "cmdline.txt: console moved to tty3"
fi

echo
echo "--- cmdline.txt ---"
cat "$CMD"
lines=$(grep -c "" "$CMD")
echo "--- line count: $lines (must be 1; more than 1 means restore the backup) ---"
[ "$lines" -le 1 ] || { echo "!! cmdline.txt has $lines lines — restore $CMD.bak-$STAMP before rebooting" >&2; exit 1; }
echo
echo "Now: sudo reboot"
