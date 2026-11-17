import * as THREE from 'three';
import { BALL_R, G } from './aero';
import { Sfx } from './audio';
import { drawCards, type Card } from './cards';
import { CLUBS, PUTTER, yards, type Club } from './clubs';
import { Course, HOLE_KEYS, type HoleKey, type Surface } from './course';
import { Fx } from './fx';
import { Hud, type MarshalState } from './hud';
import { line, type LineKey } from './lines';
import { BallSim, SURF, buildColliders, predictFlight, type Collider, type SimEnv, type SimEvent, type TreeGrid } from './physics';
import { UPGRADES, freshSave, loadSave, storeSave, upgradeCost, type Save, type UpgradeId } from './save';
import { World } from './world';

type Mode = 'boot' | 'menu' | 'loading' | 'intro' | 'cards' | 'aim' | 'power' | 'strike' | 'flight' | 'settle' | 'holed' | 'summary' | 'dq' | 'results';
type ShotKind = 'pure' | 'good' | 'ok' | 'hook' | 'slice' | 'shank' | 'chunk' | 'top' | 'yip';

interface Round { week: number; holeIdx: number; scores: number[]; earned: number; suspicion: number }
interface HoleState {
  strokes: number;
  card: Card | null;
  juice: number;
  juiceMax: number;
  usedJuice: boolean;
  foot: boolean;
  mulligan: boolean;
  laser: boolean;
  pures: number;
  prev: { x: number; z: number; strokes: number; juice: number } | null;
}

const DEG = Math.PI / 180;
const SIM_DT = 1 / 240;
/** Swing bar layout: sweet line, 100% power line (the rest is the overswing zone). */
const U0 = 0.14, U1 = 0.88;
const RISE = (U1 - U0) / 1.0;
const SPIN_RATE = (2600 * 2 * Math.PI) / 60;           // after-touch: rpm added per real second, in rad/s
const HONEST_RELIEF = 15;
const H8_LINE: [number, number][] = [[0, 0], [0, 28], [-8, 90], [-5, 170], [4, 250], [2, 320], [-4, 366]];
const PAYOUT: [number, number, string, string][] = [
  // [strokes relative to par (<=), prize, name, css class]
  [-3, 1800, 'ALBATROSS', 'under'], [-2, 1100, 'EAGLE', 'under'], [-1, 500, 'BIRDIE', 'under'], [0, 220, 'PAR', ''],
  [1, 90, 'BOGEY', 'over'], [2, 35, 'DOUBLE BOGEY', 'over'], [3, 10, 'TRIPLE BOGEY', 'over'],
];

const LIE: Record<Surface, { label: string; window: number; speed: number; spin: number }> = {
  tee: { label: 'TEE', window: 1.1, speed: 1, spin: 1 },
  fairway: { label: 'FAIRWAY', window: 1, speed: 1, spin: 1 },
  green: { label: 'GREEN', window: 1, speed: 1, spin: 1 },
  rough: { label: 'ROUGH', window: 0.72, speed: 0.84, spin: 0.6 },
  sand: { label: 'BUNKER', window: 0.6, speed: 0.72, spin: 0.8 },
  path: { label: 'CART PATH', window: 0.8, speed: 0.97, spin: 0.9 },
  water: { label: 'WATER', window: 1, speed: 1, spin: 1 },
  ob: { label: 'OUT OF BOUNDS', window: 1, speed: 1, spin: 1 },
};

const rand = (a: number, b: number): number => a + Math.random() * (b - a);
const clamp = (x: number, a: number, b: number): number => Math.min(Math.max(x, a), b);
const damp = (rate: number, dt: number): number => 1 - Math.exp(-rate * dt);

export class Game {
  private readonly world: World;
  private readonly hud: Hud;
  private readonly sfx = new Sfx();
  private fx!: Fx;
  private save: Save = loadSave();
  private mode: Mode = 'boot';
  private modeTime = 0;
  private paused = false;
  private readonly keys = new Set<string>();
  private readonly courses = new Map<HoleKey, Course>();
  private readonly colliderCache = new Map<HoleKey, { colliders: Collider[]; trees: TreeGrid }>();
  private builtKey: HoleKey | null = null;
  private course!: Course;
  private env!: SimEnv;
  private sim!: BallSim;
  private round: Round | null = null;
  private hole: HoleState = this.freshHole();
  private extras: THREE.Object3D[] = [];

  // aiming and swing
  private aimYaw = 0;
  private clubIdx = 0;
  private aimDirty = true;
  private meterU = U0;
  private meterDir = 1;
  private powerU = -1;
  private strikeSpeed = 0.9;
  private windowS = 0.08;
  private puttMax = 0;
  private dragX: number | null = null;

  // flight
  private timeScale = 1;
  private simAcc = 0;
  private steering = false;
  private steerTime = 0;
  private shotSpin0 = new THREE.Vector3();
  private kicked = false;
  private said = new Set<string>();
  private readonly flightDir = new THREE.Vector3(0, 0, -1);
  private caughtTimer = 0;
  private whistleCool = 0;
  private settleTimer = 0;
  private afterSettle: (() => void) | null = null;

  // marshal
  private marshal: MarshalState = 'away';
  private marshalTimer = 4;

  // camera
  private readonly camPos = new THREE.Vector3();
  private readonly camLook = new THREE.Vector3();
  private readonly wantPos = new THREE.Vector3();
  private readonly wantLook = new THREE.Vector3();
  private camSnap = true;
  private fovWant = 52;
  private worldTime = 0;
  private last = 0;
  private dqCart: THREE.Object3D | null = null;
  private readonly tmp = new THREE.Vector3();
  private readonly tmp2 = new THREE.Vector3();

  constructor(canvas: HTMLCanvasElement, ui: HTMLElement) {
    this.world = new World(canvas);
    this.hud = new Hud(ui, () => { this.sfx.unlock(); this.sfx.click(); });
    this.sfx.setVolume(this.save.volume);
    this.world.setQuality(this.save.quality);
    window.addEventListener('resize', () => {
      this.world.resize();
      this.fx?.resize(window.innerWidth, window.innerHeight);
    });
    window.addEventListener('keydown', (e) => this.onKey(e));
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    canvas.addEventListener('pointerdown', (e) => {
      this.sfx.unlock();
      if (this.mode === 'aim') this.dragX = e.clientX;
      else this.action();
    });
    window.addEventListener('pointermove', (e) => {
      if (this.dragX === null || this.mode !== 'aim') return;
      this.aimYaw += (e.clientX - this.dragX) * (this.club.kind === 'putter' ? 0.0012 : 0.0028);
      this.dragX = e.clientX;
      this.aimDirty = true;
    });
    window.addEventListener('pointerup', () => { this.dragX = null; });
    canvas.addEventListener('wheel', (e) => { if (this.mode === 'aim') this.changeClub(e.deltaY > 0 ? 1 : -1); }, { passive: true });
  }

