# Barnaby — Parts Audit and Purchase List

### v0.5 · flat-faced screen design

Supersedes the earlier parts audit and parts decisions documents. Reflects the
screen-face, truncated-sphere head on a rounded creature body.

**Headline:** you keep everything except the amp HAT. Two new purchases matter —
a **display** and the **wide camera**. Everything else is infrastructure.

---

## 1. What the Design Change Did to the Parts List

| | Ring-gimbal design (v0.3) | Flat-faced screen (v0.5) |
|---|---|---|
| Head DOF | Yaw ±175, pitch −25/+40, roll ±32 | Yaw ±175, **24° tilt cone** |
| Pitch drive | GT2 belt from a servo low in the body | **Direct** — servo at head centre |
| Servos used | 3 (one belt-driven) | 3, all direct-drive |
| Where emotion lives | Motion + LED band | **Screen**, with motion for attention |
| Face | Lens + light ring | 83 mm flat facet, LCD behind glass |
| WS2812 rings | Core (the face) | **Optional** — status light only |
| Co-processor | Nice to have | **Essential** — see §4 |
| New purchase | — | Display, ~$13 |

The tilt cone shrank because the head is supported by a column through an aperture in
its underside, and that aperture has to stay hidden below the collar. That trade is
only acceptable because the screen took over the expressive work.

---

## 2. Verdicts on What You Own

| Part | Verdict | Notes |
|---|---|---|
| ReSpeaker XVF3800 4-mic array | **Keep** | Still the best part you own. Lives in the **body**, not the head |
| Feetech STS3215 ×7 (7.4 V) | **Keep — use 3** | Yaw in body; pitch and roll **inside the head**. Four spares |
| Bus servo controller (FE-URT-1) | **Keep** | Mandatory for assigning unique bus IDs before assembly |
| MAX98357A I²S amp ×2 | **Keep** | Primary audio path. One spare |
| 5 W 8 Ω double-cavity speaker ×2 | **Keep** | Factory enclosure — no acoustic chamber to design |
| Gikfun 40 mm 4 Ω 3 W ×2 | **Keep as louder fallback** | 3.2 W vs 1.8 W, but needs a printed sealed chamber |
| Waveshare USB sound card | **Keep as escape hatch** | If I²S misbehaves |
| DIYmall 24-LED WS2812 rings ×2 | **Keep, demoted** | Face is now a screen. Use one as a body status glow, or shelve |
| Arducam IMX708 **75°** | **Replace** | §5 |
| Innomaker TAS5713 AMP HAT | **Retire** | Fights the M.2 HAT, needs a fragile overlay, 25 W into 5 W drivers |

---

## 3. The Display — Settled

**2.1″ round IPS, 480×480, micro HDMI control board.** Amazon B0DZ2ZKP7B.

This is the round-face option I originally priced at ~$38 and then talked you out of on
interface grounds. HDMI removes that objection: no SPI driver, no device-tree overlay,
no QSPI wrangling. The Pi sees a standard display and the face can be drawn with
pygame, SDL, or anything else. 480 px across 53 mm is ~230 ppi, so the eyes render with
genuinely smooth edges rather than visible stair-stepping.

**Consequences, all of which are now baked into the design:**

| | Effect |
|---|---|
| Active area | 53 mm circle inside the 83 mm facet — a 15 mm bezel band |
| Camera aperture | Now has *more* room. Sits at 37 mm from centre, clear of the 26.5 mm active radius |
| Face artwork | Sized to a 26.5 mm usable radius. Worst-case expression reaches 26.2 mm |
| Glass | Round dark window, ~66 mm. The unlit surround is black-on-black and invisible |
| Rendering | **Pi, not ESP32** — see §4 |

**Three build notes:**

- **Micro HDMI through the gimbal is the real risk.** The cable is thick and stiff and
  has to survive ±175° of yaw. Mount the **control board inside the head** so only power
  and the short panel FPC live up there, and source a **flat ribbon-style micro HDMI
  cable** rather than a moulded one. Check the panel-to-board FPC length before
  assembly — if it's 100 mm, the board has no choice but to be in the head.
- **Kill the boot console on that output.** An HDMI display shows kernel messages during
  startup. Disable console on that framebuffer and set a splash, or Barnaby spends his
  first 30 seconds displaying boot logs.
- **480×480 is a non-standard mode.** Expect to add an explicit
  `video=HDMI-A-1:480x480@60` or a custom CVT line in `config.txt`.

## 4. What the ESP32-S3 Does Now

I previously argued the ESP32 should render the face, because animating over SPI is CPU
work and would stutter whenever Whisper pegged the Pi. **HDMI inverts that argument.**
Over SPI every frame costs CPU: pack pixels, push bytes. Over HDMI the panel refreshes
from a GPU-composited surface independently of what the CPU is doing — so the Pi is now
the *better* place to render the face, not the worse one.

The ESP32-S3 still earns its place, for three things the Pi genuinely handles badly:

- **Servo interpolation** at 100 Hz with S-curves and the 24° tilt-cone clamp, so motion
  stays smooth under inference load.
