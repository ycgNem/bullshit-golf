import type { Card } from './cards';
import { UPGRADES, upgradeCost, type Save, type UpgradeId } from './save';
import type { Quality } from './world';

export type MarshalState = 'away' | 'turning' | 'watching';

export interface MeterView {
  /** marker position along the bar, 0..1 */
  marker: number;
  /** locked power position, or -1 while still rising */
  power: number;
  sweet: number;
  full: number;
  /** half-width of the clean-strike window in bar units */
  window: number;
  /** putting guide position, or -1 */
  tick: number;
}

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

const EYE: Record<MarshalState, string> = {
  away: '<svg viewBox="0 0 64 40"><path d="M6 22 Q32 34 58 22" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round"/><path d="M14 27l-4 6M26 31l-2 7M38 31l2 7M50 27l4 6" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></svg>',
  turning: '<svg viewBox="0 0 64 40"><path d="M6 20 Q32 4 58 20 Q32 30 6 20Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><circle cx="44" cy="19" r="5" fill="currentColor"/></svg>',
  watching: '<svg viewBox="0 0 64 40"><path d="M4 20 Q32 -6 60 20 Q32 46 4 20Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><circle cx="32" cy="20" r="9" fill="currentColor"/><circle cx="35" cy="17" r="3" fill="#fff"/></svg>',
};
const EYE_LABEL: Record<MarshalState, string> = { away: 'NOT LOOKING', turning: 'TURNING AROUND', watching: 'WATCHING YOU' };

export class Hud {
  private readonly hud: HTMLElement;
  private readonly screen: HTMLElement;
  private readonly cache = new Map<string, string>();
  private captionTimer = 0;
  private toastTimer = 0;
  private handlers: Record<string, (arg: string) => void> = {};