  async boot(): Promise<void> {
    this.hud.showLoading('Mowing the fairways', 0);
    await this.world.loadShared((f) => this.hud.showLoading(f < 0.5 ? 'Mowing the fairways' : 'Feeding the alligators', f * 0.8));
    this.fx = new Fx(this.world);
    this.fx.resize(window.innerWidth, window.innerHeight);
    this.hud.showLoading('Waking the marshal', 0.9);
    await this.prepareHole('h7', 0);
    this.toMenu();
    this.last = performance.now();
    requestAnimationFrame((t) => this.frame(t));
  }

  // ------------------------------------------------------------------ flow

  private freshHole(): HoleState {
    const lvl = this.save?.upgrades.juice ?? 0;
    const j = 2.5 + 0.5 * lvl;
    return { strokes: 0, card: null, juice: j, juiceMax: j, usedJuice: false, foot: false, mulligan: false, laser: false, pures: 0, prev: null };
  }

  private setMode(m: Mode): void {
    this.mode = m;
    this.modeTime = 0;
  }

  private toMenu(): void {
    this.round = null;
    this.paused = false;
    this.setMode('menu');
    this.camSnap = true;
    this.hud.showHud(false);
    this.fx.setAim(null);
    this.fx.setLaser(null);
    this.fx.trailReset();
    this.sfx.slowmo(0);
    this.showMenu();
  }

  private showMenu(): void {
    this.hud.showMenu(this.save, {
      play: () => void this.startRound(),
      shop: () => this.showShop(() => this.showMenu()),
      how: () => this.hud.showHow(() => this.showMenu()),
      settings: () => this.showSettings(() => this.showMenu()),
    });
  }

  private showShop(back: () => void, backLabel = 'BACK'): void {
    this.hud.showShop(this.save, {
      buy: (id: UpgradeId) => {
        const u = UPGRADES.find((x) => x.id === id)!;
        const lvl = this.save.upgrades[id];
        const cost = upgradeCost(u, lvl);
        if (lvl >= u.max || cost > this.save.money) { this.sfx.deny(); return; }
        this.save.money -= cost;
        this.save.upgrades[id] = lvl + 1;
        storeSave(this.save);
        this.sfx.kaching();
        this.showShop(back, backLabel);
      },
      back,
    }, backLabel);
  }

  private showSettings(back: () => void): void {
    this.hud.showSettings(this.save, {
      volume: (v) => { this.save.volume = v; this.sfx.setVolume(v); storeSave(this.save); },
      quality: (q) => { this.save.quality = q; this.world.setQuality(q); storeSave(this.save); this.showSettings(back); },
      reset: () => {
        if (!window.confirm('Reset all progress, money and upgrades?')) return;
        const keep = { volume: this.save.volume, quality: this.save.quality };
        this.save = { ...freshSave(), ...keep };
        storeSave(this.save);
        this.showSettings(back);
      },
      back,
    });
  }

  private async startRound(): Promise<void> {
    this.round = { week: this.save.week, holeIdx: 0, scores: [], earned: 0, suspicion: 0 };
    await this.enterHole(0);
  }

  /** Load (or reuse) a hole and put the ball on its tee. */
  private async prepareHole(key: HoleKey, pin: number): Promise<void> {
    let course = this.courses.get(key);
    if (!course) {
      course = await Course.load(key);
      this.courses.set(key, course);
    }
    course.pinIndex = pin % course.json.pins.length;
    if (this.builtKey !== key) {
      await this.world.buildHole(course);
      this.builtKey = key;
    }
    let col = this.colliderCache.get(key);
    if (!col) this.colliderCache.set(key, (col = buildColliders(course, this.world.trees)));
    for (const o of this.extras) this.world.scene.remove(o);
    this.extras = [];
    this.course = course;
    this.env = {
      course, wind: new THREE.Vector3(), colliders: col.colliders.slice(), trees: col.trees,
      cupX: course.cupX, cupZ: course.cupZ, cupY: course.terrainAt(course.cupX, course.cupZ), cupR: 0.054, magnet: false, greenSlow: 1,
    };
    this.world.setCup(course.cupX, course.cupZ, 0.054);
    this.world.setGreenWet(0);
    this.world.wind.set(0, 0, 0);
    this.sim = new BallSim(this.env);
    this.sim.place(course.teeX, course.teeZ);
  }

  private async enterHole(idx: number): Promise<void> {
    const round = this.round!;
    round.holeIdx = idx;
    const key = HOLE_KEYS[idx]!;
    this.setMode('loading');
    this.hud.showHud(false);
    this.hud.showVeil(`Walking to hole ${key === 'h7' ? 7 : 8}`);
    await new Promise((r) => setTimeout(r, 50));
    await this.prepareHole(key, round.week - 1);
    const c = this.course;

    const sp = Math.min(11, rand(1.5, 4.5) + 1.3 * (round.week - 1)) * (1 - 0.1 * this.save.upgrades.ball);
    const wa = rand(0, Math.PI * 2);
    this.env.wind.set(Math.cos(wa) * sp, 0, Math.sin(wa) * sp);
    this.world.wind.copy(this.env.wind);

    this.hole = this.freshHole();
    this.marshal = 'away';
    this.marshalTimer = rand(3, 5);
    this.fx.trailReset();
    this.fx.setAim(null);
    this.fx.setLaser(null);
    const len = Math.hypot(c.cupX - c.teeX, c.cupZ - c.teeZ);
    this.hud.setHole(`HOLE ${c.json.number}`, `PAR ${c.par} · ${yards(len)} YDS · ${c.json.name.toUpperCase()}`);
    this.hud.setCard(null);
    this.hud.clearScreen();
    this.setMode('intro');
    this.camSnap = true;
    this.hud.caption(line(key === 'h7' ? 'intro7' : 'intro8'), 6);
    this.hud.toast(c.json.name.toUpperCase(), 'plain', 3);
    this.hud.showHud(true);
    this.hud.showMeter(false);
  }

  private showCards(): void {
    const round = this.round!;
    this.setMode('cards');
    const c = this.course;
    this.hud.showCards(`HOLE ${c.json.number} · PAR ${c.par}`, drawCards(3 + this.save.upgrades.sleeve), round.suspicion, HONEST_RELIEF, (id) => {
      this.hud.clearScreen();
      const card = id ? drawCardById(id) : null;
      if (card) this.applyCard(card);
      else this.hud.caption(line('honest'));
      this.beginAim(true);
      if (round.suspicion >= 100) this.disqualify('The marshal watched your caddie hand it to you.');
    });
  }

  private susFactor(): number { return 1 - 0.1 * this.save.upgrades.xmas; }

  private addSuspicion(n: number): void {
    const r = this.round;
    if (!r) return;
    const before = r.suspicion;
    r.suspicion = clamp(r.suspicion + n * (n > 0 ? this.susFactor() : 1), 0, 100);
    if (before < 70 && r.suspicion >= 70 && r.suspicion < 100) this.hud.caption(line('suspicious'));
  }