- **The WS2812 body glow.** `rpi_ws281x` doesn't work on the Pi 5 since the RP1
  southbridge changed the DMA/PWM path. This alone justifies the part.
- **Touch and IMU** on its own I²C bus, with sub-20 ms reflex responses that never
  touch the Pi.

**PSRAM is no longer needed** — there's no framebuffer to hold. A plain
**ESP32-S3-DevKitC-1** at ~$8 is enough; the N16R8 is fine if you already have one.

## 5. Camera — Still Buy the Wide, Plus One Aperture Detail

Unchanged reasoning: at 2 m your 75° module sees 2.4 m of room, the Wide sees 4.9 m.
The narrow lens can't do passive presence detection — noticing someone walk in
silently, which is what the morning brief and wake-on-approach depend on.

**Camera Module 3 Wide, $35.** Keep the 75° module for a future satellite.

**New detail that matters:** the camera now sits behind a small aperture in the bezel,
and a 120° lens behind a straight 6 mm hole **will vignette**. The aperture must be a
**countersink** — roughly 6 mm at the outer surface flaring to 12 mm inside over the
plate thickness — so the lens's full cone clears. Easy in CAD, invisible from outside,
and impossible to fix after printing.

---

## 6. Purchase List

**Essential**

| Item | Why | ~USD |
|---|---|---|
| Raspberry Pi 5, 8 GB + active cooler *(skip if owned)* | No substitute | 85 |
| M.2 HAT+ and 256 GB NVMe SSD | SD cards die on 24/7 appliances | 45 |
| **Camera Module 3 Wide** | Passive presence detection | 35 |
| 300 mm 22→15-pin FPC cable | Included one won't reach through the yaw joint | 8 |
| **Flat ribbon HDMI cable** | Moulded cable is too stiff for the gimbal. Pi end is micro (Type D); check whether the panel board is mini (C) or micro (D) before ordering | 10 |
| **2.1″ round IPS 480×480, micro HDMI** (B0DZ2ZKP7B) | The face | 30 |
| **ESP32-S3-DevKitC-1** | Motion, body glow, touch, IMU | 8 |
| Waveshare Bus Servo Adapter (A) | Half-duplex TTL for the ESP32 | 8 |
| 12 V 5 A brick + 5.1 V 5 A buck + **7.4 V 4 A buck** | **Note the 7.4 V servo rail** | 30 |
| 6807-2RS bearing (35×47×7) | Yaw column support | 9 |
| 2 × MR85-ZZ bearings | Pitch and roll idlers opposite each servo | 5 |
| MPR121 capacitive touch + copper tape | Head pats | 8 |
| MPU6050 IMU (or BNO085 at $20) | Tap and pick-up detection | 6 |
| DPDT toggle switch | Hardware mic mute — cuts USB power and data | 4 |
| M3/M2 heat-set inserts, screws, TPU feet | | 15 |
| Matte PLA + PETG + TPU (~450 g) | | 15 |
| **Subtotal** | | **~$323** (~$238 with a Pi) |

**Conditional**

| Item | Trigger | ~USD |
|---|---|---|
| 6-circuit capsule slip ring | You want continuous yaw instead of ±175° | 15 |
| Gimbal BLDC + AS5600 + SimpleFOC | Tracking jitter bothers you after living with it | ~150 |

Nothing else is conditional. The louder-audio fallback uses parts you already own.

**House side — Phase 0, independent of the robot**

| Item | ~USD |
|---|---|
| Home Assistant Green, or an N100 mini PC running HA OS | 100–250 |
| Home Assistant Connect ZBT-1 (Zigbee + Thread/Matter) | 40 |
| Small UPS for the HA host | 60 |

---

## 7. Settled vs. Still Open

**Settled by arithmetic, safe to build around:**

- Rotation about the head centre is collision-free with the collar at every angle — a
  sphere maps onto itself, so clearance is constant.
- The 24° tilt cone, from `2 × tilt + β ≤ 65°` with a 24 mm support column.
- Both pitch and roll servos fit inside the 124 mm head with their corners ~45 mm from
  centre against a ~58 mm interior. Balanced about the pivot, so holding torque is near
  zero and they can be de-energised at idle.
- Yaw is mechanically unconstrained; ±175° is a cable limit, not a geometry limit.
- Face artwork fits the 53 mm active circle at every expression — worst case 26.2 mm
  against a 26.5 mm radius.
- Camera aperture clears the active area with 10 mm to spare.

**Genuinely for CAD:**

- Aperture shape. A circular hole is symmetric; an **offset oval** would buy more
  downward pitch than upward, which is probably the better allocation.
- Column cross-section and how it transitions into the servo yoke inside the head.
- Wire routing down the column. **The micro HDMI cable is now the hardest item** and
  should sit as close to the rotation axes as possible.
- Print splits: the head is a bowl with an open bottom plus a separate face plate,
  which is convenient for both printing and service.
- Whether the collar gap needs a TPU wiper for kitchen grease, or stays open for
  positive-pressure venting.

---

## 8. Confirm Before Ordering

**Do you have a Raspberry Pi 5?** It's still the one part with no substitute, and it's
the only thing standing between you and starting Phase 1 with parts in hand.
