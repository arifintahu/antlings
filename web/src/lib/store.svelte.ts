import type {
  ClientMessage,
  PermissionMode,
  PlanUsage,
  ServerMessage,
  SessionSummary,
  TerminalInfo,
} from '@antlings/shared';
import type { AntState } from '../ants/draw.js';
import { ApiError, del, get, isStepUp, patch, post, setCsrf, setUnauthorizedHandler } from './api.js';
import type { ConnectionsSummary } from './connections.js';
import { applyDelta, applyEvent, newView, type SessionView } from './model.js';
import { saveLast } from './options.js';
import { Socket, type SocketStatus } from './socket.js';

export interface ModelDto {
  value: string;
  displayName: string;
  description: string;
  supportsEffort: boolean;
  effortLevels: string[];
}

export interface FolderListing {
  path: string;
  parent: string | null;
  entries: { name: string }[];
}

const NAMES = ['Mia', 'Dev', 'Sam', 'Ana', 'Raj', 'Lee', 'Zed', 'Kai', 'Zoe', 'Ivy', 'Eli', 'Noa'];
const hash = (s: string): number => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
export const nameOf = (id: string): string => NAMES[hash(id) % NAMES.length]!;
export const lookOf = (id: string): number => hash(id) % 6;

/** A session with no message yet is called "New session". The folder name says more. */
export function titleOf(s: SessionSummary): string {
  if (s.title && s.title !== 'New session') return s.title;
  const base = s.cwd.split('/').filter(Boolean).pop();
  return base ? `New session in ${base}` : 'New session in ~';
}

export interface StatusDto {
  version: string;
  uptimeSec: number;
  serviceMemoryMb: number;
  hostMemory: { freeMb: number; totalMb: number };
  sessions: { running: number; max: number };
  database: { sizeMb: number; events: number };
  lastSignin: { at: number; ip: string | null } | null;
  pushDevices: number;
  eventKeep: number;
}

export type Screen = 'boot' | 'login' | 'firstrun' | 'app';

class AppStore {
  screen = $state<Screen>('boot');
  securityOpen = $state(false);
  connectionsOpen = $state(false);
  aboutOpen = $state(false);
  /** The server's version, from its package.json. Empty until the first answer. */
  version = $state('');
  /** Which of Claude and GitHub are connected. Null until the first answer. */
  connSummary = $state<ConnectionsSummary | null>(null);
  sessions = $state<SessionSummary[]>([]);
  listView = $state<'active' | 'archived'>('active');
  views = $state<Record<string, SessionView>>({});
  activeId = $state<string | null>(null);
  focus = $state<string>('lead');
  plan = $state<PlanUsage>({ status: 'unavailable' });
  models = $state<ModelDto[]>([]);
  wsStatus = $state<SocketStatus>('down');
  banner = $state('');
  live = $state('');
  stepUpAsk = $state<{ id: number; reason: string; resolve: (ok: boolean) => void } | null>(null);
  private askId = 0;
  freshUntil = 0;
  now = $state(Date.now());
  loadError = $state('');
  /** Shells per session, as the server last listed them. */
  terminals = $state<Record<string, TerminalInfo[]>>({});
  termOpen = $state<Record<string, boolean>>({});

  private removed = new Set<string>();
  /** lastSeq at the moment a session was (re)subscribed. Used to say how many events a reconnect caught up. */
  private resyncFrom: Record<string, number> = {};
  search = $state('');

  private socket = new Socket({
    onMessage: (m) => this.onMessage(m),
    onStatus: (s) => {
      this.wsStatus = s;
      // A load that failed while the server stalled would otherwise stay empty until the next turn ends.
      if (s === 'open') void this.refreshSessions();
    },
    subscriptions: () => Object.values(this.views).map((v) => ({ sessionId: v.id, lastSeq: v.lastSeq })),
    onSignedOut: () => this.signedOut(),
  });

  constructor() {
    setUnauthorizedHandler(() => this.signedOut());
    setInterval(() => {
      this.now = Date.now();
    }, 1000);
    // Keeps the "running" dot right while the panel is hidden, and notices shells that ended on their own.
    setInterval(() => {
      if (this.activeId && this.screen === 'app') void this.refreshTerminals(this.activeId);
    }, 15_000);
  }

  // ---- boot and sign-in ----

