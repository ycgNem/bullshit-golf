import type { Card } from './cards';
import { UPGRADES, upgradeCost, type Save, type UpgradeId } from './save';
import { SwingPad, type PadView } from './swingpad';
import type { Quality } from './world';

export type MarshalState = 'away' | 'turning' | 'watching';
export type Tone = '' | 'good' | 'warn' | 'bad' | 'cheat';

export interface MonitorRow { k: string; v: string; u?: string; tone?: Tone }

export interface HoleSummary {
  title: string;
  scoreName: string;
  scoreClass: string;
  strokes: number;
  par: number;
  lines: [string, string][];
  total: number;
  suspicion: number;
  last: boolean;
}

export interface RoundResults {
  dq: boolean;
  rows: { hole: number; name: string; par: number; strokes: number }[];
  toPar: number;
  earned: number;
  kept: number;
  week: number;
  best: number | null;
  wallet: number;
}

const el = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document): T => {
  const e = root.querySelector<T>(sel);
  if (!e) throw new Error(`missing element ${sel}`);
  return e;
};

export const fmtPar = (n: number): string => (n === 0 ? 'E' : n > 0 ? `+${n}` : `${n}`);
const money = (n: number): string => `$${Math.round(n).toLocaleString('en-US')}`;

/** Little mouse pictures for the control hints: left button, right button, wheel. */
const mouseSvg = (part: 'l' | 'r' | 'w'): string => /* html */ `<svg class="ms" viewBox="0 0 16 22"><rect x="1" y="1" width="14" height="20" rx="7" fill="none" stroke="currentColor" stroke-width="1.5"/>${
  part === 'l' ? '<path d="M8 1.6A6.4 6.4 0 0 0 1.6 8v1.4H8Z" fill="currentColor"/>'
    : part === 'r' ? '<path d="M8 1.6A6.4 6.4 0 0 1 14.4 8v1.4H8Z" fill="currentColor"/>'
      : '<rect x="6.6" y="4" width="2.8" height="6" rx="1.4" fill="currentColor"/>'}</svg>`;
export const MOUSE = { l: mouseSvg('l'), r: mouseSvg('r'), w: mouseSvg('w') };

const EYE: Record<MarshalState, string> = {
  away: '<svg viewBox="0 0 64 40"><path d="M8 20 Q32 34 56 20" fill="none" stroke="currentColor" stroke-width="4.5" stroke-linecap="round"/><path d="M16 26l-3 6M27 30l-1.5 7M37 30l1.5 7M48 26l3 6" stroke="currentColor" stroke-width="3.5" stroke-linecap="round"/></svg>',
  turning: '<svg viewBox="0 0 64 40"><path d="M6 20 Q32 4 58 20 Q32 32 6 20Z" fill="none" stroke="currentColor" stroke-width="4.5" stroke-linejoin="round"/><circle cx="44" cy="19" r="5.5" fill="currentColor"/></svg>',
  watching: '<svg viewBox="0 0 64 40"><path d="M4 20 Q32 -6 60 20 Q32 46 4 20Z" fill="none" stroke="currentColor" stroke-width="4.5" stroke-linejoin="round"/><circle cx="32" cy="20" r="9.5" fill="currentColor"/><circle cx="35.5" cy="16.5" r="3" fill="#fff"/></svg>',
};
const EYE_LABEL: Record<MarshalState, string> = { away: 'NOT LOOKING', turning: 'TURNING ROUND', watching: 'WATCHING YOU' };
const RING = 2 * Math.PI * 31;

const WORDMARK = '<h1 class="wordmark">BULLSHIT<em>GOLF</em></h1>';

export class Hud {
  private readonly hud: HTMLElement;
  private readonly screen: HTMLElement;
  private readonly pad: SwingPad;
  private readonly cache = new Map<string, string>();
  private captionTimer = 0;
  private toastTimer = 0;
  private handlers: Record<string, (arg: string) => void> = {};

