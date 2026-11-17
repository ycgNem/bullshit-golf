// Course data exported from Blender: height grid, surface masks, hazards and prop placements.
// Blender coordinates are (bx across, by along the hole, bz up). The game uses three.js axes:
//   x = bx, y = bz, z = -by.

export type Surface = 'tee' | 'fairway' | 'green' | 'rough' | 'sand' | 'path' | 'water' | 'ob';

export interface PropData {
  kind: string;
  x: number;
  y: number;
  z: number;
  /** degrees about the up axis */
  yaw: number;
  seed?: number;
  float?: number;
  length?: number;
}

export interface HoleJson {
  key: string;
  number: number;
  par: number;
  name: string;
  bounds: [number, number, number, number];
  step: number;
  nx: number;
  ny: number;
  tee: [number, number];
  teeZ: number;
  pins: [number, number][];
  waterZ: number;
  pond: [number, number][] | null;
  river: { pts: [number, number][]; halfWidth: number } | null;
  /** [bx, by, bz, yaw_rad, scale, z_scale, variant] */
  trees: number[][];
  props: PropData[];
}

/** A raised deck (the bridge) that overrides the ground height inside an oriented rectangle. */
export interface Platform {
  x: number;
  z: number;
  hx: number;
  hz: number;
  yaw: number;
  top: number;
}

/** Per-hole facts that are not in the export. `play` is the in-bounds rectangle in Blender coordinates. */
const EXTRA: Record<string, { play: [number, number, number, number]; riverCore: number }> = {
  h7: { play: [-74, 74, -122, 122], riverCore: 0 },
  h8: { play: [-94, 106, -46, 514], riverCore: 8 },
};

export const HOLE_KEYS = ['h7', 'h8'] as const;
export type HoleKey = (typeof HOLE_KEYS)[number];

const BASE = `${import.meta.env.BASE_URL}assets/`;
export const assetUrl = (name: string): string => BASE + name;

async function loadMask(url: string): Promise<{ data: Uint8ClampedArray; w: number; h: number }> {
  const img = new Image();
  img.src = url;
  await img.decode();
  const cv = document.createElement('canvas');
  cv.width = img.naturalWidth;
  cv.height = img.naturalHeight;
  const ctx = cv.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0);
  const id = ctx.getImageData(0, 0, cv.width, cv.height);
  return { data: id.data, w: cv.width, h: cv.height };
}

export class Course {
  readonly x0: number;
  readonly x1: number;
  readonly y0: number;
  readonly y1: number;
  readonly step: number;
  readonly nx: number;
  readonly ny: number;
  readonly waterZ: number;
  readonly platforms: Platform[] = [];
  pinIndex = 0;
  private readonly play: [number, number, number, number];
  private readonly pondBox: [number, number, number, number] | null = null;
  private readonly riverPts: [number, number][] | null;
  private readonly riverReach: number;

  private constructor(
    readonly json: HoleJson,
    readonly heights: Float32Array,
    private readonly maskA: Uint8ClampedArray,
    private readonly maskB: Uint8ClampedArray,
    private readonly mw: number,
    private readonly mh: number,
  ) {
    [this.x0, this.x1, this.y0, this.y1] = json.bounds;
    this.step = json.step;
    this.nx = json.nx;
    this.ny = json.ny;
    this.waterZ = json.waterZ;
    this.play = EXTRA[json.key]?.play ?? json.bounds;
    if (json.pond) {
      let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity;
      for (const [px, py] of json.pond) {
        a = Math.min(a, px); b = Math.max(b, px); c = Math.min(c, py); d = Math.max(d, py);
      }
      this.pondBox = [a - 4, b + 4, c - 4, d + 4];
    }
    this.riverPts = json.river ? json.river.pts : null;
    this.riverReach = json.river ? json.river.halfWidth + 4 : 0;
    for (const p of json.props) {
      if (p.kind === 'bridge') {
        const L = p.length ?? 24;
        const yaw = (p.yaw * Math.PI) / 180;
        // The deck runs along +by from the prop origin; centre it.
        const cbx = p.x - Math.sin(yaw) * (L / 2);
        const cby = p.y + Math.cos(yaw) * (L / 2);
        this.platforms.push({ x: cbx, z: -cby, hx: 1.2, hz: L / 2, yaw, top: p.z });
      }
    }
  }

  static async load(key: HoleKey): Promise<Course> {
    const [json, bin, a, b] = await Promise.all([
      fetch(assetUrl(`${key}.json`)).then((r) => r.json() as Promise<HoleJson>),
      fetch(assetUrl(`${key}_h.bin`)).then((r) => r.arrayBuffer()),
      loadMask(assetUrl(`${key}_a.png`)),
      loadMask(assetUrl(`${key}_b.png`)),
    ]);
    return new Course(json, new Float32Array(bin), a.data, b.data, a.w, a.h);
  }

  get key(): string { return this.json.key; }
  get par(): number { return this.json.par; }
  get teeX(): number { return this.json.tee[0]; }
  get teeZ(): number { return -this.json.tee[1]; }
  get cupX(): number { return this.json.pins[this.pinIndex]![0]; }
  get cupZ(): number { return -this.json.pins[this.pinIndex]![1]; }

