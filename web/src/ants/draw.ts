/**
 * Ant sprite renderer: a 32x28 logical canvas, ported from design/mockup.html.
 * Do not change the drawing calls. web/src/ants/draw.test.ts compares a hash of every
 * state and look against values taken from the mockup, so edits cannot alter the art by accident.
 */

export type AntState = 'idle' | 'thinking' | 'tool' | 'approval' | 'done' | 'error';
export interface Look {
  body: string;
  dk: string;
  vest: string;
}

/** The part of CanvasRenderingContext2D the renderer uses. Tests pass a recorder. */
export interface Ctx {
  fillStyle: string | CanvasGradient | CanvasPattern;
  fillRect(x: number, y: number, w: number, h: number): void;
  clearRect(x: number, y: number, w: number, h: number): void;
}

export const SPRITE_W = 32;
export const SPRITE_H = 28;
export const FPS = 8;

export const LOOKS: Look[] = [
  { body: '#DC2626', dk: '#991B1B', vest: '#38BDF8' },
  { body: '#B4783C', dk: '#7C4A1D', vest: '#F472B6' },
  { body: '#EA580C', dk: '#9A3412', vest: '#A78BFA' },
  { body: '#65A30D', dk: '#3F6212', vest: '#FB923C' },
  { body: '#3B82F6', dk: '#1D4ED8', vest: '#34D399' },
  { body: '#D97706', dk: '#92400E', vest: '#38BDF8' },
];

export const STATE_LABEL: Record<AntState, string> = {
  idle: 'Idle',
  thinking: 'Thinking',
  tool: 'Running tool',
  approval: 'Needs approval',
  done: 'Done',
  error: 'Error',
};