  constructor(root: HTMLElement, private readonly onClick: () => void) {
    root.innerHTML = /* html */ `
      <div id="hud" class="hidden">
        <div class="vignette"></div>

        <div class="tl">
          <div class="bug panel">
            <div class="bug-hole"><span class="lbl">HOLE</span><b id="h-hole"></b></div>
            <div class="bug-main"><b id="h-name"></b><span class="lbl" id="h-info"></span></div>
            <div class="bug-stat"><span class="lbl">STROKE</span><b class="num" id="h-stroke">1</b></div>
            <div class="bug-stat"><span class="lbl">ROUND</span><b class="num" id="h-total">E</b></div>
            <div class="bug-stat cash"><span class="lbl">PURSE</span><b class="num" id="h-money"></b></div>
          </div>
          <div id="h-card" class="cardchip hidden"></div>
        </div>

        <div class="tr">
          <div class="marshal panel" id="h-marshal" data-state="away">
            <div class="gauge">
              <svg viewBox="0 0 72 72"><circle class="g-bg" cx="36" cy="36" r="31"/><circle class="g-fill" id="h-sus" cx="36" cy="36" r="31" stroke-dasharray="${RING.toFixed(1)}" stroke-dashoffset="${RING.toFixed(1)}"/></svg>
              <div class="eye" id="h-eye"></div>
            </div>
            <div class="mtext">
              <span class="lbl">COURSE MARSHAL</span>
              <b id="h-eyelabel"></b>
              <div class="susrow"><span class="lbl">SUSPICION</span><em class="num" id="h-susn">0</em><span class="lbl">/ 100</span></div>
            </div>
          </div>
          <div class="wind panel">
            <div class="compass">
              <svg viewBox="-24 -24 48 48"><circle r="21" fill="none" stroke="currentColor" stroke-opacity="0.22" stroke-width="1.5"/><path d="M0 -21v4M0 21v-4M-21 0h4M21 0h-4" stroke="currentColor" stroke-opacity="0.5" stroke-width="1.5"/></svg>
              <svg id="h-windarrow" viewBox="-24 -24 48 48"><path d="M0 -15 L7.5 3 L2 1.2 L2 14 L-2 14 L-2 1.2 L-7.5 3 Z" fill="currentColor"/></svg>
            </div>
            <div class="windtext"><div><b class="num" id="h-wind">0</b><span class="lbl">MPH</span></div><em class="lbl" id="h-windlbl"></em></div>
          </div>
        </div>

        <div class="bl">
          <div class="bag panel" id="h-bag">
            <div class="bag-top"><span class="chip" id="h-lie"></span><span class="lbl" id="h-read"></span></div>
            <div class="bag-club"><b id="h-club"></b><em class="num" id="h-carry"></em></div>
            <div class="bag-pin"><span class="lbl">TO PIN</span><b class="num" id="h-pin"></b><span class="lbl" id="h-pinunit"></span></div>
            <div class="bag-strip" id="h-strip"></div>
          </div>
          <div class="monitor panel hidden" id="h-monitor">
            <div class="mon-head"><span class="lbl">LAUNCH MONITOR</span><i></i></div>
            <div class="mon-grid" id="h-mongrid"></div>
          </div>
        </div>

        <div class="br">
          <div class="pad panel" id="h-pad">
            <div class="pad-head"><span class="lbl" id="h-padtitle">SWING</span><b class="num" id="h-padpow"></b></div>
            <canvas id="h-padcv"></canvas>
            <div class="pad-read">
              <div id="p-path-row"><span class="lbl">PATH</span><b id="p-path">—</b></div>
              <div id="p-contact-row"><span class="lbl">CONTACT</span><b id="p-contact">—</b></div>
              <div id="p-tempo-row"><span class="lbl">TEMPO</span><b id="p-tempo">—</b></div>
            </div>
          </div>
        </div>

        <div class="hints" id="h-hints"></div>

        <div class="juice hidden" id="h-juice">
          <b class="lbl">SPIN JUICE</b>
          <div class="jbar"><div class="jfill" id="h-juicefill"></div></div>
          <span class="num" id="h-juicen"></span>
        </div>
        <div class="aftertouch hidden" id="h-after">AFTER-TOUCH<span class="num" id="h-afterspin"></span></div>
        <div class="caught hidden" id="h-caught">HE SAW THAT</div>
        <div class="toast hidden" id="h-toast"></div>
        <div class="caption hidden" id="h-caption"><i><u></u>BOOTH</i><span></span></div>
      </div>
      <div id="screen"></div>`;
    this.hud = el('#hud', root);
    this.screen = el('#screen', root);
    this.pad = new SwingPad(el<HTMLCanvasElement>('#h-padcv', root));
    this.screen.addEventListener('click', (ev) => {
      const t = (ev.target as HTMLElement).closest<HTMLElement>('[data-act]');
      if (!t || t.hasAttribute('disabled')) return;
      this.onClick();
      this.handlers[t.dataset.act!]?.(t.dataset.arg ?? '');
    });
    this.screen.addEventListener('input', (ev) => {
      const t = ev.target as HTMLInputElement;
      if (t.dataset.input) this.handlers[t.dataset.input]?.(t.value);
    });
  }

