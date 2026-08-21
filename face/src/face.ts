import {
  ACTIVE_RADIUS_MM, EYES, MM, PANEL_PX, STATES,
  type EyeGeom, type EyeShape, type StateName,
} from './expressions';

import { LAYOUT } from './layout';

const {
  eyeX: EYE_X_MM, browW: BROW_W_MM, browH: BROW_H_MM, browR: BROW_R_MM,
  driftX, driftY, lookX, lookY, maxDX, maxDY,
  eyeColor: EYE_COLOR, background: BG,
} = LAYOUT;

const clamp = (v: number, lim: number) => Math.max(-lim, Math.min(lim, v));

const BLINK_MS = 140;
const BLINK_MIN_S = 2.1;
const BLINK_RANGE_S = 3.6;
/** Interpolation rate per 60 fps frame. Slow enough to read as motion. */
const EASE = 0.12;

/** Numeric fields we interpolate between states. Shape can't be lerped. */
type Lerpable = 'eyeY' | 'browY' | 'browTilt' | 'browAsym' | 'gaze';
const LERPABLE: Lerpable[] = ['eyeY', 'browY', 'browTilt', 'browAsym', 'gaze'];

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

function roundRect(
  ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number,
): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  // ctx.roundRect exists in modern engines but not every WebKit build on the Pi.
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(x - w / 2, y - h / 2, w, h, rr);
    return;
  }
  const l = x - w / 2, t = y - h / 2, rgt = x + w / 2, b = y + h / 2;
  ctx.moveTo(l + rr, t);
  ctx.arcTo(rgt, t, rgt, b, rr);
  ctx.arcTo(rgt, b, l, b, rr);
  ctx.arcTo(l, b, l, t, rr);
  ctx.arcTo(l, t, rgt, t, rr);
  ctx.closePath();
}

export class Face {
  private ctx: CanvasRenderingContext2D;
  private target: StateName = 'boot';
  private cur: Record<Lerpable, number>;
  private shape: EyeShape = 'closed';
  private pendingShape: EyeShape | null = null;

  private blinkAt = 0;
  private blinkK = 1;
  private nextBlink = BLINK_MIN_S;
  /** External gaze from face tracking, -1..1. Eyes lead the head turn. */
  private look = { x: 0, y: 0 };
  private lookSmooth = { x: 0, y: 0 };
  private raf = 0;

  constructor(canvas: HTMLCanvasElement) {
    canvas.width = PANEL_PX;
    canvas.height = PANEL_PX;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('2D context unavailable');
    this.ctx = ctx;
    const b = STATES.boot;
    this.cur = {
      eyeY: b.eyeY, browY: b.browY, browTilt: b.browTilt,
      browAsym: b.browAsym, gaze: b.gaze,
    };
  }

  get state(): StateName { return this.target; }
  get glow() { return STATES[this.target].glow; }

  /**
   * Shape changes pop if you swap them mid-frame, so we swap during a blink —
   * the eyes are shut at the midpoint and the change is invisible. Same trick
   * animators use to hide a cut.
   */
  setState(name: StateName, now = performance.now() / 1000): void {
    if (name === this.target) return;
    this.target = name;
    const next = STATES[name].shape;
    if (next !== this.shape) {
      this.pendingShape = next;
      this.blinkAt = now;
    }
  }

  setLook(x: number, y: number): void {
    this.look.x = Math.max(-1, Math.min(1, x));
    this.look.y = Math.max(-1, Math.min(1, y));
  }

  start(): void {
    const frame = () => {
      this.raf = requestAnimationFrame(frame);
      this.tick(performance.now() / 1000);
    };
    this.raf = requestAnimationFrame(frame);
  }

  stop(): void { cancelAnimationFrame(this.raf); }

  private tick(t: number): void {
    const s = STATES[this.target];
    for (const k of LERPABLE) this.cur[k] = lerp(this.cur[k], s[k], EASE);
    this.lookSmooth.x = lerp(this.lookSmooth.x, this.look.x, 0.18);
    this.lookSmooth.y = lerp(this.lookSmooth.y, this.look.y, 0.18);

    // blink: either scheduled idle, or triggered by a shape change
    if (this.blinkAt === 0 && s.blinks && t > this.nextBlink) this.blinkAt = t;
    if (this.blinkAt > 0) {
      const p = (t - this.blinkAt) / (BLINK_MS / 1000);
      if (p >= 1) {
        this.blinkK = 1;
        this.blinkAt = 0;
        this.nextBlink = t + BLINK_MIN_S + Math.random() * BLINK_RANGE_S;
      } else {
        this.blinkK = 1 - Math.sin(p * Math.PI) * 0.95;
        if (p >= 0.5 && this.pendingShape) {   // swap while shut
          this.shape = this.pendingShape;
          this.pendingShape = null;
        }
      }
    } else if (!s.blinks) {
      this.blinkK = 1;
      this.nextBlink = t + BLINK_MIN_S;
    }
    if (this.pendingShape && !s.blinks) {      // sleeping states never blink
      this.shape = this.pendingShape;
      this.pendingShape = null;
    }

    this.draw(t);
  }

  private draw(t: number): void {
    const { ctx } = this;
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, PANEL_PX, PANEL_PX);
    ctx.save();
    ctx.translate(PANEL_PX / 2, PANEL_PX / 2);

    // Idle drift + tracked gaze. Amplitudes verified against the 26.5 mm circle.
    const g = this.cur.gaze;
    const idle = Math.sin(t * 0.37) * 0.7 + Math.sin(t * 0.94) * 0.3;
    const dx = clamp(idle * driftX * g + this.lookSmooth.x * lookX, maxDX);
    const dy = clamp(Math.sin(t * 0.55) * driftY * g + this.lookSmooth.y * lookY, maxDY);

    ctx.fillStyle = EYE_COLOR;
    for (const side of [-1, 1] as const) {
      ctx.save();
      ctx.translate((EYE_X_MM * side + dx) * MM, (this.cur.eyeY + dy) * MM);
      this.drawEye(EYES[this.shape]);
      this.drawBrow(side);
      ctx.restore();
    }
    ctx.restore();
  }

  private drawEye(geom: EyeGeom): void {
    const { ctx } = this;
    ctx.save();
    ctx.scale(1, this.blinkK);
    if (geom.kind === 'rect') {
      roundRect(ctx, 0, 0, geom.w * MM, geom.h * MM, geom.r * MM);
      ctx.fill();
    } else {
      const a0 = (geom.from * Math.PI) / 180;
      const a1 = (geom.to * Math.PI) / 180;
      const cy = -geom.dy * MM;   // canvas y is inverted vs the design frame
      ctx.beginPath();
      ctx.arc(0, cy, geom.outer * MM, -a1, -a0);
      ctx.arc(0, cy, geom.inner * MM, -a0, -a1, true);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  private drawBrow(side: -1 | 1): void {
    const { ctx } = this;
    // Asymmetry lifts the left brow only. Reads as a question.
    const lift = side === -1 ? this.cur.browAsym : -this.cur.browAsym * 0.4;
    const tilt = side === -1
      ? this.cur.browTilt + this.cur.browAsym * 0.8
      : -(this.cur.browTilt - this.cur.browAsym * 0.5);
    ctx.save();
    ctx.translate(0, -(this.cur.browY + lift) * MM);
    ctx.rotate((-tilt * Math.PI) / 180);
    roundRect(ctx, 0, 0, BROW_W_MM * MM, BROW_H_MM * MM, BROW_R_MM * MM);
    ctx.fill();
    ctx.restore();
  }

}

export { ACTIVE_RADIUS_MM };
