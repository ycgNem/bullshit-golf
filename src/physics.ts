import { Vector3 } from 'three';
import { AERO, BALL_R, G, aeroAccel } from './aero';
import type { Course, Surface } from './course';

export type BallState = 'rest' | 'fly' | 'roll' | 'holed' | 'water' | 'ob';

export type SimEvent =
  | { type: 'bounce'; surface: Surface; speed: number }
  | { type: 'splash' }
  | { type: 'tree'; trunk: boolean }
  | { type: 'prop'; tag: string; speed: number }
  | { type: 'pin' }
  | { type: 'lipout' }
  | { type: 'holed'; dunk: boolean }
  | { type: 'rest'; surface: Surface }
  | { type: 'ob' };

export type Collider =
  | { shape: 'box'; x: number; y: number; z: number; hx: number; hy: number; hz: number; yaw: number; e: number; tag: string }
  | { shape: 'cap'; ax: number; ay: number; az: number; bx: number; by: number; bz: number; r: number; e: number; tag: string };

interface TreeCol { x: number; z: number; base: number; trunkR: number; trunkTop: number; cx: number; cy: number; cz: number; rx: number; ry: number }
export type TreeGrid = Map<number, TreeCol[]>;
const TREE_CELL = 16;
const cellKey = (x: number, z: number): number => (Math.floor(x / TREE_CELL) + 512) * 4096 + (Math.floor(z / TREE_CELL) + 2048);

interface SurfParams {
  /** scales the turf dent angle (Penner): softer ground kills more forward speed */
  soft: number;
  /** multiplies the speed-dependent restitution; fixedE overrides it */
  eK: number;
  fixedE?: number;
  mu: number;
  /** fraction of speed kept after the bounce */
  keep: number;
  /** rolling resistance as a fraction of g at putting speed */
  roll: number;
  /** extra resistance per m/s above 2.5 m/s (balls skidding through grass slow faster) */
  vr: number;
}

export const SURF: Record<Surface, SurfParams> = {
  tee: { soft: 0.8, eK: 1, mu: 0.4, keep: 1, roll: 0.13, vr: 4 },
  fairway: { soft: 0.8, eK: 1, mu: 0.4, keep: 1, roll: 0.13, vr: 4 },
  green: { soft: 1.0, eK: 1, mu: 0.4, keep: 1, roll: 0.056, vr: 9 },
  rough: { soft: 1.3, eK: 0.6, mu: 0.55, keep: 0.82, roll: 0.36, vr: 3 },
  sand: { soft: 2.6, eK: 0.2, mu: 0.9, keep: 0.45, roll: 0.95, vr: 3 },
  path: { soft: 0, eK: 1, fixedE: 0.8, mu: 0.3, keep: 1, roll: 0.05, vr: 30 },
  water: { soft: 1, eK: 0, mu: 1, keep: 0, roll: 1, vr: 1 },
  ob: { soft: 1.3, eK: 0.6, mu: 0.55, keep: 0.82, roll: 0.36, vr: 3 },
};

export interface SimEnv {
  course: Course;
  /** wind velocity 10 m above the ground */
  wind: Vector3;
  colliders: Collider[];
  trees: TreeGrid | null;
  cupX: number;
  cupZ: number;
  cupY: number;
  cupR: number;
  magnet: boolean;
  /** rolling resistance multiplier on the green (sprinklers) */
  greenSlow: number;
}

function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DEG = Math.PI / 180;

export class BallSim {
  readonly pos = new Vector3();
  readonly vel = new Vector3();
  /** angular velocity, rad/s */
  readonly spin = new Vector3();
  state: BallState = 'rest';
  events: SimEvent[] = [];
  time = 0;
  /** preview runs skip trees, props and events */
  ghost = false;
  bounces = 0;
  private lipTimer = 0;
  private leafTimer = 0;
  private readonly n = { x: 0, y: 1, z: 0 };
  private readonly acc = [0, 0, 0];
  private rng = mulberry(1);

  constructor(public env: SimEnv) {}

  place(x: number, z: number): void {
    this.pos.set(x, this.env.course.groundAt(x, z) + BALL_R, z);
    this.vel.set(0, 0, 0);
    this.spin.set(0, 0, 0);
    this.state = 'rest';
  }

