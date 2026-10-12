import type { ClientMessage, ServerMessage } from '@antlings/shared';
import { ApiError, post } from './api.js';

export type SocketStatus = 'connecting' | 'open' | 'down';

export interface SocketHandlers {
  onMessage(m: ServerMessage): void;
  onStatus(s: SocketStatus): void;
  /** Sessions to subscribe to after every (re)connect, with the last seq already applied. */
  subscriptions(): { sessionId: string; lastSeq: number }[];
  onSignedOut(): void;
}

/**
 * WebSocket with automatic reconnect. Each connect uses a single-use ticket, then sends `hello`
 * with the last seq per session, so the server replays only what was missed.
 */
export class Socket {
  private ws: WebSocket | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private attempt = 0;
  private stopped = true;
  status: SocketStatus = 'down';

  constructor(private h: SocketHandlers) {
    window.addEventListener('online', () => this.reconnectNow());
    document.addEventListener('visibilitychange', () => {
      // After a phone sleeps the socket may be dead without telling us. Reconnecting is cheap: replay is by seq.
      if (!document.hidden && !this.stopped) this.reconnectNow();
    });
  }

  private set(s: SocketStatus): void {
    this.status = s;
    this.h.onStatus(s);
  }

  start(): void {
    this.stopped = false;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.ws?.close();
    this.ws = null;
    this.set('down');
  }

  send(m: ClientMessage): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(m));
    return true;
  }

  /** Subscribes to one more session on the open socket. */
  hello(sessionId: string, lastSeq: number): void {
    this.send({ t: 'hello', sessionId, lastSeq });
  }

  reconnectNow(): void {
    if (this.stopped) return;
    clearTimeout(this.timer);
    this.ws?.close();
    this.ws = null;
    void this.connect();
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    this.set('connecting');
    let ticket: string;
    try {
      ticket = (await post<{ ticket: string }>('/api/ws-ticket')).ticket;
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return this.h.onSignedOut();
      return this.retry();
    }
    if (this.stopped) return;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/ws?ticket=${encodeURIComponent(ticket)}`);
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.attempt = 0;
      this.set('open');
      for (const s of this.h.subscriptions()) this.hello(s.sessionId, s.lastSeq);
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      try {
        this.h.onMessage(JSON.parse(String(ev.data)) as ServerMessage);
      } catch {
        /* ignore a malformed frame */
      }
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (ev.code === 4401) return this.h.onSignedOut();
      this.retry();
    };
    ws.onerror = () => ws.close();
  }

  private retry(): void {
    if (this.stopped) return;
    this.set('down');
    const wait = Math.min(15_000, 1000 * 2 ** this.attempt++);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.connect(), wait);
  }
}
