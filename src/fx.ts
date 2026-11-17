import * as THREE from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import type { InstancedInterleavedBuffer } from 'three';
import { BALL_R } from './aero';
import type { Course } from './course';
import type { World } from './world';

const TRAIL_N = 180;
const PARTICLES = 500;

export type Burst = 'splash' | 'sand' | 'turf' | 'leaves' | 'pure' | 'dust';

const BURSTS: Record<Burst, { n: number; color: [number, number, number]; up: number; spread: number; life: number; g: number }> = {
  splash: { n: 90, color: [0.82, 0.9, 0.95], up: 6.5, spread: 2.2, life: 1.1, g: 9.8 },
  sand: { n: 60, color: [0.78, 0.7, 0.52], up: 3.2, spread: 2.0, life: 0.8, g: 9.8 },
  turf: { n: 26, color: [0.16, 0.2, 0.07], up: 3.0, spread: 1.6, life: 0.7, g: 9.8 },
  leaves: { n: 34, color: [0.2, 0.33, 0.08], up: 0.6, spread: 2.4, life: 1.8, g: 2.2 },
  pure: { n: 40, color: [1.0, 0.82, 0.3], up: 2.4, spread: 2.6, life: 0.5, g: 1.0 },
  dust: { n: 20, color: [0.6, 0.58, 0.5], up: 1.0, spread: 1.2, life: 0.6, g: 1.0 },
};

function dotTexture(): THREE.Texture {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 32;
  const ctx = cv.getContext('2d')!;
  const g = ctx.createRadialGradient(16, 16, 2, 16, 16, 15);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 32, 32);
  return new THREE.CanvasTexture(cv);
}

/** Ball, trail, aim aids and particle bursts. */
export class Fx {
  readonly ball: THREE.Object3D;
  private readonly peg: THREE.Object3D;
  private readonly trail: Line2;
  private readonly trailPts: { x: number; y: number; z: number; hot: number }[] = [];
  private readonly aimMat: LineMaterial;
  private readonly laserMat: LineMaterial;
  private aim: Line2 | null = null;
  private laser: Line2 | null = null;
  private readonly ring: THREE.Mesh;
  private readonly points: THREE.Points;
  private readonly pPos: Float32Array;
  private readonly pCol: Float32Array;
  private readonly pVel = new Float32Array(PARTICLES * 3);
  private readonly pLife = new Float32Array(PARTICLES);
  private readonly pMax = new Float32Array(PARTICLES);
  private readonly pBase = new Float32Array(PARTICLES * 3);
  private readonly pG = new Float32Array(PARTICLES);
  private pNext = 0;
  private readonly spinAxis = new THREE.Vector3();
  private readonly lastTrail = new THREE.Vector3();