  async boot(): Promise<void> {
    try {
      const st = await get<{ firstRun: boolean }>('/api/auth/status');
      if (st.firstRun) {
        this.screen = 'firstrun';
        return;
      }
      try {
        const me = await get<{ csrf: string; freshUntil: number }>('/api/me');
        setCsrf(me.csrf);
        this.freshUntil = me.freshUntil;
        await this.enterApp();
      } catch (e) {
        if (e instanceof ApiError && e.status !== 401) this.loadError = e.message;
        this.screen = 'login';
      }
    } catch (e) {
      this.loadError = e instanceof ApiError ? e.message : 'The server did not answer';
      this.screen = 'login';
    }
  }

  async signedIn(csrf: string): Promise<void> {
    setCsrf(csrf);
    this.freshUntil = 0;
    await this.enterApp();
  }

  private async enterApp(): Promise<void> {
    this.screen = 'app';
    this.socket.start();
    void this.refreshConnections();
    void this.loadVersion();
    await Promise.all([this.refreshSessions(), this.loadModels(), this.loadUsage()]);
    window.addEventListener('hashchange', this.onHash);
    const wanted = location.hash.match(/^#s=([0-9a-f-]{36})$/i)?.[1];
    if (wanted) await this.openSession(wanted);
    else for (const s of this.sessions) if (s.running) void this.watch(s.id);
  }

  /** A notification click or a pasted link changes the hash while the app is open. */
  private onHash = (): void => {
    const id = location.hash.match(/^#s=([0-9a-f-]{36})$/i)?.[1];
    if (id && id !== this.activeId) void this.openSession(id);
  };

  signedOut(): void {
    window.removeEventListener('hashchange', this.onHash);
    this.socket.stop();
    setCsrf('');
    this.views = {};
    this.sessions = [];
    this.activeId = null;
    this.securityOpen = false;
    this.connectionsOpen = false;
    this.aboutOpen = false;
    this.connSummary = null;
    this.screen = 'login';
  }

  async signOut(): Promise<void> {
    try {
      await post('/api/auth/logout');
    } catch {
      /* the server may already have dropped the session */
    }
    this.signedOut();
  }

  reconnect(): void {
    this.socket.reconnectNow();
  }

  // ---- data ----

  private refreshN = 0;

  async refreshSessions(): Promise<void> {
    const n = ++this.refreshN; // overlapping refreshes: only the newest may write
    try {
      const [a, b] = await Promise.all([
        get<{ sessions: SessionSummary[] }>('/api/sessions'),
        get<{ sessions: SessionSummary[] }>('/api/sessions?archived=1'),
      ]);
      if (n === this.refreshN) this.sessions = [...a.sessions, ...b.sessions];
    } catch {
      /* keep the old list; the offline banner explains */
    }
  }

  async loadModels(): Promise<void> {
    try {
      this.models = (await get<{ models: ModelDto[] }>('/api/models')).models;
    } catch {
      /* the dialog falls back to the default model */
    }
  }

  async loadUsage(): Promise<void> {
    try {
      this.plan = (await get<{ plan: PlanUsage }>('/api/usage')).plan;
    } catch {
      this.plan = { status: 'unavailable' };
    }
  }

  get active(): SessionView | null {
    return this.activeId ? (this.views[this.activeId] ?? null) : null;
  }
  get activeSummary(): SessionSummary | null {
    return this.sessions.find((s) => s.id === this.activeId) ?? null;
  }
  stateOf(id: string): AntState {
    return this.views[id]?.state ?? 'idle';
  }

  /** Subscribes to a session's events (replayed from the last seq the page has). */
  async watch(id: string): Promise<void> {
    if (!this.views[id]) this.views[id] = newView(id);
    const v = this.views[id]!;
    v.synced = false; // replayed state changes after a reconnect are not announced again
    this.resyncFrom[id] = v.lastSeq;
    if (this.socket.status === 'open') this.socket.hello(id, v.lastSeq);
  }

  async openSession(id: string): Promise<void> {
    this.focus = 'lead';
    this.activeId = id;
    history.replaceState(null, '', `#s=${id}`);
    try {
      await get(`/api/sessions/${id}`); // makes the server import terminal history when there is no log yet
    } catch (e) {
      this.banner = e instanceof ApiError && e.status === 404 ? 'That session was not found.' : this.banner;
    }
    await this.watch(id);
    void this.refreshTerminals(id);
  }

  closeSession(): void {
    this.activeId = null;
    history.replaceState(null, '', location.pathname);
  }

  private onMessage(m: ServerMessage): void {
    if (m.t === 'ping') return;
    if (m.t === 'error') {
      if (m.code === 'stepup_required') {
        const id = this.activeId;
        void this.askStepUp('Switching to Bypass mode.').then((ok) => {
          if (ok && id) this.tell({ t: 'setPermissionMode', sessionId: id, mode: 'bypassPermissions' });
        });
      } else this.banner = m.message;
      return;
    }
    if (m.t === 'delta') {
      const v = this.views[m.sessionId];
      if (v) applyDelta(v, m.text);
      return;
    }
    if (m.t === 'synced') {
      const v = this.views[m.sessionId];
      if (v) {
        v.synced = true;
        const from = this.resyncFrom[m.sessionId] ?? 0;
        const n = v.lastSeq - from;
        if (from > 0 && n > 0 && m.sessionId === this.activeId)
          this.say(`Reconnected. Caught up on ${n} missed ${n === 1 ? 'event' : 'events'}.`);
      }
      return;
    }
    if (this.removed.has(m.sessionId)) return;
    if (!this.views[m.sessionId]) this.views[m.sessionId] = newView(m.sessionId);
    const v = this.views[m.sessionId]!; // read back through the proxy so changes are reactive
    const before = v.state;
    if (!applyEvent(v, m.seq, m.at, m.event)) return;
    const ev = m.event;
    if (ev.k === 'plan_usage') this.plan = ev.usage;
    if (ev.k === 'turn_done' || (ev.k === 'notice' && ev.message.startsWith('Session')))
      void this.refreshSessions();
    if (v.state !== before && v.synced) this.say(`${nameOf(v.id)}: ${v.state}`);
    if (ev.k === 'approval_request' && v.synced) this.say('Approval needed');
  }

  /** Screen reader announcement. Cleared first so the same text twice is read twice. */
  say(text: string): void {
    this.live = '';
    setTimeout(() => (this.live = text), 50);
  }

  // ---- step-up ----

  isFresh(): boolean {
    return this.freshUntil > Date.now();
  }

  askStepUp(reason: string): Promise<boolean> {
    return new Promise((resolve) => {
      this.stepUpAsk?.resolve(false);
      this.stepUpAsk = { id: ++this.askId, reason, resolve };
    });
  }

  /** `id` is the ask the result belongs to. A result for an ask that is gone (Esc, then a late passkey) is ignored. */
  stepUpDone(ok: boolean, id?: number): void {
    const a = this.stepUpAsk;
    if (!a || (id !== undefined && a.id !== id)) return;
    if (ok) this.freshUntil = Date.now() + 5 * 60_000 - 5000;
    this.stepUpAsk = null;
    a.resolve(ok);
  }

  /** Runs `fn`; when the server asks for a fresh passkey or code, asks the user and runs it once more. */
  async withStepUp<T>(reason: string, fn: () => Promise<T>): Promise<T | undefined> {
    try {
      return await fn();
    } catch (e) {
      if (!isStepUp(e)) throw e;
      if (!(await this.askStepUp(reason))) return undefined;
      return fn();
    }
  }

  // ---- actions ----

  async startSession(o: {
    folder: string;
    model: string;
    effort?: string;
    mode: PermissionMode;
  }): Promise<string | undefined> {
    const reason =
      o.mode === 'bypassPermissions'
        ? 'Bypass mode runs every tool without asking.'
        : 'A session in your home folder can reach everything in it.';
    const r = await this.withStepUp(reason, () => post<{ id: string }>('/api/sessions', o));
    if (!r) return undefined;
    saveLast({ folder: o.folder, model: o.model, effort: o.effort ?? '', mode: o.mode });
    await this.refreshSessions();
    this.listView = 'active';
    await this.openSession(r.id);
    return r.id;
  }

  /** Sends to the open connection. Returns false and says so when it is down, so nothing is lost silently. */
  private tell(m: ClientMessage): boolean {
    const ok = this.socket.send(m);
    if (!ok) this.banner = 'Not connected. Your action was not sent. Try again in a moment.';
    return ok;
  }
  send(text: string): boolean {
    const id = this.activeId;
    return !!id && !!text.trim() && this.tell({ t: 'send', sessionId: id, text });
  }
  approve(requestId: string): void {
    if (this.activeId) this.tell({ t: 'approve', sessionId: this.activeId, requestId });
  }
  deny(requestId: string): void {
    if (this.activeId) this.tell({ t: 'deny', sessionId: this.activeId, requestId });
  }
  interrupt(): void {
    if (this.activeId) this.tell({ t: 'interrupt', sessionId: this.activeId });
  }
  stopTask(taskId: string): void {
    if (this.activeId) this.tell({ t: 'stopTask', sessionId: this.activeId, taskId });
  }
  setModel(model: string): void {
    if (this.activeId) this.tell({ t: 'setModel', sessionId: this.activeId, model });
  }
  setEffort(effort: string): void {
    if (this.activeId) this.tell({ t: 'setEffort', sessionId: this.activeId, effort });
  }
  async setMode(mode: PermissionMode): Promise<boolean> {
    if (!this.activeId) return false;
    if (
      mode === 'bypassPermissions' &&
      !this.isFresh() &&
      !(await this.askStepUp('Switching to Bypass mode.'))
    )
      return false;
    return this.tell({ t: 'setPermissionMode', sessionId: this.activeId, mode });
  }

  async pin(id: string, pinned: boolean): Promise<void> {
    await patch(`/api/sessions/${id}`, { pinned });
    await this.refreshSessions();
  }

  /** Other sessions that are waiting for the owner right now, so an approval is never hidden behind another session. */
  get waitingElsewhere(): { id: string; title: string }[] {
    return this.sessions
      .filter((s) => s.id !== this.activeId && this.views[s.id]?.state === 'approval')
      .map((s) => ({ id: s.id, title: titleOf(s) }));
  }

  /** Keeps the last answer when the request fails; the prompt is a convenience. */
  async loadVersion(): Promise<void> {
    try {
      this.version = (await get<{ version: string }>('/api/status')).version;
    } catch {
      /* the label stays hidden */
    }
  }

  async refreshConnections(): Promise<void> {
    try {
      this.connSummary = await get<ConnectionsSummary>('/api/connections/summary');
    } catch {
      /* leave it as it was */
    }
  }

  status(): Promise<StatusDto> {
    return get<StatusDto>('/api/status');
  }

  testPush(): Promise<{ sent: number }> {
    return post<{ sent: number }>('/api/push/test');
  }

  // ---- terminals ----

  /** Shells of the open session that are still running. */
  get runningTerminals(): number {
    return (this.activeId ? (this.terminals[this.activeId] ?? []) : []).filter((t) => t.running).length;
  }

  async refreshTerminals(id: string): Promise<void> {
    try {
      this.terminals[id] = (
        await get<{ terminals: TerminalInfo[] }>(`/api/sessions/${id}/terminals`)
      ).terminals;
    } catch {
      /* keep the old list; the offline banner explains */
    }
  }

  async openTerminal(id: string, size: { cols: number; rows: number }): Promise<TerminalInfo | undefined> {
    try {
      const { terminal } = await post<{ terminal: TerminalInfo }>(`/api/sessions/${id}/terminals`, size);
      this.terminals[id] = [...(this.terminals[id] ?? []), terminal];
      return terminal;
    } catch (e) {
      const code = e instanceof ApiError ? e.code : '';
      this.banner =
        code === 'terminal_limit'
          ? 'Too many terminals are open. Close one first.'
          : code === 'archived'
            ? 'This session is archived. Unarchive it to open a terminal.'
            : code === 'shell_unavailable'
              ? 'The server could not start a shell.'
              : 'Could not open a terminal.';
      return undefined;
    }
  }

  async closeTerminal(id: string, terminalId: string): Promise<void> {
    this.terminals[id] = (this.terminals[id] ?? []).filter((t) => t.id !== terminalId);
    try {
      await del(`/api/sessions/${id}/terminals/${terminalId}`);
    } catch {
      /* already gone */
    }
  }

  async archive(id: string, archived: boolean): Promise<void> {
    await patch(`/api/sessions/${id}`, { archived });
    if (archived) this.terminals[id] = []; // the server killed the shells
    await this.refreshSessions();
    if (archived && this.activeId === id) this.closeSession();
    this.live = archived ? 'Session archived' : 'Session unarchived';
  }
  async rename(id: string, title: string): Promise<void> {
    await patch(`/api/sessions/${id}`, { title });
    await this.refreshSessions();
  }
  async remove(id: string): Promise<boolean> {
    const r = await this.withStepUp('Deleting a session cannot be undone.', () => del(`/api/sessions/${id}`));
    if (!r) return false;
    this.removed.add(id);
    delete this.views[id];
    if (this.activeId === id) this.closeSession();
    await this.refreshSessions();
    this.live = 'Session deleted';
    return true;
  }

  listFolders(path: string): Promise<FolderListing> {
    return get<FolderListing>(`/api/folders?path=${encodeURIComponent(path)}`);
  }
  createFolder(parent: string, name: string): Promise<{ path: string }> {
    return post('/api/folders', { parent, name });
  }
}

export const app = new AppStore();
