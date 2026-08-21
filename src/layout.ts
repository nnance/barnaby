/**
 * Face layout constants, in millimetres on the 53 mm active circle.
 * Changing anything here requires `npm run check:fit` to still pass.
 */
export const LAYOUT = {
  /** Eye centre offset from face centre. */
  eyeX: 8.5,
  browW: 10,
  browH: 3,
  browR: 1.5,
  /** Idle drift amplitude, scaled by each state's `gaze`. */
  driftX: 2.1,
  driftY: 0.7,
  /** Tracked-gaze amplitude at full deflection. Eyes lead the head turn. */
  lookX: 1.8,
  lookY: 1.2,
  eyeColor: '#7FD4E8',
  background: '#05080A',
} as const;