  private applyCard(card: Card): void {
    const h = this.hole, env = this.env, c = this.course;
    h.card = card;
    this.addSuspicion(card.heat);
    this.sfx.cardFlip();
    this.hud.caption(line('card'));
    this.hud.toast(card.name.toUpperCase(), 'cheat', 2);
    switch (card.id) {
      case 'magnet': env.magnet = true; break;
      case 'wind': env.wind.set(0, 0, 0); this.world.wind.set(0, 0, 0); break;
      case 'foot': h.foot = true; break;
      case 'bigcup': env.cupR = 0.162; this.world.setCup(env.cupX, env.cupZ, env.cupR); break;
      case 'juice': h.juice += 2.5; h.juiceMax += 2.5; break;
      case 'mulligan': h.mulligan = true; break;
      case 'sprinkler': env.greenSlow = 1.9; this.world.setGreenWet(1); break;
      case 'laser': h.laser = true; break;
      case 'backstop': {
        const dx = c.cupX - c.teeX, dz = c.cupZ - c.teeZ, l = Math.hypot(dx, dz);
        const x = c.cupX + (dx / l) * 2.4, z = c.cupZ + (dz / l) * 2.4;
        const yaw = Math.atan2(dx, dz) + Math.PI / 2;
        const cart = this.world.spawn('cart');
        const y = c.terrainAt(x, z);
        cart.position.set(x, y, z);
        cart.rotation.y = yaw;
        this.world.scene.add(cart);
        this.extras.push(cart);
        env.colliders.push({ shape: 'box', x, y: y + 0.95, z, hx: 0.62, hy: 0.95, hz: 1.25, yaw, e: 0.3, tag: 'backstop' });
        break;
      }
    }
    this.hud.setCard(card);
  }

  // ------------------------------------------------------------------- aim

  private get club(): Club { return CLUBS[this.clubIdx]!; }
  private get surface(): Surface { return this.course.surfaceAt(this.sim.pos.x, this.sim.pos.z); }
  private pinDist(): number { return Math.hypot(this.env.cupX - this.sim.pos.x, this.env.cupZ - this.sim.pos.z); }

  /** Where a sensible golfer would aim: the pin when it is in range, else down the fairway. */
  private targetPoint(out: THREE.Vector3): void {
    const p = this.sim.pos, c = this.course;
    if (c.key !== 'h8' || this.pinDist() < 250) { out.set(this.env.cupX, 0, this.env.cupZ); return; }
    const by = Math.min(-p.z + 235, 354);
    let x = 0;
    for (let i = 0; i < H8_LINE.length - 1; i++) {
      const a = H8_LINE[i]!, b = H8_LINE[i + 1]!;
      if (by >= a[1] && by <= b[1]) x = a[0] + ((b[0] - a[0]) * (by - a[1])) / (b[1] - a[1]);
    }
    out.set(x, 0, -by);
  }

  private autoClub(): void {
    const s = this.surface, d = this.pinDist();
    if (s === 'green') { this.clubIdx = CLUBS.indexOf(PUTTER); return; }
    this.targetPoint(this.tmp);
    const want = Math.hypot(this.tmp.x - this.sim.pos.x, this.tmp.z - this.sim.pos.z) * (s === 'rough' ? 1.12 : s === 'sand' ? 1.25 : 1);
    let best = s === 'tee' ? 0 : 1, err = Infinity;
    for (let i = s === 'tee' ? 0 : 1; i < CLUBS.length - 1; i++) {
      const c = CLUBS[i]!;
      const reach = c.carry * (c.kind === 'wedge' ? 1.02 : 1.06);
      const e = Math.abs(reach - want) + (reach < want ? 0 : 3);
      if (e < err) { err = e; best = i; }
    }
    if (s === 'sand' && d < 70) best = CLUBS.findIndex((c) => c.id === 'SW');
    this.clubIdx = best;
  }

  private beginAim(first = false): void {
    this.setMode('aim');
    this.hud.showMeter(false);
    this.targetPoint(this.tmp);
    this.aimYaw = Math.atan2(this.tmp.x - this.sim.pos.x, -(this.tmp.z - this.sim.pos.z));
    this.autoClub();
    this.aimDirty = true;
    this.timeScale = 1;
    this.steering = false;
    this.sfx.slowmo(0);
    this.fx.trailReset();
    this.fx.showPeg(this.hole.strokes === 0 && this.surface === 'tee', this.sim.pos);
    if (first) this.camSnap = true;
  }

  private changeClub(d: number): void {
    const n = clamp(this.clubIdx + d, 0, CLUBS.length - 1);
    if (n === this.clubIdx) return;
    this.clubIdx = n;
    this.aimDirty = true;
    this.sfx.tick();
  }

  private putterMax(): number {
    const reach = clamp(this.pinDist() * 1.6, 4, 45);
    return Math.sqrt(2 * SURF.green.roll * this.env.greenSlow * G * reach);
  }

  private weekWindow(): number {
    const week = this.round?.week ?? 1;
    return Math.max(0.6, 1 - 0.06 * (week - 1)) * (1 + 0.08 * this.save.upgrades.tape);
  }

  private launchVectors(power: number, speedK: number, faceDeg: number, tiltDeg: number, launchAdd: number, spinK: number, vel: THREE.Vector3, spin: THREE.Vector3): void {
    const club = this.club, lie = LIE[this.surface];
    const yaw = this.aimYaw + faceDeg * DEG;
    const fx = Math.sin(yaw), fz = -Math.cos(yaw);
    if (club.kind === 'putter') {
      vel.set(fx, 0, fz).multiplyScalar(this.puttMax * power * speedK);
      spin.set(0, 0, 0);
      return;
    }
    const wedgeOut = this.surface === 'sand' && club.kind === 'wedge';
    const speed = club.speed * power * speedK * (wedgeOut ? 0.9 : lie.speed) * (1 + 0.02 * this.save.upgrades.gym);
    const L = clamp(club.launch + launchAdd, 1.5, 60) * DEG;
    vel.set(fx * Math.cos(L), Math.sin(L), fz * Math.cos(L)).multiplyScalar(speed);
    const w = ((club.spin * 2 * Math.PI) / 60) * (0.55 + 0.45 * Math.min(1, power)) * spinK * lie.spin;
    const t = tiltDeg * DEG;
    // backspin about the right-hand axis; a tilted axis makes it curve (negative y spin curves right)
    spin.set(-fz * w * Math.cos(t), -w * Math.sin(t), fx * w * Math.cos(t));
  }

  private refreshAim(): void {
    this.aimDirty = false;
    const club = this.club, p = this.sim.pos;
    const fx = Math.sin(this.aimYaw), fz = -Math.cos(this.aimYaw);
    if (club.kind === 'putter') {
      this.puttMax = this.putterMax();
      this.fx.setAim(this.course, p, fx, fz, Math.min(this.pinDist() * 1.15 + 0.6, 30), false);
      this.fx.setLaser(null);
      return;
    }
    const lie = LIE[this.surface];
    this.fx.setAim(this.course, p, fx, fz, club.carry * lie.speed * (1 + 0.02 * this.save.upgrades.gym), true);
    if (this.hole.laser) {
      const v = new THREE.Vector3(), w = new THREE.Vector3();
      this.launchVectors(1, 1, 0, 0, 0, 1, v, w);
      this.fx.setLaser(predictFlight(this.env, p, v, w));
    } else this.fx.setLaser(null);
  }

