import { randomUUID } from 'node:crypto';
import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk';
import type { PermissionMode, PlanUsage, ServerMessage, StoredEvent, UiEvent } from '@antlings/shared';
import type { AgentFactory, AgentHandle, Effort, ModelInfo } from './agent.js';
import type { Config } from './config.js';
import type { Db } from './db.js';
import { EventMapper, historyEvents } from './events.js';
import { fetchPlanUsage } from './plan.js';
import type { Transcripts } from './transcripts.js';
import { randomToken, type Clock } from './util.js';

export class LimitError extends Error {
  constructor(max: number) {
    super(`Only ${max} sessions can run at once on this server. Close or finish one first.`);
  }
}
export class NotFoundError extends Error {}

export interface Notifier {
  approvalWaiting(sessionId: string, toolName: string): void;
  sessionFinished(sessionId: string): void;
}

export interface SessionMeta {
  id: string;
  cwd: string;
  model: string;
  effort: Effort | null;
  mode: PermissionMode;
  createdAt: number;
}

interface Pending {
  resolve: (r: Awaited<ReturnType<CanUseTool>>) => void;
  toolName: string;
  input: Record<string, unknown>;
}

interface Active {
  id: string;
  handle: AgentHandle;
  mapper: EventMapper;
  pending: Map<string, Pending>;
  lastActivity: number;
  turnRunning: boolean;
  closing: boolean;
}

export interface ManagerDeps {
  db: Db;
  clock: Clock;
  config: Config;
  agents: AgentFactory;
  transcripts: Transcripts;
  audit: (kind: string, detail?: unknown) => void;
  notifier?: Notifier;
  maxBudgetUsd?: number;
}

type Listener = (m: ServerMessage) => void;

export const FALLBACK_MODELS: ModelInfo[] = [
  { value: 'default', displayName: 'Default', description: 'Default model', supportsEffort: false },
  {
    value: 'sonnet',
    displayName: 'Sonnet',
    description: 'Sonnet',
    supportsEffort: true,
    supportedEffortLevels: ['low', 'medium', 'high'],
  },
  {
    value: 'opus',
    displayName: 'Opus',
    description: 'Opus',
    supportsEffort: true,
    supportedEffortLevels: ['low', 'medium', 'high'],
  },
  { value: 'haiku', displayName: 'Haiku', description: 'Haiku', supportsEffort: false },
];
const MODEL_CACHE_MS = 3_600_000;
export const IDLE_CLOSE_MS = 15 * 60_000;

export class SessionManager {
  private active = new Map<string, Active>();
  private listeners = new Map<string, Set<Listener>>();
  private seqCache = new Map<string, number>();
  private starting = new Set<string>();
  private removed = new Set<string>();
  private models: { at: number; list: ModelInfo[] } | undefined;
  plan: PlanUsage = { status: 'unavailable' };

  constructor(private d: ManagerDeps) {}

  // ---- event log ----

  private nextSeq(id: string): number {
    let n = this.seqCache.get(id);
    if (n === undefined) {
      const row = this.d.db.prepare('SELECT MAX(seq) AS m FROM event_log WHERE session_id = ?').get(id) as {
        m: number | null;
      };
      n = row.m ?? 0;
    }
    n += 1;
    this.seqCache.set(id, n);
    return n;
  }

  emit(id: string, event: UiEvent): StoredEvent {
    // A deleted session must not get log rows from its dying process.
    if (this.removed.has(id)) return { seq: 0, at: this.d.clock.now(), event };
    const seq = this.nextSeq(id);
    const at = this.d.clock.now();
    this.d.db
      .prepare('INSERT INTO event_log (session_id, seq, at, data) VALUES (?, ?, ?, ?)')
      .run(id, seq, at, JSON.stringify(event));
    for (const l of this.listeners.get(id) ?? []) l({ t: 'event', sessionId: id, seq, at, event });
    return { seq, at, event };
  }

  eventsAfter(id: string, lastSeq: number, limit = 5000): StoredEvent[] {
    const rows = this.d.db
      .prepare('SELECT seq, at, data FROM event_log WHERE session_id = ? AND seq > ? ORDER BY seq LIMIT ?')
      .all(id, lastSeq, limit) as { seq: number; at: number; data: string }[];
    return rows.map((r) => ({ seq: r.seq, at: r.at, event: JSON.parse(r.data) as UiEvent }));
  }