  launch(vel: Vector3, spin: Vector3, seed: number): void {
    this.vel.copy(vel);
    this.spin.copy(spin);
    this.rng = mulberry(seed);
    this.bounces = 0;
    this.lipTimer = 0;
    this.time = 0;
    this.state = vel.y > 0.3 ? 'fly' : 'roll';
  }

  get moving(): boolean { return this.state === 'fly' || this.state === 'roll'; }
  get heightAboveGround(): number { return this.pos.y - BALL_R - this.env.course.groundAt(this.pos.x, this.pos.z); }

  private emit(e: SimEvent): void { if (!this.ghost) this.events.push(e); }

  /** Wind speed factor at a height above ground, with slow gusts. */
  private windFactor(h: number): number {
    const prof = Math.min(1.35, Math.max(0.45, Math.pow(Math.max(h, 0.3) / 10, 0.17)));
    return prof * (1 + 0.16 * Math.sin(this.time * 0.9 + 1.3) + 0.09 * Math.sin(this.time * 2.3));
  }

  /** After-touch: add spin about the flight axes. side > 0 curves right, lift > 0 adds backspin. rate in rad/s. */
  steer(side: number, lift: number, amount: number): void {
    const v = this.vel;
    const hl = Math.hypot(v.x, v.z);
    if (hl < 0.5) return;
    const fx = v.x / hl, fz = v.z / hl;
    // right = forward x up
    const rx = -fz, rz = fx;
    this.spin.x += rx * lift * amount;
    this.spin.z += rz * lift * amount;
    this.spin.y -= side * amount;
  }

  /** After-touch on the ground: push a rolling ball. */
  nudge(ax: number, az: number, dt: number): void {
    if (this.state !== 'roll') return;
    this.vel.x += ax * dt;
    this.vel.z += az * dt;
  }

  step(dt: number): void {
    if (this.state === 'fly') this.stepFly(dt);
    else if (this.state === 'roll') this.stepRoll(dt);
    this.time += dt;
    if (this.lipTimer > 0) this.lipTimer -= dt;
    if (this.leafTimer > 0) this.leafTimer -= dt;
  }

  private magnetPull(dt: number, strength: number): void {
    const e = this.env;
    if (!e.magnet) return;
    const dx = e.cupX - this.pos.x, dz = e.cupZ - this.pos.z;
    const d = Math.hypot(dx, dz);
    if (d > 7 || d < 0.01 || this.pos.y - e.cupY > 4) return;
    const a = strength * (1 - d / 7);
    this.vel.x += (dx / d) * a * dt;
    this.vel.z += (dz / d) * a * dt;
  }

  private stepFly(dt: number): void {
    const { pos: p, vel: v, spin: w, env } = this;
    const c = env.course;
    const h = p.y - c.groundAt(p.x, p.z);
    const wf = this.windFactor(h);
    aeroAccel(v.x, v.y, v.z, w.x, w.y, w.z, env.wind.x * wf, 0, env.wind.z * wf, this.acc);
    v.x += this.acc[0]! * dt; v.y += this.acc[1]! * dt; v.z += this.acc[2]! * dt;
    this.magnetPull(dt, 9);
    p.x += v.x * dt; p.y += v.y * dt; p.z += v.z * dt;
    w.multiplyScalar(Math.exp(-dt / AERO.spinTau));

    if (p.x < c.x0 || p.x > c.x1 || -p.z < c.y0 || -p.z > c.y1) {
      this.state = 'ob';
      this.emit({ type: 'ob' });
      return;
    }
    if (!this.ghost) {
      this.collideProps();
      if (h < 26) this.collideTrees(dt);
    }
    this.collidePin();
    if (p.y < c.waterZ + BALL_R && c.inWater(p.x, p.z)) {
      this.state = 'water';
      this.emit({ type: 'splash' });
      return;
    }
    const g = c.groundAt(p.x, p.z);
    if (p.y - BALL_R <= g) {
      p.y = g + BALL_R;
      const surface = c.surfaceAt(p.x, p.z);
      if (surface === 'ob') {
        this.state = 'ob';
        this.emit({ type: 'ob' });
        return;
      }
      this.bounce(surface);
    }
  }

