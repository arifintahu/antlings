import type { PermissionMode, PlanUsage, ServerMessage, SessionSummary } from '@antlings/shared';
import type { AntState } from '../ants/draw.js';
import { ApiError, del, get, isStepUp, patch, post, setCsrf, setUnauthorizedHandler } from './api.js';
import { applyEvent, newView, type SessionView } from './model.js';
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

export type Screen = 'boot' | 'login' | 'firstrun' | 'app';

class AppStore {
  screen = $state<Screen>('boot');
  securityOpen = $state(false);
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
  stepUpAsk = $state<{ reason: string; resolve: (ok: boolean) => void } | null>(null);
  freshUntil = 0;
  now = $state(Date.now());
  loadError = $state('');

  private socket = new Socket({
    onMessage: (m) => this.onMessage(m),
    onStatus: (s) => {
      this.wsStatus = s;
    },
    subscriptions: () => Object.values(this.views).map((v) => ({ sessionId: v.id, lastSeq: v.lastSeq })),
    onSignedOut: () => this.signedOut(),
  });

  constructor() {
    setUnauthorizedHandler(() => this.signedOut());
    setInterval(() => {
      this.now = Date.now();
    }, 1000);
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
      } catch {
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
    await Promise.all([this.refreshSessions(), this.loadModels(), this.loadUsage()]);
    const wanted = location.hash.match(/^#s=([0-9a-f-]{36})$/i)?.[1];
    if (wanted) await this.openSession(wanted);
    else for (const s of this.sessions) if (s.running) void this.watch(s.id);
  }

  signedOut(): void {
    this.socket.stop();
    setCsrf('');
    this.views = {};
    this.sessions = [];
    this.activeId = null;
    this.securityOpen = false;
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

  async refreshSessions(): Promise<void> {
    try {
      const [a, b] = await Promise.all([
        get<{ sessions: SessionSummary[] }>('/api/sessions'),
        get<{ sessions: SessionSummary[] }>('/api/sessions?archived=1'),
      ]);
      this.sessions = [...a.sessions, ...b.sessions];
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
    if (this.socket.status === 'open') this.socket.hello(id, this.views[id]!.lastSeq);
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
  }

  closeSession(): void {
    this.activeId = null;
    history.replaceState(null, '', location.pathname);
  }

  private onMessage(m: ServerMessage): void {
    if (m.t === 'error') {
      if (m.code === 'stepup_required') void this.askStepUp('Confirm to continue.');
      else this.banner = m.message;
      return;
    }
    if (m.t === 'synced') {
      const v = this.views[m.sessionId];
      if (v) v.synced = true;
      return;
    }
    const v = (this.views[m.sessionId] ??= newView(m.sessionId));
    const before = v.state;
    if (!applyEvent(v, m.seq, m.at, m.event)) return;
    const ev = m.event;
    if (ev.k === 'plan_usage') this.plan = ev.usage;
    if (ev.k === 'turn_done' || (ev.k === 'notice' && ev.message.startsWith('Session')))
      void this.refreshSessions();
    if (v.state !== before && v.synced) this.live = `${nameOf(v.id)}: ${v.state}`;
    if (ev.k === 'approval_request' && v.synced) this.live = 'Approval needed';
  }

  // ---- step-up ----

  isFresh(): boolean {
    return this.freshUntil > Date.now();
  }

  askStepUp(reason: string): Promise<boolean> {
    return new Promise((resolve) => {
      this.stepUpAsk?.resolve(false);
      this.stepUpAsk = { reason, resolve };
    });
  }

  stepUpDone(ok: boolean): void {
    if (ok) this.freshUntil = Date.now() + 5 * 60_000 - 5000;
    const a = this.stepUpAsk;
    this.stepUpAsk = null;
    a?.resolve(ok);
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
    await this.refreshSessions();
    this.listView = 'active';
    await this.openSession(r.id);
    return r.id;
  }

  send(text: string): void {
    const id = this.activeId;
    if (id && text.trim()) this.socket.send({ t: 'send', sessionId: id, text });
  }
  approve(requestId: string): void {
    if (this.activeId) this.socket.send({ t: 'approve', sessionId: this.activeId, requestId });
  }
  deny(requestId: string): void {
    if (this.activeId) this.socket.send({ t: 'deny', sessionId: this.activeId, requestId });
  }
  interrupt(): void {
    if (this.activeId) this.socket.send({ t: 'interrupt', sessionId: this.activeId });
  }
  stopTask(taskId: string): void {
    if (this.activeId) this.socket.send({ t: 'stopTask', sessionId: this.activeId, taskId });
  }
  setModel(model: string): void {
    if (this.activeId) this.socket.send({ t: 'setModel', sessionId: this.activeId, model });
  }
  setEffort(effort: string): void {
    if (this.activeId) this.socket.send({ t: 'setEffort', sessionId: this.activeId, effort });
  }
  async setMode(mode: PermissionMode): Promise<boolean> {
    if (!this.activeId) return false;
    if (
      mode === 'bypassPermissions' &&
      !this.isFresh() &&
      !(await this.askStepUp('Switching to Bypass mode.'))
    )
      return false;
    this.socket.send({ t: 'setPermissionMode', sessionId: this.activeId, mode });
    return true;
  }

  async archive(id: string, archived: boolean): Promise<void> {
    await patch(`/api/sessions/${id}`, { archived });
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