  constructor(root: HTMLElement, private readonly onClick: () => void) {
    root.innerHTML = /* html */ `
      <div id="hud" class="hidden">
        <div class="vignette"></div>
        <div class="tl">
          <div class="plate"><b id="h-hole"></b><span id="h-info"></span></div>
          <div class="plate small"><span>STROKE</span><b id="h-stroke">1</b><span>ROUND</span><b id="h-total">E</b><span id="h-money" class="cash"></span></div>
          <div id="h-card" class="plate small card-badge hidden"></div>
        </div>
        <div class="tr">
          <div class="marshal" id="h-marshal" data-state="away">
            <div class="eye" id="h-eye"></div>
            <div class="mtext"><span>MARSHAL</span><b id="h-eyelabel"></b></div>
            <div class="sus"><div class="susfill" id="h-sus"></div><i>SUSPICION</i><em id="h-susn">0</em></div>
          </div>
          <div class="wind plate">
            <svg id="h-windarrow" viewBox="-20 -20 40 40"><path d="M0 -15 L9 4 L2.5 2 L2.5 15 L-2.5 15 L-2.5 2 L-9 4 Z" fill="currentColor"/></svg>
            <div><b id="h-wind">0</b><span>MPH WIND</span></div>
          </div>
        </div>
        <div class="bl">
          <div class="plate club"><span id="h-lie"></span><b id="h-club"></b><em id="h-carry"></em></div>
          <div class="plate small"><span>TO PIN</span><b id="h-pin"></b><span id="h-read"></span></div>
        </div>
        <div class="hints" id="h-hints"></div>
        <div class="meter hidden" id="h-meter">
          <div class="mlabel" id="h-mlabel"></div>
          <div class="bar">
            <div class="over" id="m-over"></div>
            <div class="fill" id="m-fill"></div>
            <div class="win" id="m-win"></div>
            <div class="sweet" id="m-sweet"></div>
            <div class="full" id="m-full"><i>100</i></div>
            <div class="tick hidden" id="m-tick"></div>
            <div class="pow hidden" id="m-pow"></div>
            <div class="marker" id="m-marker"></div>
          </div>
        </div>
        <div class="juice hidden" id="h-juice">
          <div class="jhead"><b>SPIN JUICE</b><span id="h-juicen"></span></div>
          <div class="jbar"><div class="jfill" id="h-juicefill"></div></div>
          <div class="jkeys"><kbd>A</kbd><kbd>D</kbd> bend it &nbsp; <kbd>W</kbd> dive &nbsp; <kbd>S</kbd> float</div>
        </div>
        <div class="aftertouch hidden" id="h-after">AFTER-TOUCH<span id="h-afterspin"></span></div>
        <div class="caught hidden" id="h-caught">HE SAW THAT</div>
        <div class="toast hidden" id="h-toast"></div>
        <div class="caption hidden" id="h-caption"><i>BOOTH</i><span></span></div>
      </div>
      <div id="screen"></div>`;
    this.hud = el('#hud', root);
    this.screen = el('#screen', root);
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

  private cls(id: string, name: string, on: boolean): void {
    const key = `${id}.${name}`, v = on ? '1' : '0';
    if (this.cache.get(key) === v) return;
    this.cache.set(key, v);
    el(`#${id}`).classList.toggle(name, on);
  }

  showHud(on: boolean): void { this.hud.classList.toggle('hidden', !on); }
  /** Flyover and card pick: hide the club read-outs. */
  setCinematic(on: boolean): void { this.cls('hud', 'cine', on); }

  setHole(title: string, info: string): void { this.set('h-hole', title); this.set('h-info', info); }
  setScore(stroke: number, total: number, cash: number): void {
    this.set('h-stroke', `${stroke}`);
    this.set('h-total', fmtPar(total));
    this.set('h-money', money(cash));
  }

  setCard(card: Card | null, note = ''): void {
    this.cls('h-card', 'hidden', !card);
    if (card) this.set('h-card', `${card.icon} ${card.name}${note ? ` · ${note}` : ''}`);
  }

  setWind(mph: number, screenAngle: number): void {
    this.set('h-wind', `${Math.round(mph)}`);
    const deg = `${Math.round((screenAngle * 180) / Math.PI)}`;
    if (this.cache.get('windrot') !== deg) {
      this.cache.set('windrot', deg);
      el('#h-windarrow').style.transform = `rotate(${deg}deg)`;
    }
  }

  setClub(lie: string, club: string, carry: string, pin: string, read: string): void {
    this.set('h-lie', lie); this.set('h-club', club); this.set('h-carry', carry); this.set('h-pin', pin); this.set('h-read', read);
  }

  setMarshal(state: MarshalState, suspicion: number): void {
    if (this.cache.get('eye') !== state) {
      this.cache.set('eye', state);
      el('#h-marshal').dataset.state = state;
      el('#h-eye').innerHTML = EYE[state];
      el('#h-eyelabel').textContent = EYE_LABEL[state];
    }
    const s = `${Math.round(Math.min(100, suspicion))}`;
    if (this.cache.get('sus') !== s) {
      this.cache.set('sus', s);
      el('#h-sus').style.width = `${s}%`;
      el('#h-susn').textContent = s;
      el('#h-marshal').classList.toggle('hot', suspicion >= 70);
    }
  }

  setHints(html: string): void {
    if (this.cache.get('hints') === html) return;
    this.cache.set('hints', html);
    el('#h-hints').innerHTML = html;
  }

  showMeter(on: boolean, label = ''): void {
    this.cls('h-meter', 'hidden', !on);
    if (on) this.set('h-mlabel', label);
  }

  setMeter(m: MeterView): void {
    const pct = (u: number): string => `${(u * 100).toFixed(2)}%`;
    el('#m-marker').style.left = pct(m.marker);
    el('#m-sweet').style.left = pct(m.sweet);
    el('#m-full').style.left = pct(m.full);
    el('#m-over').style.left = pct(m.full);
    const win = el('#m-win');
    win.style.left = pct(m.sweet - m.window);
    win.style.width = pct(m.window * 2);
    const top = m.power >= 0 ? m.power : m.marker;
    const fill = el('#m-fill');
    fill.style.left = pct(m.sweet);
    fill.style.width = pct(Math.max(0, top - m.sweet));
    this.cls('m-pow', 'hidden', m.power < 0);
    if (m.power >= 0) el('#m-pow').style.left = pct(m.power);
    this.cls('m-tick', 'hidden', m.tick < 0);
    if (m.tick >= 0) el('#m-tick').style.left = pct(m.tick);
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
      this.open(/* html */ `<div class="loading"><h1>BULLSHIT<em>GOLF</em></h1><div class="lbar"><div></div></div><p></p></div>`, {}, 'solid');
    }
    el('.loading p', this.screen).textContent = text;
    el<HTMLElement>('.lbar div', this.screen).style.width = `${Math.round(frac * 100)}%`;
  }

  /** Thin veil while a hole streams in; the game keeps its own screen afterwards. */
  showVeil(text: string): void {
    this.open(/* html */ `<div class="veil"><div class="spinner"></div><p>${text}</p></div>`, {}, 'solid');
  }

