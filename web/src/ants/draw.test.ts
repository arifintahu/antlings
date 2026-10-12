import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { drawWorker, LOOKS, type AntState } from './draw.js';
import golden from './golden.json' with { type: 'json' };

const STATES: AntState[] = ['idle', 'thinking', 'tool', 'approval', 'done', 'error'];

function hashFrames(li: number, state: AntState, lead: boolean): string {
  const h = createHash('sha256');
  for (let f = 0; f < 25; f++) {
    const calls: string[] = [];
    const ctx = {
      fillStyle: '' as string,
      fillRect(x: number, y: number, w: number, hh: number) {
        calls.push(`${this.fillStyle}|${x},${y},${w},${hh}`);
      },
      clearRect(x: number, y: number, w: number, hh: number) {
        calls.push(`clear|${x},${y},${w},${hh}`);
      },
    };
    drawWorker(ctx, LOOKS[li]!, state, f, lead);
    h.update(calls.join(';') + '\n');
  }
  return h.digest('hex');
}

describe('ant sprites', () => {
  it('has a stored hash for every look, state and role', () => {
    expect(Object.keys(golden)).toHaveLength(LOOKS.length * STATES.length * 2);
  });

  for (let li = 0; li < LOOKS.length; li++) {
    for (const state of STATES) {
      for (const lead of [false, true]) {
        const key = `${li}:${state}:${lead ? 'lead' : 'worker'}`;
        it(`draws ${key} exactly as the mockup does (25 frames)`, () => {
          expect(hashFrames(li, state, lead)).toBe((golden as Record<string, string>)[key]);
        });
      }
    }
  }

  it('is pixel-identical on a real raster: every fillRect stays inside 32x28', () => {
    for (const state of STATES) {
      const bad: string[] = [];
      const ctx = {
        fillStyle: '' as string,
        fillRect(x: number, y: number, w: number, h: number) {
          if (x < 0 || y < 0 || x + w > 32 || y + h > 28) bad.push(`${x},${y},${w},${h}`);
        },
        clearRect() {},
      };
      for (let f = 0; f < 25; f++) drawWorker(ctx, LOOKS[0]!, state, f, true);
      expect(bad, state).toEqual([]);
    }
  });
});
