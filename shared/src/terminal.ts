import { z } from 'zod';

/** Server-chosen shell ids: 8 random bytes in hex. Anything else is refused before it reaches a lookup. */
export const TERMINAL_ID_RE = /^[0-9a-f]{16}$/;

const Cols = z.number().int().min(20).max(500);
const Rows = z.number().int().min(5).max(200);

export const TerminalCreateBody = z.object({ cols: Cols, rows: Rows });
export type TerminalCreateBody = z.infer<typeof TerminalCreateBody>;

/** Messages the browser sends on /ws/term. Every inbound frame is parsed with this schema. */
export const TerminalClientMessage = z.discriminatedUnion('t', [
  z.object({ t: z.literal('in'), d: z.string().max(65_536) }),
  z.object({ t: z.literal('resize'), cols: Cols, rows: Rows }),
]);
export type TerminalClientMessage = z.infer<typeof TerminalClientMessage>;

export type TerminalServerMessage =
  { t: 'replay'; d: string } | { t: 'out'; d: string } | { t: 'exit'; code: number | null } | { t: 'ping' };

export interface TerminalInfo {
  id: string;
  name: string;
  running: boolean;
  exitCode: number | null;
  createdAt: number;
}
