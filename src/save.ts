import type { Quality } from './world';

export type UpgradeId = 'juice' | 'tape' | 'gym' | 'xmas' | 'sleeve' | 'ball' | 'shades';

export interface UpgradeDef {
  id: UpgradeId;
  name: string;
  blurb: string;
  /** what one level does, for the shop row */
  per: string;
  max: number;
  cost: number;
  growth: number;
}

export const UPGRADES: UpgradeDef[] = [
  { id: 'juice', name: 'Spin Juice Tank', blurb: 'A bigger reservoir of whatever is in that flask. More after-touch per hole.', per: '+0.5 s of steering', max: 5, cost: 260, growth: 1.6 },
  { id: 'tape', name: 'Lead Tape', blurb: 'Stuck all over the club head. Technically legal. Widens the clean-strike window.', per: '+8% strike window', max: 5, cost: 220, growth: 1.6 },
  { id: 'gym', name: 'Gym Membership', blurb: 'You went twice. It helped anyway.', per: '+2% ball speed', max: 5, cost: 240, growth: 1.65 },
  { id: 'xmas', name: "Marshal's Christmas Card", blurb: 'A card. With cash in it. He remembers who his friends are.', per: '-10% suspicion gained', max: 5, cost: 300, growth: 1.7 },
  { id: 'shades', name: 'Gift: Tinted Sunglasses', blurb: 'A thoughtful present for the marshal. Very dark lenses.', per: 'looks away 12% longer', max: 4, cost: 280, growth: 1.7 },
  { id: 'ball', name: 'Tour Ball (Fell Off a Truck)', blurb: 'Bores through the wind. Do not ask about the truck.', per: '-10% wind effect', max: 4, cost: 200, growth: 1.6 },
  { id: 'sleeve', name: 'Deeper Sleeves', blurb: 'Room for more cards up there. See one more cheat card each hole.', per: '+1 card to choose from', max: 2, cost: 650, growth: 2.4 },
];

export interface Save {
  money: number;
  week: number;
  rounds: number;
  /** best round relative to par, or null before the first finished round */
  best: number | null;
  dqs: number;
  upgrades: Record<UpgradeId, number>;
  volume: number;
  quality: Quality;
}

const KEY = 'bullshit-golf-save-v1';

export function freshSave(): Save {
  return {
    money: 0, week: 1, rounds: 0, best: null, dqs: 0,
    upgrades: { juice: 0, tape: 0, gym: 0, xmas: 0, sleeve: 0, ball: 0, shades: 0 },
    volume: 0.7, quality: 'high',
  };
}

export function loadSave(): Save {
  const base = freshSave();
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return base;
    const got = JSON.parse(raw) as Partial<Save>;
    return { ...base, ...got, upgrades: { ...base.upgrades, ...(got.upgrades ?? {}) } };
  } catch {
    return base;
  }
}

export function storeSave(s: Save): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // private windows may refuse storage; the game still runs
  }
}

export const upgradeCost = (u: UpgradeDef, level: number): number => Math.round((u.cost * Math.pow(u.growth, level)) / 10) * 10;