  private set(id: string, text: string): void {
    if (this.cache.get(id) === text) return;
    this.cache.set(id, text);
    el(`#${id}`).textContent = text;
  }

  private html(id: string, html: string): void {
    if (this.cache.get(id) === html) return;
    this.cache.set(id, html);
    el(`#${id}`).innerHTML = html;
  }

  private cls(id: string, name: string, on: boolean): void {
    const key = `${id}.${name}`, v = on ? '1' : '0';
    if (this.cache.get(key) === v) return;
    this.cache.set(key, v);
    el(`#${id}`).classList.toggle(name, on);
  }

  private tone(id: string, tone: Tone): void {
    const key = `${id}.tone`;
    if (this.cache.get(key) === tone) return;
    this.cache.set(key, tone);
    el(`#${id}`).dataset.tone = tone;
  }

  showHud(on: boolean): void { this.hud.classList.toggle('hidden', !on); }
  /** Flyover and card pick: hide the instruments. */
  setCinematic(on: boolean): void { this.cls('hud', 'cine', on); }

  setHole(num: string, name: string, info: string): void { this.set('h-hole', num); this.set('h-name', name); this.set('h-info', info); }
  setScore(stroke: number, total: number, cash: number): void {
    this.set('h-stroke', `${stroke}`);
    this.set('h-total', fmtPar(total));
    this.set('h-money', money(cash));
  }

  setCard(card: Card | null, note = ''): void {
    this.cls('h-card', 'hidden', !card);
    if (card) this.html('h-card', `<span>${card.icon}</span><b>${card.name}</b>${note ? `<em>${note}</em>` : ''}`);
    this.cls('h-card', 'used', note !== '');
  }

  /** screenAngle: 0 = blowing straight down the line you are looking along. */
  setWind(mph: number, screenAngle: number): void {
    const n = Math.round(mph);
    this.set('h-wind', `${n}`);
    const d = (screenAngle * 180) / Math.PI;
    const deg = `${Math.round(d)}`;
    if (this.cache.get('windrot') !== deg) {
      this.cache.set('windrot', deg);
      el('#h-windarrow').style.transform = `rotate(${deg}deg)`;
    }
    const a = Math.abs(d);
    const side = d > 0 ? 'L → R' : 'R → L';
    this.set('h-windlbl', n === 0 ? 'CALM' : a < 25 ? 'HELPING' : a > 155 ? 'INTO' : a < 65 ? `HELPING ${side}` : a > 115 ? `INTO ${side}` : `CROSS ${side}`);
  }

  setClub(lie: string, club: string, carry: string, pin: string, pinUnit: string, read: string): void {
    this.set('h-lie', lie); this.set('h-club', club); this.set('h-carry', carry);
    this.set('h-pin', pin); this.set('h-pinunit', pinUnit); this.set('h-read', read);
  }

  setBag(ids: string[], idx: number): void {
    this.html('h-strip', ids.map((id, i) => `<i class="${i === idx ? 'on' : ''}">${id}</i>`).join(''));
  }

  setMarshal(state: MarshalState, suspicion: number): void {
    if (this.cache.get('eye') !== state) {
      this.cache.set('eye', state);
      el('#h-marshal').dataset.state = state;
      el('#h-eye').innerHTML = EYE[state];
      el('#h-eyelabel').textContent = EYE_LABEL[state];
    }
    const v = Math.round(Math.min(100, suspicion));
    const s = `${v}`;
    if (this.cache.get('sus') !== s) {
      this.cache.set('sus', s);
      el('#h-sus').style.strokeDashoffset = `${(RING * (1 - v / 100)).toFixed(1)}`;
      el('#h-susn').textContent = s;
      el('#h-marshal').dataset.heat = v >= 70 ? 'hot' : v >= 40 ? 'warm' : 'cool';
    }
  }

  setHints(html: string): void { this.html('h-hints', html); }

