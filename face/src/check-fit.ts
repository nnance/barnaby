/**
 * Fails the build if any expression would be clipped by the round panel.
 *
 * The 2.1" panel gives 26.5 mm of usable radius. This samples the ACTUAL drawn
 * outline — eye shape plus brow corners, offset by worst-case idle drift and
 * worst-case tracked gaze simultaneously — rather than a bounding box, because
 * a bounding box on the "happy" arc is wrong by several millimetres.
 *
 * Run: npm run check:fit
 */
import {
  ACTIVE_RADIUS_MM, EYES, STATES,
  type EyeGeom, type FaceState, type StateName,
} from './expressions';
import { LAYOUT } from './layout';

const { eyeX, browW, browH, maxDX, maxDY } = LAYOUT;

/** Points on the eye outline, in the eye's own frame (+y up). */
function eyeOutline(g: EyeGeom): [number, number][] {
  const pts: [number, number][] = [];
  if (g.kind === 'rect') {
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
      // rounded corner: the true extreme is the corner arc centre plus r
      const cx = sx * (g.w / 2 - g.r), cy = sy * (g.h / 2 - g.r);
      for (let a = 0; a <= 90; a += 10) {
        const t = (a * Math.PI) / 180;
        pts.push([cx + sx * g.r * Math.cos(t), cy + sy * g.r * Math.sin(t)]);
      }
    }
  } else {
    for (let a = g.from; a <= g.to; a += 4) {
      const t = (a * Math.PI) / 180;
      pts.push([g.outer * Math.cos(t), g.dy + g.outer * Math.sin(t)]);
      pts.push([g.inner * Math.cos(t), g.dy + g.inner * Math.sin(t)]);
    }
  }
  return pts;
}

function browCorners(tilt: number): [number, number][] {
  const t = (tilt * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t);
  const out: [number, number][] = [];
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
    const x = (sx * browW) / 2, y = (sy * browH) / 2;
    out.push([x * c - y * s, x * s + y * c]);
  }
  return out;
}

let worst = 0, worstName = '';
let failed = false;

for (const [name, s] of Object.entries(STATES) as [StateName, FaceState][]) {
  // Worst case is the clamp, not the sum — the renderer caps combined offset.
  const dx = maxDX;
  const dy = maxDY;
  let mm = 0;

  for (const side of [-1, 1] as const) {
    const ox = eyeX * side + dx;
    const oy = s.eyeY + dy;
    for (const [px, py] of eyeOutline(EYES[s.shape])) {
      mm = Math.max(mm, Math.hypot(ox + px, oy + py));
    }
    const lift = side === -1 ? s.browAsym : -s.browAsym * 0.4;
    const tilt = side === -1
      ? s.browTilt + s.browAsym * 0.8
      : -(s.browTilt - s.browAsym * 0.5);
    for (const [px, py] of browCorners(tilt)) {
      mm = Math.max(mm, Math.hypot(ox + px, oy + s.browY + lift + py));
    }
  }

  const ok = mm <= ACTIVE_RADIUS_MM;
  if (!ok) failed = true;
  console.log(`${ok ? 'ok  ' : 'CLIP'} ${name.padEnd(10)} ${mm.toFixed(1)} mm`);
  if (mm > worst) { worst = mm; worstName = name; }
}

console.log(`\nworst: ${worstName} at ${worst.toFixed(1)} of ${ACTIVE_RADIUS_MM} mm`);
if (failed) {
  console.error('FAIL — the panel would clip this. Shrink the layout.');
  process.exit(1);
}
console.log(`margin: ${(ACTIVE_RADIUS_MM - worst).toFixed(1)} mm`);
