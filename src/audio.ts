// Every sound is synthesised: no audio files.

type Wave = OscillatorType;

export class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  private volume = 0.7;
  private drone: { osc: OscillatorNode; osc2: OscillatorNode; gain: GainNode; filter: BiquadFilterNode } | null = null;
  private birdTimer = 0;

  /** Call from a user gesture: browsers keep audio suspended until then. */
  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const ctx = new AudioContext();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.volume;
    const comp = ctx.createDynamicsCompressor();
    this.master.connect(comp).connect(ctx.destination);
    const len = ctx.sampleRate * 2;
    this.noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

    // Wind bed.
    const bed = ctx.createBufferSource();
    bed.buffer = this.noiseBuf;
    bed.loop = true;
    const bf = ctx.createBiquadFilter();
    bf.type = 'lowpass';
    bf.frequency.value = 380;
    const bg = ctx.createGain();
    bg.gain.value = 0.035;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.13;
    const lg = ctx.createGain();
    lg.gain.value = 0.02;
    lfo.connect(lg).connect(bg.gain);
    bed.connect(bf).connect(bg).connect(this.master);
    bed.start();
    lfo.start();

    // After-touch drone, silent until steering.
    const osc = ctx.createOscillator(), osc2 = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc2.type = 'sawtooth';
    osc.frequency.value = 55;
    osc2.frequency.value = 82.7;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 300;
    filter.Q.value = 6;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    osc.connect(filter);
    osc2.connect(filter);
    filter.connect(gain).connect(this.master);
    osc.start();
    osc2.start();
    this.drone = { osc, osc2, gain, filter };
  }

  setVolume(v: number): void {
    this.volume = v;
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.03);
  }

  private tone(freq: number, dur: number, type: Wave, gain: number, when = 0, slideTo?: number, attack = 0.005): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const t = ctx.currentTime + when;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0005, t + dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  private noise(dur: number, type: BiquadFilterType, freq: number, q: number, gain: number, when = 0, sweepTo?: number, attack = 0.004): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || !this.noiseBuf) return;
    const t = ctx.currentTime + when;
    const s = ctx.createBufferSource();
    s.buffer = this.noiseBuf;
    s.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(freq, t);
    if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, t + dur);
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0005, t + dur);
    s.connect(f).connect(g).connect(this.master);
    s.start(t, Math.random());
    s.stop(t + dur + 0.02);
  }

  click(): void { this.tone(880, 0.05, 'triangle', 0.12); }
  tick(): void { this.tone(1400, 0.025, 'square', 0.04); }
  cardFlip(): void { this.noise(0.09, 'highpass', 2500, 0.7, 0.2); this.tone(520, 0.12, 'triangle', 0.1, 0.03, 780); }
  deny(): void { this.tone(160, 0.18, 'square', 0.1, 0, 110); }

  whoosh(power: number): void {
    this.noise(0.28, 'bandpass', 500, 1.2, 0.25 * power, 0, 2600, 0.12);
  }

  strike(kind: 'pure' | 'ok' | 'bad' | 'putt', power: number): void {
    if (kind === 'putt') {
      this.tone(1500, 0.05, 'sine', 0.2);
      this.noise(0.03, 'bandpass', 2400, 2, 0.18);
      return;
    }
    const p = 0.5 + 0.5 * power;
    if (kind === 'pure') {
      this.noise(0.05, 'highpass', 3000, 0.7, 0.75 * p);
      this.tone(3100, 0.22, 'sine', 0.3 * p, 0, 2700);
      this.tone(4650, 0.14, 'sine', 0.12 * p);
      this.tone(170, 0.12, 'sine', 0.5 * p, 0, 70);
    } else if (kind === 'ok') {
      this.noise(0.06, 'bandpass', 2100, 0.8, 0.7 * p);
      this.tone(1900, 0.09, 'triangle', 0.14 * p, 0, 1500);
      this.tone(150, 0.1, 'sine', 0.4 * p, 0, 70);
    } else {
      this.noise(0.12, 'lowpass', 900, 0.8, 0.8 * p);
      this.tone(110, 0.16, 'square', 0.22 * p, 0, 55);
    }
  }

  bounce(surface: string, speed: number): void {
    const g = Math.min(0.6, 0.06 + speed * 0.035);
    if (surface === 'path') {
      this.tone(2300, 0.07, 'triangle', g, 0, 1700);
      this.noise(0.04, 'highpass', 3000, 0.7, g);
    } else if (surface === 'sand') this.noise(0.16, 'lowpass', 1300, 0.6, g * 1.2);
    else {
      this.tone(120, 0.1, 'sine', g * 1.3, 0, 60);
      this.noise(0.07, 'lowpass', 700, 0.7, g);
    }
  }

  thunk(speed: number): void {
    const g = Math.min(0.7, 0.15 + speed * 0.03);
    this.tone(210, 0.16, 'triangle', g, 0, 120);
    this.noise(0.05, 'bandpass', 1400, 1.2, g);
  }

  clank(): void {
    this.tone(1240, 0.3, 'square', 0.12, 0, 1180);
    this.tone(1870, 0.22, 'square', 0.07);
    this.noise(0.05, 'highpass', 2000, 0.7, 0.3);
  }

  leaves(): void { this.noise(0.3, 'bandpass', 3800, 0.6, 0.3, 0, 1800, 0.02); this.tone(300, 0.06, 'triangle', 0.14, 0.02); }

  splash(): void {
    this.noise(0.6, 'lowpass', 2800, 0.5, 0.6, 0, 400, 0.01);
    this.noise(0.9, 'bandpass', 5200, 0.9, 0.16, 0.06, 2600, 0.1);
    this.tone(190, 0.22, 'sine', 0.3, 0, 60);
  }

  chomp(): void {
    this.noise(0.1, 'lowpass', 500, 1, 0.8);
    this.tone(90, 0.2, 'sawtooth', 0.3, 0, 45);
    this.noise(0.08, 'lowpass', 400, 1, 0.6, 0.22);
    this.tone(70, 0.4, 'sawtooth', 0.2, 0.3, 50);
  }

  cup(): void {
    for (let i = 0; i < 4; i++) {
      this.tone(820 - i * 70 + Math.random() * 60, 0.06, 'triangle', 0.28 - i * 0.05, i * 0.075);
      this.noise(0.03, 'bandpass', 1800, 2, 0.2 - i * 0.04, i * 0.075);
    }
  }

  /** Polite golf clap: n dry hand claps with ragged timing. */
  clap(n: number): void {
    for (let i = 0; i < n; i++) this.noise(0.035, 'bandpass', 1100 + Math.random() * 900, 1.1, 0.12 + Math.random() * 0.1, Math.random() * 1.6 + i * 0.012);
  }

  ooh(): void {
    for (const f of [196, 247, 294]) this.tone(f * 1.06, 0.9, 'sawtooth', 0.035, 0, f * 0.9, 0.15);
    this.noise(0.9, 'bandpass', 700, 1.5, 0.05, 0, 500, 0.2);
  }

  trombone(): void {
    const notes = [233, 220, 208, 196];
    notes.forEach((f, i) => {
      const last = i === notes.length - 1;
      this.tone(f, last ? 1.0 : 0.3, 'sawtooth', 0.14, i * 0.34, last ? f * 0.86 : f * 0.97, 0.04);
      this.tone(f / 2, last ? 1.0 : 0.3, 'square', 0.05, i * 0.34, last ? (f / 2) * 0.86 : undefined, 0.04);
    });
  }

  fanfare(): void {
    [392, 523, 659, 784].forEach((f, i) => {
      this.tone(f, i === 3 ? 0.7 : 0.16, 'square', 0.09, i * 0.13);
      this.tone(f * 1.5, i === 3 ? 0.7 : 0.16, 'triangle', 0.06, i * 0.13);
    });
  }

  whistle(long = false): void {
    const n = long ? 3 : 1;
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < 9; k++) this.tone(k % 2 ? 2750 : 2950, 0.045, 'sine', 0.16, i * 0.5 + k * 0.04);
      this.noise(0.36, 'bandpass', 2850, 9, 0.22, i * 0.5);
    }
  }

  horn(): void {
    for (const t of [0, 0.32]) {
      this.tone(392, 0.24, 'square', 0.14, t);
      this.tone(494, 0.24, 'square', 0.11, t);
    }
  }

  kaching(): void {
    this.noise(0.05, 'highpass', 4000, 0.7, 0.3);
    this.tone(1320, 0.4, 'triangle', 0.16, 0.04);
    this.tone(1760, 0.5, 'triangle', 0.14, 0.11);
  }

  kick(): void { this.tone(140, 0.14, 'sine', 0.5, 0, 50); this.noise(0.06, 'lowpass', 900, 0.8, 0.4); }

  /** Continuous after-touch hum: 0 off, 1 full. */
  slowmo(level: number): void {
    const d = this.drone, ctx = this.ctx;
    if (!d || !ctx) return;
    const t = ctx.currentTime;
    d.gain.gain.setTargetAtTime(0.11 * level, t, 0.05);
    d.filter.frequency.setTargetAtTime(260 + 900 * level, t, 0.08);
    d.osc.frequency.setTargetAtTime(55 + 18 * level, t, 0.1);
    d.osc2.frequency.setTargetAtTime(82.7 + 27 * level, t, 0.1);
  }

  /** Occasional birdsong. Call every frame with real dt. */
  ambience(dt: number): void {
    if (!this.ctx) return;
    this.birdTimer -= dt;
    if (this.birdTimer > 0) return;
    this.birdTimer = 2.5 + Math.random() * 6;
    const base = 2600 + Math.random() * 1800;
    const n = 2 + Math.floor(Math.random() * 4);
    for (let i = 0; i < n; i++) this.tone(base * (1 + Math.random() * 0.15), 0.09, 'sine', 0.025, i * 0.13, base * (1.25 + Math.random() * 0.3), 0.02);
  }
}