  /** Which instruments sit along the bottom: the bag and swing lane, or the launch monitor. */
  setPanels(which: 'aim' | 'flight' | 'none'): void {
    this.cls('h-bag', 'hidden', which !== 'aim');
    this.cls('h-monitor', 'hidden', which !== 'flight');
    this.cls('h-pad', 'hidden', which === 'none');
  }

  drawPad(v: PadView): void { this.pad.draw(v); }

  /** The three swing numbers under the lane. Pass null to blank them. */
  setPadRead(title: string, power: string, read: { path: [string, Tone]; contact: [string, Tone]; tempo: [string, Tone] } | null): void {
    this.set('h-padtitle', title);
    this.set('h-padpow', power);
    this.set('p-path', read ? read.path[0] : '—');
    this.set('p-contact', read ? read.contact[0] : '—');
    this.set('p-tempo', read ? read.tempo[0] : '—');
    this.tone('p-path-row', read ? read.path[1] : '');
    this.tone('p-contact-row', read ? read.contact[1] : '');
    this.tone('p-tempo-row', read ? read.tempo[1] : '');
  }

  setMonitor(rows: MonitorRow[]): void {
    this.html('h-mongrid', rows.map((r) => `<div data-tone="${r.tone ?? ''}"><span class="lbl">${r.k}</span><b class="num">${r.v}</b><em class="lbl">${r.u ?? ''}</em></div>`).join(''));
  }

  setJuice(visible: boolean, frac: number, seconds: number, active: boolean): void {
    this.cls('h-juice', 'hidden', !visible);
    if (!visible) return;
    const w = `${Math.round(frac * 100)}`;
    if (this.cache.get('juice') !== w) {
      this.cache.set('juice', w);
      el('#h-juicefill').style.width = `${w}%`;
    }
    this.set('h-juicen', `${seconds.toFixed(1)}s`);
    this.cls('h-juice', 'active', active);
    this.cls('h-juice', 'empty', frac <= 0.001);
  }

  setAfterTouch(level: number, text: string): void {
    this.cls('h-after', 'hidden', level < 0.05);
    this.set('h-afterspin', text);
    const v = level.toFixed(2);
    if (this.cache.get('vig') !== v) {
      this.cache.set('vig', v);
      el('.vignette', this.hud).style.opacity = v;
    }
  }

  setCaught(on: boolean): void { this.cls('h-caught', 'hidden', !on); }

  caption(text: string, seconds = 4.2): void {
    const c = el('#h-caption');
    el('span', c).textContent = text;
    c.classList.remove('hidden');
    c.classList.remove('pop');
    void c.offsetWidth;
    c.classList.add('pop');
    this.captionTimer = seconds;
  }

  toast(text: string, kind: 'good' | 'bad' | 'cheat' | 'plain' = 'plain', seconds = 1.8): void {
    const t = el('#h-toast');
    t.textContent = text;
    t.className = `toast ${kind}`;
    void t.offsetWidth;
    t.classList.add('pop');
    this.toastTimer = seconds;
  }

  update(dt: number): void {
    if (this.captionTimer > 0 && (this.captionTimer -= dt) <= 0) el('#h-caption').classList.add('hidden');
    if (this.toastTimer > 0 && (this.toastTimer -= dt) <= 0) el('#h-toast').classList.add('hidden');
  }

  // ---------------------------------------------------------------- screens

  private open(html: string, handlers: Record<string, (arg: string) => void>, cls = ''): void {
    this.handlers = handlers;
    this.screen.className = cls;
    this.screen.innerHTML = html;
  }

  get screenOpen(): boolean { return this.screen.innerHTML !== ''; }

  clearScreen(): void {
    this.handlers = {};
    this.screen.innerHTML = '';
    this.screen.className = '';
  }

  showLoading(text: string, frac: number): void {
    if (!this.screen.querySelector('.loading')) {
      this.open(/* html */ `<div class="loading">${WORDMARK}<div class="lbar"><div></div></div><p class="lbl"></p></div>`, {}, 'solid');
    }
    el('.loading p', this.screen).textContent = text;
    el<HTMLElement>('.lbar div', this.screen).style.width = `${Math.round(frac * 100)}%`;
  }

  /** Thin veil while a hole streams in; the game keeps its own screen afterwards. */
  showVeil(text: string): void {
    this.open(/* html */ `<div class="veil"><div class="spinner"></div><p class="lbl">${text}</p></div>`, {}, 'solid');
  }

