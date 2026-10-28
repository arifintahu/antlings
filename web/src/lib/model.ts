import type { AttachmentRef, UiEvent } from '@antlings/shared';
import type { AntState } from '../ants/draw.js';

export interface LogEntry {
  toolUseId: string;
  name: string;
  arg: string;
  st: 'run' | 'ok' | 'fail' | 'ask';
}

export interface ApprovalView {
  requestId: string;
  toolName: string;
  title?: string;
  input: unknown;
  status: 'waiting' | 'allowed' | 'denied';
}

export interface AntView {
  taskId: string;
  toolUseId?: string;
  description: string;
  subagentType: string;
  state: AntState;
  lastTool?: string;
  startedAt: number;
  endedAt?: number;
  totalTokens: number;
  toolUses: number;
  report?: string;
  status?: 'completed' | 'failed' | 'stopped';
  log: LogEntry[];
  approval?: ApprovalView;
  look: number;
}

export type Item =
  | { kind: 'user'; seq: number; text: string; attachments?: AttachmentRef[] }
  | { kind: 'agent'; seq: number; text: string }
  | {
      kind: 'tool';
      seq: number;
      toolUseId: string;
      name: string;
      input: unknown;
      result?: { ok: boolean; text: string };
      /** The approval for this very call, shown inside the same card. */
      approval?: ApprovalView;
    }
  | ({ kind: 'approval'; seq: number } & ApprovalView)
  | { kind: 'spawn'; seq: number; taskId: string }
  | { kind: 'notice'; seq: number; text: string; bad: boolean };

export interface ContextView {
  percentage: number;
  totalTokens: number;
  maxTokens: number;
}

export interface SessionView {
  id: string;
  lastSeq: number;
  synced: boolean;
  items: Item[];
  ants: AntView[];
  state: AntState;
  tool?: string;
  model?: string;
  mode?: string;
  effort?: string;
  context?: ContextView;
  turnRunning: boolean;
  /** Hidden when the page gets the same seq twice (a reconnect race). */
  seen: number;
  /** Text of the lead's answer while it is still being written. Replaced by the final message. */
  streaming: string;
  /** Sum of the cost the SDK reported for each turn. */
  costUsd: number;
  /** Position in `items` by tool call id and by approval request id, so lookups stay cheap in long sessions. */
  toolIndex: Record<string, number>;
  approvalIndex: Record<string, number>;
}

/** Adds live text from the lead. Not part of the event log. */
export function applyDelta(v: SessionView, text: string): void {
  v.streaming += text;
}

export function newView(id: string): SessionView {
  return {
    streaming: '',
    costUsd: 0,
    toolIndex: {},
    approvalIndex: {},
    id,
    lastSeq: 0,
    synced: false,
    items: [],
    ants: [],
    state: 'idle',
    turnRunning: false,
    seen: 0,
  };
}

/** A one-line summary of a tool input for logs and cards. */
export function argOf(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const o = input as Record<string, unknown>;
  for (const k of ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'description', 'prompt']) {
    if (typeof o[k] === 'string') return o[k].split('\n')[0]!.slice(0, 160);
  }
  return '';
}

const antFor = (v: SessionView, parentToolUseId?: string): AntView | undefined =>
  parentToolUseId ? v.ants.find((a) => a.toolUseId === parentToolUseId) : undefined;

