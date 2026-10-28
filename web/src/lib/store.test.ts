import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SocketStatus } from './socket.js';

const h = vi.hoisted(() => ({
  onStatus: undefined as undefined | ((s: SocketStatus) => void),
  onMessage: undefined as undefined | ((m: unknown) => void),
  get: undefined as undefined | ReturnType<typeof import('vitest').vi.fn>,
}));

vi.mock('./socket.js', () => ({
  Socket: class {
    status = 'down';
    constructor(handlers: { onStatus: (s: SocketStatus) => void; onMessage: (m: unknown) => void }) {
      h.onStatus = handlers.onStatus;
      h.onMessage = handlers.onMessage;
    }
    send() {
      return true;
    }
    start() {}
    stop() {}
  },
}));

vi.mock('./api.js', async (orig) => {
  const real = await orig<typeof import('./api.js')>();
  h.get = vi.fn();
  return { ...real, get: h.get };
});

const { app } = await import('./store.svelte.js');

const summary = (id: string) => ({ id }) as never;

beforeEach(() => {
  h.get!.mockReset();
  app.sessions = [];
});

describe('reconnect', () => {
  it('reloads the session list when the socket opens after a failed first load', async () => {
    h.get!.mockRejectedValueOnce(new Error('stalled')).mockRejectedValueOnce(new Error('stalled'));
    await app.refreshSessions();
    expect(app.sessions).toEqual([]);

    h.get!.mockImplementation(async (url: string) =>
      url.includes('archived') ? { sessions: [summary('b')] } : { sessions: [summary('a')] },
    );
    h.onStatus!('open');
    await vi.waitFor(() => expect(app.sessions.map((s) => s.id)).toEqual(['a', 'b']));
  });

  it('does not refetch while the socket is still down', () => {
    h.onStatus!('down');
    h.onStatus!('connecting');
    expect(h.get).not.toHaveBeenCalled();
  });
});

describe('attachments that expired', () => {
  it('puts the unsent text back so a long prompt is not lost', () => {
    app.activeId = 's';
    expect(app.send('a long prompt', ['u1'])).toBe(true);
    h.onMessage!({
      t: 'error',
      code: 'attachment_expired',
      message: 'An attached file is no longer on the server.',
    });
    expect(app.restoreText).toBe('a long prompt');
    expect(app.banner).toBe('An attached file is no longer on the server.');
  });
});