  private startSwing(): void {
    const club = this.club, lie = LIE[this.surface];
    this.setMode('power');
    this.meterU = U0;
    this.meterDir = 1;
    this.powerU = -1;
    const week = this.round?.week ?? 1;
    this.strikeSpeed = (club.kind === 'putter' ? 0.72 : 0.9) * Math.min(1.35, 1 + 0.05 * (week - 1));
    const wedgeOut = this.surface === 'sand' && club.kind === 'wedge';
    this.windowS = (club.window / 1000) * (wedgeOut ? 0.85 : lie.window) * this.weekWindow();
    if (club.kind === 'putter') this.puttMax = this.putterMax();
    this.hud.showMeter(true, 'POWER');
    this.sfx.tick();
  }

  private meterTick(): number {
    if (this.club.kind !== 'putter') return -1;
    const reach = clamp(this.pinDist() * 1.6, 4, 45);
    return U0 + Math.sqrt(this.pinDist() / reach) * (U1 - U0);
  }

  private currentWindowU(): number {
    const p = this.powerU >= 0 ? (this.powerU - U0) / (U1 - U0) : 1;
    return this.strikeSpeed * this.windowS * (p > 1 ? Math.max(0.35, 1 - 2.2 * (p - 1)) : 1);
  }

  /** Space, Enter or a click: the one action button. */
  private action(): void {
    if (this.paused) return;
    switch (this.mode) {
      case 'intro': this.showCards(); break;
      case 'aim': this.startSwing(); break;
      case 'power':
        if (this.meterU < U0 + 0.03) break;
        this.powerU = this.meterU;
        this.setMode('strike');
        this.hud.showMeter(true, 'STRIKE ON THE LINE');
        this.sfx.tick();
        break;
      case 'strike': this.strike((U0 - this.meterU) / this.strikeSpeed); break;
      default: break;
    }
  }

  /** errS: seconds late (positive) or early (negative) relative to the sweet line. */
  private strike(errS: number): void {
    const club = this.club, h = this.hole, sim = this.sim;
    const power = clamp((this.powerU - U0) / (U1 - U0), 0.06, 1.2);
    const win = this.windowS * (power > 1 ? Math.max(0.35, 1 - 2.2 * (power - 1)) : 1);
    const q = errS / win, aq = Math.abs(q), sg = Math.sign(q) || 1;
    let kind: ShotKind, speedK = 1, face = 0, tilt = 0, launchAdd = 0, spinK = 1;
    const putter = club.kind === 'putter';
    const curve = club.kind === 'wood' ? 1.25 : club.kind === 'wedge' ? 0.8 : 1;
    if (aq <= 0.2) {
      kind = 'pure'; speedK = putter ? 1 : 1.012; face = q * (putter ? 0.3 : 1); tilt = q * 4;
    } else if (aq <= 1) {
      kind = aq < 0.55 ? 'good' : aq < 0.8 ? 'ok' : putter ? 'ok' : q < 0 ? 'hook' : 'slice';
      speedK = 1 - (putter ? 0.04 : 0.07) * aq * aq; face = q * (putter ? 1.5 : 3); tilt = q * 13 * curve;
    } else if (aq <= 1.8) {
      const x = aq - 1;
      if (putter) { kind = 'yip'; face = sg * (1.5 + 4 * x); speedK = 1 + rand(-0.18, 0.2); }
      else { kind = q < 0 ? 'hook' : 'slice'; speedK = 0.92 - 0.25 * x; face = sg * (3 + 9 * x); tilt = sg * (13 + 30 * x) * curve; }
    } else if (putter) {
      kind = 'yip'; face = rand(-7, 7); speedK = Math.random() < 0.5 ? 0.4 : 1.45;
    } else if (q < 0) {
      kind = 'chunk'; speedK = rand(0.28, 0.42); launchAdd = 5; spinK = 0.5; face = rand(-6, 6);
    } else if (aq > 3.2) {
      kind = 'top'; speedK = 0.5; launchAdd = -club.launch + 2; spinK = -0.4; face = rand(-5, 5);
    } else {
      kind = 'shank'; speedK = 0.5; face = rand(38, 55); launchAdd = -3; tilt = 20;
    }
    if (this.surface === 'rough' && !putter) speedK *= rand(0.94, 1.08);

    h.prev = { x: sim.pos.x, z: sim.pos.z, strokes: h.strokes, juice: h.juice };
    h.strokes++;
    const vel = new THREE.Vector3(), spin = new THREE.Vector3();
    const lieNow = this.surface;
    this.launchVectors(power, speedK, face, tilt, launchAdd, spinK, vel, spin);
    this.flightDir.set(Math.sin(this.aimYaw), 0, -Math.cos(this.aimYaw));
    sim.launch(vel, spin, (Math.random() * 1e9) | 0);
    this.shotSpin0.copy(spin);
    this.kicked = false;
    this.beginFlight();

    // feedback
    this.sfx.whoosh(power);
    this.sfx.strike(putter ? 'putt' : kind === 'pure' ? 'pure' : kind === 'good' || kind === 'ok' ? 'ok' : 'bad', power);
    if (!putter) this.fx.burst(lieNow === 'sand' ? 'sand' : 'turf', sim.pos, kind === 'chunk' ? 1.6 : 0.6 * power);
    if (kind === 'pure') {
      h.pures++;
      this.fx.burst('pure', sim.pos, 1);
      this.hud.toast(putter ? 'PURE ROLL' : 'PURE', 'good');
      if (!putter) this.say('pure', 0.9);
    } else if (kind === 'shank' || kind === 'chunk' || kind === 'top' || kind === 'yip') {
      this.hud.toast(kind === 'yip' ? 'YIPPED IT' : kind === 'top' ? 'TOPPED IT' : `${kind.toUpperCase()}!`, 'bad', 2.2);
      this.sfx.trombone();
      this.say(kind, 0.7);
    } else if (kind === 'hook' || kind === 'slice') {
      this.hud.toast(aq > 1 ? `BIG ${kind.toUpperCase()}` : kind.toUpperCase(), 'bad', 1.6);
      this.say(kind, 1.2);
    } else if (kind === 'good' && !putter && Math.random() < 0.5) this.say('good', 1.2);
  }

  private pending: { key: LineKey; at: number }[] = [];
  /** Queue a booth line a moment from now. */
  private say(key: LineKey, delay = 0): void {
    this.pending.push({ key, at: this.worldReal + delay });
  }
  private worldReal = 0;

  private beginFlight(): void {
    this.setMode('flight');
    this.hud.showMeter(false);
    this.fx.setAim(null);
    this.fx.setLaser(null);
    this.fx.showPeg(false);
    this.fx.trailReset();
    this.simAcc = 0;
    this.steerTime = 0;
    this.said.clear();
    this.sim.events.length = 0;
  }

  private footWedge(): void {
    const h = this.hole;
    if (!h.foot || this.surface === 'green') { this.sfx.deny(); return; }
    h.foot = false;
    this.addSuspicion(this.marshal === 'watching' ? 35 : 8);
    if (this.marshal === 'watching') { this.flashCaught(); this.say('caught', 0.8); } else this.say('foot', 0.4);
    const fx = Math.sin(this.aimYaw), fz = -Math.cos(this.aimYaw);
    this.flightDir.set(fx, 0, fz);
    this.sim.launch(new THREE.Vector3(fx * 9.8, 6.2, fz * 9.8), new THREE.Vector3(-fz * 40, 0, fx * 40), (Math.random() * 1e9) | 0);
    this.kicked = true;
    this.sfx.kick();
    this.hud.toast('FOOT WEDGE', 'cheat');
    this.hud.setCard(h.card, 'used');
    this.beginFlight();
  }

