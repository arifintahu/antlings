import { drawWorker, FPS, LOOKS, SPRITE_H, SPRITE_W, type AntState } from './draw.js';

export interface Registration {
  canvas: HTMLCanvasElement;
  state: () => AntState;
  look: () => number;
  lead: boolean;
  animated: boolean;
}

interface Entry extends Registration {
  ctx: CanvasRenderingContext2D;
  key: string;
}

const entries = new Set<Entry>();
const reduce = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
let raf = 0;
let lastFrame = -1;

function tick(t: number): void {
  const f = Math.floor((t / 1000) * FPS);
  if (f === lastFrame) {
    raf = requestAnimationFrame(tick); // the display may run at 60 to 120 Hz, the art at 8 fps
    return;
  }
  lastFrame = f;
  for (const e of entries) {
    if (e.canvas.offsetParent === null) continue; // hidden
    const ff = !reduce?.matches && e.animated ? f : 0;
    const state = e.state();
    const key = `${ff}:${state}:${e.look()}`;
    if (e.key !== key) {
      e.key = key;
      drawWorker(e.ctx, LOOKS[e.look() % LOOKS.length]!, state, ff, e.lead);
    }
  }
  raf = requestAnimationFrame(tick);
}

function ensureLoop(): void {
  if (!raf && !document.hidden && entries.size > 0) raf = requestAnimationFrame(tick);
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      cancelAnimationFrame(raf);
      raf = 0;
    } else ensureLoop();
  });
}

/** One shared 8 fps loop draws every ant on the page. It pauses while the tab is hidden. */
export function registerAnt(r: Registration): () => void {
  r.canvas.width = SPRITE_W;
  r.canvas.height = SPRITE_H;
  const ctx = r.canvas.getContext('2d');
  if (!ctx) return () => undefined;
  const e: Entry = { ...r, ctx, key: '' };
  entries.add(e);
  ensureLoop();
  return () => {
    entries.delete(e);
    if (entries.size === 0) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
  };
}
