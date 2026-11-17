import { CENTRE, MAX_BACK, type SwingTracker } from './swing';

export interface PadView {
  tracker: SwingTracker;
  /** a swing is in progress (false: the trace is the previous swing) */
  live: boolean;
  putter: boolean;
  /** power marks down the lane: fraction of a full backswing and its label */
  ticks: { p: number; label: string }[];
  /** backswing that carries to the pin, or -1 */
  pin: number;
  /** half-width of the usable face in swing units */
  face: number;
  /** seconds, same clock as the tracker */
  now: number;
}

const LIME = '#c8f03c';
const RED = '#ff4d42';
const FONT = "600 10px 'Barlow Condensed', sans-serif";

/** The swing lane: a top-down plot of what the mouse did, like the trace on a launch monitor. */
export class SwingPad {
  private readonly ctx: CanvasRenderingContext2D;
  private w = 0;
  private h = 0;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
  }

  private fit(): void {
    const r = this.canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.round(r.width), h = Math.round(r.height);
    if (w === this.w && h === this.h) return;
    this.w = w;
    this.h = h;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  draw(v: PadView): void {
    this.fit();
    const g = this.ctx, w = this.w, h = this.h;
    if (!w || !h) return;
    g.clearRect(0, 0, w, h);
    const t = v.tracker;
    const cx = Math.round(w * 0.56), y0 = 30;
    const S = (h - y0 - 14) / MAX_BACK;
    const X = (x: number): number => cx + x * S;
    const Y = (y: number): number => y0 + y * S;
    const laneL = cx - 46, laneR = cx + 46;

    // lane
    g.fillStyle = 'rgba(255,255,255,0.035)';
    g.fillRect(laneL, y0, laneR - laneL, Y(MAX_BACK) - y0);
    // overswing zone
    g.fillStyle = 'rgba(255,77,66,0.16)';
    g.fillRect(laneL, Y(1), laneR - laneL, Y(MAX_BACK) - Y(1));
    g.strokeStyle = 'rgba(255,77,66,0.5)';
    g.lineWidth = 1;
    for (let y = Y(1) + 5; y < Y(MAX_BACK); y += 6) {
      g.beginPath(); g.moveTo(laneL, y); g.lineTo(laneR, y); g.stroke();
    }

    // target line
    g.setLineDash([3, 5]);
    g.strokeStyle = 'rgba(255,255,255,0.28)';
    g.beginPath(); g.moveTo(cx, y0 - 22); g.lineTo(cx, Y(MAX_BACK)); g.stroke();
    g.setLineDash([]);

    // power marks
    g.font = FONT;
    g.textBaseline = 'middle';
    for (const k of v.ticks) {
      const y = Math.round(Y(k.p)) + 0.5, full = k.p === 1;
      g.strokeStyle = full ? 'rgba(255,255,255,0.85)' : 'rgba(255,255,255,0.3)';
      g.beginPath(); g.moveTo(full ? laneL - 6 : laneL, y); g.lineTo(full ? laneR : laneL + 12, y); g.stroke();
      g.fillStyle = full ? '#eef2ea' : 'rgba(238,242,234,0.62)';
      g.textAlign = 'right';
      g.fillText(k.label, laneL - 10, y);
    }
    if (v.pin > 0 && v.pin <= MAX_BACK) {
      const y = Y(v.pin);
      g.fillStyle = LIME;
      g.beginPath(); g.moveTo(laneR + 3, y); g.lineTo(laneR + 11, y - 5); g.lineTo(laneR + 11, y + 5); g.closePath(); g.fill();
      g.textAlign = 'left';
      g.fillText('PIN', laneR + 15, y);
      g.strokeStyle = 'rgba(200,240,60,0.5)';
      g.setLineDash([2, 3]);
      g.beginPath(); g.moveTo(laneL, y); g.lineTo(laneR, y); g.stroke();
      g.setLineDash([]);
    }

    // the face at the ball line: usable width and the centred part of it
    const fw = v.face * S;
    g.fillStyle = 'rgba(255,255,255,0.16)';
    g.fillRect(cx - fw, y0 - 2, fw * 2, 4);
    g.fillStyle = LIME;
    g.fillRect(cx - fw * CENTRE, y0 - 2, fw * 2 * CENTRE, 4);

    // trace
    const n = t.xs.length, di = t.downIndex < 0 ? n : t.downIndex;
    g.lineJoin = g.lineCap = 'round';
    g.globalAlpha = v.live ? 1 : 0.55;
    if (n > 1) {
      g.strokeStyle = 'rgba(238,242,234,0.75)';
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(X(t.xs[0]!), Y(t.ys[0]!));
      for (let i = 1; i < Math.min(n, di + 1); i++) g.lineTo(X(t.xs[i]!), Y(t.ys[i]!));
      g.stroke();
      if (di < n) {
        g.strokeStyle = LIME;
        g.lineWidth = 3;
        g.shadowColor = LIME;
        g.shadowBlur = 8;
        g.beginPath();
        g.moveTo(X(t.xs[di - 1] ?? 0), Y(t.ys[di - 1] ?? 0));
        for (let i = di; i < n; i++) g.lineTo(X(t.xs[i]!), Y(t.ys[i]!));
        g.stroke();
        g.shadowBlur = 0;
      }
    }
    // top-of-swing mark
    if (t.top > 0.03) {
      const y = Y(t.top);
      g.strokeStyle = t.top > 1 ? RED : '#eef2ea';
      g.lineWidth = 2;
      g.beginPath(); g.moveTo(laneL, y); g.lineTo(laneR, y); g.stroke();
    }
    g.globalAlpha = 1;

    // ball
    g.fillStyle = 'rgba(0,0,0,0.45)';
    g.beginPath(); g.arc(cx + 1, y0 + 2, 7, 0, 7); g.fill();
    g.fillStyle = '#fff';
    g.beginPath(); g.arc(cx, y0, 6.5, 0, 7); g.fill();

    if (v.live) {
      // club head
      g.fillStyle = t.phase === 'down' ? LIME : '#eef2ea';
      g.strokeStyle = 'rgba(0,0,0,0.6)';
      g.lineWidth = 1.5;
      g.beginPath(); g.arc(X(t.x), Y(t.y), 5.5, 0, 7); g.fill(); g.stroke();
      if (t.phase === 'back') {
        g.fillStyle = 'rgba(238,242,234,0.8)';
        g.textAlign = 'left';
        g.fillText(`${(v.now - t.tStart).toFixed(2)}s`, laneR + 15, Math.min(Y(t.y), Y(MAX_BACK) - 6));
      }
    } else if (t.impactX !== null) {
      // where the last one met the ball
      const x = X(t.impactX);
      g.strokeStyle = Math.abs(t.impactX) <= v.face * CENTRE ? LIME : Math.abs(t.impactX) <= v.face ? '#ffc247' : RED;
      g.lineWidth = 2;
      g.beginPath(); g.moveTo(x - 5, y0 - 13); g.lineTo(x + 5, y0 - 13); g.moveTo(x, y0 - 18); g.lineTo(x, y0 - 8); g.stroke();
    } else if (n === 0) {
      // nothing yet: say what to do
      g.fillStyle = 'rgba(238,242,234,0.5)';
      g.textAlign = 'center';
      const mid = Y(0.55);
      g.fillText('PULL', cx, mid - 7);
      g.fillText('BACK', cx, mid + 6);
      g.strokeStyle = 'rgba(238,242,234,0.4)';
      g.lineWidth = 1.5;
      g.beginPath(); g.moveTo(cx, mid + 18); g.lineTo(cx, mid + 44); g.moveTo(cx - 5, mid + 38); g.lineTo(cx, mid + 44); g.lineTo(cx + 5, mid + 38); g.stroke();
    }
  }
}