  private takeMulligan(): void {
    const h = this.hole;
    if (!h.mulligan || !h.prev) { this.sfx.deny(); return; }
    h.mulligan = false;
    this.addSuspicion(this.marshal === 'watching' ? 22 : 4);
    this.sim.place(h.prev.x, h.prev.z);
    h.strokes = h.prev.strokes;
    h.prev = null;
    this.hud.toast('MULLIGAN', 'cheat');
    this.hud.setCard(h.card, 'used');
    this.say('mulligan', 0.3);
    this.sfx.cardFlip();
    this.beginAim();
  }

  // ---------------------------------------------------------------- flight

  private flashCaught(): void {
    this.caughtTimer = 0.9;
    if (this.whistleCool <= 0) {
      this.sfx.whistle();
      this.whistleCool = 2.5;
    }
  }

  private updateFlight(dt: number): void {
    const sim = this.sim, h = this.hole, k = this.keys;
    const sx = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    const sy = (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0) - (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0);
    const canSteer = sim.moving && this.modeTime > 0.25 && h.juice > 0;
    this.steering = canSteer && (sx !== 0 || sy !== 0);
    if (this.steering) {
      h.juice = Math.max(0, h.juice - dt);
      h.usedJuice = true;
      this.steerTime += dt;
      let rate = this.marshal === 'watching' ? 32 : this.marshal === 'turning' ? 12 : 6;
      if (sim.state === 'fly') sim.steer(sx, sy, SPIN_RATE * dt);
      else {
        // on the ground: shove it, relative to the direction it is rolling
        const f = this.flightDir;
        sim.nudge((-f.z * sx - f.x * sy) * 2.8, (f.x * sx - f.z * sy) * 2.8, dt);
        rate *= 1.4;
      }
      this.addSuspicion(rate * dt);
      if (this.marshal === 'watching') {
        this.flashCaught();
        if (!this.said.has('caught')) { this.said.add('caught'); this.say('caught', 0.5); }
      } else if (this.steerTime > 0.5 && !this.said.has('steer')) {
        this.said.add('steer');
        this.say(sim.state === 'roll' ? 'nudge' : 'steer', 0.2);
      }
      if (h.juice <= 0) this.sfx.deny();
    }
    this.timeScale += ((this.steering ? 0.2 : 1) - this.timeScale) * damp(this.steering ? 14 : 5, dt);
    this.sfx.slowmo(this.steering ? 1 : 0);

    this.simAcc += dt * this.timeScale;
    let steps = 0;
    while (this.simAcc >= SIM_DT && steps < 40 && sim.moving) {
      sim.step(SIM_DT);
      this.simAcc -= SIM_DT;
      steps++;
    }
    const hv = Math.hypot(sim.vel.x, sim.vel.z);
    if (hv > 1.2) {
      this.tmp.set(sim.vel.x / hv, 0, sim.vel.z / hv);
      this.flightDir.lerp(this.tmp, damp(sim.state === 'fly' ? 2.5 : 1.2, dt)).normalize();
    }
    if (sim.moving) this.fx.trailPush(sim.pos, this.steering ? 1 : 0);
    for (const e of sim.events) this.onSimEvent(e);
    sim.events.length = 0;
    if (this.round && this.round.suspicion >= 100 && this.mode === 'flight') this.disqualify('Balls do not do that. He has seen enough.');
  }

  private once(tag: string): boolean {
    if (this.said.has(tag)) return false;
    this.said.add(tag);
    return true;
  }

  private onSimEvent(e: SimEvent): void {
    const sim = this.sim, p = sim.pos;
    switch (e.type) {
      case 'bounce':
        this.sfx.bounce(e.surface, e.speed);
        if (e.speed > 2.5) this.fx.burst(e.surface === 'sand' ? 'sand' : e.surface === 'path' ? 'dust' : 'turf', p, clamp(e.speed / 14, 0.3, 1.2));
        if (e.surface === 'path' && e.speed > 5 && this.once('path')) this.say('path');
        break;
      case 'tree':
        if (e.trunk) this.sfx.thunk(8); else this.sfx.leaves();
        this.fx.burst('leaves', p, 1);
        if (this.once('tree')) this.say(e.trunk ? 'trunk' : 'tree', 0.3);
        break;
      case 'prop': {
        if (e.tag === 'bridge' || e.tag === 'sign') this.sfx.clank(); else this.sfx.thunk(e.speed);
        this.fx.burst('dust', p, 0.8);
        const tag = e.tag === 'backstop' ? 'cart' : e.tag === 'gator' ? 'gatorBounce' : e.tag;
        if (e.tag === 'gator') this.world.gatorSnap(p.x, p.z);
        if (e.tag === 'cart') this.addSuspicion(6);
        if (this.once(`prop-${e.tag}`)) this.say(tag as LineKey, 0.2);
        break;
      }
      case 'pin':
        this.sfx.clank();
        if (this.once('pin')) this.say('pin');
        break;
      case 'lipout':
        this.sfx.bounce('path', 3);
        this.sfx.ooh();
        this.hud.toast('LIP OUT', 'bad');
        this.say('lipout', 0.2);
        break;
      case 'splash': {
        this.fx.burst('splash', this.tmp.set(p.x, this.course.waterZ, p.z), 1);
        this.sfx.splash();
        let eaten = false;
        for (const g of this.world.gators) if (Math.hypot(g.x - p.x, g.z - p.z) < 10) eaten = true;
        if (eaten) {
          this.world.gatorSnap(p.x, p.z);
          this.sfx.chomp();
          this.hud.toast('EATEN', 'bad', 2.2);
        } else this.hud.toast('SPLASH', 'bad', 1.6);
        this.sfx.trombone();
        this.penalty(eaten ? 'gator' : 'water');
        break;
      }
      case 'ob':
        this.hud.toast('OUT OF BOUNDS', 'bad', 2);
        this.sfx.trombone();
        this.penalty('ob');
        break;
      case 'holed':
        this.holeOut(e.dunk);
        break;
      case 'rest':
        this.ballAtRest(e.surface);
        break;
    }
  }

  private settle(seconds: number, then: () => void): void {
    this.setMode('settle');
    this.settleTimer = seconds;
    this.afterSettle = then;
    this.timeScale = 1;
    this.steering = false;
    this.sfx.slowmo(0);
  }

  private overLimit(): boolean {
    return this.hole.strokes >= this.course.par + 5;
  }

  private pickUp(): void {
    this.hud.toast('PICK UP', 'bad', 2.4);
    this.say('pickup');
    this.settle(2.6, () => this.finishHole(false));
  }

