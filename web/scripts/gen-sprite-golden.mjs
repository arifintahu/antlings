// Regenerates src/ants/golden.json from the ORIGINAL drawing code in design/mockup.html.
// Run only if the art is changed on purpose: node scripts/gen-sprite-golden.mjs
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const html = readFileSync(new URL('../../design/mockup.html', import.meta.url), 'utf8');
const start = html.indexOf('function drawWorker(');
const end = html.indexOf('/* ── Animation loop');
const draw = new Function(`${html.slice(start, end)}; return drawWorker;`)();

const LOOKS = [
  { body: '#DC2626', dk: '#991B1B', vest: '#38BDF8' },
  { body: '#B4783C', dk: '#7C4A1D', vest: '#F472B6' },
  { body: '#EA580C', dk: '#9A3412', vest: '#A78BFA' },
  { body: '#65A30D', dk: '#3F6212', vest: '#FB923C' },
  { body: '#3B82F6', dk: '#1D4ED8', vest: '#34D399' },
  { body: '#D97706', dk: '#92400E', vest: '#38BDF8' },
];
const STATES = ['idle', 'thinking', 'tool', 'approval', 'done', 'error'];

const out = {};
for (const [li, look] of LOOKS.entries()) {
  for (const state of STATES) {
    for (const lead of [false, true]) {
      const h = createHash('sha256');
      for (let f = 0; f < 25; f++) {
        const calls = [];
        const ctx = {
          fillStyle: '',
          fillRect(x, y, w, hh) {
            calls.push(`${this.fillStyle}|${x},${y},${w},${hh}`);
          },
          clearRect(x, y, w, hh) {
            calls.push(`clear|${x},${y},${w},${hh}`);
          },
        };
        draw(ctx, look, state, f, lead);
        h.update(calls.join(';') + '\n');
      }
      out[`${li}:${state}:${lead ? 'lead' : 'worker'}`] = h.digest('hex');
    }
  }
}
writeFileSync(new URL('../src/ants/golden.json', import.meta.url), JSON.stringify(out, null, 1) + '\n');
console.log(Object.keys(out).length, 'hashes written');
