export type CardId = 'magnet' | 'wind' | 'foot' | 'bigcup' | 'juice' | 'mulligan' | 'sprinkler' | 'laser' | 'backstop';

export interface Card {
  id: CardId;
  name: string;
  icon: string;
  blurb: string;
  flavor: string;
  /** suspicion added the moment you take it */
  heat: number;
}

export const CARDS: Card[] = [
  { id: 'magnet', name: 'Magnetic Cup', icon: '🧲', heat: 12, blurb: 'The hole pulls the ball in from 7 m and swallows putts at over twice the speed.', flavor: 'The ball has a steel core. Since this morning.' },
  { id: 'wind', name: 'Bribe the Wind', icon: '💨', heat: 8, blurb: 'Dead calm for this hole.', flavor: 'A man with a very large fan owes you a favour.' },
  { id: 'foot', name: 'Foot Wedge', icon: '🥾', heat: 5, blurb: 'Press F once to kick the ball about 12 m along your aim. No stroke counted. Risky if he is watching.', flavor: 'The oldest club in the bag.' },
  { id: 'bigcup', name: 'Big Cup', icon: '🕳️', heat: 15, blurb: 'The hole is three times wider.', flavor: 'The greenkeeper was up late with a post-hole digger.' },
  { id: 'juice', name: 'Double Juice', icon: '🧃', heat: 5, blurb: '+2.5 seconds of Spin Juice for this hole.', flavor: 'Not for human consumption.' },
  { id: 'mulligan', name: 'Mulligan', icon: '↩️', heat: 8, blurb: 'Press M after any shot to take it again. Once.', flavor: '"That was a practice swing." It was not.' },
  { id: 'sprinkler', name: 'Sprinklers', icon: '💦', heat: 6, blurb: 'A soaked green: the ball rolls about half as far on it.', flavor: 'Somebody leaned on the valve. Tragic.' },
  { id: 'laser', name: "Caddie's Laser", icon: '🔦', heat: 5, blurb: 'Shows the true flight of a clean full shot, wind included.', flavor: 'It is a rangefinder. A military one.' },
  { id: 'backstop', name: 'Backstop', icon: '🛺', heat: 10, blurb: 'A cart parks right behind the pin. Go ahead and fire at it.', flavor: 'It broke down there. What are the odds.' },
];

export function drawCards(n: number): Card[] {
  const pool = CARDS.slice();
  const out: Card[] = [];
  while (out.length < n && pool.length) out.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]!);
  return out;
}
