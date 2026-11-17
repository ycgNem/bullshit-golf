/**
 * The mouse swing. Pull the mouse back (towards you) for the backswing, then push it through the
 * ball. Three things are measured, the same three a launch monitor reports:
 *
 *   path     the direction the head travels through impact (in-to-out draws it, out-to-in fades it)
 *   contact  where on the face the ball was met (centre, toe or heel)
 *   tempo    backswing time : downswing time (3 : 1 for a full swing, 2 : 1 for a putt)
 *
 * All positions are in units of one full backswing, so the tracker knows nothing about pixels.
 * x grows to the right, y grows as the mouse is pulled back; the ball sits at (0, 0).
 */

export type SwingPhase = 'address' | 'back' | 'down';

export interface SwingResult {
  /** backswing length: 1 = full, up to MAX_BACK for an overswing */
  power: number;
  /** club path through impact in degrees; positive = in-to-out (swung out to the right) */
  pathDeg: number;
  /** where the head crossed the ball line; positive = heel side (right of the ball) */
  offset: number;
  backTime: number;
  downTime: number;
  /** backTime / downTime */
  tempo: number;
  /** the head never came back to the ball */
  whiff: boolean;
}

export const MAX_BACK = 1.14;
/** Shorter than this and the movement is a twitch, not a swing. */
const MIN_BACK = 0.07;
const TRACE_MAX = 600;

const clamp = (x: number, a: number, b: number): number => Math.min(Math.max(x, a), b);

export class SwingTracker {
  phase: SwingPhase = 'address';
  x = 0;
  y = 0;
  /** the top of the backswing so far */
  top = 0;
  readonly xs: number[] = [];
  readonly ys: number[] = [];
  /** index into the trace where the downswing begins, or -1 */
  downIndex = -1;
  /** where the head crossed the ball line on the last finished swing */
  impactX: number | null = null;
  tStart = 0;
  tTop = 0;
  private tRest = 0;
  private xTop = 0;
  private xMid = 0;
  private yMid = 0;
  private hasMid = false;
  private lastT = 0;

  reset(t = 0): void {
    this.phase = 'address';
    this.x = this.y = this.top = 0;
    this.xs.length = this.ys.length = 0;
    this.downIndex = -1;
    this.impactX = null;
    this.tStart = this.tTop = this.tRest = this.lastT = t;
    this.hasMid = false;
  }

  private push(): void {
    if (this.xs.length >= TRACE_MAX) return;
    this.xs.push(this.x);
    this.ys.push(this.y);
  }

  /** Feed one mouse movement (already divided by the full-swing length). t is in seconds. */
  move(dx: number, dy: number, t: number): SwingResult | null {
    const px = this.x, py = this.y, pt = this.lastT;
    this.lastT = t;
    if (this.phase === 'address') {
      // sideways shuffling at address does not count; the takeaway starts the clock
      this.y = clamp(this.y + dy, 0, MAX_BACK);
      if (this.y <= 0.004) this.tRest = t;
      if (this.y > 0.03) {
        this.phase = 'back';
        this.tStart = this.tRest;
        this.top = this.y;
        this.tTop = t;
        this.xs.push(0); this.ys.push(0);
        this.push();
      }
      return null;
    }
    this.x = clamp(this.x + dx, -0.95, 0.95);
    this.y = Math.min(this.y + dy, MAX_BACK);

    if (this.phase === 'back') {
      if (this.y >= this.top - 0.02) {
        if (this.y > this.top) this.top = this.y;
        this.tTop = t;
        this.xTop = this.x;
      }
      if (this.y >= this.top - 0.06 && this.y > 0) { this.push(); return null; }
      if (this.top < MIN_BACK) { this.reset(t); return null; }
      this.phase = 'down';
      this.downIndex = this.xs.length;
    }

    // downswing
    if (!this.hasMid && this.y <= 0.6 * this.top) {
      this.hasMid = true;
      this.xMid = px;
      this.yMid = Math.max(py, 0.05);
    }
    if (this.y > 0) { this.push(); return null; }
    const f = py > this.y ? py / (py - this.y) : 1;
    const xi = px + (this.x - px) * f;
    const ti = pt + (t - pt) * f;
    this.x = xi;
    this.y = 0;
    this.push();
    this.impactX = xi;
    const fromX = this.hasMid ? this.xMid : this.xTop;
    const fromY = this.hasMid ? this.yMid : this.top;
    const backTime = Math.max(0.03, this.tTop - this.tStart);
    const downTime = Math.max(0.03, ti - this.tTop);
    return {
      power: this.top, pathDeg: (Math.atan2(xi - fromX, fromY) * 180) / Math.PI, offset: xi,
      backTime, downTime, tempo: backTime / downTime, whiff: false,
    };
  }