  /**
   * Sends the events after `lastSeq`, then everything new, in order and once.
   * The replay and the listener registration happen in one tick, so nothing is missed or doubled.
   */
  subscribe(id: string, lastSeq: number, send: Listener): () => void {
    // Page through the whole backlog so a client far behind still gets every event.
    const replay: StoredEvent[] = [];
    for (let from = lastSeq; ;) {
      const page = this.eventsAfter(id, from, 2000);
      replay.push(...page);
      if (page.length < 2000) break;
      from = page[page.length - 1]!.seq;
    }
    for (const e of replay) send({ t: 'event', sessionId: id, seq: e.seq, at: e.at, event: e.event });
    const last = replay.at(-1)?.seq ?? lastSeq;
    send({ t: 'synced', sessionId: id, lastSeq: last });
    let set = this.listeners.get(id);
    if (!set) this.listeners.set(id, (set = new Set()));
    set.add(send);
    return () => set.delete(send);
  }

  /** For a session with no event log (started in the terminal), builds one from the transcript. */
  async importHistory(id: string): Promise<void> {
    const has = this.d.db.prepare('SELECT 1 FROM event_log WHERE session_id = ? LIMIT 1').get(id);
    if (has || this.removed.has(id)) return;
    const events = historyEvents(await this.d.transcripts.messages(id));
    for (const e of events) this.emit(id, e);
  }

  // ---- metadata and state ----

  meta(id: string): SessionMeta | undefined {
    const r = this.d.db.prepare('SELECT * FROM session_meta WHERE id = ?').get(id) as
      | {
          id: string;
          cwd: string;
          model: string;
          effort: Effort | null;
          mode: PermissionMode;
          created_at: number;
        }
      | undefined;
    return (
      r && { id: r.id, cwd: r.cwd, model: r.model, effort: r.effort, mode: r.mode, createdAt: r.created_at }
    );
  }

  private saveMeta(m: SessionMeta): void {
    this.d.db
      .prepare(
        `INSERT INTO session_meta (id, cwd, model, effort, mode, created_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET cwd = excluded.cwd, model = excluded.model, effort = excluded.effort, mode = excluded.mode`,
      )
      .run(m.id, m.cwd, m.model, m.effort, m.mode, m.createdAt);
  }

  isRunning(id: string): boolean {
    return this.active.has(id);
  }
  runningIds(): string[] {
    return [...this.active.keys()];
  }
  pendingApprovals(id: string): number {
    return this.active.get(id)?.pending.size ?? 0;
  }

  // ---- lifecycle ----

  private checkLimit(): void {
    if (this.active.size + this.starting.size >= this.d.config.maxSessions)
      throw new LimitError(this.d.config.maxSessions);
  }

  /** Starts a brand new session. The caller has already validated folder, model, effort and mode. */
  async create(input: {
    cwd: string;
    model: string;
    effort?: Effort;
    mode: PermissionMode;
  }): Promise<SessionMeta> {
    this.checkLimit();
    const meta: SessionMeta = {
      id: randomUUID(),
      cwd: input.cwd,
      model: input.model,
      effort: input.effort ?? null,
      mode: input.mode,
      createdAt: this.d.clock.now(),
    };
    this.saveMeta(meta);
    this.launch(meta, false);
    this.d.audit('session_created', { id: meta.id, cwd: meta.cwd, mode: meta.mode, model: meta.model });
    this.emit(meta.id, {
      k: 'settings',
      model: meta.model,
      mode: meta.mode,
      effort: meta.effort ?? undefined,
    });
    return meta;
  }

  /** Makes sure the session has a live process. Resumes from the transcript when it is closed. */
  async ensureRunning(id: string): Promise<void> {
    if (this.active.has(id) || this.starting.has(id)) return;
    this.checkLimit();
    this.starting.add(id);
    try {
      let meta = this.meta(id);
      if (!meta) {
        const info = await this.d.transcripts.info(id);
        if (!info?.cwd) throw new NotFoundError('Session not found');
        meta = {
          id,
          cwd: info.cwd,
          model: 'default',
          effort: null,
          mode: 'default',
          createdAt: info.createdAt ?? this.d.clock.now(),
        };
        this.saveMeta(meta);
      }
      this.settleDangling(id);
      this.launch(meta, true);
      this.emit(id, { k: 'notice', message: 'Session resumed' });
    } finally {
      this.starting.delete(id);
    }
  }