  constructor(private readonly world: World) {
    const scene = world.scene;
    this.ball = world.spawn('ball');
    this.ball.traverse((o) => { if (o instanceof THREE.Mesh) o.receiveShadow = false; });
    this.peg = world.spawn('peg');
    this.peg.visible = false;
    scene.add(this.ball, this.peg);

    const tg = new LineGeometry();
    tg.setPositions(new Float32Array(TRAIL_N * 3));
    tg.setColors(new Float32Array(TRAIL_N * 3));
    this.trail = new Line2(tg, new LineMaterial({
      linewidth: 3.5, vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
    }));
    this.trail.frustumCulled = false;
    this.trail.visible = false;
    scene.add(this.trail);

    this.aimMat = new LineMaterial({ color: 0xffffff, linewidth: 2.5, transparent: true, opacity: 0.75, dashed: true, dashSize: 2.2, gapSize: 1.6, depthWrite: false });
    this.laserMat = new LineMaterial({ color: 0xff2a2a, linewidth: 2.5, transparent: true, opacity: 0.9, depthWrite: false, fog: false });

    this.ring = new THREE.Mesh(
      new THREE.RingGeometry(1.5, 1.9, 40),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.7, depthWrite: false, side: THREE.DoubleSide, fog: false }),
    );
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.visible = false;
    this.ring.renderOrder = 3;
    scene.add(this.ring);

    this.pPos = new Float32Array(PARTICLES * 3).fill(-9999);
    this.pCol = new Float32Array(PARTICLES * 3);
    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.BufferAttribute(this.pPos, 3));
    pg.setAttribute('color', new THREE.BufferAttribute(this.pCol, 3));
    this.points = new THREE.Points(pg, new THREE.PointsMaterial({
      size: 0.16, map: dotTexture(), vertexColors: true, transparent: true, depthWrite: false, sizeAttenuation: true, alphaTest: 0.02,
    }));
    this.points.frustumCulled = false;
    scene.add(this.points);
  }

  resize(w: number, h: number): void {
    for (const m of [this.aimMat, this.laserMat, this.trail.material]) m.resolution.set(w, h);
  }

  /** Put the ball mesh at the sim position; grow it with distance so it never drops below a few pixels. */
  syncBall(pos: THREE.Vector3, spin: THREE.Vector3, dt: number, lift = 0): void {
    const cam = this.world.camera;
    this.ball.position.set(pos.x, pos.y + lift, pos.z);
    const d = cam.position.distanceTo(this.ball.position);
    const k = (2 * Math.tan((cam.fov * Math.PI) / 360)) / window.innerHeight;       // radians per pixel
    this.ball.scale.setScalar(Math.max(1, (d * k * 2.6) / BALL_R));
    const w = spin.length();
    if (w > 0.5) {
      this.spinAxis.copy(spin).multiplyScalar(1 / w);
      this.ball.rotateOnWorldAxis(this.spinAxis, Math.min(w * dt, 1.1));
    }
  }

  showPeg(on: boolean, pos?: THREE.Vector3): void {
    this.peg.visible = on;
    if (on && pos) this.peg.position.set(pos.x, pos.y - BALL_R, pos.z);
  }

  trailReset(): void {
    this.trailPts.length = 0;
    this.trail.visible = false;
  }

  /** Extend the trail. hot = 1 while after-touch is steering the ball. */
  trailPush(pos: THREE.Vector3, hot: number): void {
    if (this.trailPts.length && this.lastTrail.distanceToSquared(pos) < 0.09) return;
    this.lastTrail.copy(pos);
    this.trailPts.push({ x: pos.x, y: pos.y, z: pos.z, hot });
    if (this.trailPts.length > TRAIL_N) this.trailPts.shift();
    const n = this.trailPts.length;
    if (n < 2) return;
    const geo = this.trail.geometry;
    const pb = (geo.attributes.instanceStart as THREE.InterleavedBufferAttribute).data as InstancedInterleavedBuffer;
    const cb = (geo.attributes.instanceColorStart as THREE.InterleavedBufferAttribute).data as InstancedInterleavedBuffer;
    const pa = pb.array as Float32Array, ca = cb.array as Float32Array;
    for (let s = 0; s < TRAIL_N - 1; s++) {
      const a = this.trailPts[Math.min(s, n - 1)]!, b = this.trailPts[Math.min(s + 1, n - 1)]!;
      const o = s * 6;
      pa[o] = a.x; pa[o + 1] = a.y; pa[o + 2] = a.z; pa[o + 3] = b.x; pa[o + 4] = b.y; pa[o + 5] = b.z;
      for (let e = 0; e < 2; e++) {
        const pt = e ? b : a;
        const f = Math.pow(Math.min(1, (s + e) / (n - 1)), 1.6) * 0.9;
        ca[o + e * 3] = f * (1 - 0.0 * pt.hot);
        ca[o + e * 3 + 1] = f * (1 - 0.72 * pt.hot);
        ca[o + e * 3 + 2] = f * (1 - 0.25 * pt.hot);
      }
    }
    pb.needsUpdate = true;
    cb.needsUpdate = true;
    this.trail.visible = true;
  }

  private setLine(old: Line2 | null, mat: LineMaterial, pts: number[] | null, dashed: boolean): Line2 | null {
    if (old) {
      this.world.scene.remove(old);
      old.geometry.dispose();
    }
    if (!pts || pts.length < 6) return null;
    const g = new LineGeometry();
    g.setPositions(pts);
    const l = new Line2(g, mat);
    if (dashed) l.computeLineDistances();
    l.frustumCulled = false;
    l.renderOrder = 3;
    this.world.scene.add(l);
    return l;
  }

  /** Dashed line along the ground from the ball in the aim direction, with a ring where a full shot would land. */
  setAim(course: Course | null, from?: THREE.Vector3, dirX = 0, dirZ = 0, length = 0, ring = true): void {
    if (!course || !from || length <= 0) {
      this.aim = this.setLine(this.aim, this.aimMat, null, true);
      this.ring.visible = false;
      return;
    }
    const pts: number[] = [];
    const n = Math.max(2, Math.ceil(length / 2));
    for (let i = 0; i <= n; i++) {
      const d = 0.4 + ((length - 0.4) * i) / n;
      const x = from.x + dirX * d, z = from.z + dirZ * d;
      pts.push(x, course.groundAt(x, z) + 0.07, z);
    }
    this.aim = this.setLine(this.aim, this.aimMat, pts, true);
    this.ring.visible = ring;
    if (ring) {
      const x = from.x + dirX * length, z = from.z + dirZ * length;
      this.ring.position.set(x, Math.max(course.groundAt(x, z), course.waterZ) + 0.12, z);
      this.ring.scale.setScalar(Math.max(0.5, length / 110));
    }
  }

  setLaser(pts: THREE.Vector3[] | null): void {
    const flat = pts ? pts.flatMap((p) => [p.x, p.y, p.z]) : null;
    this.laser = this.setLine(this.laser, this.laserMat, flat, false);
  }

  burst(kind: Burst, at: THREE.Vector3, power = 1): void {
    const b = BURSTS[kind];
    const n = Math.round(b.n * Math.min(1.6, Math.max(0.35, power)));
    for (let i = 0; i < n; i++) {
      const k = this.pNext;
      this.pNext = (this.pNext + 1) % PARTICLES;
      const a = Math.random() * Math.PI * 2, r = Math.random() * b.spread * power;
      this.pPos[k * 3] = at.x; this.pPos[k * 3 + 1] = at.y + 0.05; this.pPos[k * 3 + 2] = at.z;
      this.pVel[k * 3] = Math.cos(a) * r; this.pVel[k * 3 + 1] = b.up * power * (0.35 + Math.random() * 0.75); this.pVel[k * 3 + 2] = Math.sin(a) * r;
      this.pLife[k] = this.pMax[k] = b.life * (0.6 + Math.random() * 0.6);
      this.pG[k] = b.g;
      const tone = 0.75 + Math.random() * 0.4;
      this.pBase[k * 3] = b.color[0] * tone; this.pBase[k * 3 + 1] = b.color[1] * tone; this.pBase[k * 3 + 2] = b.color[2] * tone;
    }
  }

  update(dt: number): void {
    let any = false;
    for (let k = 0; k < PARTICLES; k++) {
      if (this.pLife[k]! <= 0) continue;
      any = true;
      this.pLife[k]! -= dt;
      if (this.pLife[k]! <= 0) {
        this.pPos[k * 3 + 1] = -9999;
        continue;
      }
      this.pVel[k * 3 + 1]! -= this.pG[k]! * dt;
      this.pPos[k * 3]! += this.pVel[k * 3]! * dt;
      this.pPos[k * 3 + 1]! += this.pVel[k * 3 + 1]! * dt;
      this.pPos[k * 3 + 2]! += this.pVel[k * 3 + 2]! * dt;
      const f = Math.min(1, (this.pLife[k]! / this.pMax[k]!) * 2);
      this.pCol[k * 3] = this.pBase[k * 3]! * f; this.pCol[k * 3 + 1] = this.pBase[k * 3 + 1]! * f; this.pCol[k * 3 + 2] = this.pBase[k * 3 + 2]! * f;
    }
    if (any) {
      this.points.geometry.attributes.position!.needsUpdate = true;
      this.points.geometry.attributes.color!.needsUpdate = true;
    }
  }
}
