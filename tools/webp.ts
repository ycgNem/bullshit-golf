// Convert the generated terrain PNGs (out/tex) into WebP for the game (public/assets/tex).
import sharp from 'sharp';
import { mkdirSync } from 'node:fs';

const SRC = 'out/tex';
const DST = 'public/assets/tex';
mkdirSync(DST, { recursive: true });
const jobs: [string, string, number][] = [];
for (const name of ['Rough', 'Fairway', 'Green', 'Sand', 'Concrete']) {
  jobs.push([`T_${name}_BaseColor.png`, `${name}_c.webp`, 84]);
  jobs.push([`T_${name}_Normal.png`, `${name}_n.webp`, 90]);
}
jobs.push(['T_Water_Normal.png', 'Water_n.webp', 90]);
for (const [src, dst, q] of jobs) {
  const info = await sharp(`${SRC}/${src}`).webp({ quality: q, effort: 5 }).toFile(`${DST}/${dst}`);
  console.log(dst, Math.round(info.size / 1024), 'KB');
}