  private bounce(surface: Surface): void {
    const { pos: p, vel: v, spin: w, env, n } = this;
    env.course.normalAt(p.x, p.z, n);
    const vn0 = v.x * n.x + v.y * n.y + v.z * n.z;
    if (vn0 >= 0) return;
    const speed = v.length();

    // Straight into the cup on the fly.
    const dc = Math.hypot(env.cupX - p.x, env.cupZ - p.z);
    if (dc < env.cupR * 0.85) {
      if (speed < 17) {
        this.hole(true);
        return;
      }
      this.emit({ type: 'pin' });
    }

    const S = SURF[surface];
    // Tangential direction of travel.
    let tx = v.x - vn0 * n.x, ty = v.y - vn0 * n.y, tz = v.z - vn0 * n.z;
    const tl = Math.hypot(tx, ty, tz);
    let nx = n.x, ny = n.y, nz = n.z;
    if (tl > 1e-4) {
      tx /= tl; ty /= tl; tz /= tl;
      // Penner's turf model: the ball dents the ground and bounces off the far wall of the dent.
      const thI = Math.atan2(tl, -vn0);
      const thC = Math.min(15.4 * DEG * (speed / 18.6) * (thI / (44.4 * DEG)) * S.soft, thI * 0.9);
      const cs = Math.cos(thC), sn = Math.sin(thC);
      nx = n.x * cs - tx * sn; ny = n.y * cs - ty * sn; nz = n.z * cs - tz * sn;
    }
    const vn = v.x * nx + v.y * ny + v.z * nz;
    const an = Math.abs(vn);
    const e = S.fixedE ?? S.eK * (an > 20 ? 0.12 : 0.51 - 0.0375 * an + 0.000903 * an * an);
    // Slip of the contact point: tangential velocity plus spin x (-R n).
    let sx = v.x - vn * nx - BALL_R * (w.y * nz - w.z * ny);
    let sy = v.y - vn * ny - BALL_R * (w.z * nx - w.x * nz);
    let sz = v.z - vn * nz - BALL_R * (w.x * ny - w.y * nx);
    const sl = Math.hypot(sx, sy, sz);
    let vx = v.x - vn * nx, vy = v.y - vn * ny, vz = v.z - vn * nz;
    if (sl > 1e-6) {
      sx /= sl; sy /= sl; sz /= sl;
      const J = Math.min((2 / 7) * sl, S.mu * (1 + e) * an);
      vx -= J * sx; vy -= J * sy; vz -= J * sz;
      const k = (5 / (2 * BALL_R)) * J;
      w.x += k * (ny * sz - nz * sy);
      w.y += k * (nz * sx - nx * sz);
      w.z += k * (nx * sy - ny * sx);
    }
    v.set(vx - e * vn * nx, vy - e * vn * ny, vz - e * vn * nz).multiplyScalar(S.keep);
    if (S.keep < 1) w.multiplyScalar(S.keep);
    this.bounces++;
    this.emit({ type: 'bounce', surface, speed: an });

    const out = v.x * n.x + v.y * n.y + v.z * n.z;
    if (out < 0.6) {
      v.x -= out * n.x; v.y -= out * n.y; v.z -= out * n.z;
      this.state = 'roll';
    }
  }

  private stepRoll(dt: number): void {
    const { pos: p, vel: v, env, n } = this;
    const c = env.course;
    const surface = c.surfaceAt(p.x, p.z);
    if (surface === 'ob') {
      this.state = 'ob';
      this.emit({ type: 'ob' });
      return;
    }
    if (surface === 'water') {
      this.state = 'water';
      this.emit({ type: 'splash' });
      return;
    }
    c.normalAt(p.x, p.z, n);
    const S = SURF[surface];
    const speed = v.length();
    const mu = S.roll * (surface === 'green' ? env.greenSlow : 1) * (1 + Math.max(0, speed - 2.5) / S.vr);
    const slope = (5 / 7) * G * Math.sqrt(Math.max(0, 1 - n.y * n.y));
    const fr = mu * G;
    if (speed < 0.05 + fr * dt && slope < fr && this.time > 0.05) {
      v.set(0, 0, 0);
      this.spin.set(0, 0, 0);
      this.state = 'rest';
      this.emit({ type: 'rest', surface });
      return;
    }
    const k = (5 / 7) * G * n.y;
    let ax = k * n.x, ay = (5 / 7) * -G + k * n.y, az = k * n.z;
    if (speed > 1e-4) {
      ax -= (fr * v.x) / speed; ay -= (fr * v.y) / speed; az -= (fr * v.z) / speed;
    }
    v.x += ax * dt; v.y += ay * dt; v.z += az * dt;
    this.magnetPull(dt, 5);
    p.x += v.x * dt; p.y += v.y * dt; p.z += v.z * dt;
    const g = c.groundAt(p.x, p.z);
    if (p.y - BALL_R - g > 0.06) {
      this.state = 'fly';
      return;
    }
    p.y = g + BALL_R;
    c.normalAt(p.x, p.z, n);
    const vn = v.x * n.x + v.y * n.y + v.z * n.z;
    v.x -= vn * n.x; v.y -= vn * n.y; v.z -= vn * n.z;
    this.spin.set(0, 0, 0);
    if (!this.ghost) this.collideProps();
    this.checkCup();
  }