/** Applies one stored event. Returns false for a duplicate or an out-of-order seq, so replays never double up. */
export function applyEvent(v: SessionView, seq: number, at: number, ev: UiEvent): boolean {
  if (seq <= v.lastSeq) return false;
  v.lastSeq = seq;
  switch (ev.k) {
    case 'user':
      v.streaming = '';
      v.items.push({
        kind: 'user',
        seq,
        text: ev.text,
        ...(ev.attachments?.length ? { attachments: ev.attachments } : {}),
      });
      v.turnRunning = true;
      break;
    case 'assistant_text': {
      const ant = antFor(v, ev.parentToolUseId);
      if (ant) ant.state = ant.state === 'approval' ? 'approval' : 'thinking';
      else {
        v.streaming = '';
        v.items.push({ kind: 'agent', seq, text: ev.text });
      }
      break;
    }
    case 'tool_use': {
      const ant = antFor(v, ev.parentToolUseId);
      if (ant) {
        ant.log.push({ toolUseId: ev.toolUseId, name: ev.name, arg: argOf(ev.input), st: 'run' });
        ant.lastTool = ev.name;
        if (ant.state !== 'approval') ant.state = 'tool';
      } else if (ev.name !== 'Agent' && ev.name !== 'Task') {
        v.streaming = '';
        v.toolIndex[ev.toolUseId] = v.items.length;
        v.items.push({ kind: 'tool', seq, toolUseId: ev.toolUseId, name: ev.name, input: ev.input });
      }
      break;
    }
    case 'tool_result': {
      const ant = antFor(v, ev.parentToolUseId);
      if (ant) {
        const l = ant.log.find((x) => x.toolUseId === ev.toolUseId);
        if (l) l.st = ev.ok ? 'ok' : 'fail';
        if (ant.state === 'tool') ant.state = 'thinking';
      } else {
        const t = v.items[v.toolIndex[ev.toolUseId] ?? -1];
        if (t && t.kind === 'tool') t.result = { ok: ev.ok, text: ev.text };
      }
      break;
    }
    case 'approval_request': {
      const ant = antFor(v, ev.parentToolUseId);
      const a: ApprovalView = {
        requestId: ev.requestId,
        toolName: ev.toolName,
        title: ev.title,
        input: ev.input,
        status: 'waiting',
      };
      if (ant) {
        ant.approval = a;
        ant.state = 'approval';
        const l = ev.toolUseId ? ant.log.find((x) => x.toolUseId === ev.toolUseId) : undefined;
        if (l) l.st = 'ask';
      } else {
        const tool = ev.toolUseId !== undefined ? v.items[v.toolIndex[ev.toolUseId] ?? -1] : undefined;
        if (tool && tool.kind === 'tool') {
          // One card per call: the approval buttons live in the tool card.
          tool.approval = a;
          v.approvalIndex[ev.requestId] = v.toolIndex[ev.toolUseId!]!;
        } else {
          v.approvalIndex[ev.requestId] = v.items.length;
          v.items.push({ kind: 'approval', seq, ...a });
        }
      }
      break;
    }
    case 'approval_resolved': {
      const decision = ev.decision === 'allow' ? 'allowed' : 'denied';
      const ant = v.ants.find((a) => a.approval?.requestId === ev.requestId);
      if (ant?.approval) {
        ant.approval.status = decision;
        ant.state = ev.decision === 'allow' ? 'tool' : 'thinking';
        const l = ant.log.find((x) => x.st === 'ask');
        if (l) l.st = ev.decision === 'allow' ? 'run' : 'fail';
      }
      const it = v.items[v.approvalIndex[ev.requestId] ?? -1];
      if (it?.kind === 'approval') it.status = decision;
      else if (it?.kind === 'tool' && it.approval) it.approval.status = decision;
      break;
    }
    case 'task_started':
      if (!v.ants.some((a) => a.taskId === ev.taskId)) {
        v.ants.push({
          taskId: ev.taskId,
          toolUseId: ev.toolUseId,
          description: ev.description,
          subagentType: ev.subagentType,
          state: 'thinking',
          startedAt: at,
          totalTokens: 0,
          toolUses: 0,
          log: [],
          look: (v.ants.length + 2) % 6,
        });
        v.items.push({ kind: 'spawn', seq, taskId: ev.taskId });
      }
      break;
    case 'task_progress': {
      const a = v.ants.find((x) => x.taskId === ev.taskId);
      if (!a) break;
      if (ev.lastTool) a.lastTool = ev.lastTool;
      if (ev.usage) {
        a.totalTokens = ev.usage.totalTokens;
        a.toolUses = ev.usage.toolUses;
      }
      if (ev.summary) a.description = ev.summary;
      break;
    }
    case 'task_done': {
      const a = v.ants.find((x) => x.taskId === ev.taskId);
      if (!a) break;
      a.status = ev.status;
      a.state = ev.status === 'completed' ? 'done' : ev.status === 'failed' ? 'error' : 'idle';
      a.endedAt = at;
      a.report = ev.report;
      if (ev.usage) {
        a.totalTokens = ev.usage.totalTokens;
        a.toolUses = ev.usage.toolUses;
      }
      for (const l of a.log)
        if (l.st === 'run' || l.st === 'ask') l.st = ev.status === 'completed' ? 'ok' : 'fail';
      if (ev.status === 'failed' && ev.report)
        v.items.push({ kind: 'notice', seq, text: ev.report, bad: true });
      break;
    }
    case 'state':
      v.state = ev.state;
      v.tool = ev.tool;
      break;
    case 'turn_done':
      v.turnRunning = false;
      v.streaming = '';
      if (typeof ev.costUsd === 'number') v.costUsd += ev.costUsd;
      break;
    case 'context':
      v.context = { percentage: ev.percentage, totalTokens: ev.totalTokens, maxTokens: ev.maxTokens };
      break;
    case 'settings':
      v.model = ev.model;
      v.mode = ev.mode;
      v.effort = ev.effort ?? v.effort;
      break;
    case 'notice':
      v.items.push({ kind: 'notice', seq, text: ev.message, bad: false });
      break;
    case 'error':
      v.streaming = '';
      v.items.push({ kind: 'notice', seq, text: ev.message, bad: true });
      v.state = 'error';
      v.turnRunning = false;
      break;
    case 'plan_usage':
      break;
  }
  return true;
}

export const isBusy = (s: AntState): boolean => s === 'thinking' || s === 'tool';

export function counts(ants: AntView[]) {
  return {
    run: ants.filter((a) => isBusy(a.state)).length,
    wait: ants.filter((a) => a.state === 'approval').length,
    done: ants.filter((a) => a.state === 'done').length,
    fail: ants.filter((a) => a.state === 'error').length,
  };
}

export function fmtK(n: number): string {
  return n >= 1000 ? (n / 1000).toFixed(n >= 100000 ? 0 : 1).replace(/\.0$/, '') + 'k' : String(n);
}

export function fmtDur(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
}

export function fmtReset(iso: string | null, now: number): string {
  if (!iso) return '';
  const s = Math.max(0, Math.floor((Date.parse(iso) - now) / 1000));
  return s >= 86400
    ? `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`
    : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

export const level = (p: number): '' | 'warn' | 'crit' => (p >= 90 ? 'crit' : p >= 70 ? 'warn' : '');