  /** Bare terrain height (no bridge deck). */
  terrainAt(x: number, z: number): number {
    const fx = Math.min(Math.max((x - this.x0) / this.step, 0), this.nx - 1.001);
    const fy = Math.min(Math.max((-z - this.y0) / this.step, 0), this.ny - 1.001);
    const i = Math.floor(fx), j = Math.floor(fy);
    const u = fx - i, v = fy - j;
    const h = this.heights, k = j * this.nx + i;
    const a = h[k]!, b = h[k + 1]!, c = h[k + this.nx]!, d = h[k + this.nx + 1]!;
    return (a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v;
  }

  private platformAt(x: number, z: number): Platform | null {
    for (const p of this.platforms) {
      const dx = x - p.x, dz = z - p.z;
      const c = Math.cos(p.yaw), s = Math.sin(p.yaw);
      const lx = dx * c - dz * s, lz = dx * s + dz * c;
      if (Math.abs(lx) <= p.hx && Math.abs(lz) <= p.hz) return p;
    }
    return null;
  }

  /** Height a ball rests on: terrain, or the bridge deck. */
  groundAt(x: number, z: number): number {
    const t = this.terrainAt(x, z);
    if (this.platforms.length) {
      const p = this.platformAt(x, z);
      if (p && p.top > t) return p.top;
    }
    return t;
  }

  /** Unit ground normal written into out (x, y, z). */
  normalAt(x: number, z: number, out: { x: number; y: number; z: number }): void {
    if (this.platforms.length && this.platformAt(x, z)) { out.x = 0; out.y = 1; out.z = 0; return; }
    const e = this.step;
    const dx = (this.terrainAt(x + e, z) - this.terrainAt(x - e, z)) / (2 * e);
    const dz = (this.terrainAt(x, z + e) - this.terrainAt(x, z - e)) / (2 * e);
    const l = Math.hypot(dx, 1, dz);
    out.x = -dx / l; out.y = 1 / l; out.z = -dz / l;
  }

  private maskIndex(x: number, z: number): number {
    const px = Math.round(((x - this.x0) / (this.x1 - this.x0)) * (this.mw - 1));
    const py = Math.round(((this.y1 + z) / (this.y1 - this.y0)) * (this.mh - 1));
    const cx = Math.min(Math.max(px, 0), this.mw - 1);
    const cy = Math.min(Math.max(py, 0), this.mh - 1);
    return (cy * this.mw + cx) * 4;
  }

  greenAt(x: number, z: number): number { return this.maskA[this.maskIndex(x, z) + 1]! / 255; }

  private riverDist(x: number, z: number): number {
    const pts = this.riverPts;
    if (!pts) return Infinity;
    const by = -z;
    let best = Infinity;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i]!, b = pts[i + 1]!;
      const ex = b[0] - a[0], ey = b[1] - a[1];
      const t = Math.min(Math.max(((x - a[0]) * ex + (by - a[1]) * ey) / (ex * ex + ey * ey), 0), 1);
      const d = Math.hypot(x - a[0] - t * ex, by - a[1] - t * ey);
      if (d < best) best = d;
    }
    return best;
  }

  /** Nearest river direction (unit, game xz) or null when the hole has no river. */
  riverFlow(x: number, z: number, out: { x: number; z: number }): number {
    const pts = this.riverPts;
    if (!pts) return Infinity;
    const by = -z;
    let best = Infinity;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i]!, b = pts[i + 1]!;
      const ex = b[0] - a[0], ey = b[1] - a[1];
      const t = Math.min(Math.max(((x - a[0]) * ex + (by - a[1]) * ey) / (ex * ex + ey * ey), 0), 1);
      const d = Math.hypot(x - a[0] - t * ex, by - a[1] - t * ey);
      if (d < best) {
        best = d;
        const l = Math.hypot(ex, ey);
        out.x = ex / l; out.z = -ey / l;
      }
    }
    return best;
  }

  /** True where standing water covers the ground. */
  inWater(x: number, z: number): boolean {
    if (this.terrainAt(x, z) > this.waterZ - 0.03) return false;
    if (this.platforms.length && this.platformAt(x, z)) return false;
    return this.nearWaterBody(x, z);
  }

  nearWaterBody(x: number, z: number): boolean {
    const pb = this.pondBox;
    if (pb && x > pb[0] && x < pb[1] && -z > pb[2] && -z < pb[3]) return true;
    return this.riverPts !== null && this.riverDist(x, z) < this.riverReach;
  }

  inBounds(x: number, z: number): boolean {
    const p = this.play;
    return x > p[0] && x < p[1] && -z > p[2] && -z < p[3];
  }

  surfaceAt(x: number, z: number): Surface {
    if (!this.inBounds(x, z)) return 'ob';
    if (this.platforms.length && this.platformAt(x, z)) return 'path';
    if (this.inWater(x, z)) return 'water';
    const k = this.maskIndex(x, z);
    const fair = this.maskA[k]!, green = this.maskA[k + 1]!, sand = this.maskA[k + 2]!, path = this.maskB[k]!;
    if (sand > 127) return 'sand';
    if (green > 127) return 'green';
    if (path > 127) return 'path';
    if (fair > 127) {
      const t = this.json.tee;
      return Math.abs(x - t[0]) < 5.2 && Math.abs(-z - t[1]) < 7.2 ? 'tee' : 'fairway';
    }
    return 'rough';
  }
}