  private penalty(why: 'water' | 'gator' | 'ob'): void {
    const h = this.hole;
    this.say(why, 0.5);
    if (this.kicked) {
      // a kicked ball in the water still costs a stroke
      h.strokes++;
    } else h.strokes++;
    this.settle(2.6, () => {
      if (this.overLimit()) { this.pickUp(); return; }
      const back = h.prev ?? { x: this.course.teeX, z: this.course.teeZ };
      this.sim.place(back.x, back.z);
      this.hud.toast('+1 PENALTY · REPLAY', 'bad', 1.6);
      this.beginAim();
    });
  }

  private ballAtRest(surface: Surface): void {
    const d = this.pinDist();
    if (surface === 'green') this.say(d < 1.6 ? 'close' : 'green', 0.2);
    else if (surface === 'sand') this.say('sand', 0.2);
    else if (surface === 'rough') this.say('rough', 0.2);
    else if (surface === 'fairway' && this.sim.time > 4 && Math.random() < 0.5) this.say('fairway', 0.2);
    if (surface === 'green' && d < 1.6) this.sfx.clap(14);
    this.settle(1.5, () => {
      if (this.overLimit()) this.pickUp();
      else this.beginAim();
    });
  }

  private holeOut(dunk: boolean): void {
    const h = this.hole;
    this.setMode('holed');
    this.timeScale = 1;
    this.steering = false;
    this.sfx.slowmo(0);
    this.sfx.cup();
    this.sfx.clap(40);
    const diff = h.strokes - this.course.par;
    const ace = h.strokes === 1;
    const [, , name] = this.scoreRow(diff);
    this.hud.toast(ace ? 'HOLE IN ONE' : name, diff <= 0 ? 'good' : 'plain', 3.2);
    if (diff < 0) this.sfx.fanfare();
    this.say(ace ? 'ace' : dunk ? 'dunk' : 'holed', 0.4);
  }

  private scoreRow(diff: number): [number, number, string, string] {
    for (const r of PAYOUT) if (diff <= r[0]) return r;
    return [diff, 0, `+${diff}`, 'over'];
  }

  /** Tally the hole and show the summary. holed = false when the player was told to pick up. */
  private finishHole(holed: boolean): void {
    const round = this.round!, h = this.hole, c = this.course;
    const strokes = holed ? h.strokes : c.par + 5;
    const diff = strokes - c.par;
    const row = this.scoreRow(diff);
    const mult = 1 + 0.3 * (round.week - 1);
    const lines: [string, string][] = [];
    let total = 0;
    if (holed) {
      const ace = strokes === 1;
      const base = ace ? 2500 : row[1];
      lines.push([ace ? 'Hole in one' : row[2].charAt(0) + row[2].slice(1).toLowerCase(), `$${base}`]);
      total += base;
      if (h.pures) { lines.push([`Pure strikes × ${h.pures}`, `$${h.pures * 20}`]); total += h.pures * 20; }
      if (mult > 1) { lines.push([`Week ${round.week} purse`, `× ${mult.toFixed(1)}`]); total = Math.round(total * mult); }
    } else lines.push(['Picked up', '$0']);
    if (!h.card && !h.usedJuice) {
      this.addSuspicion(-HONEST_RELIEF);
      lines.push(['Played it straight', `−${HONEST_RELIEF} suspicion`]);
    }
    round.scores.push(strokes);
    round.earned += total;
    this.setMode('summary');
    if (total > 0) this.sfx.kaching();
    const last = round.holeIdx >= HOLE_KEYS.length - 1;
    this.hud.showSummary({
      title: `HOLE ${c.json.number} · ${c.json.name.toUpperCase()}`, scoreName: holed ? (strokes === 1 ? 'HOLE IN ONE' : row[2]) : 'PICKED UP',
      scoreClass: diff < 0 ? 'under' : diff > 0 ? 'over' : '', strokes, par: c.par, lines, total, suspicion: round.suspicion, last,
    }, () => {
      this.hud.clearScreen();
      if (last) this.finishRound(false);
      else void this.enterHole(round.holeIdx + 1);
    });
  }

  private disqualify(reason: string): void {
    if (this.mode === 'dq') return;
    this.setMode('dq');
    this.timeScale = 1;
    this.steering = false;
    this.sfx.slowmo(0);
    this.sfx.whistle(true);
    this.hud.showMeter(false);
    this.hud.clearScreen();
    this.fx.setAim(null);
    this.fx.setLaser(null);
    this.pending.length = 0;
    this.say('dq', 0.6);
    const cart = this.world.spawn('cart');
    this.world.scene.add(cart);
    this.extras.push(cart);
    this.dqCart = cart;
    this.dqReason = reason;
  }
  private dqReason = '';

  private finishRound(dq: boolean): void {
    const round = this.round!, s = this.save;
    const rows = round.scores.map((strokes, i) => {
      const c = this.courses.get(HOLE_KEYS[i]!)!;
      return { hole: c.json.number, name: c.json.name, par: c.par, strokes };
    });
    const toPar = rows.reduce((a, r) => a + r.strokes - r.par, 0);
    const kept = dq ? 25 : round.earned;
    s.money += kept;
    s.rounds++;
    if (dq) s.dqs++;
    else {
      s.week++;
      if (rows.length === HOLE_KEYS.length && (s.best === null || toPar < s.best)) s.best = toPar;
    }
    storeSave(s);
    this.setMode('results');
    this.hud.showHud(false);
    const show = (): void => this.hud.showResults({ dq, rows, toPar, earned: round.earned, kept, week: s.week, best: s.best, wallet: s.money }, {
      again: () => void this.startRound(),
      shop: () => this.showShop(show, 'BACK TO RESULTS'),
      menu: () => this.toMenu(),
    });
    show();
  }

  // ----------------------------------------------------------------- input

  private onKey(e: KeyboardEvent): void {
    if (e.repeat && e.code !== 'Tab') { if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault(); return; }
    this.sfx.unlock();
    this.keys.add(e.code);
    const playing = this.round !== null && ['intro', 'aim', 'power', 'strike', 'flight', 'settle', 'holed'].includes(this.mode);
    if (e.code === 'Escape' && playing) {
      this.togglePause();
      return;
    }
    if (this.paused) return;
    if (e.code === 'Space' || e.code === 'Enter') {
      if (playing) e.preventDefault();
      this.action();
      return;
    }
    if (e.code.startsWith('Arrow')) e.preventDefault();
    if (this.mode === 'aim') {
      if (e.code === 'KeyW' || e.code === 'ArrowUp') this.changeClub(-1);
      else if (e.code === 'KeyS' || e.code === 'ArrowDown') this.changeClub(1);
      else if (e.code === 'KeyF') this.footWedge();
      else if (e.code === 'KeyM') this.takeMulligan();
    } else if (this.mode === 'power' && e.code === 'Backspace') this.beginAim();
  }

  private togglePause(): void {
    this.paused = !this.paused;
    if (!this.paused) { this.hud.clearScreen(); return; }
    this.sfx.slowmo(0);
    const show = (): void => this.hud.showPause({
      resume: () => this.togglePause(),
      settings: () => this.showSettings(show),
      how: () => this.hud.showHow(show),
      quit: () => { this.paused = false; this.hud.clearScreen(); this.toMenu(); },
    });
    show();
  }

