// Ball aerodynamics: drag plus Magnus lift from spin. Pure numbers, shared by the sim and the club table.

export const BALL_R = 0.02135;
export const BALL_M = 0.04593;
export const G = 9.81;
const K = (0.5 * 1.2 * Math.PI * BALL_R * BALL_R) / BALL_M;

export const AERO = { cd0: 0.205, cdSpin: 0.34, clMax: 0.36, clS: 0.13, spinTau: 24 };

/** Acceleration on the ball. v = velocity, w = angular velocity (rad/s), wind = air velocity. Writes into out[0..2]. */
export function aeroAccel(
  vx: number, vy: number, vz: number,
  wx: number, wy: number, wz: number,
  ax: number, ay: number, az: number,
  out: Float64Array | number[],
): void {
  const rx = vx - ax, ry = vy - ay, rz = vz - az;
  const sp = Math.hypot(rx, ry, rz);
  if (sp < 1e-4) { out[0] = 0; out[1] = -G; out[2] = 0; return; }
  const w = Math.hypot(wx, wy, wz);
  const S = Math.min(0.6, (w * BALL_R) / Math.max(sp, 3));
  const cd = AERO.cd0 + AERO.cdSpin * S;
  const cl = AERO.clMax * (1 - Math.exp(-S / AERO.clS));
  const kd = K * cd * sp;
  let lx = 0, ly = 0, lz = 0;
  if (w > 1e-3) {
    const kl = (K * cl * sp) / w;          // |v| * (w_hat x v) = (w x v) * |v| / (|w| |v|) * |v|
    lx = kl * (wy * rz - wz * ry);
    ly = kl * (wz * rx - wx * rz);
    lz = kl * (wx * ry - wy * rx);
  }
  out[0] = -kd * rx + lx;
  out[1] = -kd * ry + ly - G;
  out[2] = -kd * rz + lz;
}

/** Carry and flight facts over flat, windless ground for a straight shot. */
export function flatCarry(speed: number, launchDeg: number, spinRpm: number): { carry: number; apex: number; time: number; landAngle: number; landSpeed: number } {
  const a = (launchDeg * Math.PI) / 180;
  let x = 0, y = 0, vx = speed * Math.cos(a), vy = speed * Math.sin(a);
  let w = (spinRpm * 2 * Math.PI) / 60;
  const acc = [0, 0, 0];
  const dt = 1 / 240;
  let apex = 0, t = 0;
  while (t < 20) {
    // backspin axis = +z when travelling +x
    aeroAccel(vx, vy, 0, 0, 0, w, 0, 0, 0, acc);
    vx += acc[0] * dt; vy += acc[1] * dt;
    x += vx * dt; y += vy * dt;
    w *= Math.exp(-dt / AERO.spinTau);
    t += dt;
    if (y > apex) apex = y;
    if (y <= 0 && vy < 0) break;
  }
  return { carry: x, apex, time: t, landAngle: (Math.atan2(-vy, vx) * 180) / Math.PI, landSpeed: Math.hypot(vx, vy) };
}