  showMenu(save: Save, h: { play: () => void; shop: () => void; how: () => void; settings: () => void }): void {
    this.open(/* html */ `
      <div class="menu">
        <div class="title">
          <span class="kicker">THE 7TH AND 8TH AT GATOR CREEK</span>
          <h1>BULLSHIT<em>GOLF</em></h1>
          <p>A photo-real golf simulation. Please do not watch the ball too closely.</p>
        </div>
        <nav>
          <button class="primary" data-act="play">TEE OFF <small>WEEK ${save.week}</small></button>
          <button data-act="shop">PRO SHOP <small>${money(save.money)}</small></button>
          <button data-act="how">HOW TO PLAY</button>
          <button data-act="settings">SETTINGS</button>
        </nav>
        <footer>
          <span>WALLET <b>${money(save.money)}</b></span>
          <span>BEST ROUND <b>${save.best === null ? '—' : fmtPar(save.best)}</b></span>
          <span>ROUNDS <b>${save.rounds}</b></span>
          <span>DISQUALIFIED <b>${save.dqs}</b></span>
        </footer>
      </div>`, { play: h.play, shop: h.shop, how: h.how, settings: h.settings });
  }

  showHow(back: () => void): void {
    this.open(/* html */ `
      <div class="sheet">
        <h2>HOW TO PLAY</h2>
        <div class="cols">
          <section>
            <h3>1 · The swing is honest. And hard.</h3>
            <p><kbd>A</kbd><kbd>D</kbd> aim, <kbd>W</kbd><kbd>S</kbd> change club (hold <kbd>Shift</kbd> to aim finely). Then three presses of <kbd>Space</kbd>:</p>
            <ol>
              <li>start the swing,</li>
              <li>stop the bar for power (past 100 is an overswing: more distance, less margin),</li>
              <li>stop it again <b>exactly</b> on the white line.</li>
            </ol>
            <p>Miss early and you pull or hook it. Miss late and you slice. Miss badly and you shank, chunk or top it. Rough and sand shrink the window.</p>
          </section>
          <section class="hot">
            <h3>2 · So cheat.</h3>
            <p>While the ball is in the air, <b>hold</b> <kbd>A</kbd>/<kbd>D</kbd> to bend it, <kbd>W</kbd> to make it dive and run, <kbd>S</kbd> to float it and make it bite. Time slows while you steer. It works on a rolling ball too.</p>
            <p>Steering burns <b>Spin Juice</b>. You get a small tank per hole.</p>
            <p>Before each hole you may take one <b>cheat card</b>: a magnetic cup, a bribed wind, a foot wedge…</p>
          </section>
          <section>
            <h3>3 · Do not get caught.</h3>
            <p>The <b>course marshal</b> looks up from his sandwich every few seconds. Steering while he is <b>not looking</b> raises suspicion slowly. Steering while he is <b>watching</b> raises it very fast.</p>
            <p>Cards add suspicion too. Playing a hole straight calms him down.</p>
            <p>Reach 100 and you are <b>disqualified</b>: no prize money, and a ride in the cart.</p>
            <p>Prize money buys upgrades in the Pro Shop. Each week the course gets meaner.</p>
          </section>
        </div>
        <div class="row"><button class="primary" data-act="back">GOT IT</button></div>
      </div>`, { back });
  }