  // ------------------------------------------------------------------ loop

  private updateMarshal(dt: number): void {
    this.marshalTimer -= dt;
    if (this.marshalTimer > 0) return;
    const week = this.round?.week ?? 1;
    if (this.marshal === 'away') {
      this.marshal = 'turning';
      this.marshalTimer = 0.8;
      this.sfx.tick();
    } else if (this.marshal === 'turning') {
      this.marshal = 'watching';
      this.marshalTimer = rand(2.2, 3.4) * Math.min(1.6, 1 + 0.1 * (week - 1));
    } else {
      this.marshal = 'away';
      this.marshalTimer = rand(4, 6.5) * (1 + 0.12 * this.save.upgrades.shades);
    }
  }

  private updateAim(dt: number): void {
    const k = this.keys;
    const turn = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    if (turn) {
      const fine = k.has('ShiftLeft') || k.has('ShiftRight');
      const rate = (this.club.kind === 'putter' ? 0.16 : 0.5) * (fine ? 0.18 : 1);
      this.aimYaw += turn * rate * dt;
      this.aimDirty = true;
    }
    if (this.aimDirty) this.refreshAim();
  }

  private updateMeter(dt: number): void {
    if (this.mode === 'power') {
      this.meterU += this.meterDir * RISE * dt;
      if (this.meterU >= 1) { this.meterU = 1; this.meterDir = -1; }
      if (this.meterDir < 0 && this.meterU <= U0) { this.beginAim(); return; }
    } else {
      this.meterU -= this.strikeSpeed * dt;
      if (this.meterU <= 0) { this.strike(4 * this.windowS); return; }
    }
    this.hud.setMeter({ marker: this.meterU, power: this.powerU, sweet: U0, full: U1, window: this.currentWindowU(), tick: this.meterTick() });
  }

  private updateCamera(dt: number): void {
    const cam = this.world.camera, sim = this.sim, p = sim.pos, c = this.course;
    const want = this.wantPos, look = this.wantLook;
    let rate = 5;
    this.fovWant = 52;
    const ax = Math.sin(this.aimYaw), az = -Math.cos(this.aimYaw);
    switch (this.mode) {
      case 'boot': case 'loading': return;
      case 'menu': case 'results': {
        const a = this.worldReal * 0.045 + 2.2;
        const cx = (c.cupX + c.teeX * 0.15) / 1.15, cz = (c.cupZ + c.teeZ * 0.15) / 1.15;
        want.set(cx + Math.cos(a) * 52, 0, cz + Math.sin(a) * 52);
        want.y = c.terrainAt(want.x, want.z) + 9;
        look.set(c.cupX, this.env.cupY + 1.5, c.cupZ);
        rate = 1.5;
        break;
      }
      case 'intro': case 'cards': {
        const dur = c.key === 'h8' ? 10 : 6.5;
        let t = this.mode === 'cards' ? 1 : clamp(this.modeTime / dur, 0, 1);
        t = t * t * (3 - 2 * t);
        const dx = c.cupX - c.teeX, dz = c.cupZ - c.teeZ, l = Math.hypot(dx, dz);
        const ux = dx / l, uz = dz / l;
        // fly from above the tee to just short of the green, looking ahead and settling on the pin
        const sx = c.teeX - ux * 18, sz = c.teeZ - uz * 18;
        const ex = c.cupX - ux * 30, ez = c.cupZ - uz * 30;
        want.set(sx + (ex - sx) * t, 0, sz + (ez - sz) * t);
        want.y = Math.max(c.terrainAt(want.x, want.z), c.waterZ) + 17 - 9 * t;
        const ahead = 80 - 50 * t;
        look.set(want.x + ux * ahead, this.env.cupY + 1, want.z + uz * ahead);
        rate = 3;
        if (this.mode === 'intro' && this.modeTime > dur + 0.4) this.showCards();
        break;
      }
      case 'aim': case 'power': case 'strike': {
        const putt = this.club.kind === 'putter';
        const back = putt ? 2.6 : 4.6, up = putt ? 1.25 : 1.9;
        want.set(p.x - ax * back, p.y + up, p.z - az * back);
        look.set(p.x + ax * (putt ? 4.5 : 14), p.y + (putt ? 0 : 0.4), p.z + az * (putt ? 4.5 : 11));
        rate = 7;
        break;
      }
      case 'flight': case 'settle': {
        const f = this.flightDir;
        const sp = sim.vel.length(), h = sim.heightAboveGround;
        const slow = 1 - this.timeScale;
        const rolling = sim.state !== 'fly';
        const back = rolling ? 4.8 : (7 + Math.min(7, sp * 0.11)) * (1 - 0.35 * slow);
        const up = rolling ? 2.1 : 2.3 + Math.min(4, h * 0.07);
        want.set(p.x - f.x * back, p.y + up, p.z - f.z * back);
        look.set(p.x + f.x * 3, p.y + 0.3, p.z + f.z * 3);
        rate = rolling ? 3 : 4.5;
        this.fovWant = 52 - 12 * slow;
        break;
      }
      case 'holed': case 'summary': {
        const a = this.modeTime * 0.5 + this.aimYaw;
        want.set(this.env.cupX + Math.cos(a) * 4.2, this.env.cupY + 1.9, this.env.cupZ + Math.sin(a) * 4.2);
        look.set(this.env.cupX, this.env.cupY + 0.5, this.env.cupZ);
        rate = 2.5;
        break;
      }
      case 'dq': {
        const cart = this.dqCart;
        if (cart) {
          const f = this.flightDir;
          const t = clamp(this.modeTime / 3.2, 0, 1);
          const e = 1 - (1 - t) * (1 - t);
          const sx = p.x - f.x * 70 + f.z * 10, sz = p.z - f.z * 70 - f.x * 10;
          const ex = p.x - f.x * 5 + f.z * 1.5, ez = p.z - f.z * 5 - f.x * 1.5;
          const x = sx + (ex - sx) * e, z = sz + (ez - sz) * e;
          cart.position.set(x, c.groundAt(x, z), z);
          cart.rotation.y = Math.atan2(ex - sx, ez - sz) + (t < 1 ? Math.sin(this.modeTime * 9) * 0.03 : 0);
          want.set(p.x + f.x * 4.5 + f.z * 2.5, p.y + 1.7, p.z + f.z * 4.5 - f.x * 2.5);
          look.set(x, cart.position.y + 1.1, z);
          rate = 3.5;
        }
        break;
      }
    }
    const floor = c.groundAt(want.x, want.z) + 0.6;
    if (want.y < floor) want.y = floor;
    if (this.camSnap) {
      this.camPos.copy(want);
      this.camLook.copy(look);
      this.camSnap = false;
    } else {
      this.camPos.lerp(want, damp(rate, dt));
      this.camLook.lerp(look, damp(rate * 1.4, dt));
    }
    cam.position.copy(this.camPos);
    cam.lookAt(this.camLook);
    if (Math.abs(cam.fov - this.fovWant) > 0.05) {
      cam.fov += (this.fovWant - cam.fov) * damp(6, dt);
      cam.updateProjectionMatrix();
    }
  }