  /** Call every frame: a downswing that never arrives is an air shot. */
  tick(t: number): SwingResult | null {
    if (this.phase !== 'down' || t - this.tTop < 1.1) return null;
    const backTime = Math.max(0.03, this.tTop - this.tStart);
    return { power: this.top, pathDeg: 0, offset: 0, backTime, downTime: 1.1, tempo: backTime / 1.1, whiff: true };
  }
}

// ----------------------------------------------------------------- judging

export type ShotKind =
  | 'pure' | 'good' | 'ok' | 'draw' | 'fade' | 'hook' | 'slice'
  | 'thin' | 'fat' | 'heel' | 'toe' | 'shank' | 'chunk' | 'top' | 'yip' | 'whiff';

export interface Shot {
  kind: ShotKind;
  /** a hook or slice that is not coming back */
  big: boolean;
  power: number;
  speedK: number;
  /** start direction relative to the aim, degrees, positive right */
  face: number;
  /** spin-axis tilt, degrees, positive curves right */
  tilt: number;
  launchAdd: number;
  spinK: number;
  /** contact in face widths: 0 centre, +1 the edge of the heel, -1 the edge of the toe */
  contact: number;
  /** tempo error: 0 ideal, +1 as quick as you can get away with, -1 as slow */
  tempoErr: number;
}

export interface JudgeContext {
  /** 1 for a mid iron off the fairway; smaller is less forgiving */
  forgive: number;
  putter: boolean;
  /** how much this club curves: woods more, wedges less */
  curve: number;
  /** the club's launch angle, for topped shots */
  launch: number;
  rnd?: () => number;
}

/** Half-width of the usable face, in swing units, for a forgiveness of 1. */
export const FACE_HALF = 0.12;
/** Inside this fraction of the face the strike is centred. */
export const CENTRE = 0.35;

export const idealTempo = (putter: boolean): number => (putter ? 2 : 3);

/** Forgiveness after the overswing penalty. */
export const effectiveForgive = (forgive: number, power: number): number =>
  forgive * (power > 1 ? Math.max(0.45, 1 - 3 * (power - 1)) : 1);

