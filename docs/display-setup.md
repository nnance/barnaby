# Barnaby — Connecting the Round Panel

**2.1″ round IPS, 480×480, micro HDMI** (Amazon B0DZ2ZKP7B). Blank Pi to a face
on the counter. Two parts, in this order: get the panel lighting up on a
desk, then make the kiosk come up by itself at boot.

Do this on the bench, with the Pi out of the robot. The mode setting needs a
reboot, and the first thing you want to know is whether the panel takes the
mode at all — that is much easier to answer before anything is inside a shell.

---

## What's in the box, and what plugs into what

The product is **two boards joined by a short FPC ribbon**: the round panel
itself, and a small HDMI driver board. They arrive already connected, and you
should leave them that way — the FPC is fine-pitch, and reseating it is the
most likely way to break the thing on day one.

The driver board carries two connectors, and **both must be plugged in**:

| Connector | Goes to | Carries |
|---|---|---|
| **HDMI in** — mini (Type C) or micro (Type D), varies by unit | Pi's `HDMI0` (the port nearest the USB-C power jack) | Video only |
| **USB-C** (some units: micro-USB) | A Pi USB-A port, or a powered hub | Power only, ~0.3–0.5 A |

### Which HDMI cable

**The Pi end is always micro HDMI (Type D)** — that is what a Pi 5 has, and it
is not negotiable. The *panel* end varies: these driver boards ship with either
mini (Type C) or micro (Type D), and the listing photos are not reliable about
which. Look at the board before ordering a cable.

So the cable is **micro-to-mini** or **micro-to-micro**, and a plain
full-size-HDMI cable is no use at either end. If the board turns out to be
mini and you only have micro-to-micro, a micro-to-full-size cable plus a
full-size-to-mini adapter works electrically — HDMI Type A, C and D are the
same signals on different shells, with no active conversion anywhere. It is
just three connectors of stiffness you do not want in a gimbal, so treat it as
a bench workaround and buy the right single cable for the build.

This is the thing people get wrong: **HDMI does not power the panel.** HDMI's
own 5 V pin supplies about 50 mA, nowhere near enough to run a backlight. A
panel plugged in by HDMI alone stays completely black, with no backlight glow
and nothing in the log — identical to a dead panel, a bad cable, or a mode the
driver rejected. Plug the USB in first, confirm you can see the backlight lift
in a dark room, and only then start debugging video.

### Use HDMI0, not HDMI1

The Pi 5 has two micro HDMI ports. **HDMI0 is the one closest to the USB-C
power connector**, and it is `HDMI-A-1` in software. Everything below —
`video=HDMI-A-1:480x480@60`, the kiosk unit, the boot-console setting — names
that connector. Plug into the far port and the mode line silently applies to a
connector with nothing on it, so the panel gets the driver's default instead
and you spend an hour on a config file that was right all along.

Check which one the firmware sees:

```bash
for c in /sys/class/drm/card1-HDMI-A-*; do echo "$c: $(cat $c/status)"; done
```

Exactly one should read `connected`. If it's `card1-HDMI-A-2`, you're in the
wrong port — move the cable rather than changing the mode line, because the
kiosk and the console setting both assume HDMI-A-1.

### Power: from the Pi, or not

The panel's ~0.5 A is comfortably inside a Pi 5's USB budget **when it's on a
5 A supply** — which this one is; `usb_max_current_enable=1` is already set,
and the Pi is reporting `throttled=0x0`. On a 3 A supply the Pi caps total USB
at 600 mA shared across all ports, and the array alone is a meaningful part of
that. Symptom of getting this wrong is not a dead panel: it's the **ReSpeaker
array dropping off the bus**, because a marginal 5 V rail hits USB enumeration
before it dims a backlight. That failure already has a history here — see the
XVF3800 notes in `CLAUDE.md` — so if the array goes missing the day the panel
arrives, suspect the power budget before the array.

For the robot itself the panel should come off the same 5 V buck as everything
else, not off a Pi port. Bench bring-up on a Pi port is fine.

### The cable, for the robot

Whatever cable came in the box is for the bench. A moulded HDMI cable is too
thick and too stiff to survive ±175° of yaw through the gimbal — get a **flat
ribbon-style cable** in whichever micro-to-mini or micro-to-micro pairing your
board needs, and mount the **driver board inside the head**
so only power and the short panel FPC live above the joint. Check the
panel-to-board FPC length before you commit to a layout: if it's 100 mm, the
board has no choice about where it lives.

---

## Bench bring-up

### 1. Plug in, with the Pi powered off

Panel USB → Pi USB-A. Panel HDMI → Pi HDMI0 (micro at the Pi end). Then boot.

### 2. Set the mode

**480×480 is not a standard HDMI mode**, and most of these driver boards report
an EDID that either omits it or lies about it.

**This board needs no mode line — measured 2026-08-25**, though not for the
reason it first appears. Its **EDID is zero bytes** while the connector reads
`connected`, so it never reports timings at all; the `480x480` in `modes` is
the kernel's fallback, not the panel's request. That fallback happens to be
correct — verified by writing test patterns straight to `/dev/fb0`, which came
out clean and correctly proportioned.