  showMenu(save: Save, h: { play: () => void; shop: () => void; how: () => void; settings: () => void }): void {
    this.open(/* html */ `
      <div class="menu">
        <div class="rail">
          <div class="title">
            <span class="kicker">GATOR CREEK G.C. · HOLES 7 &amp; 8</span>
            ${WORDMARK}
            <p>Tour-grade ball flight. A real swing, in your hand. A course marshal who is not always looking.</p>
          </div>
          <nav>
            <button class="primary" data-act="play"><i>01</i><b>TEE OFF</b><small>WEEK ${save.week}</small></button>
            <button data-act="shop"><i>02</i><b>PRO SHOP</b><small class="gold">${money(save.money)}</small></button>
            <button data-act="how"><i>03</i><b>HOW TO PLAY</b><small>MOUSE SWING</small></button>
            <button data-act="settings"><i>04</i><b>SETTINGS</b><small></small></button>
          </nav>
          <footer>
            <div><span class="lbl">WALLET</span><b class="num gold">${money(save.money)}</b></div>
            <div><span class="lbl">BEST ROUND</span><b class="num">${save.best === null ? '—' : fmtPar(save.best)}</b></div>
            <div><span class="lbl">ROUNDS</span><b class="num">${save.rounds}</b></div>
            <div><span class="lbl">DISQUALIFIED</span><b class="num">${save.dqs}</b></div>
          </footer>
        </div>
      </div>`, { play: h.play, shop: h.shop, how: h.how, settings: h.settings });
  }

  showHow(back: () => void): void {
    this.open(/* html */ `
      <div class="sheet how">
        <header><span class="kicker">THE MANUAL</span><h2>HOW TO PLAY</h2></header>
        <div class="cols">
          <section>
            <span class="step">01</span>
            <h3>The swing is in your hand</h3>
            <div class="swingdemo">
              <svg viewBox="0 0 120 150">
                <rect x="38" y="20" width="44" height="118" rx="4" fill="rgba(255,255,255,0.05)"/>
                <path d="M60 8V138" stroke="rgba(255,255,255,0.25)" stroke-dasharray="3 5"/>
                <path d="M57 26 C54 60 55 96 58 124" fill="none" stroke="#eef2ea" stroke-width="2" stroke-linecap="round"/>
                <path d="M64 124 C66 92 65 58 62 28" fill="none" stroke="#c8f03c" stroke-width="3" stroke-linecap="round"/>
                <path d="M53 116l5 9 4-9M58 36l4-9 5 9" fill="none" stroke="#eef2ea" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                <circle cx="60" cy="20" r="6" fill="#fff"/>
                <text x="30" y="80" text-anchor="end">1 PULL</text><text x="90" y="80">2 PUSH</text>
              </svg>
              <p><b>Hold</b> ${MOUSE.l} on the course, <b>pull the mouse back</b>, then <b>push it through the ball</b>. How far you pull is the power. Let go on the way back to step away.</p>
            </div>
            <dl>
              <dt>Path</dt><dd>Push straight to hit it straight. Swing out to the right and it draws left. Cut across to the left and it fades right.</dd>
              <dt>Contact</dt><dd>Come back through the ball. Miss wide right and you catch the hosel. Wide left is off the toe.</dd>
              <dt>Tempo</dt><dd>Three counts back, one count through. Two to one on the green. Snatch it and you thin it; ease off and you hit it fat.</dd>
            </dl>
            <p class="fine">${MOUSE.r} drag or <kbd>A</kbd><kbd>D</kbd> to aim · ${MOUSE.w} or <kbd>W</kbd><kbd>S</kbd> for the club · rough and sand shrink every margin.</p>
          </section>
          <section class="hot">
            <span class="step">02</span>
            <h3>So cheat</h3>
            <p>While the ball is in the air, <b>hold</b> <kbd>A</kbd>/<kbd>D</kbd> to bend it, <kbd>W</kbd> to make it dive and run, <kbd>S</kbd> to float it and make it bite. Or hold ${MOUSE.l} and drag the way you want it to go.</p>
            <p>Time slows while you steer. It works on a rolling ball too.</p>
            <p>Steering burns <b>Spin Juice</b>. You get a small tank per hole.</p>
            <p>Before each hole your caddie offers one <b>cheat card</b>: a magnetic cup, a bribed wind, a foot wedge.</p>
          </section>
          <section>
            <span class="step">03</span>
            <h3>Do not get caught</h3>
            <p>The <b>course marshal</b> looks up from his sandwich every few seconds. Steering while he is <b>not looking</b> raises suspicion slowly. Steering while he is <b>watching</b> raises it very fast.</p>
            <p>Cards add suspicion too. Playing a hole straight calms him down.</p>
            <p>Reach 100 and you are <b>disqualified</b>: no prize money, and a ride in the cart.</p>
            <p>Prize money buys upgrades in the Pro Shop. Each week the course gets meaner.</p>
          </section>
        </div>
        <div class="row"><button class="primary" data-act="back">GOT IT</button></div>
      </div>`, { back });
  }

