import { flatCarry } from './aero';

export type ClubKind = 'wood' | 'iron' | 'wedge' | 'putter';

export interface Club {
  id: string;
  name: string;
  kind: ClubKind;
  /** ball speed at 100% power, m/s */
  speed: number;
  /** launch angle, degrees */
  launch: number;
  /** backspin, rpm */
  spin: number;
  /** half-width of the clean-strike window, milliseconds */
  window: number;
  /** flat-ground carry at 100%, metres (filled in below) */
  carry: number;
}

const def = (id: string, name: string, kind: ClubKind, speed: number, launch: number, spin: number, window: number): Club =>
  ({ id, name, kind, speed, launch, spin, window, carry: 0 });

export const CLUBS: Club[] = [
  def('D', 'Driver', 'wood', 67, 11.5, 2700, 62),
  def('3W', '3 Wood', 'wood', 62, 12.0, 3600, 68),
  def('5I', '5 Iron', 'iron', 54, 14.0, 5200, 76),
  def('6I', '6 Iron', 'iron', 51, 15.5, 5800, 80),
  def('7I', '7 Iron', 'iron', 48, 17.0, 6500, 84),
  def('8I', '8 Iron', 'iron', 45, 19.0, 7300, 88),
  def('9I', '9 Iron', 'iron', 42, 21.5, 8000, 92),
  def('PW', 'Pitching Wedge', 'wedge', 38.5, 25.0, 8800, 98),
  def('SW', 'Sand Wedge', 'wedge', 33, 30.0, 9500, 104),
  def('LW', 'Lob Wedge', 'wedge', 27, 36.0, 10000, 108),
  def('P', 'Putter', 'putter', 7.5, 0, 0, 120),
];

for (const c of CLUBS) c.carry = c.kind === 'putter' ? 0 : flatCarry(c.speed, c.launch, c.spin).carry;

export const PUTTER = CLUBS[CLUBS.length - 1]!;
export const M_TO_YD = 1.09361;
export const yards = (m: number): number => Math.round(m * M_TO_YD);