  showSettings(save: Save, h: { volume: (v: number) => void; quality: (q: Quality) => void; reset: () => void; back: () => void }): void {
    const q = (id: Quality, label: string): string => `<button data-act="quality" data-arg="${id}" class="${save.quality === id ? 'on' : ''}">${label}</button>`;
    this.open(/* html */ `
      <div class="sheet narrow">
        <h2>SETTINGS</h2>
        <label class="field"><span>Volume</span><input type="range" min="0" max="1" step="0.05" value="${save.volume}" data-input="volume"></label>
        <div class="field"><span>Graphics</span><div class="seg">${q('low', 'LOW')}${q('medium', 'MEDIUM')}${q('high', 'HIGH')}</div></div>
        <div class="field"><span>Save data</span><button class="danger" data-act="reset">RESET PROGRESS</button></div>
        <div class="row"><button class="primary" data-act="back">DONE</button></div>
      </div>`, {
      volume: (v) => h.volume(Number(v)),
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
          <div class="upinfo"><b>${u.name}</b><span>${u.blurb}</span><em>${u.per} per level</em></div>
          <div class="pips">${pips}</div>
          <button data-act="buy" data-arg="${u.id}" ${maxed || cost > save.money ? 'disabled' : ''}>${maxed ? 'MAXED' : money(cost)}</button>
        </div>`;
    }).join('');
    this.open(/* html */ `
      <div class="sheet">
        <h2>PRO SHOP <span class="wallet">${money(save.money)}</span></h2>
        <p class="sub">Everything here is within the rules, in the sense that the rules have not been updated since 1974.</p>
        <div class="ups">${rows}</div>
        <div class="row"><button class="primary" data-act="back">${backLabel}</button></div>
      </div>`, { buy: (id) => h.buy(id as UpgradeId), back: h.back });
  }

  showCards(holeTitle: string, cards: Card[], suspicion: number, honestRelief: number, pick: (id: string | null) => void): void {
    const list = cards.map((c) => /* html */ `
      <button class="card" data-act="pick" data-arg="${c.id}">
        <div class="cicon">${c.icon}</div>
        <b>${c.name}</b>
        <p>${c.blurb}</p>
        <i>${c.flavor}</i>
        <span class="heat">+${c.heat} SUSPICION</span>
      </button>`).join('');
    this.open(/* html */ `
      <div class="cards">
        <span class="kicker">${holeTitle}</span>
        <h2>YOUR CADDIE HAS SOMETHING FOR YOU</h2>
        <div class="cardrow">${list}</div>
        <button class="honest" data-act="honest">PLAY IT STRAIGHT <small>no card · −${honestRelief} suspicion if you also keep your hands off the ball</small></button>
        <div class="susline">Marshal suspicion right now: <b>${Math.round(suspicion)}</b> / 100</div>
      </div>`, { pick: (id) => pick(id), honest: () => pick(null) });
  }

  showSummary(s: HoleSummary, next: () => void): void {
    const lines = s.lines.map(([a, b]) => `<div><span>${a}</span><b>${b}</b></div>`).join('');
    this.open(/* html */ `
      <div class="sheet narrow summary">
        <span class="kicker">${s.title}</span>
        <h2 class="${s.scoreClass}">${s.scoreName}</h2>
        <div class="bigscore"><b>${s.strokes}</b><span>strokes · par ${s.par}</span></div>
        <div class="ledger">${lines}<div class="sum"><span>Hole winnings</span><b>${money(s.total)}</b></div></div>
        <div class="susline">Marshal suspicion: <b>${Math.round(s.suspicion)}</b> / 100</div>
        <div class="row"><button class="primary" data-act="next">${s.last ? 'FINISH ROUND' : 'NEXT HOLE'}</button></div>
      </div>`, { next });
  }

  showResults(r: RoundResults, h: { again: () => void; shop: () => void; menu: () => void }): void {
    const rows = r.rows.map((x) => `<tr><td>${x.hole}</td><td>${x.name}</td><td>${x.par}</td><td><b>${x.strokes}</b></td><td>${fmtPar(x.strokes - x.par)}</td></tr>`).join('');
    this.open(/* html */ `
      <div class="sheet narrow results ${r.dq ? 'dq' : ''}">
        <span class="kicker">${r.dq ? 'ROUND VOID' : 'ROUND COMPLETE'}</span>
        <h2>${r.dq ? 'DISQUALIFIED' : `FINAL: ${fmtPar(r.toPar)}`}</h2>
        ${rows ? `<table><thead><tr><th>HOLE</th><th></th><th>PAR</th><th>SCORE</th><th></th></tr></thead><tbody>${rows}</tbody></table>` : ''}
        <div class="ledger">
          <div><span>Prize money won</span><b>${money(r.earned)}</b></div>
          ${r.dq ? `<div><span>Confiscated by the marshal</span><b>−${money(r.earned)}</b></div>` : ''}
          <div class="sum"><span>${r.dq ? 'Gas money' : 'Banked'}</span><b>${money(r.kept)}</b></div>
          <div><span>Wallet</span><b>${money(r.wallet)}</b></div>
        </div>
        <p class="sub">${r.dq
          ? 'Your name has been written in the book. Same week next time; the marshal has a short memory and a long lunch.'
          : `Week ${r.week} is next. More wind, a smaller sweet spot and a more attentive marshal.`}</p>
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
        <h2>PAUSED</h2>
        <nav class="stack">
          <button class="primary" data-act="resume">RESUME</button>
          <button data-act="how">HOW TO PLAY</button>
          <button data-act="settings">SETTINGS</button>
          <button class="danger" data-act="quit">ABANDON ROUND</button>
        </nav>
      </div>`, { resume: h.resume, settings: h.settings, how: h.how, quit: h.quit }, 'dim');
  }

  showDq(text: string): void {
    this.open(/* html */ `<div class="dqbanner"><h1>DISQUALIFIED</h1><p>${text}</p></div>`, {});
  }
}