  private updateHud(): void {
    const round = this.round;
    if (!round) return;
    const h = this.hole, sim = this.sim, c = this.course;
    const total = round.scores.reduce((a, s, i) => a + s - this.courses.get(HOLE_KEYS[i]!)!.par, 0);
    this.hud.setScore(Math.max(1, h.strokes + (this.mode === 'aim' || this.mode === 'power' || this.mode === 'strike' ? 1 : 0)), total, this.save.money + round.earned);
    this.hud.setMarshal(this.marshal, round.suspicion);

    // wind arrow relative to where the camera looks
    const cam = this.world.camera;
    cam.getWorldDirection(this.tmp);
    const fl = Math.hypot(this.tmp.x, this.tmp.z) || 1;
    const fx = this.tmp.x / fl, fz = this.tmp.z / fl;
    const w = this.env.wind;
    this.hud.setWind(Math.hypot(w.x, w.z) * 2.237, Math.atan2(w.x * -fz + w.z * fx, w.x * fx + w.z * fz));

    const d = this.pinDist();
    const club = this.club, s = this.surface;
    const aiming = this.mode === 'aim' || this.mode === 'power' || this.mode === 'strike';
    const dh = this.env.cupY - (sim.pos.y - BALL_R);
    let read = Math.abs(dh) < 0.05 ? 'level' : `${dh > 0 ? '▲' : '▼'} ${Math.abs(dh) < 1 ? `${Math.round(Math.abs(dh) * 100)} cm` : `${Math.abs(dh).toFixed(1)} m`}`;
    if (s === 'green' && aiming) {
      const n = { x: 0, y: 1, z: 0 };
      c.normalAt((sim.pos.x + this.env.cupX) / 2, (sim.pos.z + this.env.cupZ) / 2, n);
      const ax = Math.sin(this.aimYaw), az = -Math.cos(this.aimYaw);
      const br = n.x * -az + n.z * ax;
      const pct = Math.abs(br) * 100;
      read += pct < 0.4 ? ' · straight' : ` · breaks ${br > 0 ? 'right →' : '← left'} ${pct.toFixed(1)}%`;
    }
    const lie = LIE[s].label;
    const carry = club.kind === 'putter' ? `max ${Math.round(clamp(d * 1.6, 4, 45) * 1.094)} yd` : `${yards(club.carry * LIE[s].speed * (1 + 0.02 * this.save.upgrades.gym))} yd carry`;
    this.hud.setClub(aiming ? lie : sim.moving ? 'IN PLAY' : lie, club.name.toUpperCase(), aiming ? carry : '', d < 30 ? `${(d * 3.281).toFixed(d < 3 ? 1 : 0)} ft` : `${yards(d)} yd`, read);

    const flight = this.mode === 'flight';
    this.hud.setJuice(flight || this.mode === 'settle', h.juiceMax > 0 ? h.juice / h.juiceMax : 0, h.juice, this.steering);
    const ds = this.tmp2.copy(sim.spin).sub(this.shotSpin0);
    const sideRpm = Math.round((-ds.y * 60) / (2 * Math.PI) / 10) * 10;
    this.hud.setAfterTouch(1 - this.timeScale > 0.1 ? Math.min(1, (1 - this.timeScale) * 1.25) : 0,
      sim.state === 'fly' ? `${sideRpm === 0 ? '' : sideRpm > 0 ? `→ ${sideRpm} rpm` : `← ${-sideRpm} rpm`}` : 'ROLL CONTROL');
    this.hud.setCaught(this.caughtTimer > 0);

    let hints = '';
    if (this.mode === 'intro') hints = '<kbd>Space</kbd> skip';
    else if (this.mode === 'aim') {
      hints = '<kbd>A</kbd><kbd>D</kbd> aim &nbsp; <kbd>W</kbd><kbd>S</kbd> club &nbsp; <kbd>Space</kbd> swing';
      if (h.foot) hints += '<br><b><kbd>F</kbd> foot wedge</b>';
      if (h.mulligan && h.prev) hints += '<br><b><kbd>M</kbd> mulligan</b>';
      if (h.juice > 0 && h.strokes === 0) hints += '<br><b>In the air: hold A / D / W / S to cheat</b>';
    } else if (this.mode === 'power') hints = '<kbd>Space</kbd> set power &nbsp; <kbd>⌫</kbd> back off';
    else if (this.mode === 'strike') hints = '<kbd>Space</kbd> on the white line';
    else if (flight && h.juice > 0) hints = '<b>HOLD <kbd>A</kbd><kbd>D</kbd> bend · <kbd>W</kbd> dive · <kbd>S</kbd> float</b>';
    this.hud.setHints(hints);
  }

  private frame(now: number): void {
    requestAnimationFrame((t) => this.frame(t));
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    if (!this.paused && this.mode !== 'boot') {
      this.modeTime += dt;
      this.worldReal += dt;
      if (this.caughtTimer > 0) this.caughtTimer -= dt;
      if (this.whistleCool > 0) this.whistleCool -= dt;
      switch (this.mode) {
        case 'aim': this.updateMarshal(dt); this.updateAim(dt); break;
        case 'power': case 'strike': this.updateMarshal(dt); this.updateMeter(dt); break;
        case 'flight': this.updateMarshal(dt); this.updateFlight(dt); break;
        case 'settle':
          this.updateMarshal(dt);
          if ((this.settleTimer -= dt) <= 0 && this.afterSettle) {
            const f = this.afterSettle;
            this.afterSettle = null;
            f();
          }
          break;
        case 'holed': if (this.modeTime > 3.4) this.finishHole(true); break;
        case 'dq':
          if (this.modeTime > 1.1 && this.modeTime - dt <= 1.1) { this.sfx.horn(); this.hud.showDq(this.dqReason); }
          if (this.modeTime > 2.6 && this.modeTime - dt <= 2.6) { this.sfx.horn(); this.sfx.trombone(); }
          if (this.modeTime > 6) { this.dqCart = null; this.hud.clearScreen(); this.finishRound(true); }
          break;
        default: break;
      }
      for (let i = this.pending.length - 1; i >= 0; i--) {
        if (this.pending[i]!.at <= this.worldReal) {
          this.hud.caption(line(this.pending[i]!.key));
          this.pending.splice(i, 1);
        }
      }
      const scaled = dt * this.timeScale;
      this.worldTime += scaled;
      this.updateCamera(dt);
      const lift = this.mode === 'aim' && this.hole.strokes === 0 && this.surface === 'tee' ? 0.03 : 0;
      this.fx.syncBall(this.sim.pos, this.sim.spin, scaled, this.mode === 'aim' || this.mode === 'power' || this.mode === 'strike' ? lift : 0);
      this.fx.update(scaled);
      this.hud.update(dt);
      this.hud.setCinematic(this.mode === 'intro' || this.mode === 'cards' || this.mode === 'loading');
      this.updateHud();
      this.sfx.ambience(dt);
      this.world.update(scaled, this.worldTime, this.sim.pos);
    }
    this.world.render();
  }
}

import { CARDS } from './cards';
function drawCardById(id: string): Card | null {
  return CARDS.find((c) => c.id === id) ?? null;
}