  private hole(dunk: boolean): void {
    const e = this.env;
    this.pos.set(e.cupX, e.cupY - 0.09, e.cupZ);
    this.vel.set(0, 0, 0);
    this.spin.set(0, 0, 0);
    this.state = 'holed';
    this.emit({ type: 'holed', dunk });
  }

  private checkCup(): void {
    const { pos: p, vel: v, env } = this;
    const dx = env.cupX - p.x, dz = env.cupZ - p.z;
    const d = Math.hypot(dx, dz);
    if (d >= env.cupR || this.lipTimer > 0 || Math.abs(p.y - BALL_R - env.cupY) > 0.2) return;
    const sp = Math.hypot(v.x, v.z);
    const b = sp > 1e-3 ? Math.abs(dx * v.z - dz * v.x) / sp : d;
    const vcap = 1.63 * Math.sqrt(env.cupR / 0.054) * Math.sqrt(Math.max(0, 1 - (b / env.cupR) ** 2)) * (env.magnet ? 2.4 : 1);
    if (sp <= vcap) {
      this.hole(false);
      return;
    }
    // Lip-out: thrown sideways off the rim.
    const side = dx * v.z - dz * v.x > 0 ? 1 : -1;
    const a = side * (30 + 45 * this.rng()) * DEG;
    const cs = Math.cos(a), sn = Math.sin(a);
    const nx = v.x * cs - v.z * sn, nz = v.x * sn + v.z * cs;
    v.x = nx * 0.55; v.z = nz * 0.55;
    this.lipTimer = 0.6;
    this.emit({ type: 'lipout' });
  }

  private collidePin(): void {
    const { pos: p, vel: v, env } = this;
    const hy = p.y - env.cupY;
    if (hy < 0.02 || hy > 2.15) return;
    const dx = p.x - env.cupX, dz = p.z - env.cupZ;
    const d = Math.hypot(dx, dz);
    if (d > 0.008 + BALL_R || d < 1e-5) return;
    const nx = dx / d, nz = dz / d;
    const vn = v.x * nx + v.z * nz;
    if (vn >= 0) return;
    v.x -= 1.35 * vn * nx; v.z -= 1.35 * vn * nz;
    v.multiplyScalar(0.55);
    this.spin.multiplyScalar(0.3);
    this.emit({ type: 'pin' });
  }

  private hitNormal(nx: number, ny: number, nz: number, pen: number, e: number, tag: string): void {
    const { pos: p, vel: v } = this;
    p.x += nx * pen; p.y += ny * pen; p.z += nz * pen;
    const vn = v.x * nx + v.y * ny + v.z * nz;
    if (vn >= 0) return;
    v.x -= (1 + e) * vn * nx; v.y -= (1 + e) * vn * ny; v.z -= (1 + e) * vn * nz;
    v.multiplyScalar(0.92);
    this.spin.multiplyScalar(0.5);
    if (vn < -0.8) {
      if (tag === 'trunk') this.emit({ type: 'tree', trunk: true });
      else this.emit({ type: 'prop', tag, speed: -vn });
    }
    if (this.state === 'roll' && ny > 0.5) this.state = 'fly';
  }