  private launch(meta: SessionMeta, resume: boolean): void {
    const id = meta.id;
    const a: Active = {
      id,
      handle: undefined as unknown as AgentHandle,
      mapper: new EventMapper(),
      pending: new Map(),
      lastActivity: this.d.clock.now(),
      turnRunning: false,
      closing: false,
    };
    a.mapper.plan = this.plan;
    a.handle = this.d.agents.start({
      sessionId: id,
      resume,
      cwd: meta.cwd,
      model: meta.model,
      effort: meta.effort ?? undefined,
      mode: meta.mode,
      canUseTool: this.canUseTool(a),
      maxBudgetUsd: this.d.maxBudgetUsd,
    });
    this.active.set(id, a);
    void this.pump(a);
    void a.handle
      .supportedModels()
      .then((list) => (this.models = { at: this.d.clock.now(), list }))
      .catch(() => undefined);
  }

  private async pump(a: Active): Promise<void> {
    try {
      for await (const m of a.handle.messages) {
        a.lastActivity = this.d.clock.now();
        for (const ev of a.mapper.map(m)) this.emit(a.id, ev);
        if (a.mapper.plan !== this.plan) this.plan = a.mapper.plan;
        if (m.type === 'result') {
          a.turnRunning = false;
          await this.afterTurn(a);
        }
      }
    } catch (e) {
      if (!a.closing)
        this.emit(a.id, {
          k: 'error',
          message: e instanceof Error ? e.message.slice(0, 500) : 'Agent stopped',
        });
    } finally {
      this.active.delete(a.id);
      this.denyAll(a, 'Session closed');
      this.emit(a.id, { k: 'state', state: 'idle' });
      this.emit(a.id, { k: 'notice', message: 'Session closed. Send a message to resume it.' });
    }
  }

  private async afterTurn(a: Active): Promise<void> {
    try {
      this.emit(a.id, { k: 'context', ...(await a.handle.contextUsage()) });
    } catch {
      /* context meter stays at its last value */
    }
    const usage = await fetchPlanUsage(a.handle);
    this.plan = usage;
    a.mapper.plan = usage;
    this.emit(a.id, { k: 'plan_usage', usage });
    this.d.notifier?.sessionFinished(a.id);
  }

  private canUseTool(a: Active): CanUseTool {
    return (toolName, input, opts) =>
      new Promise((resolve) => {
        const requestId = randomToken(9);
        a.pending.set(requestId, { resolve, toolName, input });
        this.emit(a.id, {
          k: 'approval_request',
          requestId,
          toolName,
          toolUseId: opts.toolUseID,
          title: opts.title,
          input,
          parentToolUseId: a.mapper.parentOf(opts.toolUseID),
        });
        this.emit(a.id, { k: 'state', state: 'approval', tool: toolName });
        this.d.notifier?.approvalWaiting(a.id, toolName);
        opts.signal.addEventListener(
          'abort',
          () => this.settle(a, requestId, { behavior: 'deny', message: 'Cancelled' }, 'deny'),
          {
            once: true,
          },
        );
      });
  }

  private settle(
    a: Active,
    requestId: string,
    result: Awaited<ReturnType<CanUseTool>>,
    decision: 'allow' | 'deny',
  ): boolean {
    const p = a.pending.get(requestId);
    if (!p) return false;
    a.pending.delete(requestId);
    p.resolve(result);
    this.emit(a.id, { k: 'approval_resolved', requestId, decision });
    if (a.pending.size === 0)
      this.emit(a.id, { k: 'state', state: decision === 'allow' ? 'tool' : 'thinking', tool: p.toolName });
    return true;
  }

  private denyAll(a: Active, message: string): void {
    for (const id of [...a.pending.keys()]) this.settle(a, id, { behavior: 'deny', message }, 'deny');
  }

  /** After a crash or restart, requests nobody can answer any more are closed in the log. */
  private settleDangling(id: string): void {
    const open = new Set<string>();
    for (const e of this.eventsAfter(id, 0, 100_000)) {
      if (e.event.k === 'approval_request') open.add(e.event.requestId);
      else if (e.event.k === 'approval_resolved') open.delete(e.event.requestId);
    }
    for (const requestId of open) this.emit(id, { k: 'approval_resolved', requestId, decision: 'deny' });
  }

  // ---- actions ----