export function judge(r: SwingResult, c: JudgeContext): Shot {
  const rnd = c.rnd ?? Math.random;
  const span = (a: number, b: number): number => a + rnd() * (b - a);
  const power = clamp(r.power, 0.06, MAX_BACK);
  const F = effectiveForgive(c.forgive, power);
  const shot: Shot = { kind: 'ok', big: false, power, speedK: 1, face: 0, tilt: 0, launchAdd: 0, spinK: 1, contact: 0, tempoErr: 0 };
  if (r.whiff) { shot.kind = 'whiff'; return shot; }

  const con = r.offset / (FACE_HALF * F);
  let te = Math.log2(r.tempo / idealTempo(c.putter)) / (0.6 * Math.sqrt(F));
  const lazy = c.putter ? 0.65 : 0.42;
  if (r.downTime > lazy) te -= (r.downTime - lazy) / 0.2;      // a lazy downswing is a decel however you count it
  const path = clamp(r.pathDeg, -35, 35) / F;
  const ac = Math.abs(con), at = Math.abs(te);
  shot.contact = con;
  shot.tempoErr = te;

  if (c.putter) {
    shot.face = 0.2 * path + 0.6 * clamp(con, -2.5, 2.5);
    shot.speedK = 1 - 0.03 * Math.min(ac, 2) ** 2;
    if (at > 0.35) shot.speedK *= 1 + 0.07 * Math.sign(te) * Math.min(at - 0.35, 1.2);
    if (at > 1.7 || ac > 2.2) {
      shot.kind = 'yip';
      shot.face += span(-3.5, 3.5);
      shot.speedK = te > 0 ? span(1.25, 1.5) : span(0.45, 0.65);
    } else shot.kind = ac <= CENTRE && at <= 0.35 && Math.abs(shot.face) < 0.5 ? 'pure' : ac < 0.8 && at < 0.8 ? 'good' : 'ok';
    return shot;
  }

  // ball-flight laws: the ball starts mostly where the face points and curves away from the path
  shot.face = 0.3 * path + 1.0 * clamp(con, -2, 2);
  shot.tilt = clamp(-2.0 * path * c.curve, -50, 50);

  // contact
  if (ac > 2) {
    if (con > 0) {
      shot.kind = 'shank'; shot.speedK = 0.5; shot.face = span(38, 55); shot.launchAdd = -3; shot.tilt = 20;
    } else {
      shot.kind = 'toe'; shot.speedK = span(0.36, 0.48); shot.face = -span(14, 26); shot.launchAdd = -4; shot.spinK = 0.6; shot.tilt = -12;
    }
    return shot;
  }
  if (ac > 1) shot.speedK = 0.93 - 0.25 * (ac - 1);
  else if (ac > CENTRE) shot.speedK = 1 - 0.07 * ((ac - CENTRE) / (1 - CENTRE)) ** 2;

  // tempo
  if (at > 2) {
    if (te > 0) {
      shot.kind = 'top'; shot.speedK = 0.5; shot.launchAdd = -c.launch + 2; shot.spinK = -0.4; shot.face = span(-5, 5); shot.tilt = 0;
    } else {
      shot.kind = 'chunk'; shot.speedK = span(0.28, 0.42); shot.launchAdd = 5; shot.spinK = 0.5; shot.face = span(-6, 6); shot.tilt = 0;
    }
    return shot;
  }
  if (at > 1) {
    const x = at - 1;
    if (te > 0) { shot.speedK *= 0.97 - 0.2 * x; shot.launchAdd = -(2.5 + 0.45 * c.launch * x); shot.spinK = 0.85 - 0.4 * x; }
    else { shot.speedK *= 0.91 - 0.4 * x; shot.launchAdd = 1 + 3 * x; shot.spinK = 0.85 - 0.3 * x; }
  } else if (at > 0.35) {
    const x = (at - 0.35) / 0.65;
    if (te > 0) { shot.speedK *= 1 - 0.03 * x; shot.launchAdd = -2.5 * x; shot.spinK = 1 - 0.15 * x; }
    else { shot.speedK *= 1 - 0.09 * x; shot.launchAdd = x; shot.spinK = 1 - 0.15 * x; }
  }

  const curl = Math.abs(shot.tilt);
  if (curl >= 11) {
    shot.kind = shot.tilt < 0 ? 'hook' : 'slice';
    shot.big = curl >= 22;
  } else if (at > 1) shot.kind = te > 0 ? 'thin' : 'fat';
  else if (ac > 1) shot.kind = con > 0 ? 'heel' : 'toe';
  else if (ac <= CENTRE && at <= 0.35) {
    shot.kind = 'pure';
    shot.speedK *= 1.012;
  } else if (curl >= 4) shot.kind = shot.tilt < 0 ? 'draw' : 'fade';
  else shot.kind = ac < 0.7 && at < 0.7 ? 'good' : 'ok';
  return shot;
}

// ------------------------------------------------------ read-out wording

export function pathLabel(deg: number): string {
  const a = Math.abs(deg);
  return a < 1 ? 'SQUARE' : `${a.toFixed(1)}° ${deg > 0 ? 'IN-TO-OUT' : 'OUT-TO-IN'}`;
}

export function contactLabel(contact: number): string {
  const a = Math.abs(contact);
  if (a <= CENTRE) return 'CENTRE';
  if (a > 2) return contact > 0 ? 'HOSEL' : 'OFF THE TOE';
  return `${Math.round(a * 22)} mm ${contact > 0 ? 'HEEL' : 'TOE'}`;
}

export function tempoLabel(tempo: number, tempoErr: number): string {
  const word = Math.abs(tempoErr) <= 0.35 ? 'SMOOTH' : tempoErr > 0 ? (tempoErr > 1 ? 'SNATCHED' : 'QUICK') : tempoErr < -1 ? 'DECEL' : 'LAZY';
  return `${tempo >= 9.95 ? '10+' : tempo.toFixed(1)} : 1 ${word}`;
}