  private collideCapsule(ax: number, ay: number, az: number, bx: number, by: number, bz: number, r: number, e: number, tag: string): void {
    const p = this.pos;
    const ex = bx - ax, ey = by - ay, ez = bz - az;
    const t = Math.min(Math.max(((p.x - ax) * ex + (p.y - ay) * ey + (p.z - az) * ez) / (ex * ex + ey * ey + ez * ez), 0), 1);
    const dx = p.x - ax - t * ex, dy = p.y - ay - t * ey, dz = p.z - az - t * ez;
    const d = Math.hypot(dx, dy, dz);
    const lim = r + BALL_R;
    if (d >= lim || d < 1e-6) return;
    this.hitNormal(dx / d, dy / d, dz / d, lim - d, e, tag);
  }

  private collideProps(): void {
    const p = this.pos;
    for (const c of this.env.colliders) {
      if (c.shape === 'cap') {
        if (Math.abs(p.x - c.ax) > 6 || Math.abs(p.z - c.az) > 6) continue;
        this.collideCapsule(c.ax, c.ay, c.az, c.bx, c.by, c.bz, c.r, c.e, c.tag);
        continue;
      }
      const dx = p.x - c.x, dz = p.z - c.z;
      if (Math.abs(dx) > 16 || Math.abs(dz) > 16) continue;
      const cs = Math.cos(c.yaw), sn = Math.sin(c.yaw);
      const lx = dx * cs - dz * sn, ly = p.y - c.y, lz = dx * sn + dz * cs;
      const qx = Math.min(Math.max(lx, -c.hx), c.hx), qy = Math.min(Math.max(ly, -c.hy), c.hy), qz = Math.min(Math.max(lz, -c.hz), c.hz);
      let ox = lx - qx, oy = ly - qy, oz = lz - qz;
      let d = Math.hypot(ox, oy, oz);
      let pen: number;
      if (d >= BALL_R) continue;
      if (d < 1e-6) {
        // centre is inside the box: leave by the nearest face
        const px = c.hx - Math.abs(lx), py = c.hy - Math.abs(ly), pz = c.hz - Math.abs(lz);
        ox = oy = oz = 0;
        if (px <= py && px <= pz) { ox = Math.sign(lx) || 1; pen = px + BALL_R; }
        else if (py <= pz) { oy = Math.sign(ly) || 1; pen = py + BALL_R; }
        else { oz = Math.sign(lz) || 1; pen = pz + BALL_R; }
        d = 1;
      } else pen = BALL_R - d;
      ox /= d; oy /= d; oz /= d;
      this.hitNormal(ox * cs + oz * sn, oy, -ox * sn + oz * cs, pen, c.e, c.tag);
    }
  }

  private collideTrees(dt: number): void {
    const grid = this.env.trees;
    if (!grid) return;
    const { pos: p, vel: v } = this;
    const ci = Math.floor(p.x / TREE_CELL), cj = Math.floor(p.z / TREE_CELL);
    for (let i = ci - 1; i <= ci + 1; i++) {
      for (let j = cj - 1; j <= cj + 1; j++) {
        const list = grid.get((i + 512) * 4096 + (j + 2048));
        if (!list) continue;
        for (const t of list) {
          if (p.y < t.base + t.trunkTop) this.collideCapsule(t.x, t.base, t.z, t.x, t.base + t.trunkTop, t.z, t.trunkR, 0.45, 'trunk');
          if (this.leafTimer > 0) continue;
          const qx = (p.x - t.cx) / t.rx, qy = (p.y - t.cy) / t.ry, qz = (p.z - t.cz) / t.rx;
          if (qx * qx + qy * qy + qz * qz > 1) continue;
          const sp = v.length();
          if (this.rng() > 1 - Math.exp(-0.1 * sp * dt)) continue;
          // A branch. Lose most of the speed and leave in a new direction.
          const a = this.rng() * Math.PI * 2, u = this.rng() * 2 - 1, s = Math.sqrt(1 - u * u);
          v.multiplyScalar(0.3 + 0.3 * this.rng());
          v.x += Math.cos(a) * s * sp * 0.3; v.z += Math.sin(a) * s * sp * 0.3; v.y += (u - 0.5) * sp * 0.2;
          this.spin.multiplyScalar(0.25);
          this.leafTimer = 0.1;
          this.emit({ type: 'tree', trunk: false });
        }
      }
    }
  }
}