  showSettings(save: Save, h: { volume: (v: number) => void; sens: (v: number) => void; quality: (q: Quality) => void; reset: () => void; back: () => void }): void {
    const q = (id: Quality, label: string): string => `<button data-act="quality" data-arg="${id}" class="${save.quality === id ? 'on' : ''}">${label}</button>`;
    this.open(/* html */ `
      <div class="sheet narrow">
        <header><span class="kicker">CLUBHOUSE</span><h2>SETTINGS</h2></header>
        <label class="field"><span>Volume</span><input type="range" min="0" max="1" step="0.05" value="${save.volume}" data-input="volume"></label>
        <label class="field"><span>Swing length<small>how far the mouse travels for a full swing</small></span><input type="range" min="0.6" max="1.6" step="0.05" value="${save.sens}" data-input="sens"></label>
        <div class="field"><span>Graphics</span><div class="seg">${q('low', 'LOW')}${q('medium', 'MEDIUM')}${q('high', 'HIGH')}</div></div>
        <div class="field"><span>Save data</span><button class="danger" data-act="reset">RESET PROGRESS</button></div>
        <div class="row"><button class="primary" data-act="back">DONE</button></div>
      </div>`, {
      volume: (v) => h.volume(Number(v)),
      sens: (v) => h.sens(Number(v)),
      quality: (v) => h.quality(v as Quality),
      reset: h.reset,
      back: h.back,
    });
  }

  showShop(save: Save, h: { buy: (id: UpgradeId) => void; back: () => void }, backLabel = 'BACK'): void {
    const rows = UPGRADES.map((u) => {
      const lvl = save.upgrades[u.id];
      const maxed = lvl >= u.max;
      const cost = upgradeCost(u, lvl);
      const pips = Array.from({ length: u.max }, (_, i) => `<i class="${i < lvl ? 'on' : ''}"></i>`).join('');
      return /* html */ `
        <div class="up ${maxed ? 'maxed' : ''}">
          <div class="uphead"><b>${u.name}</b><div class="pips">${pips}</div></div>
          <p>${u.blurb}</p>
          <div class="upfoot"><em class="lbl">${u.per} per level</em>
            <button data-act="buy" data-arg="${u.id}" ${maxed || cost > save.money ? 'disabled' : ''}>${maxed ? 'MAXED' : money(cost)}</button>
          </div>
        </div>`;
    }).join('');
    this.open(/* html */ `
      <div class="sheet shop">
        <header><span class="kicker">GATOR CREEK</span><h2>PRO SHOP</h2><div class="wallet"><span class="lbl">WALLET</span><b class="num">${money(save.money)}</b></div></header>
        <p class="sub">Everything here is within the rules, in the sense that the rules have not been updated since 1974.</p>
        <div class="ups">${rows}</div>
        <div class="row"><button class="primary" data-act="back">${backLabel}</button></div>
      </div>`, { buy: (id) => h.buy(id as UpgradeId), back: h.back });
  }

  showCards(holeTitle: string, cards: Card[], suspicion: number, honestRelief: number, pick: (id: string | null) => void): void {
    const list = cards.map((c, i) => /* html */ `
      <button class="card" data-act="pick" data-arg="${c.id}" style="--i:${i}">
        <div class="cicon">${c.icon}</div>
        <b>${c.name}</b>
        <p>${c.blurb}</p>
        <i>${c.flavor}</i>
        <span class="heat"><u style="width:${Math.min(100, c.heat * 5)}%"></u><em>+${c.heat} SUSPICION</em></span>
      </button>`).join('');
    this.open(/* html */ `
      <div class="cards">
        <span class="kicker">${holeTitle}</span>
        <h2>YOUR CADDIE HAS SOMETHING FOR YOU</h2>
        <div class="cardrow">${list}</div>
        <button class="honest" data-act="honest"><b>PLAY IT STRAIGHT</b><small>no card · −${honestRelief} suspicion if you also keep your hands off the ball</small></button>
        <div class="susline lbl">MARSHAL SUSPICION <b class="num">${Math.round(suspicion)}</b> / 100</div>
      </div>`, { pick: (id) => pick(id), honest: () => pick(null) });
  }

