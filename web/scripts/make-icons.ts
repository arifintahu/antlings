// Draws the PWA icons from the ant sprite. Run: pnpm --filter @antlings/web icons
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { drawWorker, LOOKS, SPRITE_H, SPRITE_W } from '../src/ants/draw.js';

type RGBA = [number, number, number, number];

function parse(c: string): RGBA {
  if (c.startsWith('#')) {
    const n = parseInt(c.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
  }
  const m = /rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/.exec(c);
  if (!m) throw new Error(`unsupported colour ${c}`);
  return [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
}

/** The sprite as a 32x28 RGBA buffer. */
function sprite(): Uint8ClampedArray {
  const buf = new Uint8ClampedArray(SPRITE_W * SPRITE_H * 4);
  const ctx = {
    fillStyle: '' as string,
    clearRect() {
      buf.fill(0);
    },
    fillRect(x: number, y: number, w: number, h: number) {
      const [r, g, b, a] = parse(this.fillStyle);
      for (let yy = y; yy < y + h; yy++)
        for (let xx = x; xx < x + w; xx++) {
          if (xx < 0 || yy < 0 || xx >= SPRITE_W || yy >= SPRITE_H) continue;
          const i = (yy * SPRITE_W + xx) * 4;
          const da = buf[i + 3]! / 255;
          const oa = a + da * (1 - a);
          for (const [k, v] of [r, g, b].entries())
            buf[i + k] = (v * a + buf[i + k]! * da * (1 - a)) / (oa || 1);
          buf[i + 3] = oa * 255;
        }
    },
  };
  drawWorker(ctx, LOOKS[0]!, 'idle', 0, true);
  return buf;
}

function png(w: number, h: number, rgba: Uint8Array): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 255]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function icon(size: number, scale: number): Buffer {
  const out = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) out.set([0x0f, 0x17, 0x2a, 255], i * 4); // #0F172A
  const s = sprite();
  const ox = Math.floor((size - SPRITE_W * scale) / 2);
  const oy = Math.floor((size - SPRITE_H * scale) / 2);
  for (let y = 0; y < SPRITE_H * scale; y++)
    for (let x = 0; x < SPRITE_W * scale; x++) {
      const si = (Math.floor(y / scale) * SPRITE_W + Math.floor(x / scale)) * 4;
      const a = s[si + 3]! / 255;
      if (a === 0) continue;
      const oi = ((oy + y) * size + ox + x) * 4;
      for (let k = 0; k < 3; k++) out[oi + k] = s[si + k]! * a + out[oi + k]! * (1 - a);
    }
  return png(size, size, out);
}

mkdirSync(new URL('../public/icons/', import.meta.url), { recursive: true });
const dir = (n: string) => new URL(`../public/icons/${n}`, import.meta.url);
writeFileSync(dir('icon-192.png'), icon(192, 6));
writeFileSync(dir('icon-512.png'), icon(512, 16));
writeFileSync(dir('icon-maskable-512.png'), icon(512, 12)); // keeps the art inside the 80% safe zone
writeFileSync(dir('apple-touch-icon.png'), icon(180, 5));
console.log('icons written');