export function drawWorker(ctx: Ctx, look: Look, state: AntState, f: number, lead: boolean): void {
  const R = (c: string, x: number, y: number, w: number, h: number) => {
    ctx.fillStyle = c;
    ctx.fillRect(x, y, w, h);
  };
  const dark = '#0F172A',
    W = '#F8FAFC';
  const { body, dk, vest } = look;
  ctx.clearRect(0, 0, 32, 28);
  R('rgba(0,0,0,.28)', 3, 26, 26, 2); // floor shadow
  R('#334155', 9, 11, 14, 11);
  R('#1E293B', 9, 11, 14, 1); // chair back

  let hx = 0,
    by = 0;
  if (state === 'idle') by = (f >> 2) & 1;
  else if (state === 'error') hx = f & 1 ? 1 : -1;
  else if (state === 'done') by = (f & 3) < 2 ? -1 : 0;

  R(body, 11, 14, 10, 8);
  R(vest, 12, 15, 8, 7);
  R('rgba(255,255,255,.35)', 15, 15, 2, 1); // torso + vest

  // thin arms, small hands
  let lh = [9, 20],
    rh = [21, 20],
    la = [10, 15, 1, 5],
    ra = [21, 15, 1, 5];
  if (state === 'tool') {
    lh[1] = 19 + (f & 1);
    rh[1] = 19 + ((f + 1) & 1);
    la[3] = lh[1] - 15;
    ra[3] = rh[1] - 15;
  } else if (state === 'approval') {
    ra = [21, 11, 1, 5];
    rh = [21 + ((f >> 1) & 1), 9];
  } else if (state === 'done') {
    la = [10, 11, 1, 5];
    ra = [21, 11, 1, 5];
    lh = [9 - (f & 1), 9];
    rh = [21 + (f & 1), 9];
  }
  R(body, la[0]!, la[1]!, la[2]!, la[3]!);
  R(body, ra[0]!, ra[1]!, ra[2]!, ra[3]!);
  R(dk, lh[0]!, lh[1]!, 2, 2);
  R(dk, rh[0]!, rh[1]!, 2, 2);

  // round head
  const hy = 6 + by;
  R(body, 13 + hx, hy, 6, 1);
  R(body, 12 + hx, hy + 1, 8, 6);
  R(body, 13 + hx, hy + 7, 6, 1);

  // antennae (wiggle, or droop on error) + crown for the lead
  const aw = state === 'idle' || state === 'thinking' || state === 'tool' ? (f >> 2) & 1 : 0;
  if (state === 'error') {
    R(body, 13 + hx, 5 + by, 1, 1);
    R(body, 12 + hx, 5 + by, 1, 1);
    R(dk, 11 + hx, 6 + by, 1, 1);
    R(body, 18 + hx, 5 + by, 1, 1);
    R(body, 19 + hx, 5 + by, 1, 1);
    R(dk, 20 + hx, 6 + by, 1, 1);
  } else {
    R(body, 13 + hx, 5 + by, 1, 1);
    R(body, 12 + hx, 4 + by, 1, 1);
    R(body, 11 + hx, 3 + by, 1, 1);
    R(dk, 10 + hx, 2 + by + aw, 1, 1);
    R(body, 18 + hx, 5 + by, 1, 1);
    R(body, 19 + hx, 4 + by, 1, 1);
    R(body, 20 + hx, 3 + by, 1, 1);
    R(dk, 21 + hx, 2 + by + aw, 1, 1);
  }
  if (lead) {
    const g = '#FACC15';
    R(g, 14 + hx, 4 + by, 4, 1);
    R(g, 14 + hx, 3 + by, 1, 1);
    R(g, 17 + hx, 3 + by, 1, 1);
    R(g, 15 + hx, 2 + by, 2, 2);
  }

  // eyes, cheeks, mouth
  const ex = state === 'thinking' ? 1 : 0,
    ey = hy + 3;
  const blink = f % 24 === 0 && (state === 'idle' || state === 'thinking');
  if (state === 'done' || blink) {
    R(dark, 13 + hx + ex, ey + 1, 2, 1);
    R(dark, 17 + hx + ex, ey + 1, 2, 1);
  } else {
    R(dark, 13 + hx + ex, ey, 2, 3);
    R(dark, 17 + hx + ex, ey, 2, 3);
    if (state !== 'error') {
      R(W, 13 + hx + ex, ey, 1, 1);
      R(W, 17 + hx + ex, ey, 1, 1);
    }
  }
  if (state === 'idle' || state === 'done') {
    R('rgba(251,113,133,.75)', 12 + hx, hy + 5, 1, 1);
    R('rgba(251,113,133,.75)', 19 + hx, hy + 5, 1, 1);
  }
  if (state === 'done') {
    R(dark, 14 + hx, hy + 5, 1, 1);
    R(dark, 17 + hx, hy + 5, 1, 1);
    R(dark, 15 + hx, hy + 6, 2, 1);
  } else if (state === 'error') {
    R(dark, 15 + hx, hy + 6, 2, 1);
    R(dark, 14 + hx, hy + 7, 1, 1);
    R(dark, 17 + hx, hy + 7, 1, 1);
  } else if (state === 'approval') R(dark, 15 + hx, hy + 6, 2, 2);
  else if (state === 'tool') R(dark, 16 + hx, hy + 6, 1, 1);
  else R(dark, 15 + hx, hy + 6, 2, 1);
  if (state === 'thinking') {
    R(body, 9, 13, 3, 2);
    R(dk, 11, 12, 3, 2);
  } // hand on chin
  if (state === 'error') R('#7DD3FC', 21, 6 + ((f >> 1) & 1), 1, 2); // sweat drop

  // laptop (from behind), desk, mug
  R('#94A3B8', 11, 17, 10, 4);
  R('#CBD5E1', 11, 17, 10, 1);
  R('#475569', 15, 18, 2, 1);
  R('#C08457', 2, 21, 28, 2);
  R('#E0A872', 2, 21, 28, 1);
  R('#8B5A2B', 3, 23, 26, 3);
  R('#5C3A1A', 3, 25, 26, 1);
  R('#F8FAFC', 3, 18, 3, 3);
  R('#6F4E37', 3, 18, 3, 1);
  R('#F8FAFC', 6, 19, 1, 1);
  if (state === 'idle') R('rgba(255,255,255,.7)', 4, 16 - ((f >> 1) % 3), 1, 1);

  // side monitor
  R('#475569', 27, 19, 2, 2);
  R('#1E293B', 24, 11, 8, 8);
  const screen =
    ({ tool: '#052E16', done: '#052E16', approval: '#451A03', error: '#450A0A' } as Record<string, string>)[
      state
    ] || '#0B1220';
  R(screen, 25, 12, 6, 6);
  if (state === 'tool') {
    for (let i = 0; i < 3; i++) R('#4ADE80', 26, 13 + i * 2, 2 + ((f + i * 2) % 4), 1);
  } else if (state === 'thinking') {
    R('#93C5FD', 26, 13, 3, 1);
    R('#93C5FD', 26, 15, 2, 1);
    if ((f >> 1) & 1) R('#93C5FD', 29, 15, 1, 1);
  } else if (state === 'approval') {
    R('#F59E0B', 26, 14, 4, 1);
    if ((f >> 1) & 1) R('#F59E0B', 24, 11, 8, 1);
  } else if (state === 'error') {
    for (const [x, y] of [
      [26, 13],
      [27, 14],
      [28, 15],
      [29, 16],
      [29, 13],
      [28, 14],
      [27, 15],
      [26, 16],
    ] as const)
      R('#FCA5A5', x, y, 1, 1);
  } else if (state === 'done') {
    for (const [x, y] of [
      [26, 15],
      [27, 16],
      [28, 15],
      [29, 14],
      [30, 13],
    ] as const)
      R('#4ADE80', x, y, 1, 1);
  } else {
    R('#334155', 26, 13, 4, 1);
    R('#475569', 26 + ((f >> 2) % 4), 15, 1, 1);
  }

  // speech bubble
  const G: Record<string, string[]> = {
    approval: ['..#..', '..#..', '..#..', '.....', '..#..'],
    error: ['.###.', '#...#', '..##.', '.....', '..#..'],
    done: ['....#', '...#.', '#.#..', '.#...', '.....'],
    gearA: ['..#..', '.###.', '##.##', '.###.', '..#..'],
    gearB: ['#...#', '.###.', '..#..', '.###.', '#...#'],
  };
  if (state !== 'idle') {
    R(dark, 22, 0, 10, 9);
    R('#F8FAFC', 23, 1, 8, 7);
    const col = (
      {
        approval: '#D97706',
        error: '#DC2626',
        done: '#16A34A',
        tool: '#0284C7',
        thinking: '#334155',
      } as Record<string, string>
    )[state]!;
    if (state === 'thinking') {
      for (let i = 0; i < (f >> 1) % 4; i++) R(col, 25 + i * 2, 4, 1, 1);
    } else {
      const g = state === 'tool' ? (f & 2 ? G.gearB! : G.gearA!) : G[state]!;
      g.forEach((row, y) =>
        [...row].forEach((c, x) => {
          if (c === '#') R(col, 25 + x, 2 + y, 1, 1);
        }),
      );
    }
  }
  if (state === 'done')
    [
      [4, 8],
      [6, 2],
      [19, 1],
    ].forEach(([x, y], k) => {
      if (((f + k * 2) >> 1) & 1) R('#FDE047', x!, y!, 1, 1);
    });
}
