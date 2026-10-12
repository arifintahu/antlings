import {
  deleteSession,
  getSessionInfo,
  getSessionMessages,
  getSubagentMessages,
  listSessions,
  listSubagents,
  renameSession,
  tagSession,
} from '@anthropic-ai/claude-agent-sdk';

export interface TranscriptInfo {
  sessionId: string;
  summary: string;
  lastModified: number;
  cwd?: string;
  customTitle?: string;
  firstPrompt?: string;
  tag?: string;
  createdAt?: number;
}

export interface TranscriptMessage {
  type: 'user' | 'assistant' | 'system';
  uuid: string;
  message: unknown;
  parent_tool_use_id: string | null;
}

/** Session transcripts on disk. The SDK implementation lives below; tests use an in-memory one. */
export interface Transcripts {
  list(): Promise<TranscriptInfo[]>;
  info(id: string): Promise<TranscriptInfo | undefined>;
  messages(id: string): Promise<TranscriptMessage[]>;
  subagents(id: string): Promise<string[]>;
  subagentMessages(id: string, agentId: string): Promise<TranscriptMessage[]>;
  rename(id: string, title: string): Promise<void>;
  tag(id: string, tag: string | null): Promise<void>;
  remove(id: string): Promise<void>;
}

export const sdkTranscripts: Transcripts = {
  list: () => listSessions(),
  info: (id) => getSessionInfo(id),
  messages: (id) => getSessionMessages(id, { includeSystemMessages: false }),
  subagents: (id) => listSubagents(id),
  subagentMessages: (id, agentId) => getSubagentMessages(id, agentId),
  rename: (id, title) => renameSession(id, title),
  tag: (id, tag) => tagSession(id, tag),
  remove: (id) => deleteSession(id),
};