  showSummary(s: HoleSummary, next: () => void): void {
    const lines = s.lines.map(([a, b]) => `<div><span>${a}</span><b class="num">${b}</b></div>`).join('');
    this.open(/* html */ `
      <div class="sheet narrow summary">
        <header><span class="kicker">${s.title}</span><h2 class="${s.scoreClass}">${s.scoreName}</h2></header>
        <div class="bigscore"><b class="num">${s.strokes}</b><span class="lbl">STROKES · PAR ${s.par}</span></div>
        <div class="ledger">${lines}<div class="sum"><span>Hole winnings</span><b class="num">${money(s.total)}</b></div></div>
        <div class="susline lbl">MARSHAL SUSPICION <b class="num">${Math.round(s.suspicion)}</b> / 100</div>
        <div class="row"><button class="primary" data-act="next">${s.last ? 'FINISH ROUND' : 'NEXT HOLE'}</button></div>
      </div>`, { next });
  }

  showResults(r: RoundResults, h: { again: () => void; shop: () => void; menu: () => void }): void {
    const rows = r.rows.map((x) => `<tr><td class="num">${x.hole}</td><td>${x.name}</td><td class="num">${x.par}</td><td class="num"><b>${x.strokes}</b></td><td class="num">${fmtPar(x.strokes - x.par)}</td></tr>`).join('');
    this.open(/* html */ `
      <div class="sheet narrow results ${r.dq ? 'dq' : ''}">
        <header><span class="kicker">${r.dq ? 'ROUND VOID' : 'ROUND COMPLETE'}</span><h2>${r.dq ? 'DISQUALIFIED' : `FINAL ${fmtPar(r.toPar)}`}</h2></header>
        ${rows ? `<table><thead><tr><th>HOLE</th><th></th><th>PAR</th><th>SCORE</th><th></th></tr></thead><tbody>${rows}</tbody></table>` : ''}
        <div class="ledger">
          <div><span>Prize money won</span><b class="num">${money(r.earned)}</b></div>
          ${r.dq ? `<div><span>Confiscated by the marshal</span><b class="num">−${money(r.earned)}</b></div>` : ''}
          <div class="sum"><span>${r.dq ? 'Gas money' : 'Banked'}</span><b class="num">${money(r.kept)}</b></div>
          <div><span>Wallet</span><b class="num">${money(r.wallet)}</b></div>
        </div>
        <p class="sub">${r.dq
          ? 'Your name has been written in the book. Same week next time; the marshal has a short memory and a long lunch.'
          : `Week ${r.week} is next. More wind, less margin on the club face and a more attentive marshal.`}</p>
        <div class="row">
          <button class="primary" data-act="again">${r.dq ? 'TRY AGAIN' : `PLAY WEEK ${r.week}`}</button>
          <button data-act="shop">PRO SHOP</button>
          <button data-act="menu">MAIN MENU</button>
        </div>
      </div>`, { again: h.again, shop: h.shop, menu: h.menu });
  }

  showPause(h: { resume: () => void; settings: () => void; how: () => void; quit: () => void }): void {
    this.open(/* html */ `
      <div class="sheet narrow pause">
        <header><span class="kicker">PLAY SUSPENDED</span><h2>PAUSED</h2></header>
        <nav class="stack">
          <button class="primary" data-act="resume">RESUME</button>
          <button data-act="how">HOW TO PLAY</button>
          <button data-act="settings">SETTINGS</button>
          <button class="danger" data-act="quit">ABANDON ROUND</button>
        </nav>
      </div>`, { resume: h.resume, settings: h.settings, how: h.how, quit: h.quit }, 'dim');
  }

  showDq(text: string): void {
    this.open(/* html */ `<div class="dqbanner"><span class="lbl">OFFICIAL RULING</span><h1>DISQUALIFIED</h1><p>${text}</p></div>`, {});
  }
}
