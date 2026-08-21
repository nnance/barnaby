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
  lookX: 3.0,
  lookY: 2.0,
  /**
   * Hard cap on the COMBINED idle-drift + tracked-gaze offset. Without this,
   * the two stack and the worst case eats the panel margin, so gaze has to be
   * timid to stay safe. Clamping means gaze can be generous and the geometry
   * is still guaranteed. check-fit uses these as its worst case.
   */
  maxDX: 3.4,
  maxDY: 2.3,
  eyeColor: '#7FD4E8',
  background: '#05080A',
} as const;
