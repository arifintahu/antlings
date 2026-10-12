import { z } from 'zod';
import { PERMISSION_MODES } from './api.js';

const Id = z.string().min(1).max(200);
const SessionId = Id;

/** Messages the browser sends over the WebSocket. Every inbound message is parsed with this schema. */
export const ClientMessage = z.discriminatedUnion('t', [
  z.object({ t: z.literal('hello'), sessionId: SessionId, lastSeq: z.number().int().min(0) }),
  z.object({ t: z.literal('send'), sessionId: SessionId, text: z.string().min(1).max(100_000) }),
  z.object({
    t: z.literal('approve'),
    sessionId: SessionId,
    requestId: Id,
    updatedInput: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({
    t: z.literal('deny'),
    sessionId: SessionId,
    requestId: Id,
    message: z.string().max(2000).optional(),
  }),
  z.object({ t: z.literal('interrupt'), sessionId: SessionId }),
  z.object({ t: z.literal('stopTask'), sessionId: SessionId, taskId: Id }),
  z.object({ t: z.literal('setModel'), sessionId: SessionId, model: z.string().min(1).max(100) }),
  z.object({ t: z.literal('setPermissionMode'), sessionId: SessionId, mode: z.enum(PERMISSION_MODES) }),
  z.object({ t: z.literal('setEffort'), sessionId: SessionId, effort: z.string().min(1).max(20) }),
  z.object({ t: z.literal('resume'), sessionId: SessionId }),
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

export type AntState = 'idle' | 'thinking' | 'tool' | 'approval' | 'done' | 'error';

export interface PlanWindow {
  percent: number;
  resetsAt: string | null;
}
export type PlanUsage =
  { status: 'ok'; fiveHour: PlanWindow | null; sevenDay: PlanWindow | null } | { status: 'unavailable' };

export interface TaskUsage {
  totalTokens: number;
  toolUses: number;
  durationMs: number;
}

/** Events the server stores in the event log and streams to the browser. */
export type UiEvent =
  | { k: 'user'; text: string }
  | { k: 'assistant_text'; text: string; parentToolUseId?: string }
  | { k: 'tool_use'; toolUseId: string; name: string; input: unknown; parentToolUseId?: string }
  | { k: 'tool_result'; toolUseId: string; ok: boolean; text: string; parentToolUseId?: string }
  | {
      k: 'approval_request';
      requestId: string;
      toolName: string;
      toolUseId?: string;
      title?: string;
      input: unknown;
      parentToolUseId?: string;
    }
  | { k: 'approval_resolved'; requestId: string; decision: 'allow' | 'deny' }
  | { k: 'task_started'; taskId: string; toolUseId?: string; description: string; subagentType: string }
  | { k: 'task_progress'; taskId: string; lastTool?: string; usage?: TaskUsage; summary?: string }
  | {
      k: 'task_done';
      taskId: string;
      status: 'completed' | 'failed' | 'stopped';
      usage?: TaskUsage;
      report?: string;
    }
  | { k: 'state'; state: AntState; tool?: string }
  | { k: 'turn_done'; costUsd?: number; isError: boolean }
  | { k: 'context'; percentage: number; totalTokens: number; maxTokens: number }
  | { k: 'plan_usage'; usage: PlanUsage }
  | { k: 'settings'; model: string; mode: string; effort?: string }
  | { k: 'notice'; message: string }
  | { k: 'error'; message: string };

export interface StoredEvent {
  seq: number;
  at: number;
  event: UiEvent;
}

export type ServerMessage =
  | { t: 'event'; sessionId: string; seq: number; at: number; event: UiEvent }
  | { t: 'synced'; sessionId: string; lastSeq: number }
  | { t: 'error'; code: string; message: string };

export interface SessionSummary {
  id: string;
  title: string;
  cwd: string;
  model?: string;
  lastModified: number;
  archived: boolean;
  running: boolean;
}
