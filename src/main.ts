import './style.css';
import { Game } from './game';

const canvas = document.querySelector<HTMLCanvasElement>('#view');
const ui = document.querySelector<HTMLElement>('#ui');
if (!canvas || !ui) throw new Error('page is missing the canvas or the UI root');

const game = new Game(canvas, ui);
if (import.meta.env.DEV) (window as unknown as { golf: Game }).golf = game;
game.boot().catch((err: unknown) => {
  console.error(err);
  ui.innerHTML = `<div style="position:absolute;inset:0;display:grid;place-items:center;pointer-events:auto;font:16px system-ui;color:#fff;background:#0b1210;padding:2em;text-align:center">
    <div><h2>The course failed to load</h2><p>${err instanceof Error ? err.message : String(err)}</p></div></div>`;
});