/** Static colliders for a hole: props from the export, and trunks/canopies for every tree. */
export function buildColliders(
  course: Course, variants: { leafMin: Vector3; leafMax: Vector3 }[],
): { colliders: Collider[]; trees: TreeGrid } {
  const colliders: Collider[] = [];
  for (const pr of course.json.props) {
    const yaw = pr.yaw * DEG;
    const x = pr.x, y = pr.z, z = -pr.y;
    const sn = Math.sin(yaw), cs = Math.cos(yaw);
    if (pr.kind === 'cart') colliders.push({ shape: 'box', x, y: y + 0.95, z, hx: 0.62, hy: 0.95, hz: 1.25, yaw, e: 0.55, tag: 'cart' });
    else if (pr.kind === 'bench') colliders.push({ shape: 'box', x, y: y + 0.43, z, hx: 0.75, hy: 0.43, hz: 0.3, yaw, e: 0.5, tag: 'bench' });
    else if (pr.kind.startsWith('sign')) colliders.push({ shape: 'box', x, y: y + 0.66, z, hx: 0.27, hy: 0.66, hz: 0.1, yaw, e: 0.5, tag: 'sign' });
    else if (pr.kind === 'log') colliders.push({ shape: 'cap', ax: x - sn * 1.4, ay: y + 0.05, az: z - cs * 1.4, bx: x + sn * 1.4, by: y + 0.05, bz: z + cs * 1.4, r: 0.4, e: 0.55, tag: 'log' });
    else if (pr.kind === 'gator') colliders.push({ shape: 'cap', ax: x - sn * 1.9, ay: y, az: z - cs * 1.9, bx: x + sn * 1.4, by: y, bz: z + cs * 1.4, r: 0.42, e: 0.5, tag: 'gator' });
  }
  for (const pl of course.platforms) {
    for (const side of [-1, 1]) {
      const lx = side * 1.24;
      colliders.push({
        shape: 'box', x: pl.x + lx * Math.cos(pl.yaw), y: pl.top + 0.55, z: pl.z - lx * Math.sin(pl.yaw),
        hx: 0.06, hy: 0.55, hz: pl.hz, yaw: pl.yaw, e: 0.6, tag: 'bridge',
      });
    }
  }
  const trees: TreeGrid = new Map();
  const R = [0.3, 0.36, 0.24, 0.32];
  for (const t of course.json.trees) {
    const v = t[6]!, s = t[4]!, sz = t[5]!, yaw = t[3]!;
    const b = variants[v]!;
    const lowY = Math.max(b.leafMin.y, 3.6);
    const lcx = ((b.leafMin.x + b.leafMax.x) / 2) * s, lcz = ((b.leafMin.z + b.leafMax.z) / 2) * s;
    const x = t[0]!, z = -t[1]!, base = t[2]!;
    const tc: TreeCol = {
      x, z, base, trunkR: R[v]! * s * 1.25, trunkTop: lowY * sz,
      cx: x + lcx * Math.cos(yaw) + lcz * Math.sin(yaw),
      cy: base + ((lowY + b.leafMax.y) / 2) * sz,
      cz: z - lcx * Math.sin(yaw) + lcz * Math.cos(yaw),
      rx: 0.19 * ((b.leafMax.x - b.leafMin.x) + (b.leafMax.z - b.leafMin.z)) * s,
      ry: 0.46 * (b.leafMax.y - lowY) * sz,
    };
    // Cells are wider than any canopy, so a 3x3 lookup around the ball always finds it.
    const key = cellKey(tc.cx, tc.cz);
    let list = trees.get(key);
    if (!list) trees.set(key, (list = []));
    list.push(tc);
  }
  return { colliders, trees };
}

/** Flight path of a shot until it first touches down (for the aim marker and the laser card). */
export function predictFlight(env: SimEnv, from: Vector3, vel: Vector3, spin: Vector3, every = 0.08): Vector3[] {
  const sim = new BallSim(env);
  sim.ghost = true;
  sim.pos.copy(from);
  sim.launch(vel, spin, 1);
  const pts: Vector3[] = [from.clone()];
  const dt = 1 / 120;
  let acc = 0;
  for (let i = 0; i < 120 * 14 && sim.state === 'fly' && sim.bounces === 0; i++) {
    sim.step(dt);
    acc += dt;
    if (acc >= every) { acc = 0; pts.push(sim.pos.clone()); }
  }
  pts.push(sim.pos.clone());
  return pts;
}
