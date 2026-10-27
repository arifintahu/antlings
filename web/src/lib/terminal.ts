import type { TerminalInfo, TerminalServerMessage } from '@antlings/shared';
import { ApiError, post } from './api.js';

export type TermLink = 'connecting' | 'open' | 'down' | 'ended';
export type TermKey = 'esc' | 'tab' | 'up' | 'down' | 'left' | 'right' | 'ctrl-c';

const KEYS: Record<TermKey, string> = {
  esc: '\x1b',
  tab: '\t',
  up: '\x1b[A',
  down: '\x1b[B',
  left: '\x1b[D',
  right: '\x1b[C',
  'ctrl-c': '\x03',
};
export const keyBytes = (k: TermKey): string => KEYS[k];

/** What the phone's sticky Ctrl key does to the next typed character. Anything it cannot map passes through. */
export function ctrlOf(d: string): string {
  if (d.length !== 1) return d;
  const code = d.toUpperCase().charCodeAt(0);
  // A..Z give 1..26; [ \ ] ^ _ give 27..31
  return code >= 65 && code <= 95 ? String.fromCharCode(code - 64) : d;
}

export function terminalLabel(t: TerminalInfo, link: TermLink): string {
  if (!t.running && t.exitCode !== null) return `Exited (code ${t.exitCode})`;
  if (link === 'ended' || !t.running) return 'Ended';
  if (link === 'open') return 'Running';
  if (link === 'down') return 'Reconnecting…';
  return 'Connecting…';
}

/** A paste can be far over the server's frame limit. Splits it, never between the halves of a surrogate pair. */
export function chunkInput(d: string, size: number): string[] {
  const parts: string[] = [];
  for (let i = 0; i < d.length;) {
    let end = Math.min(d.length, i + size);
    const last = d.charCodeAt(end - 1);
    if (end < d.length && last >= 0xd800 && last <= 0xdbff) end--;
    parts.push(d.slice(i, end));
    i = end;
  }
  return parts;
}

export const nextDelay = (attempt: number): number => Math.min(15_000, 1000 * 2 ** attempt);

export interface TerminalHandlers {
  sessionId: string;
  terminalId: string;
  onMessage(m: TerminalServerMessage): void;
  onStatus(s: TermLink): void;
  onSignedOut(): void;
  /** After a failed connect: does the server still have this shell? A restart answers no. */
  exists(): Promise<boolean>;
}

/**
 * One shell's WebSocket with automatic reconnect, in the style of `Socket`: a single-use ticket per connect,
 * and a fresh `replay` on every connect, so the consumer resets its terminal before writing it.
 */
export class TerminalConnection {
  private ws: WebSocket | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private watchdog: ReturnType<typeof setInterval> | undefined;
  private attempt = 0;
  private stopped = true;
  private ended = false;
  private gen = 0;
  private lastHeard = 0;
  private openedAt = 0;
  private readonly onOnline = () => this.reconnectNow();
  private readonly onVisible = () => {
    if (!document.hidden) this.reconnectNow();
  };

  constructor(private h: TerminalHandlers) {}

  start(): void {
    this.stopped = false;
    this.ended = false;
    window.addEventListener('online', this.onOnline);
    document.addEventListener('visibilitychange', this.onVisible);
    clearInterval(this.watchdog);
    // The server pings every 15 s. Silence for 50 s means the connection is dead (a phone that slept).
    this.watchdog = setInterval(() => {
      if (this.ws && Date.now() - this.lastHeard > 50_000) this.reconnectNow();
    }, 10_000);
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.gen++;
    window.removeEventListener('online', this.onOnline);
    document.removeEventListener('visibilitychange', this.onVisible);
    clearInterval(this.watchdog);
    clearTimeout(this.timer);
    this.ws?.close();
    this.ws = null;
  }

  sendInput(d: string): boolean {
    return chunkInput(d, 8192).every((part) => this.send({ t: 'in', d: part }));
  }
  sendResize(cols: number, rows: number): boolean {
    return this.send({ t: 'resize', cols, rows });
  }

  private send(m: unknown): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(m));
    return true;
  }

  private reconnectNow(): void {
    if (this.stopped || this.ended) return;
    this.gen++;
    clearTimeout(this.timer);
    this.ws?.close();
    this.ws = null;
    void this.connect();
  }

  private end(): void {
    this.ended = true;
    this.ws = null;
    clearTimeout(this.timer);
    this.h.onStatus('ended');
  }

  private async connect(): Promise<void> {
    if (this.stopped || this.ended) return;
    const gen = ++this.gen;
    this.h.onStatus('connecting');
    let ticket: string;
    try {
      ticket = (await post<{ ticket: string }>('/api/ws-ticket')).ticket;
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return this.h.onSignedOut();
      return void this.retry();
    }
    if (this.stopped || gen !== this.gen) return;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const q = new URLSearchParams({ ticket, session: this.h.sessionId, terminal: this.h.terminalId });
    const ws = new WebSocket(`${proto}//${location.host}/ws/term?${q}`);
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.openedAt = this.lastHeard = Date.now();
      this.h.onStatus('open');
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      this.lastHeard = Date.now();
      try {
        const m = JSON.parse(String(ev.data)) as TerminalServerMessage;
        if (m.t === 'ping') return;
        this.h.onMessage(m);
        if (m.t === 'exit') this.end();
      } catch {
        /* ignore a malformed frame */
      }
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.ended) return;
      if (ev.code === 4401) return this.h.onSignedOut();
      if (ev.code === 4410) return this.end();
      if (Date.now() - this.openedAt > 10_000) this.attempt = 0;
      void this.retry();
    };
    ws.onerror = () => ws.close();
  }

  private async retry(): Promise<void> {
    if (this.stopped || this.ended) return;
    this.h.onStatus('down');
    const gen = this.gen;
    let exists = true;
    try {
      exists = await this.h.exists();
    } catch {
      /* offline: keep trying */
    }
    if (this.stopped || gen !== this.gen) return;
    if (!exists) return this.end();
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.connect(), nextDelay(this.attempt++));
  }
}