  private live(id: string): Active {
    const a = this.active.get(id);
    if (!a) throw new NotFoundError('Session is not running');
    return a;
  }

  async send(id: string, text: string): Promise<void> {
    await this.ensureRunning(id);
    const a = this.live(id);
    a.turnRunning = true;
    a.lastActivity = this.d.clock.now();
    this.emit(id, { k: 'user', text });
    this.emit(id, { k: 'state', state: 'thinking' });
    a.handle.send(text);
  }

  approve(id: string, requestId: string, updatedInput?: Record<string, unknown>): boolean {
    const a = this.active.get(id);
    const p = a?.pending.get(requestId);
    if (!a || !p) return false;
    this.d.audit('approval', { id, tool: p.toolName, decision: 'allow' });
    return this.settle(a, requestId, { behavior: 'allow', updatedInput: updatedInput ?? p.input }, 'allow');
  }

  deny(id: string, requestId: string, message?: string): boolean {
    const a = this.active.get(id);
    const p = a?.pending.get(requestId);
    if (!a || !p) return false;
    this.d.audit('approval', { id, tool: p.toolName, decision: 'deny' });
    return this.settle(a, requestId, { behavior: 'deny', message: message ?? 'Denied by the user' }, 'deny');
  }

  async interrupt(id: string): Promise<void> {
    const a = this.live(id);
    this.denyAll(a, 'Interrupted');
    await a.handle.interrupt();
  }

  async stopTask(id: string, taskId: string): Promise<void> {
    await this.live(id).handle.stopTask(taskId);
    this.d.audit('task_stopped', { id, taskId });
  }

  async setModel(id: string, model: string): Promise<void> {
    await this.ensureRunning(id);
    await this.live(id).handle.setModel(model);
    this.updateMeta(id, { model });
  }

  /** The caller must have checked step-up for `bypassPermissions`. */
  async setPermissionMode(id: string, mode: PermissionMode): Promise<void> {
    await this.ensureRunning(id);
    await this.live(id).handle.setPermissionMode(mode);
    this.updateMeta(id, { mode });
    this.d.audit('mode_changed', { id, mode });
  }

  async setEffort(id: string, effort: Effort): Promise<void> {
    await this.ensureRunning(id);
    await this.live(id).handle.setEffort(effort);
    this.updateMeta(id, { effort });
  }

  private updateMeta(id: string, patch: Partial<Pick<SessionMeta, 'model' | 'mode' | 'effort'>>): void {
    const m = this.meta(id);
    if (!m) return;
    const next = { ...m, ...patch };
    this.saveMeta(next);
    this.emit(id, { k: 'settings', model: next.model, mode: next.mode, effort: next.effort ?? undefined });
  }

  close(id: string): void {
    const a = this.active.get(id);
    if (!a) return;
    a.closing = true;
    this.denyAll(a, 'Session closed');
    a.handle.close();
  }

  closeAll(): void {
    for (const id of [...this.active.keys()]) this.close(id);
  }

  /** Closes sessions that are idle with nobody to answer. They resume on the next message. */
  reapIdle(): string[] {
    const now = this.d.clock.now();
    const closed: string[] = [];
    for (const a of this.active.values()) {
      if (!a.turnRunning && a.pending.size === 0 && now - a.lastActivity > IDLE_CLOSE_MS) {
        this.close(a.id);
        closed.push(a.id);
      }
    }
    return closed;
  }

  /** Removes the transcript, the event log and the metadata. The caller has checked step-up. */
  async remove(id: string): Promise<void> {
    this.close(id);
    this.removed.add(id);
    await this.d.transcripts.remove(id).catch(() => undefined); // no transcript yet is fine
    this.d.db.prepare('DELETE FROM event_log WHERE session_id = ?').run(id);
    this.d.db.prepare('DELETE FROM session_meta WHERE id = ?').run(id);
    this.seqCache.delete(id);
    this.d.audit('session_deleted', { id });
  }

  // ---- models ----

  async modelList(): Promise<ModelInfo[]> {
    const now = this.d.clock.now();
    if (this.models && now - this.models.at < MODEL_CACHE_MS) return this.models.list;
    try {
      const list = await this.d.agents.probeModels();
      if (list.length > 0) this.models = { at: now, list };
    } catch {
      /* fall back below */
    }
    return this.models?.list ?? FALLBACK_MODELS;
  }
}