So an empty EDID here is **not** a fault to chase. It looks like one, and it
cost a reboot and a wrong `framebuffer_depth` theory before a framebuffer test
settled it. Check yours the same way before touching timings:

```bash
cat /sys/class/drm/card1-HDMI-A-1/modes
```

If that prints `480x480`, skip to step 3. If it is empty or lists other modes,
set it explicitly.

Edit `/boot/firmware/cmdline.txt` — it is **one single line**, and everything
here gets appended to that same line, space-separated. A newline in this file
means the kernel silently ignores everything after it.

```bash
sudo nano /boot/firmware/cmdline.txt
```

Append:

```
video=HDMI-A-1:480x480@60
```

Then reboot. If the panel shows the boot console and then a login prompt,
squashed or centred but *present*, the mode took and you are done with this
step.

If it stays black, the driver board is refusing the mode. Force it, ignoring
the EDID entirely:

```
video=HDMI-A-1:480x480@60D
```

The trailing `D` means "digital, use this mode whatever the display claims".
That is the setting that usually wins on these boards.

### 3. Kill the boot console on that output

Once video works, stop Barnaby spending his first 30 seconds showing kernel
messages — the symptom is a wall of boot text ending in cloud-init lines like
`completed socket interaction for stage final`, which reads like an error and
is not one.

`cmdline.txt` is a ONE-LINE file and the kernel drops everything after the
first newline, so back it up before editing and check the line count after.
Change the existing `console=tty1` in place rather than appending a second
`console=` — two both apply and tty1 keeps the panel.

The flags, on that same single line:

```
console=tty3 quiet logo.nologo vt.global_cursor_default=0
```

Full line, for reference — yours will differ in `root=` and `PARTUUID`:

```
console=serial0,115200 console=tty3 root=PARTUUID=... rootfstype=ext4 fsck.repair=yes rootwait quiet logo.nologo vt.global_cursor_default=0 video=HDMI-A-1:480x480@60
```

Keep `console=serial0` — that is the serial console, and it is what you have
left to debug with if the display work goes wrong.

---

## Proving it is the panel, before blaming the renderer

When something is on screen but wrong — streaks, smears, wrong proportions —
find out whether the *display* is being driven correctly before touching any
renderer. Stop the kiosk and write straight to the framebuffer:

```bash
systemctl --user stop barnaby-kiosk
python3 -c '
import struct
w=h=480
def rgb565(r,g,b): return struct.pack("<H",((r>>3)<<11)|((g>>2)<<5)|(b>>3))
row = rgb565(255,0,0)*(w//2) + rgb565(0,0,255)*(w-w//2)   # left red, right blue
open("/dev/fb0","wb").write(row*h)
'
```

`/dev/fb0` is writable by the `video` group, so this needs no sudo. A clean
split down the middle means the panel, cable, mode and timings are all fine and
the fault is above them. That one test replaced two reboots' worth of guessing
about pixel formats and HDMI timings, both of which were wrong.

**Do not diagnose this from `/sys/class/graphics/fb0`.** That is the *text
console's* framebuffer — 16 bpp RGB565, stride 960 — and it is not what cog
renders into. Cog allocates its own AR24 (32-bit, pitch 1920) buffer, visible
in `/sys/kernel/debug/dri/1/framebuffer`. Reading the console's buffer and
concluding the depth is wrong is a trap this guide walked into.

## The kiosk

With video working, the face is three files and two user units.

```bash
# needs sudo, so run it yourself with a TTY; deploy-face.sh checks for both
ssh -t admin@barnaby.local 'sudo apt update && sudo apt install -y --no-install-recommends cog libgles2'
./deploy-face.sh --install
```

**Expect this to install ~60 packages, about 620 MB.** That is not a mistake and
it is not bloat you can trim much: `cog` is a browser engine, WPE WebKit alone
is 115 MB, and it genuinely needs a graphics stack (Mesa/GL), a media stack
(GStreamer and its codecs), text shaping (HarfBuzz) and input handling. Chromium
would cost more, plus a desktop.

What `--no-install-recommends` **does** buy you is that none of it is a desktop:
no X server, no Wayland compositor, no window manager, no display manager.
Verified on this Pi — 623 MB of disk, no new daemons, and RAM at idle unchanged.

`libgles2` is listed explicitly for a reason. It is a *recommends*, so
`--no-install-recommends` drops it, and without it cog starts, loads the page,
reports `Loaded successfully`, and **then** the renderer crashes in a loop on a
missing `libGLESv2.so.2`. The unit reads `active` throughout. It is 230 KB and
its one dependency is already present.

That builds the bundle here, rsyncs `dist/` to `~/face` on the Pi, installs
`cog`, and enables both units. After it, and after every subsequent code
change, plain `./deploy-face.sh` rebuilds and restarts.

Two units, deliberately:

- **`barnaby-face-server`** — `python3 -m http.server` on `127.0.0.1:8080`.
  A server rather than a `file://` URL because a `file://` page has an opaque
  origin, which makes the WebSocket to the orchestrator a cross-origin request
  from a null origin. It works today and is one browser update from not.
- **`barnaby-kiosk`** — `cog` (WPE WebKit) rendering straight to DRM/KMS. No X,
  no Wayland, no desktop, no window manager. Chromium would work and brings a
  desktop's worth of dependencies to an appliance.

The kiosk does **not** depend on `barnaby.service`. The face survives the
orchestrator restarting — it keeps its last state, keeps blinking, and
reconnects with backoff — so ordering it behind the orchestrator would only
mean a blank panel whenever the orchestrator is down, which is exactly when you
want to see a face.

It loads `http://127.0.0.1:8080/?dev=0`. The `?dev=0` strips the dev panel and
the cursor. It needs no `?ws=` override: the default derives the socket from
`location.hostname`, which is loopback, which is where the orchestrator's face
server is listening on `0.0.0.0:8711`.

### Checking it

```bash
systemctl --user status barnaby-kiosk
journalctl --user-unit barnaby-kiosk -f
```

From your laptop, drive the face by hand to prove the whole path — that the
panel shows what the orchestrator says, not just that it shows something:

```bash
ssh admin@barnaby.local
# each of these should land on the panel within a frame or two
```

---

## Symptom table

| Symptom | Likely cause |
|---|---|
| Completely black, no backlight | **USB power not connected.** HDMI alone cannot light it |
| Backlight on, black picture | Mode rejected. Try the `D` suffix — `480x480@60D` |
| `status: disconnected` in `/sys/class/drm` | Wrong port, bad cable, or panel unpowered — the driver board must be powered to talk EDID |
| Cable won't seat at the panel | Mini vs micro. The Pi end is always micro; the board end may be either |
| Mode line seems ignored | Plugged into HDMI1. It's `HDMI-A-2`; the mode line names `HDMI-A-1` |
| Boot logs on the face | `console=tty1` still on that line. Change it, don't append a second `console=` |
| Nothing after `cmdline.txt` edit | A newline crept in. It is one line; the kernel drops everything past the first |
| Panel fine, **array vanishes** | USB power budget. Check `vcgencmd get_throttled`, move the panel to external 5 V |
| `status=203/EXEC` looping in the kiosk log | `cog` is not installed. `deploy-face.sh` prints the install command; it needs sudo |
| Boot text ends in `completed socket interaction for stage final` | Normal cloud-init, not an error. It is just the console on tty1 — step 3 |
| Face blank but kiosk running | The static server is down, or `dist/` never landed. `curl -sI 127.0.0.1:8080/` |
| Face shows, never changes state | Kiosk is fine, the WebSocket isn't. Check `barnaby.service` and port 8711 |
| `cog` exits immediately, repeatedly | Panel unplugged or the mode is wrong. Fix video first; the unit gives up after 5 tries in a minute |
| `Unknown option --set-fullscreen` | Older docs. Not a cog 0.18 option; under `--platform=drm` it fills the display anyway |
| `Loaded successfully` then `Crash!: The renderer process crashed` | `libGLESv2.so.2` missing — `sudo apt install libgles2`. The page and server are fine; only compositing is broken |
| Panel flashes white before the face | `cog -b black`. The default background is white, which is loud on a round panel |
| **Streaks / smears, right colours, no shapes** | Cog fell back to its `modeset` software renderer. Needs `-O renderer=gles` — see below |
| `Renderer 'modeset' does not support rotation 0` | **Not noise.** It is the only log evidence of that fallback |
| EDID is 0 bytes but the panel works | Normal for this board. The kernel's 480x480 fallback is correct; do not chase it |

---

## Why `-O renderer=gles` is mandatory

The single least obvious thing about this setup, and the one that produced a
screen full of garbage while every log line looked healthy.

On a Pi 5 the display controller and the GPU are **separate DRM devices**:

```
/dev/dri/card1                  vc4  — display, no render node
/dev/dri/card0 + renderD128     v3d  — the GPU
```

Cog selects the device that has the display, which is `card1`. It then finds no
render node on it and quietly falls back to its `modeset` renderer, a software
path that on this hardware draws the page as smeared horizontal streaks —
roughly the right colours, no recognisable geometry.

Everything else keeps reporting success while this happens. The page loads, the
WebSocket connects, the orchestrator logs `face connected (1 client(s))`, and
the unit sits at `active` with `NRestarts=0`. The only symptom in the log is:

```
Cog-DRM-WARNING: Renderer 'modeset' does not support rotation 0 (0 degrees).
```

which reads like noise about an unsupported rotation and is in fact the whole
problem. `-O renderer=gles` forces the accelerated path; when it works, that
line disappears. GBM and EGL are already present, so nothing else is needed.

**`face connected` proves the data path, not the picture.** It says the browser
reached the orchestrator — nothing about whether anything legible is on the
glass. Only eyes on the panel confirm that.
