/**
 * Barnaby's expression table.
 *
 * GEOMETRY IS DEFINED IN MILLIMETRES, not pixels. The panel is a 2.1" round
 * 480x480 IPS with a 53 mm active diameter, so the usable radius is 26.5 mm.
 * Every layout number below was verified against that circle — the worst case
 * (curious, raised brow, full gaze drift) reaches 26.2 mm. Keep it that way:
 * if you edit these, re-run `npm run check:fit`.
 */

export const ACTIVE_RADIUS_MM = 26.5;
export const PANEL_PX = 480;
/** Millimetres to pixels. 240 px of radius across 26.5 mm. */
export const MM = PANEL_PX / 2 / ACTIVE_RADIUS_MM;

export type EyeShape = 'normal' | 'wide' | 'tall' | 'narrow' | 'slit' | 'arc' | 'closed';

export type ExpressionName =
  | 'neutral' | 'happy' | 'curious' | 'surprise' | 'listening' | 'sleepy';

export type FaultName = 'offline' | 'haDown' | 'muted';

export type StateName = ExpressionName | FaultName | 'boot';

/** Rounded-rect eye, in mm. */
interface RectEye { kind: 'rect'; w: number; h: number; r: number }
/** Annulus sector — the "happy" upward arc. */
interface ArcEye { kind: 'arc'; inner: number; outer: number; from: number; to: number; dy: number }

export type EyeGeom = RectEye | ArcEye;

export const EYES: Record<EyeShape, EyeGeom> = {
  normal: { kind: 'rect', w: 14, h: 18, r: 6 },
  wide: { kind: 'rect', w: 16.4, h: 21, r: 7 },
  tall: { kind: 'rect', w: 13.4, h: 19.5, r: 6.3 },
  narrow: { kind: 'rect', w: 13.4, h: 15, r: 5.6 },
  slit: { kind: 'rect', w: 14, h: 6, r: 3 },
  closed: { kind: 'rect', w: 14, h: 2.2, r: 1.1 },
  arc: { kind: 'arc', inner: 6.7, outer: 11.3, from: 28, to: 152, dy: -2.2 },
};

export interface FaceState {
  shape: EyeShape;
  /** Vertical offset of both eyes, mm. */
  eyeY: number;
  /** Brow height above eye centre, mm. */
  browY: number;
  /** Brow tilt, degrees. Positive = inner end raised. */
  browTilt: number;
  /** Asymmetry, mm. Raises the left brow only — reads as quizzical. */
  browAsym: number;
  /** Idle gaze-drift multiplier. 0 freezes the eyes, which reads as alarm. */
  gaze: number;
  /** Body glow. SINGLE SOURCE OF TRUTH — the orchestrator forwards this to the
   *  ESP32 so the LED ring and the face never disagree. */
  glow: { hex: string; level: number; pulse: boolean };
  /** Blink when idle. Off for sleeping and fault states. */
  blinks: boolean;
}

const NO_GLOW = { hex: '#35506A', level: 0, pulse: false };

export const STATES: Record<StateName, FaceState> = {
  boot: {
    shape: 'closed', eyeY: 0, browY: 12.5, browTilt: 0, browAsym: 0, gaze: 0,
    glow: { hex: '#F0D8B0', level: 0.2, pulse: true }, blinks: false,
  },
  neutral: {
    shape: 'normal', eyeY: 0, browY: 12.5, browTilt: 5, browAsym: 0, gaze: 1,
    glow: { hex: '#F0D8B0', level: 0.62, pulse: false }, blinks: true,
  },
  happy: {
    shape: 'arc', eyeY: 1.5, browY: 13, browTilt: 13, browAsym: 0, gaze: 1,
    glow: { hex: '#FFBE45', level: 1.15, pulse: false }, blinks: true,
  },
  curious: {
    shape: 'tall', eyeY: 1, browY: 12.5, browTilt: 9, browAsym: 3, gaze: 1.6,
    glow: { hex: '#7FD4E8', level: 0.95, pulse: false }, blinks: true,
  },
  surprise: {
    shape: 'wide', eyeY: 1.5, browY: 13.5, browTilt: 2, browAsym: 0, gaze: 0.3,
    glow: { hex: '#BDEFFA', level: 1.55, pulse: false }, blinks: true,
  },
  listening: {
    shape: 'narrow', eyeY: 0, browY: 12.5, browTilt: 7, browAsym: 0, gaze: 0.8,
    glow: { hex: '#5EC8E0', level: 1.05, pulse: true }, blinks: true,
  },
  sleepy: {
    shape: 'slit', eyeY: -3, browY: 9.5, browTilt: 1, browAsym: 0, gaze: 0.15,
    glow: NO_GLOW, blinks: false,
  },

  // ---- faults. These OVERRIDE mood; a fault light mood can mask is useless.
  offline: {
    shape: 'normal', eyeY: 0, browY: 11, browTilt: -6, browAsym: 0, gaze: 0.5,
    glow: { hex: '#E8A33D', level: 0.9, pulse: true }, blinks: true,
  },
  haDown: {
    shape: 'normal', eyeY: 0, browY: 11, browTilt: -9, browAsym: 0, gaze: 0.4,
    glow: { hex: '#D4674A', level: 0.9, pulse: true }, blinks: true,
  },
  /** Mic and camera hard-muted. Eyes shut, no drift, no glow. Deliberately
   *  unmistakable — this is a privacy indicator, not a mood. */
  muted: {
    shape: 'closed', eyeY: 0, browY: 10, browTilt: 0, browAsym: 0, gaze: 0,
    glow: NO_GLOW, blinks: false,
  },
};

export const FAULTS: readonly FaultName[] = ['offline', 'haDown', 'muted'] as const;

export function isState(x: unknown): x is StateName {
  return typeof x === 'string' && x in STATES;
}
