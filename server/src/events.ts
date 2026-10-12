import type { PlanUsage, UiEvent } from '@antlings/shared';
import type { SDKMessage } from './agent.js';
import { mergeRateLimit, type RateLimitInfo } from './plan.js';

interface Block {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  is_error?: boolean;
  content?: unknown;
}

function blocks(content: unknown): Block[] {
  return Array.isArray(content) ? (content as Block[]) : [];
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  return blocks(content)
    .map((b) => (b.type === 'text' && typeof b.text === 'string' ? b.text : ''))
    .filter(Boolean)
    .join('\n');
}

const clip = (s: string, n = 4000): string => (s.length > n ? `${s.slice(0, n)}\n[truncated]` : s);

/**
 * Turns SDK messages into UI events. Keeps the little state the mapping needs:
 * which tool_use ids belong to subagent calls, and the last known plan usage.
 */
export class EventMapper {
  plan: PlanUsage = { status: 'unavailable' };
  /** `system:init` arrives every turn; it only reports the settings, it is not a new session. */
  private agentToolIds = new Set<string>();
  private parents = new Map<string, string | undefined>();

  /** The subagent call (Agent tool_use id) a tool call ran under, if any. */
  parentOf(toolUseId: string | undefined): string | undefined {
    return toolUseId ? this.parents.get(toolUseId) : undefined;
  }

  map(m: SDKMessage): UiEvent[] {
    switch (m.type) {
      case 'system':
        return this.mapSystem(m);
      case 'assistant':
        return this.mapAssistant(m);
      case 'user':
        return this.mapUser(m);
      case 'result':
        return [
          {
            k: 'turn_done',
            costUsd: typeof m.total_cost_usd === 'number' ? m.total_cost_usd : undefined,
            isError: !!m.is_error,
          },
          { k: 'state', state: m.is_error ? 'error' : 'done' },
        ];
      case 'rate_limit_event': {
        const next = mergeRateLimit(this.plan, m.rate_limit_info as RateLimitInfo);
        if (!next) return [];
        this.plan = next;
        return [{ k: 'plan_usage', usage: next }];
      }
      default:
        return [];
    }
  }

  private mapSystem(m: Extract<SDKMessage, { type: 'system' }>): UiEvent[] {
    switch (m.subtype) {
      case 'init':
        return [{ k: 'settings', model: m.model, mode: m.permissionMode }];
      case 'task_started':
        if (m.task_type !== undefined && m.task_type !== 'local_agent') return [];
        return [
          {
            k: 'task_started',
            taskId: m.task_id,
            toolUseId: m.tool_use_id,
            description: m.description,
            subagentType: m.subagent_type ?? 'agent',
          },
        ];
      case 'task_progress':
        return [
          {
            k: 'task_progress',
            taskId: m.task_id,
            lastTool: m.last_tool_name,
            summary: m.summary,
            usage: {
              totalTokens: m.usage.total_tokens,
              toolUses: m.usage.tool_uses,
              durationMs: m.usage.duration_ms,
            },
          },
        ];
      case 'task_updated':
        // Terminal states come from task_notification. A description change is shown as progress.
        return m.patch.description
          ? [{ k: 'task_progress', taskId: m.task_id, summary: m.patch.description }]
          : [];
      case 'task_notification':
        return [
          {
            k: 'task_done',
            taskId: m.task_id,
            status: m.status,
            report: clip(m.summary ?? ''),
            usage: m.usage && {
              totalTokens: m.usage.total_tokens,
              toolUses: m.usage.tool_uses,
              durationMs: m.usage.duration_ms,
            },
          },
        ];
      default:
        return [];
    }
  }

  private mapAssistant(m: Extract<SDKMessage, { type: 'assistant' }>): UiEvent[] {
    const parent = m.parent_tool_use_id ?? undefined;
    const out: UiEvent[] = [];
    for (const b of blocks(m.message.content)) {
      if (b.type === 'text' && b.text)
        out.push({ k: 'assistant_text', text: b.text, parentToolUseId: parent });
      else if (b.type === 'tool_use' && b.id && b.name) {
        if (b.name === 'Agent' || b.name === 'Task') this.agentToolIds.add(b.id);
        this.parents.set(b.id, parent);
        out.push({ k: 'tool_use', toolUseId: b.id, name: b.name, input: b.input, parentToolUseId: parent });
        if (!parent) out.push({ k: 'state', state: 'tool', tool: b.name });
      }
    }
    return out;
  }

  private mapUser(m: Extract<SDKMessage, { type: 'user' }>): UiEvent[] {
    const parent = m.parent_tool_use_id ?? undefined;
    const out: UiEvent[] = [];
    for (const b of blocks(m.message.content)) {
      if (b.type === 'tool_result' && b.tool_use_id) {
        out.push({
          k: 'tool_result',
          toolUseId: b.tool_use_id,
          ok: !b.is_error,
          text: clip(textOf(b.content)),
          parentToolUseId: parent,
        });
      }
    }
    return out;
  }
}

interface HistoryMessage {
  type: string;
  message: unknown;
  parent_tool_use_id: string | null;
}

const tag = (name: string): RegExp => new RegExp(`<${name}>([^]*?)</${name}>`, 'g');

/**
 * Claude Code's terminal stores slash commands and their output as tagged text. This turns
 * `<command-name>/exit</command-name>...` into "/exit", drops caveats and system reminders,
 * and returns local command output separately.
 */
export function cleanUserText(raw: string): { text: string; stdout: string } {
  let t = raw.replace(tag('local-command-caveat'), '').replace(tag('system-reminder'), '');
  const stdout = [...t.matchAll(tag('local-command-stdout'))]
    .map((m) => m[1]!.trim())
    .filter(Boolean)
    .join(String.fromCharCode(10));
  t = t.replace(tag('local-command-stdout'), '').replace(tag('local-command-stderr'), '');
  const name = tag('command-name').exec(t)?.[1]?.trim();
  if (name) {
    const args = tag('command-args').exec(t)?.[1]?.trim() ?? '';
    t = `${name} ${args}`.trim();
  } else t = t.replace(tag('command-message'), '').replace(tag('command-args'), '');
  return { text: t.trim(), stdout };
}

/** Converts transcript messages (from the SDK's session readers) to UI events, for sessions with no event log. */
export function historyEvents(messages: HistoryMessage[], limit = 2000): UiEvent[] {
  const mapper = new EventMapper();
  const out: UiEvent[] = [];
  for (const m of messages) {
    const msg = m.message as { content?: unknown } | undefined;
    if (m.type === 'user' && !m.parent_tool_use_id) {
      const cleaned = cleanUserText(textOf(msg?.content));
      if (cleaned.stdout) out.push({ k: 'notice', message: clip(cleaned.stdout, 2000) });
      if (cleaned.text) out.push({ k: 'user', text: clip(cleaned.text, 20_000) });
    }
    if (m.type === 'user' || m.type === 'assistant') {
      for (const e of mapper.map(m as unknown as SDKMessage)) if (e.k !== 'state') out.push(e);
    }
  }
  return out.slice(-limit);
}
